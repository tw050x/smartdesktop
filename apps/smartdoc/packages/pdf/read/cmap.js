// CMaps (Adobe Technical Note #5014, PDF 32000-1 9.7.5 and 9.10.3): how a composite font's
// character codes are read (codespace ranges, one to four bytes) and which CID each is, and how a
// font's ToUnicode maps codes to text. The Identity CMaps are built in; other predefined CMaps
// (CJK encodings) aren't included yet.

import { Lexer, EOF, Cmd } from './parser.js';
import { Name, Stream } from './objects.js';
import { streamBytes, streamDamaged } from './filters.js';

const MAX_ENTRIES = 2 ** 24 - 1;

export class CMap {
  constructor() {
    this.codespaceRanges = [[], [], [], []];
    this.map = new Map();
    this.vertical = false;
    this.name = '';
    this.builtIn = false;
    this.entries = 0;
  }
  budget(n) {
    if (this.entries + n > MAX_ENTRIES) throw new Error('CMap too large');
    this.entries += n;
  }
  addCodespaceRange(n, low, high) {
    this.codespaceRanges[n - 1].push(low, high);
  }
  mapCidRange(low, high, dst) {
    this.budget(high - low + 1);
    while (low <= high) this.map.set(low++, dst++);
  }
  // A range to text: the last byte of the destination counts up, carrying into the one before.
  mapBfRange(low, high, dst) {
    this.budget(high - low + 1);
    const last = dst.length - 1;
    while (low <= high) {
      this.map.set(low++, dst);
      const next = dst.charCodeAt(last) + 1;
      if (next > 0xff) {
        dst = dst.substring(0, last - 1) + String.fromCharCode(dst.charCodeAt(last - 1) + 1) + '\x00';
        continue;
      }
      dst = dst.substring(0, last) + String.fromCharCode(next);
    }
  }
  mapBfRangeToArray(low, high, array) {
    this.budget(Math.min(high - low + 1, array.length));
    for (let i = 0; low <= high && i < array.length; ) this.map.set(low++, array[i++]);
  }
  lookup(code) {
    return this.map.get(code);
  }
  contains(code) {
    return this.map.has(code);
  }
  forEach(fn) {
    for (const [code, value] of this.map) fn(code, value);
  }
  // The code starting at `offset` in a binary string: { charcode, length }. A code in no range
  // reads as 0, one byte long.
  readCharCode(str, offset) {
    let c = 0;
    for (let n = 0; n < 4; n++) {
      c = ((c << 8) | str.charCodeAt(offset + n)) >>> 0;
      const ranges = this.codespaceRanges[n];
      for (let k = 0; k < ranges.length; k += 2) if (c >= ranges[k] && c <= ranges[k + 1]) return { charcode: c, length: n + 1 };
    }
    return { charcode: 0, length: 1 };
  }
}

// Identity-H and Identity-V: two-byte codes, each its own CID.
export class IdentityCMap extends CMap {
  constructor(vertical) {
    super();
    this.vertical = vertical;
    this.builtIn = true;
    this.name = vertical ? 'Identity-V' : 'Identity-H';
    this.addCodespaceRange(2, 0, 0xffff);
  }
  lookup(code) {
    return Number.isInteger(code) && code <= 0xffff ? code : undefined;
  }
  contains(code) {
    return Number.isInteger(code) && code <= 0xffff;
  }
  forEach(fn) {
    for (let i = 0; i <= 0xffff; i++) fn(i, i);
  }
}

const toInt = (s) => {
  let a = 0;
  for (let i = 0; i < s.length; i++) a = (a << 8) | s.charCodeAt(i);
  return a >>> 0;
};

// A predefined CMap (other than Identity) that isn't available: Adobe's CJK CMaps aren't included
// yet. pdf.js, without its CMap files (as the app runs it), can't use such a font either.
export class MissingCMapError extends Error {}

// A CMap from a name (Identity-H/V; others aren't available yet) or a stream, with the parent
// it names by usecmap. A name that isn't available gives null, or throws if `strict`.
export function loadCMap(value, strict = false) {
  if (value instanceof Name) {
    if (value.name === 'Identity-H') return new IdentityCMap(false);
    if (value.name === 'Identity-V') return new IdentityCMap(true);
    if (strict) throw new MissingCMapError(`CMap ${value.name} isn't available`);
    return null;
  }
  if (value instanceof Stream) {
    // Damaged data: pdf.js can't read the CMap at all.
    if (streamDamaged(value)) {
      if (strict) throw new Error('damaged CMap stream');
      return null;
    }
    const cmap = parseCMap(streamBytes(value));
    const wmode = value.dict.number('WMode');
    if (wmode === 1) cmap.vertical = true;
    const use = cmap.useCMap ? Name.of(cmap.useCMap) : value.dict.get('UseCMap');
    if (use) {
      const parent = loadCMap(use, strict);
      if (parent) inherit(cmap, parent);
    }
    // A copy of Adobe's Identity CMap is that CMap (as pdf.js takes it).
    if ((cmap.name === 'Identity-H' || cmap.name === 'Identity-V') && isIdentity(cmap)) return new IdentityCMap(cmap.name === 'Identity-V');
    return cmap;
  }
  return null;
}

function isIdentity(cmap) {
  if (cmap.map.size !== 0x10000) return false;
  for (let i = 0; i < 0x10000; i++) if (cmap.map.get(i) !== i) return false;
  return true;
}

function inherit(cmap, parent) {
  if (parent instanceof IdentityCMap) {
    // Codes not mapped here are their own CIDs, two bytes long.
    if (!cmap.codespaceRanges.some((r) => r.length)) cmap.addCodespaceRange(2, 0, 0xffff);
    cmap.fallback = parent;
    return;
  }
  for (let n = 0; n < 4; n++) cmap.codespaceRanges[n].push(...parent.codespaceRanges[n]);
  parent.forEach((code, value) => {
    if (!cmap.map.has(code)) cmap.map.set(code, value);
  });
  cmap.vertical ||= parent.vertical;
}

// Parses a CMap's PostScript-like source; what can be read is kept when it's malformed.
export function parseCMap(bytes) {
  const cmap = new CMap();
  const lexer = new Lexer(bytes);
  let prev = null;
  let last = null;
  const next = () => {
    prev = last;
    // Arrays are read token by token: [ and ] come back as Cmd.
    last = lexer.next();
    return last;
  };
  const isCmd = (t, name) => t instanceof Cmd && t.cmd === name;
  try {
    for (;;) {
      const t = next();
      if (t === EOF) break;
      if (t instanceof Name) {
        if (t.name === 'WMode') {
          const v = next();
          if (Number.isInteger(v)) cmap.vertical = v === 1;
        } else if (t.name === 'CMapName') {
          const v = next();
          if (v instanceof Name) cmap.name = v.name;
        }
        continue;
      }
      if (!(t instanceof Cmd)) continue;
      switch (t.cmd) {
        case 'usecmap':
          // The parent's name came just before.
          if (prev instanceof Name) cmap.useCMap = prev.name;
          break;
        case 'begincodespacerange':
          for (;;) {
            const low = next();
            if (isCmd(low, 'endcodespacerange') || low === EOF) break;
            const high = next();
            if (typeof low !== 'string' || typeof high !== 'string') break;
            cmap.addCodespaceRange(Math.min(4, Math.max(1, high.length)), toInt(low), toInt(high));
          }
          break;
        case 'beginbfchar':
          for (;;) {
            const src = next();
            if (isCmd(src, 'endbfchar') || src === EOF) break;
            let dst = next();
            if (typeof src !== 'string') break;
            if (dst instanceof Name) dst = dst.name; // a glyph name: rare, kept as it is
            if (Number.isInteger(dst)) dst = String.fromCharCode(dst);
            if (typeof dst === 'string') cmap.map.set(toInt(src), dst);
          }
          break;
        case 'beginbfrange':
          for (;;) {
            const low = next();
            if (isCmd(low, 'endbfrange') || low === EOF) break;
            const high = next();
            if (typeof low !== 'string' || typeof high !== 'string') break;
            let dst = next();
            if (Number.isInteger(dst)) dst = String.fromCharCode(dst);
            if (typeof dst === 'string') cmap.mapBfRange(toInt(low), toInt(high), dst);
            else if (isCmd(dst, '[')) {
              const array = [];
              for (let v = next(); !isCmd(v, ']') && v !== EOF; v = next()) array.push(v);
              cmap.mapBfRangeToArray(toInt(low), toInt(high), array);
            } else break;
          }
          break;
        case 'begincidchar':
          for (;;) {
            const src = next();
            if (isCmd(src, 'endcidchar') || src === EOF) break;
            const dst = next();
            if (typeof src !== 'string' || !Number.isInteger(dst)) break;
            cmap.map.set(toInt(src), dst);
          }
          break;
        case 'begincidrange':
          for (;;) {
            const low = next();
            if (isCmd(low, 'endcidrange') || low === EOF) break;
            const high = next();
            const dst = next();
            if (typeof low !== 'string' || typeof high !== 'string' || !Number.isInteger(dst)) break;
            cmap.mapCidRange(toInt(low), toInt(high), dst);
          }
          break;
      }
    }
  } catch {
    // keep what was read
  }
  return cmap;
}

// A ToUnicode CMap's entries as text: UTF-16BE, with surrogate pairs; a number as a code point.
export function toUnicodeMap(cmap) {
  const map = new Map();
  if (cmap instanceof IdentityCMap) return { identity: true, map };
  cmap.forEach((code, token) => {
    if (typeof token === 'number') {
      map.set(code, String.fromCodePoint(token));
      return;
    }
    if (token.length % 2) token = '\x00' + token;
    const chars = [];
    for (let k = 0; k < token.length; k += 2) {
      const w1 = (token.charCodeAt(k) << 8) | token.charCodeAt(k + 1);
      if ((w1 & 0xf800) !== 0xd800) {
        chars.push(w1);
        continue;
      }
      k += 2;
      const w2 = (token.charCodeAt(k) << 8) | token.charCodeAt(k + 1);
      chars.push(((w1 & 0x3ff) << 10) + (w2 & 0x3ff) + 0x10000);
    }
    map.set(code, String.fromCodePoint(...chars));
  });
  return { identity: false, map };
}
