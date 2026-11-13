// Reading a Type 1 font program (Adobe Type 1 Font Format): its cleartext header (FontMatrix,
// Encoding, FontBBox), then the eexec-encrypted part (the Private dictionary, Subrs and
// CharStrings, each charstring decrypted). Charstrings stay as bytes; `type1Width` reads a glyph's
// advance from its hsbw or sbw, as text needs, and drawing reads the rest. Finding the parts
// follows pdf.js, so damaged fonts come out as other readers make them out.

import { getEncoding } from './encodings.js';

const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;
const EEXEC = [0x65, 0x65, 0x78, 0x65, 0x63];

const isWhite = (c) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isSpecial = (c) => c === 0x2f || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x28 || c === 0x29;

export function decrypt(data, key, discard) {
  if (discard >= data.length) return new Uint8Array(0);
  let r = key | 0;
  for (let i = 0; i < discard; i++) r = ((data[i] + r) * 52845 + 22719) & 0xffff;
  const out = new Uint8Array(data.length - discard);
  for (let i = discard, j = 0; j < out.length; i++, j++) {
    const v = data[i];
    out[j] = v ^ (r >> 8);
    r = ((v + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

function decryptHex(data, key, discard) {
  let r = key | 0;
  const out = new Uint8Array(data.length >>> 1);
  let j = 0;
  for (let i = 0; i < data.length; i++) {
    const d1 = data[i];
    if (!isHex(d1)) continue;
    i++;
    let d2;
    while (i < data.length && !isHex((d2 = data[i]))) i++;
    if (i < data.length) {
      const v = parseInt(String.fromCharCode(d1, d2), 16);
      out[j++] = v ^ (r >> 8);
      r = ((v + r) * 52845 + 22719) & 0xffff;
    }
  }
  return out.slice(discard, j);
}

// PostScript tokens as a Type 1 font's parts are read: names' slashes and brackets on their own.
class Tokens {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.next();
  }
  next() {
    this.ch = this.pos < this.bytes.length ? this.bytes[this.pos++] : -1;
    return this.ch;
  }
  back() {
    this.pos -= 2;
    return this.next();
  }
  take(n) {
    const end = Math.min(this.bytes.length, this.pos + Math.max(0, n));
    const out = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return out;
  }
  token() {
    let comment = false;
    let ch = this.ch;
    for (;;) {
      if (ch === -1) return null;
      if (comment) {
        if (ch === 0x0a || ch === 0x0d) comment = false;
      } else if (ch === 0x25) comment = true;
      else if (!isWhite(ch)) break;
      ch = this.next();
    }
    if (isSpecial(ch)) {
      this.next();
      return String.fromCharCode(ch);
    }
    let token = '';
    do {
      token += String.fromCharCode(ch);
      ch = this.next();
    } while (ch >= 0 && !isWhite(ch) && !isSpecial(ch));
    return token;
  }
  numbers() {
    this.token();
    const out = [];
    for (;;) {
      const t = this.token();
      if (t === null || t === ']' || t === '}') break;
      out.push(parseFloat(t || 0));
    }
    return out;
  }
  number() {
    return parseFloat(this.token() || 0);
  }
  int() {
    return parseInt(this.token() || 0, 10) | 0;
  }
}

function findEexec(bytes, from) {
  const scan = bytes.length - EEXEC.length;
  let i = from;
  while (i < scan) {
    let j = 0;
    while (j < EEXEC.length && bytes[i + j] === EEXEC[j]) j++;
    if (j >= EEXEC.length) {
      i += j;
      while (i < bytes.length && isWhite(bytes[i])) i++;
      return { found: true, length: i };
    }
    i++;
  }
  return { found: false, length: i };
}

// The cleartext part's length: Length1 if it ends just after "eexec", else found by looking.
function headerLength(bytes, start, suggested) {
  const rest = bytes.length - start;
  if (Number.isInteger(suggested) && suggested >= 0 && suggested <= rest) {
    const block = findEexec(bytes.subarray(start, start + suggested), suggested - 2 * EEXEC.length);
    if (block.found && block.length === suggested) return suggested;
  }
  let pos = start;
  for (;;) {
    const block = findEexec(bytes.subarray(pos, pos + 2048), 0);
    if (block.length === 0) break;
    pos += block.length;
    if (block.found) return pos - start;
  }
  return Number.isInteger(suggested) ? Math.max(0, Math.min(suggested, rest)) : rest;
}

// { fontMatrix, encoding, bbox, privateData, subrs, charstrings: [{ name, encoded }] }, or throws.
export function parseType1(bytes, { length1 } = {}) {
  let start = 0;
  let suggested = length1;
  const pfb = bytes[0] === 0x80 && bytes[1] === 0x01;
  if (pfb) {
    start = 6;
    suggested = bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24);
  }
  const length = headerLength(bytes, start, suggested);
  const font = { fontMatrix: null, encoding: null, bbox: null, privateData: new Map([['lenIV', 4]]), subrs: [], charstrings: [] };
  readHeader(new Tokens(bytes.subarray(start, start + length)), font);
  let eexecStart = start + length;
  if (pfb) eexecStart += 6;
  const eexec = bytes.subarray(Math.min(eexecStart, bytes.length));
  if (eexec.length === 0) throw new Error('Type 1 font has no encrypted part');
  const binary = !((isHex(eexec[0]) || isWhite(eexec[0])) && [1, 2, 3, 4, 5, 6, 7].every((i) => isHex(eexec[i])));
  readProgram(new Tokens(binary ? decrypt(eexec, EEXEC_KEY, 4) : decryptHex(eexec, EEXEC_KEY, 4)), font);
  return font;
}

function readHeader(t, font) {
  let token;
  while ((token = t.token()) !== null) {
    if (token !== '/') continue;
    switch (t.token()) {
      case 'FontMatrix':
        font.fontMatrix = t.numbers();
        break;
      case 'Encoding': {
        const arg = t.token();
        if (!/^\d+$/.test(arg)) {
          font.encoding = getEncoding(arg);
          break;
        }
        const encoding = [];
        const size = parseInt(arg, 10) | 0;
        t.token();
        for (let j = 0; j < size; j++) {
          token = t.token();
          while (token !== 'dup' && token !== 'def') {
            token = t.token();
            if (token === null) return;
          }
          if (token === 'def') break;
          const index = t.int();
          t.token();
          const glyph = t.token();
          encoding[index] = glyph;
          t.token();
        }
        font.encoding = encoding;
        break;
      }
      case 'FontBBox':
        font.bbox = t.numbers();
        break;
    }
  }
}

function readProgram(t, font) {
  const { privateData } = font;
  const charstring = (data) => {
    const lenIV = privateData.get('lenIV');
    return lenIV === -1 ? data : decrypt(data, CHARSTRING_KEY, lenIV);
  };
  let token;
  let subrsRead = false;
  let charstringsRead = false;
  while ((token = t.token()) !== null) {
    if (token !== '/') continue;
    token = t.token();
    switch (token) {
      case 'CharStrings':
        if (charstringsRead) break;
        charstringsRead = true;
        t.token();
        t.token();
        t.token();
        t.token();
        for (;;) {
          token = t.token();
          if (token === null || token === 'end') break;
          if (token !== '/') continue;
          const name = t.token();
          const length = t.int();
          t.token();
          const data = length > 0 ? t.take(length) : new Uint8Array(0);
          const encoded = charstring(data);
          t.next();
          token = t.token();
          if (token === 'noaccess') t.token();
          else if (token === '/') t.back();
          font.charstrings.push({ name, encoded });
        }
        break;
      case 'Subrs':
        if (subrsRead) break;
        subrsRead = true;
        t.int();
        t.token();
        while (t.token() === 'dup') {
          const index = t.int();
          const length = t.int();
          t.token();
          const data = length > 0 ? t.take(length) : new Uint8Array(0);
          const encoded = charstring(data);
          t.next();
          if (t.token() === 'noaccess') t.token();
          font.subrs[index] = encoded;
        }
        break;
      case 'BlueValues':
      case 'OtherBlues':
      case 'FamilyBlues':
      case 'FamilyOtherBlues':
        t.numbers();
        break;
      case 'StemSnapH':
      case 'StemSnapV':
        privateData.set(token, t.numbers());
        break;
      case 'StdHW':
      case 'StdVW':
        privateData.set(token, t.numbers()[0]);
        break;
      case 'BlueShift':
      case 'lenIV':
      case 'BlueFuzz':
      case 'BlueScale':
      case 'LanguageGroup':
        privateData.set(token, t.number());
        break;
      case 'ExpansionFactor':
        privateData.set(token, t.number() || 0.06);
        break;
      case 'ForceBold':
        privateData.set(token, t.token() === 'true' ? 1 : 0);
        break;
    }
  }
}

// A glyph's advance width: the wx of its hsbw (or sbw), running subroutines to find it. Stops at
// the first error, keeping what it found by then, as pdf.js does.
export function type1Width(encoded, subrs) {
  const state = { width: 0, stack: [], done: false };
  run(encoded, subrs, state, 0);
  return state.width;
}

function run(encoded, subrs, state, depth) {
  const { stack } = state;
  if (depth > 10) return true;
  for (let i = 0; i < encoded.length; i++) {
    let v = encoded[i];
    if (v < 32) {
      if (v === 12) v = (v << 8) + encoded[++i];
      switch (v) {
        case 10: {
          // callsubr
          if (stack.length < 1) return true;
          const n = stack.pop();
          if (!subrs[n]) return true;
          if (run(subrs[n], subrs, state, depth + 1)) return true;
          if (state.done) return false;
          break;
        }
        case 11:
          return false;
        case 13: // hsbw
          if (stack.length < 2) return true;
          state.width = stack.pop();
          state.done = true;
          return false;
        case (12 << 8) + 7: // sbw
          if (stack.length < 4) return true;
          stack.pop();
          state.width = stack.pop();
          state.done = true;
          return false;
        case (12 << 8) + 12: {
          // div
          if (stack.length < 2) return true;
          const b = stack.pop();
          const a = stack.pop();
          stack.push(a / b);
          break;
        }
        case 14:
        case (12 << 8) + 6:
          return false;
        default:
          stack.length = 0;
      }
      continue;
    }
    if (v <= 246) v -= 139;
    else if (v <= 250) v = (v - 247) * 256 + encoded[++i] + 108;
    else if (v <= 254) v = -((v - 251) * 256) - encoded[++i] - 108;
    else v = ((encoded[++i] & 0xff) << 24) | ((encoded[++i] & 0xff) << 16) | ((encoded[++i] & 0xff) << 8) | (encoded[++i] & 0xff);
    stack.push(v);
  }
  return false;
}
