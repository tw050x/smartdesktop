// Reading PDF syntax: a lexer for its tokens and a parser for its objects, used for the file's own
// objects and for content streams. Forgiving, as readers have to be: stray characters are skipped,
// a malformed number reads as pdf.js reads it, and a stream whose /Length is wrong is found by its
// endstream.

import { Dict, Name, Ref, Stream } from './objects.js';

// Keywords and punctuation: one object each, compared with ===.
export class Cmd {
  static #all = new Map();
  constructor(cmd) {
    this.cmd = cmd;
  }
  static of(cmd) {
    let c = Cmd.#all.get(cmd);
    if (!c) Cmd.#all.set(cmd, (c = new Cmd(cmd)));
    return c;
  }
}
export const EOF = Symbol('EOF');
const ARRAY_START = Cmd.of('[');
const ARRAY_END = Cmd.of(']');
const DICT_START = Cmd.of('<<');
const DICT_END = Cmd.of('>>');
const R = Cmd.of('R');

// 1: whitespace, 2: delimiter, 0: regular.
const KIND = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) KIND[c] = 1;
for (const c of '()<>[]{}/%') KIND[c.charCodeAt(0)] = 2;
const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX[48 + i] = i;
for (let i = 0; i < 6; i++) HEX[65 + i] = HEX[97 + i] = 10 + i;

export class Lexer {
  constructor(bytes, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  skipSpace() {
    const b = this.bytes;
    for (;;) {
      while (this.pos < b.length && KIND[b[this.pos]] === 1) this.pos++;
      if (b[this.pos] !== 0x25) return; // %: a comment to the end of the line
      while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
    }
  }

  next() {
    this.skipSpace();
    const b = this.bytes;
    if (this.pos >= b.length) return EOF;
    const c = b[this.pos];
    switch (c) {
      case 0x28: // (
        return this.literalString();
      case 0x2f: // /
        return this.name();
      case 0x5b: // [
        this.pos++;
        return ARRAY_START;
      case 0x5d: // ]
        this.pos++;
        return ARRAY_END;
      case 0x7b: // {
      case 0x7d: // }
        this.pos++;
        return Cmd.of(String.fromCharCode(c));
      case 0x3c: // <
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return DICT_START;
        }
        return this.hexString();
      case 0x3e: // >
        this.pos += b[this.pos + 1] === 0x3e ? 2 : 1;
        return DICT_END;
      case 0x29: // ) on its own: skip it
        this.pos++;
        return this.next();
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) return this.number();
    const start = this.pos;
    const known = this.knownCommands;
    while (this.pos < b.length && KIND[b[this.pos]] === 0) this.pos++;
    // pdf.js gives up on a content stream at a word of 128 characters or more.
    if (known && this.pos - start > 128) throw new this.TooLong(`Command token too long: ${this.pos - start}`);
    if (known && known[latin1(b, start, this.pos)] === undefined) {
      // In content streams, operators run together ("ETBT") are told apart, as pdf.js does: a word
      // stops where it's an operator and going on would make it one no longer.
      this.pos = start;
      let word = String.fromCharCode(b[this.pos++]);
      let found = known[word] !== undefined;
      while (this.pos < b.length && KIND[b[this.pos]] === 0) {
        const longer = word + String.fromCharCode(b[this.pos]);
        if (found && known[longer] === undefined) break;
        word = longer;
        found = known[word] !== undefined;
        this.pos++;
      }
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      return Cmd.of(word);
    }
    const word = latin1(b, start, this.pos);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return Cmd.of(word);
  }

  // A number as pdf.js reads one (its Lexer.getNumber), so values come out to the same bits: the
  // digits as a whole number, divided once for a decimal point. A second "-" or "+" at the start
  // counts as one; a "-" inside is passed over; a second point ends the number, and what follows
  // is the next token.
  number() {
    const b = this.bytes;
    let ch = b[this.pos];
    let sign = 1;
    let divideBy = 0;
    if (ch === 0x2d) {
      sign = -1;
      ch = b[++this.pos];
      if (ch === 0x2d) ch = b[++this.pos];
    } else if (ch === 0x2b) ch = b[++this.pos];
    while (ch === 0x0a || ch === 0x0d) ch = b[++this.pos];
    if (ch === 0x2e) {
      divideBy = 10;
      ch = b[++this.pos];
    }
    if (!(ch >= 0x30 && ch <= 0x39)) {
      // Not a number after all: as pdf.js, 0 (and anything but space or a delimiter skipped).
      if (ch !== undefined && KIND[ch] === 0) this.pos++;
      return 0;
    }
    let value = ch - 0x30;
    for (;;) {
      ch = b[++this.pos];
      if (ch >= 0x30 && ch <= 0x39) {
        if (divideBy !== 0) divideBy *= 10;
        value = value * 10 + (ch - 0x30);
      } else if (ch === 0x2e) {
        if (divideBy === 0) divideBy = 1;
        else break;
      } else if (ch !== 0x2d) break;
    }
    if (divideBy !== 0) value /= divideBy;
    return sign * value;
  }

  name() {
    const b = this.bytes;
    this.pos++;
    let s = '';
    while (this.pos < b.length && KIND[b[this.pos]] === 0) {
      const c = b[this.pos++];
      if (c === 0x23 && HEX[b[this.pos]] >= 0 && HEX[b[this.pos + 1]] >= 0) {
        s += String.fromCharCode((HEX[b[this.pos]] << 4) | HEX[b[this.pos + 1]]);
        this.pos += 2;
      } else s += String.fromCharCode(c);
    }
    return Name.of(utf8Name(s));
  }

  literalString() {
    const b = this.bytes;
    this.pos++;
    let depth = 1;
    const out = [];
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      else if (c === 0x5c) {
        c = b[this.pos++];
        switch (c) {
          case 0x6e: c = 10; break; // n
          case 0x72: c = 13; break; // r
          case 0x74: c = 9; break; // t
          case 0x62: c = 8; break; // b
          case 0x66: c = 12; break; // f
          case 0x0d: // a line break after a backslash is nothing
            if (b[this.pos] === 0x0a) this.pos++;
            continue;
          case 0x0a:
            continue;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) v = v * 8 + b[this.pos++] - 0x30;
              c = v & 0xff;
            }
        }
      }
      out.push(c);
    }
    return fromBytes(out);
  }

  hexString() {
    const b = this.bytes;
    this.pos++;
    const out = [];
    let high = -1;
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const v = HEX[b[this.pos++]];
      if (v < 0) continue;
      if (high < 0) high = v;
      else {
        out.push((high << 4) | v);
        high = -1;
      }
    }
    this.pos++;
    if (high >= 0) out.push(high << 4);
    return fromBytes(out);
  }
}

// Names are bytes, usually UTF-8.
function utf8Name(s) {
  if (!/[\x80-\xff]/.test(s)) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

export function latin1(bytes, start = 0, end = bytes.length) {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)));
  return s;
}

function fromBytes(list) {
  let s = '';
  for (let i = 0; i < list.length; i += 8192) s += String.fromCharCode.apply(null, list.slice(i, i + 8192));
  return s;
}

// Objects from a lexer. `doc` (optional) resolves an indirect /Length and is given to each Dict, so
// its get() follows references; `decrypt(value, ref)` is applied to strings and streams of the
// indirect object `ref` being read.
export class Parser {
  constructor(lexer, { doc = null, allowStreams = true } = {}) {
    this.lexer = lexer;
    this.doc = doc;
    this.allowStreams = allowStreams;
    this.ahead = [];
  }

  token() {
    return this.ahead.length ? this.ahead.shift() : this.lexer.next();
  }
  peek(n = 0) {
    while (this.ahead.length <= n) this.ahead.push(this.lexer.next());
    return this.ahead[n];
  }

  // The next object; `ref` is the indirect object it belongs to (for decryption).
  object(ref = null) {
    const t = this.token();
    if (t === ARRAY_START) {
      const list = [];
      for (;;) {
        const p = this.peek();
        if (p === ARRAY_END) {
          this.token();
          break;
        }
        if (p === EOF || p === DICT_END) break;
        list.push(this.object(ref));
      }
      return list;
    }
    if (t === DICT_START) {
      const dict = new Dict(this.doc);
      for (;;) {
        const k = this.peek();
        if (k === DICT_END) {
          this.token();
          break;
        }
        if (k === EOF) break;
        this.token();
        if (!(k instanceof Name)) continue; // a stray value where a key should be: skip it
        const v = this.peek();
        if (v === DICT_END) {
          dict.set(k.name, null);
          continue;
        }
        dict.set(k.name, this.object(ref));
      }
      if (this.allowStreams && this.peek() === Cmd.of('stream')) return this.stream(dict, ref);
      return dict;
    }
    if (typeof t === 'number' && Number.isInteger(t) && t >= 0) {
      // A reference: two whole numbers and R.
      const g = this.peek();
      if (typeof g === 'number' && Number.isInteger(g) && g >= 0 && this.peek(1) === R) {
        this.token();
        this.token();
        return new Ref(t, g);
      }
      return t;
    }
    if (typeof t === 'string' && ref && this.doc?.decryptString) return this.doc.decryptString(t, ref);
    return t;
  }

  stream(dict, ref) {
    // The ahead buffer holds just the 'stream' keyword: the data starts after its end of line.
    this.ahead = [];
    const lexer = this.lexer;
    const b = lexer.bytes;
    let start = lexer.pos;
    if (b[start] === 0x0d) start++;
    if (b[start] === 0x0a) start++;
    let length = dict.raw('Length');
    if (length instanceof Ref) {
      try {
        length = this.doc?.fetch(length);
      } catch {
        length = null;
      }
    }
    let end = Number.isInteger(length) && length >= 0 ? start + length : -1;
    if (end < 0 || end > b.length || !endstreamAt(b, end)) {
      const found = findEndstream(b, start);
      end = found < 0 ? b.length : found;
      // Drop the end of line before endstream.
      if (b[end - 1] === 0x0a) end--;
      if (b[end - 1] === 0x0d) end--;
    }
    lexer.pos = end;
    // Skip to after endstream.
    const after = indexOf(b, ENDSTREAM, end, Math.min(b.length, end + 64));
    if (after >= 0) lexer.pos = after + ENDSTREAM.length;
    const stream = new Stream(dict, b.subarray(start, end));
    if (ref) stream.ref = ref;
    return stream;
  }
}

const ENDSTREAM = Uint8Array.from('endstream', (c) => c.charCodeAt(0));

function endstreamAt(b, at) {
  let i = at;
  while (i < b.length && i < at + 16 && KIND[b[i]] === 1) i++;
  for (let j = 0; j < ENDSTREAM.length; j++) if (b[i + j] !== ENDSTREAM[j]) return false;
  return true;
}

function findEndstream(b, from) {
  return indexOf(b, ENDSTREAM, from, b.length);
}

export function indexOf(b, needle, from = 0, to = b.length) {
  const first = needle[0];
  outer: for (let i = from; i <= to - needle.length; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function lastIndexOf(b, needle, from = b.length - needle.length, to = 0) {
  outer: for (let i = Math.min(from, b.length - needle.length); i >= to; i--) {
    for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
