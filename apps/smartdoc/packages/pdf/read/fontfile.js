// What an embedded font program changes about a font's text and widths. A font with no ToUnicode
// takes its text from its glyph names, and the program can name its glyphs itself: a Type 1 or
// CFF font's built-in encoding, a symbolic TrueType font's Windows names. Its FontMatrix scales its
// widths. A program too damaged to use is set aside, and the font is read as one not embedded.
// The rules are pdf.js's (its Font constructor, convert, checkAndRepair and the adjust* functions),
// so text comes out as it does there.

import { parseCFF } from './cff.js';
import { ENCODINGS, glyphsUnicode } from './data.js';
import { unicodeForGlyph } from './encodings.js';
import { checkTrueType, isCollectionFile, isOpenTypeFile, isTrueTypeFile, readNameTable, readSfnt } from './sfnt.js';
import { parseType1, type1Width } from './type1.js';

const isType1File = (b) => (b[0] === 0x25 && b[1] === 0x21) || (b[0] === 0x80 && b[1] === 0x01);
const isCFFFile = (b) => b[0] >= 1 && b[3] >= 1 && b[3] <= 4;

// The font program's kind, from its first bytes, or the font dictionary's word for it.
export function fontFileType(bytes, { type, subtype, composite }) {
  if (isTrueTypeFile(bytes) || isCollectionFile(bytes)) return [composite ? 'CIDFontType2' : 'TrueType'];
  if (isOpenTypeFile(bytes)) return [composite ? 'CIDFontType2' : 'OpenType'];
  if (isType1File(bytes)) return [composite ? 'CIDFontType0' : type === 'MMType1' ? 'MMType1' : 'Type1'];
  if (isCFFFile(bytes)) return composite ? ['CIDFontType0', 'CIDFontType0C'] : [type === 'MMType1' ? 'MMType1' : 'Type1', 'Type1C'];
  return [type, subtype];
}

// Reads `bytes` (the decoded FontFile) into `props`, amending its toUnicode, fontMatrix and widths;
// returns the parsed program, or throws if it can't be used.
export function applyFontProgram(bytes, props, unicode) {
  const [type, subtype] = fontFileType(bytes, props);
  let program;
  switch (type) {
    case 'MMType1':
    case 'Type1':
    case 'CIDFontType0':
      program = subtype === 'Type1C' || subtype === 'CIDFontType0C' ? readCFF(bytes, props) : readType1(bytes, props);
      convert(props, unicode);
      break;
    case 'OpenType':
    case 'TrueType':
    case 'CIDFontType2':
      program = readTrueType(bytes, props, unicode);
      break;
    default:
      throw new Error(`Font ${type} is not supported`);
  }
  adjustWidths(props);
  return program;
}

function readCFF(bytes, props) {
  const cff = parseCFF(bytes);
  props.fontMatrix = cff.fontMatrix;
  if (cff.builtInEncoding) props.builtInEncoding = cff.builtInEncoding;
  return { kind: 'cff', cff };
}

function readType1(bytes, props) {
  const font = parseType1(bytes, props);
  if (font.fontMatrix) props.fontMatrix = font.fontMatrix;
  if (font.encoding) props.builtInEncoding = font.encoding;
  // Codes the PDF gives no width take the glyph's own, from its charstring.
  if (props.builtInEncoding) {
    for (const { name, encoded } of font.charstrings) {
      const index = props.builtInEncoding.indexOf(name);
      if (index > -1 && props.widths[index] === undefined && index >= props.firstChar && index <= props.lastChar) props.widths[index] = type1Width(encoded, font.subrs);
    }
  }
  return { kind: 'type1', type1: font };
}

function readTrueType(bytes, props, unicode) {
  const sfnt = readSfnt(bytes, props.name);
  const { tables } = sfnt;
  if (tables['CFF ']) {
    let parsed = null;
    try {
      parsed = parseCFF(tables['CFF '].data);
      props.fontMatrix = parsed.fontMatrix;
    } catch {
      parsed = null;
    }
    if ((sfnt.version === 'OTTO' && (!props.composite || (props.fontFileN === 'FontFile3' && parsed?.isCID))) || !tables.head || !tables.hhea || !tables.maxp || !tables.post) {
      const program = readCFF(tables['CFF '].data, props);
      convert(props, unicode);
      return program;
    }
    if (!tables.maxp) throw new Error('Required "maxp" table is not found');
  } else checkTrueType(sfnt);
  if (tables.name && !props.composite) {
    const [, records] = readNameTable(tables.name);
    adjustTrueTypeToUnicode(props, records, unicode);
  }
  return { kind: 'sfnt', sfnt };
}

function convert(props, unicode) {
  if (props.builtInEncoding) adjustType1ToUnicode(props, props.builtInEncoding, unicode);
}

function adjustWidths(props) {
  if (!props.fontMatrix || props.fontMatrix[0] === 0.001) return;
  const scale = 0.001 / props.fontMatrix[0];
  for (const code in props.widths) props.widths[code] *= scale;
  props.defaultWidth *= scale;
}

// A symbolic TrueType font named only in Windows Unicode reads its codes as WinAnsiEncoding.
function adjustTrueTypeToUnicode(props, records, unicode) {
  if (props.hasIncludedToUnicodeMap || props.hasEncoding || unicode.identity) return;
  if (!(props.flags & 4) || records.length === 0) return;
  if (props.defaultEncoding === ENCODINGS.WinAnsiEncoding) return;
  if (!records.every((r) => r.platform === 3 && r.encoding === 1 && r.language === 0x409)) return;
  const map = glyphsUnicode();
  const amend = new Map();
  ENCODINGS.WinAnsiEncoding.forEach((name, code) => {
    if (name === '') return;
    const u = map[name];
    if (u !== undefined) amend.set(code, String.fromCharCode(u));
  });
  unicode.amend(amend);
}

// A Type 1 or CFF font's built-in encoding names the glyphs of codes the PDF doesn't.
function adjustType1ToUnicode(props, builtInEncoding, unicode) {
  if (props.hasIncludedToUnicodeMap || builtInEncoding === props.defaultEncoding || unicode.identity) return;
  const amend = new Map();
  for (const code in builtInEncoding) {
    if (props.hasEncoding && (props.baseEncodingName || props.differences.has(+code))) continue;
    const u = unicodeForGlyph(builtInEncoding[code]);
    if (u !== -1) amend.set(+code, String.fromCharCode(u));
  }
  unicode.amend(amend);
}
