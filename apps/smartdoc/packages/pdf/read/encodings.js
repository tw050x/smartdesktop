// The standard encodings by name, and glyph names' code points.

import { ENCODINGS, glyphsUnicode } from './data.js';

export function getEncoding(name) {
  switch (name) {
    case 'WinAnsiEncoding':
      return ENCODINGS.WinAnsiEncoding;
    case 'StandardEncoding':
      return ENCODINGS.StandardEncoding;
    case 'MacRomanEncoding':
      return ENCODINGS.MacRomanEncoding;
    case 'SymbolSetEncoding':
      return ENCODINGS.SymbolSetEncoding;
    case 'ZapfDingbatsEncoding':
      return ENCODINGS.ZapfDingbatsEncoding;
    case 'ExpertEncoding':
      return ENCODINGS.ExpertEncoding;
    case 'MacExpertEncoding':
      return ENCODINGS.MacExpertEncoding;
    default:
      return null;
  }
}

// A glyph name's code point: from the glyph list, or uniXXXX / uXXXX[XX]; -1 if neither.
export function unicodeForGlyph(name, map = glyphsUnicode()) {
  const known = map[name];
  if (known !== undefined) return known;
  if (!name) return -1;
  if (name[0] === 'u') {
    const n = name.length;
    let hex;
    if (n === 7 && name[1] === 'n' && name[2] === 'i') hex = name.substring(3);
    else if (n >= 5 && n <= 7) hex = name.substring(1);
    else return -1;
    if (hex === hex.toUpperCase()) {
      const code = parseInt(hex, 16);
      if (code >= 0) return code;
    }
  }
  return -1;
}
