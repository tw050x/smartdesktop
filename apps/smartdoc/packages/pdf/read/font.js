// A PDF font as text needs it: how its character codes are read (one byte, or a composite font's
// CMap), what text each code is (ToUnicode, else its encoding's glyph names), and how wide each is
// (Widths, W, or the 14 standard fonts' metrics). The rules follow those other readers use, pdf.js
// in particular, so a page's text comes out the same and earlier text positions still match.

import { IdentityCMap, MissingCMapError, loadCMap, toUnicodeMap } from './cmap.js';
import { ENCODINGS, METRICS, NON_STD_FONT_MAP, SERIF_FONTS, STD_FONT_MAP, SYMBOLS_FONTS, glyphMap, glyphsUnicode } from './data.js';
import { getEncoding, unicodeForGlyph } from './encodings.js';
import { streamBytes, streamDamaged } from './filters.js';
import { applyFontProgram } from './fontfile.js';
import { Dict, Name, Stream } from './objects.js';

export { getEncoding, unicodeForGlyph };

export const FontFlags = { FixedPitch: 1, Serif: 2, Symbolic: 4, Script: 8, Nonsymbolic: 32, Italic: 64, AllCap: 65536, SmallCap: 131072, ForceBold: 262144 };
const IDENTITY_FONT_MATRIX = [0.001, 0, 0, 0.001, 0, 0];

export const normalizeFontName = (name) => name.replaceAll(/[,_]/g, '-').replaceAll(/\s/g, '');

const isKnownFontName = (name) => {
  const n = normalizeFontName(name);
  return Boolean(STD_FONT_MAP[n] || NON_STD_FONT_MAP[n] || SERIF_FONTS.has(n) || SYMBOLS_FONTS.has(n));
};

// Chinese fonts' names in GBK, as some PDFs give them: their text is GBK-EUC-H codes.
const CHINESE_FONT_NAMES = ['\xCB\xCE\xCC\xE5', '\xBA\xDA\xCC\xE5', '\xBF\xAC\xCC\xE5', '\xB7\xC2\xCB\xCE', '\xBF\xAC\xCC\xE5_GB2312', '\xB7\xC2\xCB\xCE_GB2312', '\xC1\xA5\xCA\xE9', '\xD0\xC2\xCB\xCE', '\xB7\xC2\xCB\xCE\xCC\xE5', '\xD0\xA1\xB1\xEA\xCB\xCE'];

const isSerifFont = (baseFontName) => {
  const plain = baseFontName.split('-', 1)[0];
  return SERIF_FONTS.has(plain) || /serif/i.test(plain);
};

function baseFontMetrics(name) {
  let fontName = normalizeFontName(name);
  fontName = STD_FONT_MAP[fontName] || fontName;
  const widths = METRICS[fontName] ?? METRICS[isSerifFont(name) ? 'Times-Roman' : 'Helvetica'];
  if (typeof widths === 'number') return { defaultWidth: widths, monospace: true, widths: {} };
  return { defaultWidth: 0, monospace: false, widths };
}

function charCodeToWidth(widthsByName, differences, encoding) {
  const widths = [];
  for (let code = 0; code < 256; code++) {
    const width = (differences.has(code) && widthsByName[differences.get(code)]) || (code in encoding && widthsByName[encoding[code]]);
    if (width) widths[code] = width;
  }
  return widths;
}

const numberArray = (doc, value) => (Array.isArray(value) ? value.map((v) => doc.fetchIfRef(v)) : null);

// The text-side font for a font dictionary: { glyphs(chars), vertical, fontMatrix, ... }.
export function loadTextFont(doc, fontRefOrDict) {
  const baseDict = doc.fetchIfRef(fontRefOrDict);
  if (!(baseDict instanceof Dict)) return null;
  if (baseDict.textFont) return baseDict.textFont;
  let font;
  try {
    font = new TextFont(doc, baseDict);
  } catch {
    // A font that can't be read shows no text, as pdf.js's ErrorFont.
    font = ERROR_FONT;
  }
  baseDict.textFont = font;
  return font;
}

const textOf = (v) => (typeof v === 'string' ? v : '');

const ERROR_FONT = { error: true, name: undefined, vertical: false, fontMatrix: IDENTITY_FONT_MATRIX, glyphs: () => [] };

export class TextFont {
  constructor(doc, baseDict) {
    let dict = baseDict;
    let type = baseDict.name('Subtype');
    let composite = false;
    if (type === 'Type0') {
      const df = baseDict.get('DescendantFonts');
      dict = doc.fetchIfRef(Array.isArray(df) ? df[0] : df);
      if (!(dict instanceof Dict)) throw new Error('no descendant font');
      type = dict.name('Subtype');
      composite = true;
    }
    if (!type) throw new Error('no font type');
    this.type = type;
    this.composite = composite;
    // The font dictionary (a composite font's descendant): Type 3 fonts draw from its CharProcs.
    this.dict = dict;
    let firstChar = dict.get('FirstChar');
    if (!Number.isInteger(firstChar)) firstChar = 0;
    let lastChar = dict.get('LastChar');
    if (!Number.isInteger(lastChar)) lastChar = composite ? 0xffff : 0xff;
    const isType3 = type === 'Type3';
    this.isType3Font = isType3;
    let descriptor = dict.dict('FontDescriptor');
    const toUnicodeObj = baseDict.get('ToUnicode') ?? dict.get('ToUnicode');

    const props = { type, composite, firstChar, lastChar, flags: 0, differences: new Map(), widths: [], defaultWidth: 0 };
    const fm = numberArray(doc, dict.get('FontMatrix'));
    props.fontMatrix = fm?.length === 6 && fm.every((v) => typeof v === 'number') ? fm : IDENTITY_FONT_MATRIX;
    this.fontMatrix = props.fontMatrix;
    if (isType3) {
      const bbox = numberArray(doc, dict.get('FontBBox'));
      this.bbox = bbox?.length === 4 ? bbox : [0, 0, 0, 0];
    }

    if (!descriptor && !isType3 && !composite) {
      // A standard font without a descriptor.
      const base = dict.get('BaseFont');
      if (!(base instanceof Name)) throw new Error('no base font');
      const baseFontName = normalizeFontName(base.name);
      const metrics = baseFontMetrics(baseFontName);
      const plain = baseFontName.split('-', 1)[0];
      props.name = baseFontName;
      props.flags = (isSerifFont(plain) ? FontFlags.Serif : 0) | (metrics.monospace ? FontFlags.FixedPitch : 0) | (SYMBOLS_FONTS.has(plain) ? FontFlags.Symbolic : FontFlags.Nonsymbolic);
      props.file = null;
      this.extractDataStructures(doc, dict, props, toUnicodeObj);
      const widths = dict.get('Widths');
      if (Array.isArray(widths)) {
        const w = [];
        let j = firstChar;
        for (const v of widths) {
          const n = doc.fetchIfRef(v);
          if (typeof n === 'number') w[j] = n;
          j++;
        }
        props.widths = w;
      } else props.widths = charCodeToWidth(metrics.widths, props.differences, props.defaultEncoding);
      props.defaultWidth = metrics.defaultWidth;
    } else {
      descriptor ??= new Dict(doc);
      let fontName = descriptor.get('FontName');
      let baseFont = dict.get('BaseFont');
      if (typeof fontName === 'string') fontName = Name.of(fontName);
      if (typeof baseFont === 'string') baseFont = Name.of(baseFont);
      if (isType3) {
        if (!(fontName instanceof Name)) fontName = Name.of(type);
      } else if (fontName?.name !== baseFont?.name) {
        if (fontName?.name && baseFont?.name && (baseFont.name.startsWith(fontName.name) || (!isKnownFontName(fontName.name) && isKnownFontName(baseFont.name)))) fontName = null;
        fontName ||= baseFont;
      }
      props.name = fontName instanceof Name ? fontName.name : '';
      props.file = null;
      for (const n of ['FontFile', 'FontFile2', 'FontFile3']) {
        const file = descriptor.get(n);
        if (!file) continue;
        // A font file that isn't a stream, or is empty once decoded, counts as none.
        if (file instanceof Stream) {
          try {
            const bytes = streamBytes(file);
            if (bytes.length) {
              props.file = file;
              props.fileBytes = bytes;
              // Damaged after its first part: pdf.js can't read the program, and draws the font
              // as one not embedded.
              if (streamDamaged(file)) props.fileFailed = true;
              props.fontFileN = n;
              const sub = file.dict.get('Subtype');
              props.subtype = sub instanceof Name ? sub.name : undefined;
              props.length1 = file.dict.get('Length1');
            }
          } catch {
            props.file = null;
          }
        }
        break;
      }
      const flags = descriptor.get('Flags');
      props.flags = Number.isInteger(flags) ? flags : 0;
      if (composite) {
        const enc = baseDict.get('Encoding');
        props.cidEncoding = enc instanceof Name ? enc.name : '';
        // No Encoding, or a CMap that isn't available, and the font can't be read.
        props.cMap = loadCMap(enc, true);
        if (!props.cMap) throw new Error('composite font without an encoding');
        const info = dict.get('CIDSystemInfo');
        if (info instanceof Dict) props.cidSystemInfo = { registry: textOf(info.get('Registry')), ordering: textOf(info.get('Ordering')) };
        props.vertical = props.cMap.vertical;
      }
      this.extractDataStructures(doc, dict, props, toUnicodeObj);
      this.extractWidths(doc, dict, descriptor, props);
      if (props.file && !isType3 && !props.fileFailed) {
        try {
          this.program = applyFontProgram(props.fileBytes, props, props.toUnicode);
          amendFallbackToUnicode(props);
          this.fontMatrix = props.fontMatrix;
        } catch {
          // Too damaged to use: read as a font that isn't embedded.
          props.fileFailed = true;
        }
      }
    }

    if (!isType3 && (!props.file || props.fileFailed)) this.fallbackToSystemFont(props);
    else this.toUnicodeShown = props.toUnicode;

    this.name = props.name;
    // For laying the text over the page: the font's ascent and descent (its descriptor's, in text
    // space units) and kind.
    const metric = (key) => {
      const v = descriptor?.get(key);
      return typeof v === 'number' && v !== 0 && Math.abs(v) < 2000 ? v / 1000 : null;
    };
    this.ascent = metric('Ascent');
    this.descent = metric('Descent');
    this.fixedPitch = Boolean(props.flags & FontFlags.FixedPitch);
    this.serif = Boolean(props.flags & FontFlags.Serif) || isSerifFont(props.name || '');
    this.vertical = Boolean(props.vertical);
    this.cMap = props.cMap ?? null;
    this.widths = props.widths;
    this.defaultWidth = props.defaultWidth;
    this.vmetrics = props.vmetrics;
    this.defaultVMetrics = props.defaultVMetrics;
    this.differences = props.differences;
    this.defaultEncoding = props.defaultEncoding;
    this.toUnicode = this.toUnicodeShown;
    this.missingFile = !props.file || Boolean(props.fileFailed);
    this.props = props;
    this.glyphCache = new Map();
    this.charsCache = new Map();
  }

  // Encoding, differences and ToUnicode (pdf.js's extractDataStructures and buildToUnicode).
  extractDataStructures(doc, dict, props, toUnicodeObj) {
    let baseEncodingName = null;
    if (dict.has('Encoding')) {
      const encoding = dict.get('Encoding');
      if (encoding instanceof Dict) {
        const be = encoding.get('BaseEncoding');
        baseEncodingName = be instanceof Name ? be.name : null;
        const diffs = encoding.get('Differences');
        if (Array.isArray(diffs)) {
          let index = 0;
          for (const entry of diffs) {
            const data = doc.fetchIfRef(entry);
            if (typeof data === 'number') index = data;
            else if (data instanceof Name) props.differences.set(index++, data.name);
            else break;
          }
        }
      } else if (encoding instanceof Name) baseEncodingName = encoding.name;
      if (baseEncodingName !== 'MacRomanEncoding' && baseEncodingName !== 'MacExpertEncoding' && baseEncodingName !== 'WinAnsiEncoding') baseEncodingName = null;
    }
    const nonEmbedded = !props.file;
    const isSymbolsFontName = SYMBOLS_FONTS.has(props.name);
    if (baseEncodingName && nonEmbedded && isSymbolsFontName) baseEncodingName = null;
    // pdf.js reads these as composite fonts through GBK-EUC-H, a CMap not included yet: it can't
    // without its CMap files, and nor can this.
    if (baseEncodingName === 'WinAnsiEncoding' && nonEmbedded && props.name?.charCodeAt(0) >= 0xb7 && CHINESE_FONT_NAMES.includes(props.name)) throw new MissingCMapError('GBK-EUC-H isn\'t available');
    if (baseEncodingName) props.defaultEncoding = getEncoding(baseEncodingName);
    else {
      let symbolic = Boolean(props.flags & FontFlags.Symbolic);
      const nonsymbolic = Boolean(props.flags & FontFlags.Nonsymbolic);
      if (props.type === 'TrueType' && symbolic && nonsymbolic && props.differences.size) {
        props.flags &= ~FontFlags.Symbolic;
        symbolic = false;
      }
      let encoding = ENCODINGS.StandardEncoding;
      if (props.type === 'TrueType' && !nonsymbolic) encoding = ENCODINGS.WinAnsiEncoding;
      if (symbolic || isSymbolsFontName) {
        encoding = ENCODINGS.MacRomanEncoding;
        if (nonEmbedded) {
          if (/Symbol/i.test(props.name)) encoding = ENCODINGS.SymbolSetEncoding;
          else if (/Dingbats/i.test(props.name)) encoding = ENCODINGS.ZapfDingbatsEncoding;
          else if (/Wingdings/i.test(props.name)) encoding = ENCODINGS.WinAnsiEncoding;
        }
      }
      props.defaultEncoding = encoding;
    }
    props.baseEncodingName = baseEncodingName;
    props.hasEncoding = Boolean(baseEncodingName) || props.differences.size > 0;

    // ToUnicode. A predefined CMap named here that isn't available can't be used, nor the font.
    if (toUnicodeObj instanceof Name && !/^Identity-[HV]$/.test(toUnicodeObj.name)) loadCMap(toUnicodeObj, true);
    let included = null;
    try {
      const cmap = toUnicodeObj ? loadCMap(toUnicodeObj) : null;
      if (cmap) included = toUnicodeMap(cmap);
      else if (toUnicodeObj instanceof Name && /^Identity-[HV]$/.test(toUnicodeObj.name)) included = { identity: true, map: new Map() };
    } catch {
      included = null;
    }
    props.hasIncludedToUnicodeMap = Boolean(included && (included.identity || included.map.size));
    let cidToGidBytes = null;
    if (props.composite) {
      try {
        const map = dict.get('CIDToGIDMap');
        if (map instanceof Stream) cidToGidBytes = streamBytes(map);
      } catch {
        cidToGidBytes = null;
      }
    }
    if (props.hasIncludedToUnicodeMap) {
      if (!props.composite && props.hasEncoding) props.fallbackToUnicode = simpleFontToUnicode(props);
      props.toUnicode = included.identity ? identityToUnicode(0, 0xffff) : mapToUnicode(included.map);
    } else if (!props.composite) props.toUnicode = mapToUnicode(simpleFontToUnicode(props));
    else {
      // Text for the CJK registries' CIDs comes from Adobe's UCS2 CMaps, which aren't included yet.
      const info = props.cidSystemInfo;
      if (info?.registry === 'Adobe' && ['GB1', 'CNS1', 'Japan1', 'Korea1'].includes(info.ordering)) throw new MissingCMapError(`${info.registry}-${info.ordering}-UCS2 isn't available`);
      props.toUnicode = identityToUnicode(props.firstChar, props.lastChar);
    }
    if (cidToGidBytes) props.cidToGidMap = readCidToGidMap(cidToGidBytes, props.toUnicode);
    // (CJK registries' predefined UCS2 CMaps aren't included yet.)
  }

  // pdf.js's fallbackToSystemFont, as far as text goes: a composite TrueType font named after a
  // standard one, with codes that are glyph indexes, reads them in the standard fonts' glyph order.
  fallbackToSystemFont(props) {
    const name = props.name;
    let fontName = normalizeFontName(name);
    const isStandard = Boolean(STD_FONT_MAP[fontName]);
    const isMapped = Boolean(NON_STD_FONT_MAP[fontName] && STD_FONT_MAP[NON_STD_FONT_MAP[fontName]]);
    fontName = STD_FONT_MAP[fontName] || NON_STD_FONT_MAP[fontName] || fontName;
    let shown = props.toUnicode;
    if ((isStandard || isMapped) && props.type === 'CIDFontType2' && (props.cidEncoding || '').startsWith('Identity-')) {
      const map = new Map();
      const apply = (m) => {
        for (const [code, u] of m) map.set(code, u);
      };
      if (/Trebuchet/i.test(name)) {
        apply(glyphMap('macOrdered'));
        apply(glyphMap('trebuchet'));
      } else {
        apply(glyphMap('standard'));
        if (/Arial-?Black/i.test(name)) apply(glyphMap('arialBlack'));
        else if (/Calibri/i.test(name)) apply(glyphMap('calibri'));
      }
      const cidToGid = props.cidToGidMap;
      if (cidToGid) {
        for (const [code, cid] of map) if (cidToGid.has(cid)) map.set(code, cidToGid.get(cid));
        if (cidToGid.size !== props.toUnicode.size && props.hasIncludedToUnicodeMap && props.toUnicode.identity) {
          for (const [code, cid] of map) if (!cidToGid.has(cid) && props.toUnicode.has(code)) map.delete(code);
        }
      }
      if (!props.toUnicode.identity) for (const [code, u] of props.toUnicode.map) map.set(code, u);
      shown = mapToUnicode(new Map(map));
    }
    amendFallbackToUnicode(props);
    this.toUnicodeShown = shown;
  }

  extractWidths(doc, dict, descriptor, props) {
    let widths = [];
    let defaultWidth = 0;
    const vmetrics = [];
    let defaultVMetrics;
    if (props.composite) {
      const dw = dict.get('DW');
      defaultWidth = typeof dw === 'number' ? Math.ceil(dw) : 1000;
      const w = dict.get('W');
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length; i++) {
          let start = doc.fetchIfRef(w[i++]);
          if (!Number.isInteger(start)) break;
          const code = doc.fetchIfRef(w[i]);
          if (Array.isArray(code)) {
            for (const c of code) {
              const width = doc.fetchIfRef(c);
              if (typeof width === 'number') widths[start] = width;
              start++;
            }
          } else if (Number.isInteger(code)) {
            const width = doc.fetchIfRef(w[++i]);
            if (typeof width !== 'number') continue;
            for (let j = start; j <= code; j++) widths[j] = width;
          } else break;
        }
      }
      if (props.vertical) {
        const dw2 = numberArray(doc, dict.get('DW2'));
        let vm = dw2?.length === 2 && dw2.every((v) => typeof v === 'number') ? dw2 : [880, -1000];
        defaultVMetrics = [vm[1], defaultWidth * 0.5, vm[0]];
        vm = dict.get('W2');
        if (Array.isArray(vm)) {
          for (let i = 0; i < vm.length; i++) {
            let start = doc.fetchIfRef(vm[i++]);
            if (!Number.isInteger(start)) break;
            const code = doc.fetchIfRef(vm[i]);
            if (Array.isArray(code)) {
              for (let j = 0; j < code.length; j++) {
                const m = [doc.fetchIfRef(code[j++]), doc.fetchIfRef(code[j++]), doc.fetchIfRef(code[j])];
                if (m.every((v) => typeof v === 'number')) vmetrics[start] = m;
                start++;
              }
            } else if (Number.isInteger(code)) {
              const m = [doc.fetchIfRef(vm[++i]), doc.fetchIfRef(vm[++i]), doc.fetchIfRef(vm[++i])];
              if (!m.every((v) => typeof v === 'number')) continue;
              for (let j = start; j <= code; j++) vmetrics[j] = m;
            } else break;
          }
        }
      }
    } else {
      const w = dict.get('Widths');
      if (Array.isArray(w)) {
        let j = props.firstChar;
        for (const v of w) {
          const width = doc.fetchIfRef(v);
          if (typeof width === 'number') widths[j] = width;
          j++;
        }
        const missing = descriptor.get('MissingWidth');
        defaultWidth = typeof missing === 'number' ? missing : 0;
      } else {
        const base = dict.get('BaseFont');
        if (base instanceof Name) {
          const metrics = baseFontMetrics(base.name);
          widths = charCodeToWidth(metrics.widths, props.differences, props.defaultEncoding);
          defaultWidth = metrics.defaultWidth;
        }
      }
    }
    props.widths = widths;
    props.defaultWidth = defaultWidth;
    props.vmetrics = vmetrics;
    props.defaultVMetrics = defaultVMetrics;
  }

  charToGlyph(charcode) {
    let glyph = this.glyphCache.get(charcode);
    if (glyph) return glyph;
    let widthCode = charcode;
    if (this.cMap?.contains(charcode)) {
      widthCode = this.cMap.lookup(charcode);
      if (typeof widthCode === 'string') widthCode = cidFromString(charcode, widthCode);
    }
    let width = this.widths[widthCode];
    if (typeof width !== 'number') width = this.defaultWidth;
    let vmetric = this.vmetrics?.[widthCode];
    if (!vmetric && this.defaultVMetrics) {
      const [w1y, , vy] = this.defaultVMetrics;
      vmetric = [w1y, width * 0.5, vy];
    }
    let unicode = this.toUnicode.get(charcode) || charcode;
    if (typeof unicode === 'number') unicode = String.fromCharCode(unicode);
    if (this.missingFile && this.props.type === 'Type1') {
      const glyphName = this.differences.get(charcode) || this.defaultEncoding[charcode];
      if (glyphName === '') {
        width ||= this.spaceWidth();
        if (!this.toUnicode.has(charcode)) unicode = ' ';
      }
    }
    glyph = { originalCharCode: charcode, unicode, width, vmetric, category: category(unicode) };
    this.glyphCache.set(charcode, glyph);
    return glyph;
  }

  spaceWidth() {
    if (this._spaceWidth !== undefined) return this._spaceWidth;
    let width = 0;
    const map = glyphsUnicode();
    for (const name of ['space', 'minus', 'one', 'i', 'I']) {
      const unicode = map[name];
      let code = 0;
      if (this.composite && this.cMap.contains(unicode)) {
        code = this.cMap.lookup(unicode);
        if (typeof code === 'string') code = cidFromString(unicode, code);
      }
      // A number, as pdf.js gives it: entries that are text never match it.
      if (!code && this.toUnicode) code = this.toUnicode.charCodeOf(unicode);
      if (code <= 0) code = unicode;
      width = this.widths[code];
      if (width) break;
    }
    this._spaceWidth = width || this.defaultWidth;
    return this._spaceWidth;
  }

  // The glyphs a string shows, its codes read by the CMap for a composite font.
  glyphs(chars) {
    let glyphs = this.charsCache.get(chars);
    if (glyphs) return glyphs;
    glyphs = [];
    if (this.cMap) {
      for (let i = 0; i < chars.length; ) {
        const { charcode, length } = this.cMap.readCharCode(chars, i);
        i += length;
        glyphs.push(this.charToGlyph(charcode));
      }
    } else for (let i = 0; i < chars.length; i++) glyphs.push(this.charToGlyph(chars.charCodeAt(i)));
    this.charsCache.set(chars, glyphs);
    return glyphs;
  }
}

function cidFromString(code, str) {
  // A multi-byte CID given as a string: its bytes as a number.
  let v = 0;
  for (let i = 0; i < str.length; i++) v = (v << 8) | str.charCodeAt(i);
  return v || code;
}

// pdf.js's _simpleFontToUnicode: each code's text from its glyph name, with the usual fallbacks.
function simpleFontToUnicode(props, forceGlyphs = false) {
  const toUnicode = new Map();
  const encoding = props.defaultEncoding.slice();
  for (const [code, glyphName] of props.differences) {
    if (glyphName === '.notdef') continue;
    encoding[code] = glyphName;
  }
  const map = glyphsUnicode();
  for (const key in encoding) {
    let glyphName = encoding[key];
    if (glyphName === '' || glyphName === undefined) continue;
    let unicode = map[glyphName];
    if (unicode !== undefined) {
      toUnicode.set(+key, String.fromCharCode(unicode));
      continue;
    }
    let code = 0;
    switch (glyphName[0]) {
      case 'G':
        if (glyphName.length === 3) code = parseInt(glyphName.substring(1), 16);
        break;
      case 'g':
        if (glyphName.length === 5) code = parseInt(glyphName.substring(1), 16);
        break;
      case 'C':
      case 'c':
        if (glyphName.length >= 3 && glyphName.length <= 4) {
          const codeStr = glyphName.substring(1);
          if (forceGlyphs) {
            code = parseInt(codeStr, 16);
            break;
          }
          code = +codeStr;
          if (Number.isNaN(code) && Number.isInteger(parseInt(codeStr, 16))) return simpleFontToUnicode(props, true);
        }
        break;
      case 'u':
        unicode = unicodeForGlyph(glyphName, map);
        if (unicode !== -1) code = unicode;
        break;
      default:
        if (glyphName === 'f_h' || glyphName === 'f_t' || glyphName === 'T_h') {
          toUnicode.set(+key, glyphName.replaceAll('_', ''));
          continue;
        }
    }
    if (code > 0 && code <= 0x10ffff && Number.isInteger(code)) {
      if (props.baseEncodingName && code === +key) {
        const base = getEncoding(props.baseEncodingName);
        if (base && (glyphName = base[key])) {
          toUnicode.set(+key, String.fromCharCode(map[glyphName]));
          continue;
        }
      }
      toUnicode.set(+key, String.fromCodePoint(code));
    }
  }
  return toUnicode;
}

// pdf.js's amendFallbackToUnicode: codes ToUnicode leaves out take their glyph names' text.
function amendFallbackToUnicode(props) {
  if (!props.fallbackToUnicode || props.toUnicode.identity) return;
  for (const [code, text] of props.fallbackToUnicode) if (!props.toUnicode.has(code)) props.toUnicode.map.set(code, text);
}

function readCidToGidMap(bytes, toUnicode) {
  const map = new Map();
  for (let j = 0; j < bytes.length; j++) {
    const gid = (bytes[j++] << 8) | bytes[j];
    const code = j >> 1;
    if (gid === 0 && !toUnicode.has(code)) continue;
    map.set(code, gid);
  }
  return map;
}

function mapToUnicode(map) {
  return {
    identity: false,
    map,
    get size() {
      return map.size;
    },
    amend(more) {
      for (const [code, text] of more) map.set(code, text);
    },
    get: (code) => map.get(code),
    has: (code) => map.has(code),
    charCodeOf(value) {
      for (const [code, v] of map) if (v === value) return code;
      return -1;
    },
  };
}

function identityToUnicode(first, last) {
  return {
    identity: true,
    map: new Map(),
    size: last + 1 - first,
    get: (code) => (code >= first && code <= last ? String.fromCharCode(code) : undefined),
    has: (code) => code >= first && code <= last,
    charCodeOf: (v) => (Number.isInteger(v) && v >= first && v <= last ? v : -1),
    amend() {},
  };
}

// Whitespace, zero-width marks and invisible format characters, as pdf.js tells them apart.
const SPECIAL = /^(\s)|(\p{Mn})|(\p{Cf})$/u;
const categories = new Map();
function category(char) {
  let c = categories.get(char);
  if (c) return c;
  const groups = char.match(SPECIAL);
  c = { isWhitespace: Boolean(groups?.[1]), isZeroWidthDiacritic: Boolean(groups?.[2]), isInvisibleFormatMark: Boolean(groups?.[3]) };
  categories.set(char, c);
  return c;
}

export { NON_STD_FONT_MAP };
