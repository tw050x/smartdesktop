// Text, ready to lay out: a run's characters as glyphs in its font (falling back to another font for
// characters it has no glyph for, as Word and LibreOffice do), each with its advance in points, the
// run's letter spacing, pair kerning and horizontal scale applied, and where a line may break after
// it. Breaks follow the rules Word and LibreOffice share for the scripts this handles: after spaces
// and hyphens and dashes, at a soft hyphen (which then shows), between ideographs, never at a
// no-break space or hyphen.
import { fallbackFor, findFont, sameFamilyWith } from './fonts.js';

// A run's look: { family, bold, italic, size (pt), spacing (pt added after each character), kern
// (apply pair kerning), scale (horizontal, 1 = 100%), caps, smallCaps }.
const fontCache = new Map();
export function fontFor(style) {
  const key = `${style.family}|${Boolean(style.bold)}|${Boolean(style.italic)}`;
  if (!fontCache.has(key)) {
    fontCache.set(key, findFont(style.family, { bold: style.bold, italic: style.italic }) ?? findFont('Liberation Sans', { bold: style.bold, italic: style.italic }));
  }
  return fontCache.get(key);
}

const SPACE = new Set([0x20, 0x3000, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a]);
const NO_BREAK = new Set([0xa0, 0x202f, 0x2007, 0x2011, 0xfeff, 0x2060]);
const HYPHENS = new Set([0x2d, 0x2010, 0x2012, 0x2013, 0x2014, 0x2e3a, 0x2e3b]);
// Characters no line may start with (closing punctuation and the like), and none may end with.
const NO_START = new Set([...')]}»›’”,.:;!?%‰、。，．：；！？）］｝〉》」』】〕〗〙〛ヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎゕゖㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ々〻'].map((c) => c.codePointAt(0)));
const NO_END = new Set([...'([{«‹‘“（［｛〈《「『【〔〖〘〚'].map((c) => c.codePointAt(0)));
const ideograph = (c) => (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x2fa1f);
const letterOrDigit = (c) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(c));

export const isSpace = (c) => SPACE.has(c);

// The text a symbol font's character stands for, for copying and searching (the PDF's ToUnicode),
// as Word gives it: Word's symbol codes (U+F020–U+F0FF) in Symbol as what Symbol draws there (its
// own encoding: Greek, maths, the bullet), in any other symbol font (Wingdings) as the Latin-1
// character of that code.
const SYMBOL = {
  0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2a: '∗', 0x2d: '−', 0x40: '≅', 0x5c: '∴', 0x5e: '⊥', 0x60: '‾', 0x7e: '∼',
  0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞', 0xa6: 'ƒ', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠',
  0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓', 0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×',
  0xb5: '∝', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xbf: '↵', 0xc0: 'ℵ',
  0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆',
  0xce: '∈', 0xcf: '∉', 0xd0: '∠', 0xd1: '∇', 0xd2: '®', 0xd3: '©', 0xd4: '™', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅',
  0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓', 0xe0: '◊', 0xe1: '〈',
  0xe5: '∑', 0xf1: '〉', 0xf2: '∫',
};
const GREEK = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';
function symbolText(family, code) {
  if (family?.toLowerCase() !== 'symbol') return String.fromCharCode(code);
  if (SYMBOL[code]) return SYMBOL[code];
  if (code >= 0x41 && code <= 0x5a) return GREEK[code - 0x41];
  if (code >= 0x61 && code <= 0x7a) return code === 0x6a ? 'φ' : code === 0x76 ? 'ϖ' : GREEK[code - 0x61].toLowerCase();
  return String.fromCharCode(code);
}

// What a symbol font's character looks like, where no font here has Word's code for it (Office's
// Symbol isn't on a Mac without Office, nor any on Linux): Symbol's as its own meaning, Wingdings'
// commonest bullets as their Unicode look-alikes. And the room Office's fonts give a line (their
// Windows ascent and descent, in 2048ths), so the line stands as tall as Word makes it.
const WINGDINGS = { 0x6c: '●', 0x6e: '■', 0x6f: '□', 0x71: '❑', 0x75: '◆', 0x76: '❖', 0xa7: '▪', 0xa8: '◻', 0xd8: '➢', 0xfb: '✗', 0xfc: '✓', 0xfe: '☑' };
const OFFICE_METRICS = { symbol: { ascent: 2059, descent: 450 }, wingdings: { ascent: 1841, descent: 432 } };
function symbolLook(family, code) {
  const name = family?.toLowerCase();
  if (name === 'symbol') return symbolText(family, code);
  if (name === 'wingdings' && WINGDINGS[code]) return WINGDINGS[code];
  return null;
}
function officeMetrics(family) {
  const m = OFFICE_METRICS[family?.toLowerCase()];
  return m && { unitsPerEm: 2048, ascent: m.ascent, descent: m.descent, metrics: {} };
}

// Upper case for caps and small caps, as Word shows them.
const upper = (text) => text.toLocaleUpperCase();

// The run's glyphs: [{ text, cp, gid, font, size, advance, space, breakAfter, softHyphen }], with
// `missing` set where no font on the Mac has a glyph (it shows as the font's empty box).
export function shape(text, style, { report = null } = {}) {
  const found = fontFor(style);
  const glyphs = [];
  if (!found) return glyphs;
  if (!found.exact && report) report.substitute(style.family, found.name);
  const cps = [...(style.caps || style.smallCaps ? text : text)].map((ch) => ch.codePointAt(0));
  const size = style.size;
  const scale = style.scale ?? 1;
  for (let i = 0; i < cps.length; i++) {
    let cp = cps[i];
    let shown = String.fromCodePoint(cp);
    let glyphSize = size;
    if (style.caps || style.smallCaps) {
      const up = upper(shown);
      // Small caps: lower-case letters as capitals at a smaller size (Word: 0.8 of the size).
      if (style.smallCaps && up !== shown) glyphSize = size * 0.8;
      shown = up;
      cp = shown.codePointAt(0);
    }
    if (cp === 0xad) {
      // A soft hyphen: nothing, unless the line breaks there.
      glyphs.push({ text: '', cp, gid: found.font.glyph(0x2d), font: found.font, size: glyphSize, advance: 0, hyphenWidth: (found.font.advance(found.font.glyph(0x2d)) / found.font.unitsPerEm) * glyphSize * scale, softHyphen: true, breakAfter: true });
      continue;
    }
    if (cp === 0x200b) {
      glyphs.push({ text: '', cp, gid: 0, font: found.font, size, advance: 0, breakAfter: true, zeroWidth: true });
      continue;
    }
    let font = found.font;
    let synthetic = found;
    let drawn = cp; // the character drawn (a look-alike for a symbol code no font here has)
    let metricsFont = null;
    if (!font.has(cp) && cp > 0x20) {
      const fallback = sameFamilyWith(style.family, cp, style) ?? fallbackFor(cp, style);
      const look = !fallback && cp >= 0xf020 && cp <= 0xf0ff ? symbolLook(style.family, cp - 0xf000) : null;
      if (fallback) {
        font = fallback.font;
        synthetic = fallback;
      } else if (look) {
        drawn = look.codePointAt(0);
        const other = font.has(drawn) ? found : fallbackFor(drawn, style);
        if (other) {
          font = other.font;
          synthetic = other;
          metricsFont = officeMetrics(style.family);
        } else if (report) report.missingGlyph(shown, style.family);
      } else if (report) report.missingGlyph(shown, style.family);
    }
    const gid = font.glyph(drawn);
    const advance = (font.advance(gid) / font.unitsPerEm) * glyphSize * scale + (style.spacing ?? 0);
    const copied = cp >= 0xf020 && cp <= 0xf0ff ? symbolText(style.family, cp - 0xf000) : shown;
    glyphs.push({ text: copied, cp, gid, font, metricsFont, size: glyphSize, advance, space: SPACE.has(cp), syntheticBold: synthetic.syntheticBold, syntheticItalic: synthetic.syntheticItalic });
  }
  // Pair kerning, within the run, between glyphs of the same font and size.
  if (style.kern) {
    for (let i = 0; i < glyphs.length - 1; i++) {
      const a = glyphs[i];
      const b = glyphs[i + 1];
      if (a.font !== b.font || a.size !== b.size || !a.gid || !b.gid) continue;
      a.advance += (a.font.kern(a.gid, b.gid) / a.font.unitsPerEm) * a.size * scale;
    }
  }
  markBreaks(glyphs);
  return glyphs;
}

// Where a line may break after each glyph (within the run; the paragraph adds breaks between runs
// with breakBetween).
function markBreaks(glyphs) {
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (g.breakAfter !== undefined && g.breakAfter) continue;
    const next = glyphs[i + 1];
    g.breakAfter = breakBetween(g.cp, next?.cp, glyphs[i - 1]?.cp);
  }
}

// Whether a line may break between characters `a` and `b` (`before` is the one before `a`).
export function breakBetween(a, b, before) {
  if (b === undefined) return false; // decided with the next run
  if (NO_BREAK.has(a) || NO_BREAK.has(b)) return false;
  if (SPACE.has(b)) return false; // spaces stay with what's before them
  if (NO_START.has(b) || NO_END.has(a)) return false;
  if (SPACE.has(a)) return true;
  if (HYPHENS.has(a)) return a === 0x2014 || a === 0x2013 ? true : before !== undefined && letterOrDigit(before) && letterOrDigit(b);
  if (ideograph(a) || ideograph(b)) return true;
  return false;
}

// Joins runs' glyphs: the last glyph of one run gets its break decided by the first of the next.
export function joinRuns(runs) {
  const all = [];
  for (const glyphs of runs) {
    if (!glyphs.length) continue;
    const last = all[all.length - 1];
    if (last && last.breakAfter === false && last.cp !== undefined && !last.softHyphen && !last.zeroWidth) {
      last.breakAfter = breakBetween(last.cp, glyphs[0].cp, all[all.length - 2]?.cp);
    }
    all.push(...glyphs);
  }
  return all;
}

// The vertical metrics of a font at a size, in points, as Word lays a line out: the font's Windows
// ascent and descent (Office's "single" line is their sum), or its typographic ones if the font
// asks for them.
export function lineMetrics(font, size) {
  const k = size / font.unitsPerEm;
  const m = font.metrics;
  const useTypo = m.fsSelection != null && m.fsSelection & 0x80 && m.typoAscent != null;
  const ascent = (useTypo ? m.typoAscent : font.ascent) * k;
  const descent = (useTypo ? -m.typoDescent : font.descent) * k;
  const gap = useTypo ? Math.max(0, m.typoLineGap) * k : 0;
  return { ascent, descent, gap, height: ascent + descent + gap };
}
