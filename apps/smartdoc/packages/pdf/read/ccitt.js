// CCITT fax decoding (CCITTFaxDecode; ITU-T T.4 and T.6): Group 3 one-dimensional (K = 0) and
// mixed (K > 0), and Group 4 (K < 0), with the PDF filter's parameters (EndOfLine,
// EncodedByteAlign, EndOfBlock, BlackIs1, Columns, Rows). Gives packed 1-bit rows, most significant
// bit first, where 1 is white unless BlackIs1. Damaged data ends the image where it's met, the rows
// after it left white.

// Run-length codes (T.4 tables 2 and 3): [code, run length].
const WHITE_TERMINATING = ['00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101', '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010', '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010', '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100'];
const WHITE_MAKEUP = ['11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101', '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001', '010011010', '011000', '010011011'];
const BLACK_TERMINATING = ['0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000', '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000', '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001', '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111', '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111'];
const BLACK_MAKEUP = ['0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100', '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100', '0000001100101'];
// Extended make-up codes, the same for both colours: 1792 to 2560.
const EXTENDED_MAKEUP = ['00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111'];

// Two-dimensional modes (T.4 table 4).
const PASS = 'P';
const HORIZONTAL = 'H';
const MODES = [['1', 0], ['011', 1], ['000011', 2], ['0000011', 3], ['010', -1], ['000010', -2], ['0000010', -3], ['0001', PASS], ['001', HORIZONTAL]];
const EOL = '000000000001';

// Code tables as maps by length, then value.
function table(entries) {
  const byLength = [];
  for (const [code, value] of entries) {
    const n = code.length;
    (byLength[n] ??= new Map()).set(parseInt(code, 2), value);
  }
  return byLength;
}
const runs = (terminating, makeup) => [...terminating.map((c, i) => [c, i]), ...makeup.map((c, i) => [c, (i + 1) * 64]), ...EXTENDED_MAKEUP.map((c, i) => [c, 1792 + i * 64])];
const WHITE = table(runs(WHITE_TERMINATING, WHITE_MAKEUP));
const BLACK = table(runs(BLACK_TERMINATING, BLACK_MAKEUP));
const MODE = table(MODES);

class Bits {
  constructor(data) {
    this.data = data;
    this.pos = 0; // in bits
  }
  get left() {
    return this.data.length * 8 - this.pos;
  }
  peek(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pos + i;
      const bit = p >> 3 < this.data.length ? (this.data[p >> 3] >> (7 - (p & 7))) & 1 : 0;
      v = (v << 1) | bit;
    }
    return v;
  }
  skip(n) {
    this.pos += n;
  }
  align() {
    this.pos = (this.pos + 7) & ~7;
  }
  // A code from `tables` (by length), or undefined.
  code(tables, max = 13) {
    for (let n = 1; n <= max; n++) {
      const t = tables[n];
      if (!t) continue;
      const v = t.get(this.peek(n));
      if (v !== undefined) {
        this.skip(n);
        return v;
      }
    }
    return undefined;
  }
  // An end-of-line (with any zero fill before it) at this point: skips it and says so.
  eol() {
    let p = this.pos;
    let zeros = 0;
    while (p - this.pos < 1024 && p < this.data.length * 8 && ((this.data[p >> 3] >> (7 - (p & 7))) & 1) === 0) {
      zeros++;
      p++;
    }
    if (zeros >= 11 && p < this.data.length * 8) {
      this.pos = p + 1;
      return true;
    }
    return false;
  }
  isEol() {
    return this.peek(12) === 1;
  }
}

class Damaged extends Error {}

// One colour's run: make-up codes until a terminating one.
function readRun(bits, white) {
  let total = 0;
  for (;;) {
    const v = bits.code(white ? WHITE : BLACK);
    if (v === undefined) throw new Damaged('bad run code');
    total += v;
    if (v < 64) return total;
  }
}

// `params` the filter's DecodeParms (a Dict or null).
export function decodeCCITT(data, params, fallbackWidth = 1728, fallbackHeight = 0) {
  const get = (k, d) => {
    const v = params?.get?.(k);
    return v === undefined || v === null ? d : v;
  };
  const K = get('K', 0);
  const endOfLine = get('EndOfLine', false) === true;
  const byteAlign = get('EncodedByteAlign', false) === true;
  const columns = get('Columns', fallbackWidth) || fallbackWidth;
  const rows = get('Rows', fallbackHeight) || fallbackHeight;
  const endOfBlock = get('EndOfBlock', true) !== false;
  const blackIs1 = get('BlackIs1', false) === true;
  const rowBytes = (columns + 7) >> 3;
  const maxRows = rows || Math.ceil((data.length * 8) / Math.max(1, columns / 64)) + 1;
  const out = [];
  const bits = new Bits(data);
  // The reference line's changing elements, ending with two past the end.
  let ref = [columns, columns];

  const putRow = (changes) => {
    const row = new Uint8Array(rowBytes);
    // 1 is white unless BlackIs1.
    let color = 0; // 0 white, 1 black
    let x = 0;
    for (const c of [...changes, columns]) {
      const end = Math.min(columns, Math.max(x, c));
      const bit = color === 1 ? (blackIs1 ? 1 : 0) : blackIs1 ? 0 : 1;
      if (bit) for (let i = x; i < end; i++) row[i >> 3] |= 0x80 >> (i & 7);
      x = end;
      color ^= 1;
    }
    out.push(row);
  };

  const decode1D = () => {
    const changes = [];
    let a0 = 0;
    let white = true;
    while (a0 < columns) {
      const run = readRun(bits, white);
      a0 = Math.min(columns, a0 + run);
      changes.push(a0);
      white = !white;
    }
    return changes;
  };

  const decode2D = () => {
    const changes = [];
    let a0 = -1;
    let color = 0;
    let guard = 0;
    while (a0 < columns) {
      if (++guard > columns * 2 + 16) throw new Damaged('runaway line');
      // b1: the first change on the reference line right of a0 to the opposite colour; b2 the next.
      const start = Math.max(a0, -1);
      let i = 0;
      while (i < ref.length && (ref[i] <= start || (i & 1) !== color)) i++;
      const b1 = ref[i] ?? columns;
      const b2 = ref[i + 1] ?? columns;
      const mode = bits.code(MODE, 7);
      if (mode === undefined) {
        if (bits.isEol()) throw new Damaged('end of line in a line');
        throw new Damaged('bad mode code');
      }
      if (mode === PASS) {
        a0 = b2;
      } else if (mode === HORIZONTAL) {
        const at = Math.max(a0, 0);
        const r1 = readRun(bits, color === 0);
        const r2 = readRun(bits, color === 1);
        const a1 = Math.min(columns, at + r1);
        const a2 = Math.min(columns, a1 + r2);
        changes.push(a1, a2);
        a0 = a2;
      } else {
        const a1 = Math.max(0, Math.min(columns, b1 + mode));
        changes.push(a1);
        a0 = a1;
        color ^= 1;
      }
    }
    return changes;
  };

  try {
    while (out.length < maxRows) {
      if (bits.left <= 0) break;
      let oneD = K === 0;
      if (K >= 0) {
        // (With EncodedByteAlign, the EOL ends on a byte boundary: the zero fill before it is
        // passed over with it.)
        const sawEol = bits.eol();
        if (!sawEol && endOfLine && out.length > 0) {
          // An EOL was promised: without one, the data is over.
          if (bits.left < 12) break;
        }
        // End of block: a run of EOLs (RTC).
        if (sawEol && endOfBlock && bits.isEol()) break;
        if (K > 0) {
          oneD = bits.peek(1) === 1;
          bits.skip(1);
        }
      } else {
        if (byteAlign) bits.align();
        if (endOfBlock && bits.isEol()) break; // EOFB
        if (bits.eol()) {
          if (endOfBlock) break;
        }
      }
      if (bits.left <= 0) break;
      const changes = oneD ? decode1D() : decode2D();
      putRow(changes);
      ref = [...changes, columns, columns];
      if (K >= 0 && byteAlign && !endOfLine) bits.align();
    }
    // A Group 4 block's end (EOFB) after its last row, passed over so what follows can be read.
    if (K < 0 && endOfBlock && bits.isEol()) {
      bits.skip(12);
      if (bits.isEol()) bits.skip(12);
    }
  } catch (e) {
    if (!(e instanceof Damaged)) throw e;
  }
  const height = rows || out.length;
  const result = new Uint8Array(rowBytes * height);
  const blank = blackIs1 ? 0 : 0xff;
  result.fill(blank);
  out.slice(0, height).forEach((row, y) => result.set(row, y * rowBytes));
  return { data: result, width: columns, height, bitsUsed: bits.pos };
}
