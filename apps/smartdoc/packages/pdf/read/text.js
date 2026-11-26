// A page's text, as items: { str, dir, width, height, transform, fontName, hasEOL }, in the order
// they're drawn. The rules for joining glyphs into items, adding spaces where text jumps and
// ending lines are pdf.js's (its getTextContent), so that the text comes out the same: SmartDoc's
// stored text positions (offsets into a page's items joined, a newline after each that ends a
// line) were made with it, and must still match.

import { readOperators } from './content.js';
import { loadTextFont } from './font.js';
import { Dict, Name, Ref, Stream } from './objects.js';
import { streamBytes } from './filters.js';
import { bidi } from './bidi.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const TRACKING_SPACE_FACTOR = 0.102;
const NOT_A_SPACE_FACTOR = 0.03;
const NEGATIVE_SPACE_FACTOR = -0.2;
const SPACE_IN_FLOW_MIN_FACTOR = 0.102;
const SPACE_IN_FLOW_MAX_FACTOR = 0.6;
const VERTICAL_SHIFT_RATIO = 0.25;

// m1 after m2, as pdf.js's Util.transform.
export const transform = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

class TextState {
  constructor() {
    this.ctm = IDENTITY.slice();
    this.fontName = null;
    this.fontSize = 0;
    this.loadedName = null;
    this.font = null;
    this.fontMatrix = [0.001, 0, 0, 0.001, 0, 0];
    this.textMatrix = IDENTITY.slice();
    this.textLineMatrix = IDENTITY.slice();
    this.charSpacing = 0;
    this.wordSpacing = 0;
    this.leading = 0;
    this.textHScale = 1;
    this.textRise = 0;
  }
  clone() {
    const c = Object.assign(new TextState(), this);
    c.ctm = this.ctm.slice();
    c.textMatrix = this.textMatrix.slice();
    c.textLineMatrix = this.textLineMatrix.slice();
    return c;
  }
  setTextMatrix(a, b, c, d, e, f) {
    this.textMatrix = [a, b, c, d, e, f];
  }
  setTextLineMatrix(a, b, c, d, e, f) {
    this.textLineMatrix = [a, b, c, d, e, f];
  }
  translateTextMatrix(x, y) {
    const m = this.textMatrix;
    m[4] = m[0] * x + m[2] * y + m[4];
    m[5] = m[1] * x + m[3] * y + m[5];
  }
  translateTextLineMatrix(x, y) {
    const m = this.textLineMatrix;
    m[4] = m[0] * x + m[2] * y + m[4];
    m[5] = m[1] * x + m[3] * y + m[5];
  }
  carriageReturn() {
    this.translateTextLineMatrix(0, -this.leading);
    this.textMatrix = this.textLineMatrix.slice();
  }
}

// pdf.js normalises compatibility characters (ligatures, some spaces) in each item.
const NORMALIZE = /([ µ;ຳ -  Ωﬀ-ﬄﬆﬠ-זּטּ-לּמּנּסּףּפּצּ-ﮡﮤ-ﮩﮮ-ﮱﯓ-ﯜﯞ-ﯧﯪ-ﯸﯼﯽﰀ-ﱝﱤ-ﳱﳵ-ﴽﶈﷴﷺﷻﹱﹷﹹﹻﹽ]+)|(ﬅ+)/gu;
export const normalizeUnicode = (str) => str.replaceAll(NORMALIZE, (_, p1, p2) => (p1 ? p1.normalize('NFKC') : 'ſt'.repeat(p2.length)));

// The page's text items. `page` is a PdfPage.
export function getTextContent(page) {
  const items = [];
  // Each font's look, by its name in the items, as pdf.js's styles: for laying text over the page.
  items.styles = {};
  const state = new TextState();
  run(page.doc, page.contents(), page.resources, [state], items, page.view, new Set());
  return { items, styles: items.styles };
}

// Runs one content stream (the page's, or a form's) with its own item being built, as pdf.js's
// getTextContent does for each.
// XObjects that showed no text, by name and by object, as pdf.js's emptyXObjectCache keeps them.
class EmptyXObjects {
  names = new Map();
  refs = new Set();
  set(name, ref) {
    if (ref) {
      if (this.refs.has(ref)) return;
      this.names.set(name, ref);
      this.refs.add(ref);
    } else this.names.set(name, null);
  }
  has(name) {
    if (!this.names.has(name)) return false;
    const ref = this.names.get(name);
    return ref ? this.refs.has(ref) : true;
  }
  hasRef(ref) {
    return this.refs.has(ref);
  }
}

function run(doc, bytes, resources, stack, items, viewBox, seen) {
  const empty = new EmptyXObjects();
  const textContentItem = {
    initialized: false,
    str: [],
    totalWidth: 0,
    totalHeight: 0,
    width: 0,
    height: 0,
    vertical: false,
    prevTransform: null,
    prevTextRise: 0,
    textAdvanceScale: 0,
    spaceInFlowMin: 0,
    spaceInFlowMax: 0,
    trackingSpaceMin: Infinity,
    negativeSpaceMax: -Infinity,
    notASpace: -Infinity,
    transform: null,
    fontName: null,
    hasEOL: false,
  };
  const twoLastChars = [' ', ' '];
  let twoLastCharsPos = 0;
  const saveLastChar = (char) => {
    const nextPos = (twoLastCharsPos + 1) % 2;
    const ret = twoLastChars[twoLastCharsPos] !== ' ' && twoLastChars[nextPos] === ' ';
    twoLastChars[twoLastCharsPos] = char;
    twoLastCharsPos = nextPos;
    return ret;
  };
  const shouldAddWhitespace = () => twoLastChars[twoLastCharsPos] !== ' ' && twoLastChars[(twoLastCharsPos + 1) % 2] === ' ';
  const resetLastChars = () => {
    twoLastChars[0] = twoLastChars[1] = ' ';
    twoLastCharsPos = 0;
  };
  let textState = stack[stack.length - 1];
  let currentTextState = null;

  const pushWhitespace = ({ width = 0, height = 0, transform: t = textContentItem.prevTransform, fontName = textContentItem.fontName }) => {
    items.push({ str: ' ', dir: 'ltr', width, height, transform: t, fontName, hasEOL: false });
  };
  const getCurrentTextTransform = () => {
    const font = textState.font;
    const tsm = [textState.fontSize * textState.textHScale, 0, 0, textState.fontSize, 0, textState.textRise];
    if (font?.isType3Font && textState.fontSize <= 1 && !sameMatrix(textState.fontMatrix, [0.001, 0, 0, 0.001, 0, 0])) {
      const glyphHeight = font.bbox[3] - font.bbox[1];
      if (glyphHeight > 0) tsm[3] *= glyphHeight * textState.fontMatrix[3];
    }
    return transform(textState.ctm, transform(textState.textMatrix, tsm));
  };
  const ensureTextContentItem = () => {
    if (textContentItem.initialized) return textContentItem;
    const { font, loadedName } = textState;
    textContentItem.fontName = loadedName;
    const trm = (textContentItem.transform = getCurrentTextTransform());
    if (!font.vertical) {
      textContentItem.width = textContentItem.totalWidth = 0;
      textContentItem.height = textContentItem.totalHeight = Math.hypot(trm[2], trm[3]);
      textContentItem.vertical = false;
    } else {
      textContentItem.width = textContentItem.totalWidth = Math.hypot(trm[0], trm[1]);
      textContentItem.height = textContentItem.totalHeight = 0;
      textContentItem.vertical = true;
    }
    const scaleLineX = Math.hypot(textState.textLineMatrix[0], textState.textLineMatrix[1]);
    const scaleCtmX = Math.hypot(textState.ctm[0], textState.ctm[1]);
    textContentItem.textAdvanceScale = scaleCtmX * scaleLineX;
    const { fontSize } = textState;
    textContentItem.trackingSpaceMin = fontSize * TRACKING_SPACE_FACTOR;
    textContentItem.notASpace = fontSize * NOT_A_SPACE_FACTOR;
    textContentItem.negativeSpaceMax = fontSize * NEGATIVE_SPACE_FACTOR;
    textContentItem.spaceInFlowMin = fontSize * SPACE_IN_FLOW_MIN_FACTOR;
    textContentItem.spaceInFlowMax = fontSize * SPACE_IN_FLOW_MAX_FACTOR;
    textContentItem.hasEOL = false;
    textContentItem.initialized = true;
    return textContentItem;
  };
  const updateAdvanceScale = () => {
    if (!textContentItem.initialized) return;
    const scaleLineX = Math.hypot(textState.textLineMatrix[0], textState.textLineMatrix[1]);
    const scaleCtmX = Math.hypot(textState.ctm[0], textState.ctm[1]);
    const scaleFactor = scaleCtmX * scaleLineX;
    if (scaleFactor === textContentItem.textAdvanceScale) return;
    if (!textContentItem.vertical) {
      textContentItem.totalWidth += textContentItem.width * textContentItem.textAdvanceScale;
      textContentItem.width = 0;
    } else {
      textContentItem.totalHeight += textContentItem.height * textContentItem.textAdvanceScale;
      textContentItem.height = 0;
    }
    textContentItem.textAdvanceScale = scaleFactor;
  };
  const runBidiTransform = (chunk) => {
    const text = normalizeUnicode(chunk.str.join(''));
    const result = bidi(text, -1, chunk.vertical);
    return { str: result.str, dir: result.dir, width: Math.abs(chunk.totalWidth), height: Math.abs(chunk.totalHeight), transform: chunk.transform, fontName: chunk.fontName, hasEOL: chunk.hasEOL };
  };
  const applyInverseRotation = (x, y, m) => {
    const scale = Math.hypot(m[0], m[1]);
    return [(m[0] * x + m[1] * y) / scale, (m[2] * x + m[3] * y) / scale];
  };
  const compareWithLastPosition = (glyphWidth) => {
    const currentTransform = getCurrentTextTransform();
    let posX = currentTransform[4];
    let posY = currentTransform[5];
    if (textState.font?.vertical) {
      if (posX < viewBox[0] || posX > viewBox[2] || posY + glyphWidth < viewBox[1] || posY > viewBox[3]) return false;
    } else if (posX + glyphWidth < viewBox[0] || posX > viewBox[2] || posY < viewBox[1] || posY > viewBox[3]) return false;
    if (!textState.font || !textContentItem.prevTransform) return true;
    let lastPosX = textContentItem.prevTransform[4];
    let lastPosY = textContentItem.prevTransform[5];
    if (lastPosX === posX && lastPosY === posY) return true;
    let rotate = -1;
    if (currentTransform[0] && currentTransform[1] === 0 && currentTransform[2] === 0) rotate = currentTransform[0] > 0 ? 0 : 180;
    else if (currentTransform[1] && currentTransform[0] === 0 && currentTransform[3] === 0) rotate = currentTransform[1] > 0 ? 90 : 270;
    switch (rotate) {
      case 0:
        break;
      case 90:
        [posX, posY] = [posY, posX];
        [lastPosX, lastPosY] = [lastPosY, lastPosX];
        break;
      case 180:
        [posX, posY, lastPosX, lastPosY] = [-posX, -posY, -lastPosX, -lastPosY];
        break;
      case 270:
        [posX, posY] = [-posY, -posX];
        [lastPosX, lastPosY] = [-lastPosY, -lastPosX];
        break;
      default:
        [posX, posY] = applyInverseRotation(posX, posY, currentTransform);
        [lastPosX, lastPosY] = applyInverseRotation(lastPosX, lastPosY, textContentItem.prevTransform);
    }
    if (textState.font.vertical) {
      const advanceY = (lastPosY - posY) / textContentItem.textAdvanceScale;
      const advanceX = posX - lastPosX;
      const orientation = Math.sign(textContentItem.height || textContentItem.totalHeight);
      if (advanceY < orientation * textContentItem.negativeSpaceMax) {
        if (Math.abs(advanceX) > 0.5 * textContentItem.width) {
          appendEOL();
          return true;
        }
        resetLastChars();
        flushTextContentItem();
        return true;
      }
      if (Math.abs(advanceX) > textContentItem.width) {
        appendEOL();
        return true;
      }
      if (advanceY <= orientation * textContentItem.notASpace) resetLastChars();
      if (advanceY <= orientation * textContentItem.trackingSpaceMin) {
        if (shouldAddWhitespace()) {
          resetLastChars();
          flushTextContentItem();
          pushWhitespace({ height: Math.abs(advanceY) });
        } else textContentItem.height += advanceY;
      } else if (!addFakeSpaces(advanceY, textContentItem.prevTransform, orientation)) {
        if (textContentItem.str.length === 0) {
          resetLastChars();
          pushWhitespace({ height: Math.abs(advanceY) });
        } else textContentItem.height += advanceY;
      }
      if (Math.abs(advanceX) > textContentItem.width * VERTICAL_SHIFT_RATIO) flushTextContentItem();
      return true;
    }
    const advanceX = (posX - lastPosX) / textContentItem.textAdvanceScale;
    const advanceY = posY - lastPosY;
    const orientation = Math.sign(textContentItem.width || textContentItem.totalWidth);
    if (advanceX < orientation * textContentItem.negativeSpaceMax) {
      if (Math.abs(advanceY) > 0.5 * textContentItem.height) {
        appendEOL();
        return true;
      }
      resetLastChars();
      flushTextContentItem();
      return true;
    }
    const riseDelta = textState.textRise - textContentItem.prevTextRise;
    const advanceYCorrected = riseDelta === 0 ? advanceY : advanceY - (currentTransform[3] / textState.fontSize) * riseDelta;
    if (Math.abs(advanceYCorrected) > textContentItem.height) {
      appendEOL();
      return true;
    }
    if (advanceX <= orientation * textContentItem.notASpace) resetLastChars();
    if (advanceX <= orientation * textContentItem.trackingSpaceMin) {
      if (shouldAddWhitespace()) {
        resetLastChars();
        flushTextContentItem();
        pushWhitespace({ width: Math.abs(advanceX) });
      } else textContentItem.width += advanceX;
    } else if (!addFakeSpaces(advanceX, textContentItem.prevTransform, orientation)) {
      if (textContentItem.str.length === 0) {
        resetLastChars();
        pushWhitespace({ width: Math.abs(advanceX) });
      } else textContentItem.width += advanceX;
    }
    if (Math.abs(advanceY) > textContentItem.height * VERTICAL_SHIFT_RATIO) flushTextContentItem();
    return true;
  };
  const buildTextContentItem = ({ chars, extraSpacing }) => {
    if (
      currentTextState !== textState &&
      (currentTextState.fontSize !== textState.fontSize ||
        (currentTextState.fontName !== textState.fontName && (currentTextState.font?.name !== textState.font.name || currentTextState.font?.vertical !== textState.font.vertical)))
    ) {
      flushTextContentItem();
      currentTextState = textState.clone();
    }
    const font = textState.font;
    const baseCharSpacing = font.vertical ? -textState.charSpacing : textState.charSpacing;
    if (!chars) {
      const charSpacing = baseCharSpacing + extraSpacing;
      if (charSpacing) {
        if (!font.vertical) textState.translateTextMatrix(charSpacing * textState.textHScale, 0);
        else textState.translateTextMatrix(0, -charSpacing);
      }
      return;
    }
    const glyphs = font.glyphs(chars);
    const scale = textState.fontMatrix[0] * textState.fontSize;
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i];
      const { category, originalCharCode } = glyph;
      if (category.isInvisibleFormatMark) continue;
      let charSpacing = baseCharSpacing + (i + 1 === glyphs.length ? extraSpacing : 0);
      const glyphWidth = font.vertical ? glyph.vmetric[0] : glyph.width;
      let scaledDim = glyphWidth * scale;
      if (originalCharCode === 0x20) charSpacing += textState.wordSpacing;
      if (category.isWhitespace) {
        if (!font.vertical) {
          charSpacing += scaledDim;
          textState.translateTextMatrix(charSpacing * textState.textHScale, 0);
        } else {
          charSpacing += -scaledDim;
          textState.translateTextMatrix(0, -charSpacing);
        }
        saveLastChar(' ');
        continue;
      }
      if (!category.isZeroWidthDiacritic && !compareWithLastPosition(scaledDim)) {
        if (!font.vertical) textState.translateTextMatrix(scaledDim * textState.textHScale, 0);
        else textState.translateTextMatrix(0, scaledDim);
        continue;
      }
      const chunk = ensureTextContentItem();
      if (category.isZeroWidthDiacritic) scaledDim = 0;
      if (!font.vertical) {
        scaledDim *= textState.textHScale;
        textState.translateTextMatrix(scaledDim, 0);
        chunk.width += scaledDim;
      } else {
        textState.translateTextMatrix(0, scaledDim);
        scaledDim = Math.abs(scaledDim);
        chunk.height += scaledDim;
      }
      if (scaledDim) {
        chunk.prevTransform = getCurrentTextTransform();
        chunk.prevTextRise = textState.textRise;
      }
      if (saveLastChar(glyph.unicode)) chunk.str.push(' ');
      chunk.str.push(glyph.unicode);
      if (charSpacing) {
        if (!font.vertical) textState.translateTextMatrix(charSpacing * textState.textHScale, 0);
        else textState.translateTextMatrix(0, -charSpacing);
      }
    }
  };
  const appendEOL = () => {
    resetLastChars();
    if (textContentItem.initialized) {
      textContentItem.hasEOL = true;
      flushTextContentItem();
    } else items.push({ str: '', dir: 'ltr', width: 0, height: 0, transform: getCurrentTextTransform(), fontName: textState.loadedName, hasEOL: true });
  };
  const addFakeSpaces = (width, transf, orientation) => {
    if (orientation * textContentItem.spaceInFlowMin <= width && width <= orientation * textContentItem.spaceInFlowMax) {
      if (textContentItem.initialized) {
        resetLastChars();
        textContentItem.str.push(' ');
      }
      return false;
    }
    const fontName = textContentItem.fontName;
    let height = 0;
    if (textContentItem.vertical) {
      height = width;
      width = 0;
    }
    flushTextContentItem();
    resetLastChars();
    pushWhitespace({ width: Math.abs(width), height: Math.abs(height), transform: transf || getCurrentTextTransform(), fontName });
    return true;
  };
  const flushTextContentItem = () => {
    if (!textContentItem.initialized || !textContentItem.str) return;
    if (!textContentItem.vertical) textContentItem.totalWidth += textContentItem.width * textContentItem.textAdvanceScale;
    else textContentItem.totalHeight += textContentItem.height * textContentItem.textAdvanceScale;
    items.push(runBidiTransform(textContentItem));
    textContentItem.initialized = false;
    textContentItem.str.length = 0;
  };

  const fontsOf = () => resources?.dict('Font');
  const setFont = (name, ref) => {
    const fonts = fontsOf();
    const fontObj = ref ?? fonts?.raw(name);
    const font = fontObj ? loadTextFont(doc, fontObj) : null;
    textState.font = font ?? fallbackFont();
    textState.loadedName = name;
    if (name && items.styles && !items.styles[name]) {
      const f = textState.font;
      items.styles[name] = { fontFamily: f.fixedPitch ? 'monospace' : f.serif ? 'serif' : 'sans-serif', ascent: f.ascent ?? null, descent: f.descent ?? null, vertical: Boolean(f.vertical) };
    }
    textState.fontMatrix = textState.font.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
  };
  const showSpacedTextBuffer = [];

  readOperators(
    bytes,
    (op, args) => {
      textState = stack[stack.length - 1];
      currentTextState ||= textState.clone();
      switch (op) {
        case 'q':
          stack.push(textState.clone());
          break;
        case 'Q':
          if (stack.length > 1) stack.pop();
          break;
        case 'cm':
          if (args.every((v) => typeof v === 'number')) textState.ctm = transform(textState.ctm, args);
          break;
        case 'Tf': {
          const [nameArg, size] = args;
          if (!(nameArg instanceof Name) || typeof size !== 'number') break;
          if (textState.font && nameArg.name === textState.fontName && size === textState.fontSize) break;
          textState.fontName = nameArg.name;
          textState.fontSize = size;
          setFont(nameArg.name, null);
          break;
        }
        case 'Ts':
          textState.textRise = args[0];
          break;
        case 'Tz':
          textState.textHScale = args[0] / 100;
          break;
        case 'TL':
          textState.leading = args[0];
          break;
        case 'Td':
          textState.translateTextLineMatrix(args[0], args[1]);
          textState.textMatrix = textState.textLineMatrix.slice();
          break;
        case 'TD':
          textState.leading = -args[1];
          textState.translateTextLineMatrix(args[0], args[1]);
          textState.textMatrix = textState.textLineMatrix.slice();
          break;
        case 'T*':
          textState.carriageReturn();
          break;
        case 'Tm':
          if (!args.every((v) => typeof v === 'number')) break;
          textState.setTextMatrix(...args);
          textState.setTextLineMatrix(...args);
          updateAdvanceScale();
          break;
        case 'Tc':
          textState.charSpacing = args[0];
          break;
        case 'Tw':
          textState.wordSpacing = args[0];
          break;
        case 'BT':
          textState.textMatrix = IDENTITY.slice();
          textState.textLineMatrix = IDENTITY.slice();
          break;
        case 'TJ': {
          if (!textState.font) {
            ensureFont();
            break;
          }
          if (!Array.isArray(args[0])) break;
          const spaceFactor = ((textState.font.vertical ? 1 : -1) * textState.fontSize) / 1000;
          for (const item of args[0]) {
            if (typeof item === 'string') showSpacedTextBuffer.push(item);
            else if (typeof item === 'number' && item !== 0) {
              const str = showSpacedTextBuffer.join('');
              showSpacedTextBuffer.length = 0;
              buildTextContentItem({ chars: str, extraSpacing: item * spaceFactor });
            }
          }
          if (showSpacedTextBuffer.length > 0) {
            const str = showSpacedTextBuffer.join('');
            showSpacedTextBuffer.length = 0;
            buildTextContentItem({ chars: str, extraSpacing: 0 });
          }
          break;
        }
        case 'Tj':
          if (!textState.font) {
            ensureFont();
            break;
          }
          if (typeof args[0] === 'string') buildTextContentItem({ chars: args[0], extraSpacing: 0 });
          break;
        case "'":
          if (!textState.font) {
            ensureFont();
            break;
          }
          textState.carriageReturn();
          if (typeof args[0] === 'string') buildTextContentItem({ chars: args[0], extraSpacing: 0 });
          break;
        case '"':
          if (!textState.font) {
            ensureFont();
            break;
          }
          textState.wordSpacing = args[0];
          textState.charSpacing = args[1];
          textState.carriageReturn();
          if (typeof args[2] === 'string') buildTextContentItem({ chars: args[2], extraSpacing: 0 });
          break;
        case 'Do': {
          flushTextContentItem();
          if (!(args[0] instanceof Name)) break;
          const name = args[0].name;
          if (empty.has(name)) break;
          const xobjs = resources?.dict('XObject');
          const raw = xobjs?.raw(name);
          const key = raw instanceof Ref ? raw.key : null;
          if (key && empty.hasRef(key)) break;
          if (key && seen.has(key)) break;
          const xobj = xobjs?.get(name);
          if (!(xobj instanceof Stream)) break;
          if (xobj.dict.name('Subtype') !== 'Form') {
            empty.set(name, key);
            break;
          }
          const before = items.length;
          const inner = textState.clone();
          const m = xobj.dict.array('Matrix');
          if (m?.length === 6 && m.every((v) => typeof v === 'number')) inner.ctm = transform(inner.ctm, m);
          const localResources = xobj.dict.get('Resources');
          const nested = new Set(seen);
          if (key) nested.add(key);
          try {
            run(doc, streamBytes(xobj), localResources instanceof Dict ? localResources : resources, [inner], items, viewBox, nested);
            // A form that gave no text is passed over from then on in this stream, wherever it's
            // drawn (as pdf.js does: one first drawn off the page gives none later either).
            if (items.length === before) empty.set(name, key);
          } catch {
            // a damaged form is skipped
          }
          break;
        }
        case 'gs': {
          if (!(args[0] instanceof Name)) break;
          const gState = resources?.dict('ExtGState')?.dict(args[0].name);
          const gFont = gState?.get('Font');
          if (!Array.isArray(gFont)) break;
          flushTextContentItem();
          textState.fontName = null;
          textState.fontSize = gFont[1];
          setFont(null, gFont[0]);
          break;
        }
        case 'BMC':
        case 'BDC':
        case 'EMC':
          flushTextContentItem();
          break;
      }
    },
    doc,
  );
  flushTextContentItem();

  // pdf.js loads a fallback font when text is shown with none set, and skips that operator.
  function ensureFont() {
    textState.font = fallbackFont();
    textState.loadedName = null;
    textState.fontMatrix = [0.001, 0, 0, 0.001, 0, 0];
  }
}

const sameMatrix = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let FALLBACK = null;
function fallbackFont() {
  // A font for text shown without one, as pdf.js's: Helvetica's metrics, WinAnsiEncoding, and a
  // type of its own (so none of the Type 1 rules apply).
  if (!FALLBACK) {
    const dict = new Dict(null);
    dict.set('Type', Name.of('FallbackType'));
    dict.set('Subtype', Name.of('FallbackType'));
    dict.set('BaseFont', Name.of('Helvetica'));
    dict.set('Encoding', Name.of('WinAnsiEncoding'));
    FALLBACK = loadTextFont({ fetchIfRef: (v) => v }, dict);
  }
  return FALLBACK;
}

// A page's text as SmartDoc stores positions in it: items joined, a newline after each that ends
// a line.
export const pageText = (items) => items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('');
