// JBIG2 decoding (JBIG2Decode; ITU-T T.88), for scanned pages: the embedded stream's segments (and
// the JBIG2Globals stream's), composed onto a page. Generic regions (arithmetic with templates 0 to
// 3, adaptive template pixels and typical prediction, or MMR), generic refinement regions, symbol
// dictionaries and text regions (arithmetic or Huffman, with refinement and aggregation), pattern
// dictionaries and halftone regions, page striping, the standard Huffman tables and custom ones.
// Gives packed 1-bit rows, most significant bit first, 0 black (PDF's sense; JBIG2's 1 is black).

import { decodeCCITT } from './ccitt.js';

class Jbig2Error extends Error {}

// --- The MQ arithmetic decoder (Annex E) -------------------------------------------------------

// [Qe, NMPS, NLPS, SWITCH] for each state (Table E.1).
const QE = [
  [0x5601, 1, 1, 1], [0x3401, 2, 6, 0], [0x1801, 3, 9, 0], [0x0ac1, 4, 12, 0], [0x0521, 5, 29, 0], [0x0221, 38, 33, 0],
  [0x5601, 7, 6, 1], [0x5401, 8, 14, 0], [0x4801, 9, 14, 0], [0x3801, 10, 14, 0], [0x3001, 11, 17, 0], [0x2401, 12, 18, 0],
  [0x1c01, 13, 20, 0], [0x1601, 29, 21, 0], [0x5601, 15, 14, 1], [0x5401, 16, 14, 0], [0x5101, 17, 15, 0], [0x4801, 18, 16, 0],
  [0x3801, 19, 17, 0], [0x3401, 20, 18, 0], [0x3001, 21, 19, 0], [0x2801, 22, 19, 0], [0x2401, 23, 20, 0], [0x2201, 24, 21, 0],
  [0x1c01, 25, 22, 0], [0x1801, 26, 23, 0], [0x1601, 27, 24, 0], [0x1401, 28, 25, 0], [0x1201, 29, 26, 0], [0x1101, 30, 27, 0],
  [0x0ac1, 31, 28, 0], [0x09c1, 32, 29, 0], [0x08a1, 33, 30, 0], [0x0521, 34, 31, 0], [0x0441, 35, 32, 0], [0x02a1, 36, 33, 0],
  [0x0221, 37, 34, 0], [0x0141, 38, 35, 0], [0x0111, 39, 36, 0], [0x0085, 40, 37, 0], [0x0049, 41, 38, 0], [0x0025, 42, 39, 0],
  [0x0015, 43, 40, 0], [0x0009, 44, 41, 0], [0x0005, 45, 42, 0], [0x0001, 45, 43, 0], [0x5601, 46, 46, 0],
];

export class ArithmeticDecoder {
  constructor(data, start, end) {
    this.data = data;
    this.bp = start;
    this.end = end;
    this.chigh = data[start] ?? 0xff;
    this.clow = 0;
    this.byteIn();
    this.chigh = ((this.chigh << 7) & 0xffff) | ((this.clow >> 9) & 0x7f);
    this.clow = (this.clow << 7) & 0xffff;
    this.ct -= 7;
    this.a = 0x8000;
  }
  byteIn() {
    const d = this.data;
    let bp = this.bp;
    if (d[bp] === 0xff) {
      if ((d[bp + 1] ?? 0xff) > 0x8f) {
        this.clow += 0xff00;
        this.ct = 8;
      } else {
        bp++;
        this.clow += d[bp] << 9;
        this.ct = 7;
        this.bp = bp;
      }
    } else {
      bp++;
      // Past the end (a stripped trailing 0xFF 0xAC), ones are fed in.
      this.clow += bp < this.end ? d[bp] << 8 : 0xff00;
      this.ct = 8;
      this.bp = bp;
    }
    if (this.clow > 0xffff) {
      this.chigh += this.clow >> 16;
      this.clow &= 0xffff;
    }
  }
  // A bit in context `pos` of `cx` (a Uint8Array of states, each index << 1 | MPS).
  readBit(cx, pos) {
    let index = cx[pos] >> 1;
    let mps = cx[pos] & 1;
    const [qe, nmps, nlps, sw] = QE[index];
    let d;
    let a = this.a - qe;
    if (this.chigh < qe) {
      if (a < qe) {
        a = qe;
        d = mps;
        index = nmps;
      } else {
        a = qe;
        d = 1 ^ mps;
        if (sw === 1) mps = d;
        index = nlps;
      }
    } else {
      this.chigh -= qe;
      if ((a & 0x8000) !== 0) {
        this.a = a;
        return mps;
      }
      if (a < qe) {
        d = 1 ^ mps;
        if (sw === 1) mps = d;
        index = nlps;
      } else {
        d = mps;
        index = nmps;
      }
    }
    do {
      if (this.ct === 0) this.byteIn();
      a <<= 1;
      this.chigh = ((this.chigh << 1) & 0xffff) | ((this.clow >> 15) & 1);
      this.clow = (this.clow << 1) & 0xffff;
      this.ct--;
    } while ((a & 0x8000) === 0);
    this.a = a;
    cx[pos] = (index << 1) | mps;
    return d;
  }
}

// The decoding state a segment's arithmetic decoding shares: the decoder and its contexts.
class Context {
  constructor(data, start, end) {
    this.decoder = new ArithmeticDecoder(data, start, end);
    this.contexts = new Map();
  }
  get(name, size = 512) {
    let c = this.contexts.get(name);
    if (!c) {
      c = new Uint8Array(size);
      this.contexts.set(name, c);
    }
    return c;
  }
}

// Integer arithmetic decoding (A.2): null for out-of-band.
function decodeInteger(ctx, name) {
  const cx = ctx.get(name);
  const dec = ctx.decoder;
  let prev = 1;
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bit = dec.readBit(cx, prev);
      prev = prev < 256 ? (prev << 1) | bit : (((prev << 1) | bit) & 511) | 256;
      v = v * 2 + bit;
    }
    return v;
  };
  const sign = bits(1);
  const value = bits(1) ? (bits(1) ? (bits(1) ? (bits(1) ? (bits(1) ? bits(32) + 4436 : bits(12) + 340) : bits(8) + 84) : bits(6) + 20) : bits(4) + 4) : bits(2);
  if (sign === 0) return value;
  if (value > 0) return -value;
  return null;
}

// Symbol ID decoding (A.3).
function decodeIAID(ctx, codeLength) {
  const cx = ctx.get('IAID', 1 << (codeLength + 1));
  let prev = 1;
  for (let i = 0; i < codeLength; i++) prev = (prev << 1) | ctx.decoder.readBit(cx, prev);
  return codeLength < 31 ? prev & ((1 << codeLength) - 1) : prev & 0x7fffffff;
}

// --- Bitmaps ------------------------------------------------------------------------------------

const bitmap = (width, height, fill = 0) => {
  const rows = [];
  for (let i = 0; i < height; i++) rows.push(new Uint8Array(width).fill(fill));
  rows.width = width;
  return rows;
};
const widthOf = (b) => b.width ?? (b[0]?.length ?? 0);

// Generic region templates (6.2.5.3): the fixed pixels, as (x, y).
const TEMPLATES = [
  [[-1, -2], [0, -2], [1, -2], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [-4, 0], [-3, 0], [-2, 0], [-1, 0]],
  [[-1, -2], [0, -2], [1, -2], [2, -2], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [-3, 0], [-2, 0], [-1, 0]],
  [[-1, -2], [0, -2], [1, -2], [-2, -1], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0]],
  [[-3, -1], [-2, -1], [-1, -1], [0, -1], [1, -1], [-4, 0], [-3, 0], [-2, 0], [-1, 0]],
];
// The context of typical prediction's pseudo-pixel, for each template.
const SLTP_CONTEXT = [0x9b25, 0x0795, 0x00e5, 0x0195];

// Generic region decoding (6.2), arithmetic or MMR. `at` the adaptive pixels; `skip` a bitmap of
// pixels not to decode (halftone's HSKIP).
function decodeGeneric(mmr, width, height, template, prediction, skip, at, ctx, mmrInput) {
  if (mmr) return decodeMMR(mmrInput, width, height).bitmap;
  const tpl = [...TEMPLATES[template], ...at.map(({ x, y }) => [x, y])];
  // The context's bits in the order pdf.js (and the spec's pseudo-pixel values) take them: by row,
  // then column.
  tpl.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const n = tpl.length;
  const tx = tpl.map((p) => p[0]);
  const ty = tpl.map((p) => p[1]);
  const cx = ctx.get('GB', 1 << 16);
  const dec = ctx.decoder;
  const out = bitmap(width, height);
  let ltp = 0;
  for (let y = 0; y < height; y++) {
    if (prediction) {
      ltp ^= dec.readBit(cx, SLTP_CONTEXT[template]);
      if (ltp) {
        if (y > 0) out[y].set(out[y - 1]);
        continue;
      }
    }
    const row = out[y];
    for (let x = 0; x < width; x++) {
      if (skip && skip[y][x]) continue;
      let label = 0;
      for (let k = 0; k < n; k++) {
        const yy = y + ty[k];
        const xx = x + tx[k];
        const bit = yy < 0 || xx < 0 || xx >= width ? 0 : out[yy][xx];
        label = (label << 1) | bit;
      }
      row[x] = dec.readBit(cx, label);
    }
  }
  return out;
}

// Refinement templates (6.3.5.3): pixels of the bitmap being decoded and of the reference.
const REFINEMENT = [
  { coding: [[0, -1], [1, -1], [-1, 0]], reference: [[0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] },
  { coding: [[-1, -1], [0, -1], [1, -1], [-1, 0]], reference: [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1], [1, 1]] },
];
const REFINEMENT_SLTP = [0x0020, 0x0008];

// Generic refinement region decoding (6.3).
function decodeRefinement(width, height, template, reference, dx, dy, prediction, at, ctx) {
  let coding = REFINEMENT[template].coding;
  let ref = REFINEMENT[template].reference;
  if (template === 0) {
    coding = [...coding, [at[0].x, at[0].y]];
    ref = [...ref, [at[1].x, at[1].y]];
  }
  const cx = ctx.get('GR', 1 << 14);
  const dec = ctx.decoder;
  const rw = widthOf(reference);
  const rh = reference.length;
  const out = bitmap(width, height);
  const refAt = (x, y) => (y < 0 || y >= rh || x < 0 || x >= rw ? 0 : reference[y][x]);
  let ltp = 0;
  for (let y = 0; y < height; y++) {
    if (prediction) ltp ^= dec.readBit(cx, REFINEMENT_SLTP[template]);
    const row = out[y];
    for (let x = 0; x < width; x++) {
      if (ltp) {
        // Typical prediction (6.3.5.6): where the reference's 3×3 is all one colour, so is this.
        const rx = x - dx;
        const ry = y - dy;
        const v = refAt(rx, ry);
        let same = true;
        for (let j = -1; j <= 1 && same; j++) for (let i = -1; i <= 1 && same; i++) if (refAt(rx + i, ry + j) !== v) same = false;
        if (same) {
          row[x] = v;
          continue;
        }
      }
      let label = 0;
      for (const [cxo, cyo] of coding) {
        const yy = y + cyo;
        const xx = x + cxo;
        label = (label << 1) | (yy < 0 || xx < 0 || xx >= width ? 0 : out[yy][xx]);
      }
      for (const [rxo, ryo] of ref) label = (label << 1) | refAt(x + rxo - dx, y + ryo - dy);
      row[x] = dec.readBit(cx, label);
    }
  }
  return out;
}

// MMR (T.6), as in generic regions and Huffman-coded collective bitmaps: { bitmap, bytes used }.
function decodeMMR(input, width, height) {
  const data = input.data.subarray(input.pos, input.end);
  const params = { get: (k) => ({ K: -1, Columns: width, Rows: height, BlackIs1: true, EndOfBlock: true })[k] };
  const r = decodeCCITT(data, params, width, height);
  const rowBytes = (width + 7) >> 3;
  const out = bitmap(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y][x] = (r.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
  input.pos += Math.ceil((r.bitsUsed ?? data.length * 8) / 8);
  return { bitmap: out };
}

// --- Huffman tables (Annex B) ---------------------------------------------------------------------

// A table from its lines: [rangeLow, prefixLength, rangeLength], with { lower: true } for the
// lower range line (values RANGELOW - n), { upper: true } for the upper, and [null, prefixLength]
// for out-of-band. Codes are assigned from the prefix lengths in line order (B.3).
class HuffmanTable {
  constructor(lines) {
    this.lines = lines;
    const maxLen = Math.max(...lines.map((l) => l.prefixLength));
    const count = new Array(maxLen + 1).fill(0);
    for (const l of lines) count[l.prefixLength]++;
    count[0] = 0;
    let code = 0;
    const first = [];
    for (let len = 1; len <= maxLen; len++) {
      code = (code + count[len - 1]) << 1;
      first[len] = code;
    }
    this.codes = new Map();
    for (const l of lines) {
      if (!l.prefixLength) continue;
      l.code = first[l.prefixLength]++;
      this.codes.set(`${l.prefixLength}:${l.code}`, l);
    }
    this.maxLen = maxLen;
  }
  // A value, or null for out-of-band.
  decode(input) {
    let code = 0;
    for (let len = 1; len <= this.maxLen; len++) {
      code = (code << 1) | input.readBit();
      const l = this.codes.get(`${len}:${code}`);
      if (!l) continue;
      if (l.oob) return null;
      const n = l.rangeLength ? input.readBits(l.rangeLength) : 0;
      return l.lower ? l.rangeLow - n : l.rangeLow + n;
    }
    throw new Jbig2Error('bad Huffman code');
  }
}
const line = (rangeLow, prefixLength, rangeLength, kind) => ({ rangeLow, prefixLength, rangeLength, lower: kind === 'lower', upper: kind === 'upper', oob: kind === 'oob' });
const oob = (prefixLength) => line(0, prefixLength, 0, 'oob');
const STANDARD = [
  null,
  [line(0, 1, 4), line(16, 2, 8), line(272, 3, 16), line(65808, 3, 32, 'upper')],
  [line(0, 1, 0), line(1, 2, 0), line(2, 3, 0), line(3, 4, 3), line(11, 5, 6), line(75, 6, 32, 'upper'), oob(6)],
  [line(-256, 8, 8), line(0, 1, 0), line(1, 2, 0), line(2, 3, 0), line(3, 4, 3), line(11, 5, 6), line(-257, 8, 32, 'lower'), line(75, 7, 32, 'upper'), oob(6)],
  [line(1, 1, 0), line(2, 2, 0), line(3, 3, 0), line(4, 4, 3), line(12, 5, 6), line(76, 5, 32, 'upper')],
  [line(-255, 7, 8), line(1, 1, 0), line(2, 2, 0), line(3, 3, 0), line(4, 4, 3), line(12, 5, 6), line(-256, 7, 32, 'lower'), line(76, 6, 32, 'upper')],
  [line(-2048, 5, 10), line(-1024, 4, 9), line(-512, 4, 8), line(-256, 4, 7), line(-128, 5, 6), line(-64, 5, 5), line(-32, 4, 5), line(0, 2, 7), line(128, 3, 7), line(256, 3, 8), line(512, 4, 9), line(1024, 4, 10), line(-2049, 6, 32, 'lower'), line(2048, 6, 32, 'upper')],
  [line(-1024, 4, 9), line(-512, 3, 8), line(-256, 4, 7), line(-128, 5, 6), line(-64, 5, 5), line(-32, 4, 5), line(0, 4, 5), line(32, 5, 5), line(64, 5, 6), line(128, 4, 7), line(256, 3, 8), line(512, 3, 9), line(1024, 3, 10), line(-1025, 5, 32, 'lower'), line(2048, 5, 32, 'upper')],
  [line(-15, 8, 3), line(-7, 9, 1), line(-5, 8, 1), line(-3, 9, 0), line(-2, 7, 0), line(-1, 4, 0), line(0, 2, 1), line(2, 5, 0), line(3, 6, 0), line(4, 3, 4), line(20, 6, 1), line(22, 4, 4), line(38, 4, 5), line(70, 5, 6), line(134, 5, 7), line(262, 6, 7), line(390, 7, 8), line(646, 6, 10), line(-16, 9, 32, 'lower'), line(1670, 9, 32, 'upper'), oob(2)],
  [line(-31, 8, 4), line(-15, 9, 2), line(-11, 8, 2), line(-7, 9, 1), line(-5, 7, 1), line(-3, 4, 1), line(-1, 3, 1), line(1, 3, 1), line(3, 5, 1), line(5, 6, 1), line(7, 3, 5), line(39, 6, 2), line(43, 4, 5), line(75, 4, 6), line(139, 5, 7), line(267, 5, 8), line(523, 6, 8), line(779, 7, 9), line(1291, 6, 11), line(-32, 9, 32, 'lower'), line(3339, 9, 32, 'upper'), oob(2)],
  [line(-21, 7, 4), line(-5, 8, 0), line(-4, 7, 0), line(-3, 5, 0), line(-2, 2, 2), line(2, 5, 0), line(3, 6, 0), line(4, 7, 0), line(5, 8, 0), line(6, 2, 6), line(70, 5, 5), line(102, 6, 5), line(134, 6, 6), line(198, 6, 7), line(326, 6, 8), line(582, 6, 9), line(1094, 6, 10), line(2118, 7, 11), line(-22, 8, 32, 'lower'), line(4166, 8, 32, 'upper'), oob(2)],
  [line(1, 1, 0), line(2, 2, 1), line(4, 4, 0), line(5, 4, 1), line(7, 5, 1), line(9, 5, 2), line(13, 6, 2), line(17, 7, 2), line(21, 7, 3), line(29, 7, 4), line(45, 7, 5), line(77, 7, 6), line(141, 7, 32, 'upper')],
  [line(1, 1, 0), line(2, 2, 0), line(3, 3, 1), line(5, 5, 0), line(6, 5, 1), line(8, 6, 1), line(10, 7, 0), line(11, 7, 1), line(13, 7, 2), line(17, 7, 3), line(25, 7, 4), line(41, 8, 5), line(73, 8, 32, 'upper')],
  [line(1, 1, 0), line(2, 3, 0), line(3, 4, 0), line(4, 5, 0), line(5, 4, 1), line(7, 3, 3), line(15, 6, 1), line(17, 6, 2), line(21, 6, 3), line(29, 6, 4), line(45, 6, 5), line(77, 7, 6), line(141, 7, 32, 'upper')],
  [line(-2, 3, 0), line(-1, 3, 0), line(0, 1, 0), line(1, 3, 0), line(2, 3, 0)],
  [line(-24, 7, 4), line(-8, 6, 2), line(-4, 5, 1), line(-2, 4, 0), line(-1, 3, 0), line(0, 1, 0), line(1, 3, 0), line(2, 4, 0), line(3, 5, 1), line(5, 6, 2), line(9, 7, 4), line(-25, 7, 32, 'lower'), line(25, 7, 32, 'upper')],
];
const standardCache = [];
const standard = (n) => (standardCache[n] ??= new HuffmanTable(STANDARD[n].map((l) => ({ ...l }))));

// A custom table's segment (B.2).
function customTable(data) {
  const input = new BitInput(data, 0, data.length);
  const flags = input.readBits(8);
  const htoob = flags & 1;
  const htps = ((flags >> 1) & 7) + 1;
  const htrs = ((flags >> 4) & 7) + 1;
  const toSigned = (v) => (v > 0x7fffffff ? v - 0x100000000 : v);
  const low = toSigned(input.readBits(32));
  const high = toSigned(input.readBits(32));
  const lines = [];
  let cur = low;
  while (cur < high) {
    const prefixLength = input.readBits(htps);
    const rangeLength = input.readBits(htrs);
    lines.push(line(cur, prefixLength, rangeLength));
    cur += 2 ** rangeLength;
  }
  lines.push(line(low - 1, input.readBits(htps), 32, 'lower'));
  lines.push(line(high, input.readBits(htps), 32, 'upper'));
  if (htoob) lines.push(oob(input.readBits(htps)));
  return new HuffmanTable(lines);
}

class BitInput {
  constructor(data, start, end) {
    this.data = data;
    this.pos = start;
    this.end = end;
    this.bit = 0;
  }
  readBit() {
    if (this.pos >= this.end) throw new Jbig2Error('end of data');
    const b = (this.data[this.pos] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) {
      this.bit = 0;
      this.pos++;
    }
    return b;
  }
  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.readBit();
    return v;
  }
  byteAlign() {
    if (this.bit) {
      this.bit = 0;
      this.pos++;
    }
  }
}

// --- Symbol dictionaries and text regions -----------------------------------------------------

function decodeSymbolDictionary(seg, data, start, end, inputSymbols, tables, retained) {
  const r = new Reader(data, start);
  const flags = r.u16();
  const huffman = flags & 1;
  const refagg = (flags >> 1) & 1;
  const sel = { dh: (flags >> 2) & 3, dw: (flags >> 4) & 3, bmsize: (flags >> 6) & 1, agginst: (flags >> 7) & 1 };
  const contextUsed = (flags >> 8) & 1;
  const contextRetained = (flags >> 9) & 1;
  const template = (flags >> 10) & 3;
  const rTemplate = (flags >> 12) & 1;
  const at = [];
  if (!huffman) {
    const n = template === 0 ? 4 : 1;
    for (let i = 0; i < n; i++) at.push({ x: r.i8(), y: r.i8() });
  }
  const rat = [];
  if (refagg && rTemplate === 0) for (let i = 0; i < 2; i++) rat.push({ x: r.i8(), y: r.i8() });
  const exported = r.u32();
  const newCount = r.u32();
  let custom = 0;
  const pick = (choice, standards) => (choice === 3 ? tables[custom++] : standard(standards[choice]));
  let tDH, tDW, tBMSIZE, tAGGINST;
  if (huffman) {
    tDH = pick(sel.dh, [4, 5, null]);
    tDW = pick(sel.dw, [2, 3, null]);
    tBMSIZE = sel.bmsize ? tables[custom++] : standard(1);
    tAGGINST = sel.agginst ? tables[custom++] : standard(1);
  }
  let ctx;
  if (contextUsed && retained) {
    ctx = new Context(data, r.pos, end);
    for (const [k, v] of retained) if (k === 'GB' || k === 'GR') ctx.contexts.set(k, v.slice());
  } else ctx = new Context(data, r.pos, end);
  const input = huffman ? new BitInput(data, r.pos, end) : null;
  const total = inputSymbols.length + newCount;
  let codeLength = 0;
  while (1 << codeLength < total) codeLength++;
  const newSymbols = [];
  let height = 0;
  while (newSymbols.length < newCount) {
    const dh = huffman ? tDH.decode(input) : decodeInteger(ctx, 'IADH');
    height += dh;
    let width = 0;
    let totalWidth = 0;
    const firstSymbol = newSymbols.length;
    const widths = [];
    for (;;) {
      const dw = huffman ? tDW.decode(input) : decodeInteger(ctx, 'IADW');
      if (dw === null) break;
      width += dw;
      totalWidth += width;
      if (refagg) {
        const instances = huffman ? tAGGINST.decode(input) : decodeInteger(ctx, 'IAAI');
        let bmp;
        if (instances > 1) {
          bmp = decodeTextRegion({ huffman, refine: true, width, height, defaultPixel: 0, instances, stripSize: 1, symbols: [...inputSymbols, ...newSymbols], codeLength, transposed: 0, dsOffset: 0, corner: 1, op: 0, tables: huffman ? textTablesForAggregation(tables) : null, rTemplate, rat, ctx, input, logStrip: 0 });
        } else {
          const id = huffman ? input.readBits(codeLength) : decodeIAID(ctx, codeLength);
          const rdx = huffman ? standard(15).decode(input) : decodeInteger(ctx, 'IARDX');
          const rdy = huffman ? standard(15).decode(input) : decodeInteger(ctx, 'IARDY');
          const ref = id < inputSymbols.length ? inputSymbols[id] : newSymbols[id - inputSymbols.length];
          if (huffman) {
            const size = standard(1).decode(input);
            input.byteAlign();
            const sub = new Context(data, input.pos, input.pos + size);
            // Refinements share their contexts with the dictionary's others.
            sub.contexts = ctx.contexts;
            bmp = decodeRefinement(width, height, rTemplate, ref, rdx, rdy, false, rat, sub);
            input.pos += size;
          } else bmp = decodeRefinement(width, height, rTemplate, ref, rdx, rdy, false, rat, ctx);
        }
        newSymbols.push(bmp);
      } else if (huffman) widths.push(width);
      else newSymbols.push(decodeGeneric(false, width, height, template, false, null, at, ctx));
    }
    if (huffman && !refagg) {
      const size = tBMSIZE.decode(input);
      input.byteAlign();
      let collective;
      if (size === 0) {
        collective = bitmap(totalWidth, height);
        const rowBytes = (totalWidth + 7) >> 3;
        for (let y = 0; y < height; y++) for (let x = 0; x < totalWidth; x++) collective[y][x] = (data[input.pos + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        input.pos += rowBytes * height;
      } else {
        const sub = { data, pos: input.pos, end: input.pos + size };
        collective = decodeMMR(sub, totalWidth, height).bitmap;
        input.pos += size;
      }
      let x = 0;
      for (const w of widths) {
        const s = bitmap(w, height);
        for (let y = 0; y < height; y++) s[y].set(collective[y].subarray(x, x + w));
        newSymbols.push(s);
        x += w;
      }
      void firstSymbol;
    }
  }
  // Which symbols are exported: alternating runs of not and yes.
  const flagsOut = [];
  let current = false;
  while (flagsOut.length < total) {
    const run = huffman ? standard(1).decode(input) : decodeInteger(ctx, 'IAEX');
    if (run === null || run < 0) break;
    for (let i = 0; i < run && flagsOut.length < total; i++) flagsOut.push(current);
    current = !current;
  }
  const out = [];
  for (let i = 0; i < total; i++) if (flagsOut[i]) out.push(i < inputSymbols.length ? inputSymbols[i] : newSymbols[i - inputSymbols.length]);
  void exported;
  out.retained = contextRetained ? ctx.contexts : null;
  return out;
}

// The tables an aggregate symbol's text region uses when Huffman coded (6.5.8.2.2).
function textTablesForAggregation() {
  return { fs: standard(6), ds: standard(8), dt: standard(11), rdw: standard(15), rdh: standard(15), rdx: standard(15), rdy: standard(15), rsize: standard(1), symbolId: null };
}

// Text region decoding (6.4).
function decodeTextRegion(p) {
  const { huffman, refine, width, height, defaultPixel, instances, stripSize, symbols, codeLength, transposed, dsOffset, corner, op, tables, rTemplate, rat, ctx, input, logStrip } = p;
  // A Huffman-coded region's refinements are each arithmetic coded on their own bytes, sharing
  // one set of refinement contexts.
  const refineContexts = ctx?.contexts ?? new Map();
  const out = bitmap(width, height, defaultPixel);
  const readT = () => (huffman ? tables.dt.decode(input) : decodeInteger(ctx, 'IADT'));
  let stripT = -readT() * stripSize;
  let firstS = 0;
  let i = 0;
  const bottom = !(corner & 1);
  const right = (corner & 2) !== 0;
  while (i < instances) {
    stripT += readT() * stripSize;
    const dfs = huffman ? tables.fs.decode(input) : decodeInteger(ctx, 'IAFS');
    firstS += dfs;
    let curS = firstS;
    let first = true;
    for (;;) {
      if (!first) {
        const ds = huffman ? tables.ds.decode(input) : decodeInteger(ctx, 'IADS');
        if (ds === null) break;
        curS += ds + dsOffset;
      }
      first = false;
      const curT = stripSize > 1 ? (huffman ? input.readBits(logStrip) : decodeInteger(ctx, 'IAIT')) : 0;
      const t = stripT + curT;
      let id;
      if (huffman) id = tables.symbolId ? tables.symbolId.decode(input) : input.readBits(codeLength);
      else id = decodeIAID(ctx, codeLength);
      let sym = symbols[id];
      if (!sym) throw new Jbig2Error('symbol id out of range');
      const ri = refine ? (huffman ? input.readBit() : decodeInteger(ctx, 'IARI')) : 0;
      if (ri) {
        const rdw = huffman ? tables.rdw.decode(input) : decodeInteger(ctx, 'IARDW');
        const rdh = huffman ? tables.rdh.decode(input) : decodeInteger(ctx, 'IARDH');
        const rdx = huffman ? tables.rdx.decode(input) : decodeInteger(ctx, 'IARDX');
        const rdy = huffman ? tables.rdy.decode(input) : decodeInteger(ctx, 'IARDY');
        const w = widthOf(sym) + rdw;
        const h = sym.length + rdh;
        const dx = Math.floor(rdw / 2) + rdx;
        const dy = Math.floor(rdh / 2) + rdy;
        if (huffman) {
          const size = tables.rsize.decode(input);
          input.byteAlign();
          const sub = new Context(input.data, input.pos, input.pos + size);
          sub.contexts = refineContexts;
          sym = decodeRefinement(w, h, rTemplate, sym, dx, dy, false, rat, sub);
          input.pos += size;
        } else sym = decodeRefinement(w, h, rTemplate, sym, dx, dy, false, rat, ctx);
      }
      const wi = widthOf(sym);
      const hi = sym.length;
      // The symbol's place (6.4.5 step 3c): the reference corner at (CURS, T), transposed or not.
      if (!transposed && right) curS += wi - 1;
      if (transposed && bottom) curS += hi - 1;
      let x;
      let y;
      if (!transposed) {
        x = curS - (right ? wi - 1 : 0);
        y = t - (bottom ? hi - 1 : 0);
      } else {
        x = t - (right ? wi - 1 : 0);
        y = curS - (bottom ? hi - 1 : 0);
      }
      compose(out, sym, x, y, op);
      if (!transposed && !right) curS += wi - 1;
      if (transposed && !bottom) curS += hi - 1;
      // The strip goes on until its out-of-band code, even after the last instance (6.4.5 4c).
      i++;
    }
  }
  return out;
}

// Draws `src` onto `dst` at (x, y) with a combination operator: 0 OR, 1 AND, 2 XOR, 3 XNOR,
// 4 REPLACE.
function compose(dst, src, x, y, op) {
  const dw = widthOf(dst);
  const sw = widthOf(src);
  for (let j = 0; j < src.length; j++) {
    const row = dst[y + j];
    if (!row) continue;
    const s = src[j];
    for (let i = 0; i < sw; i++) {
      const xx = x + i;
      if (xx < 0 || xx >= dw) continue;
      const v = s[i];
      switch (op) {
        case 0:
          row[xx] |= v;
          break;
        case 1:
          row[xx] &= v;
          break;
        case 2:
          row[xx] ^= v;
          break;
        case 3:
          row[xx] = (row[xx] ^ v) ^ 1;
          break;
        default:
          row[xx] = v;
      }
    }
  }
}

// --- Patterns and halftones -----------------------------------------------------------------------

function decodePatternDictionary(data, start, end) {
  const r = new Reader(data, start);
  const flags = r.u8();
  const mmr = flags & 1;
  const template = (flags >> 1) & 3;
  const pw = r.u8();
  const ph = r.u8();
  const grayMax = r.u32();
  const width = (grayMax + 1) * pw;
  const at = [{ x: -pw, y: 0 }];
  if (template === 0) at.push({ x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 });
  const collective = decodeGeneric(mmr, width, ph, template, false, null, at, mmr ? null : new Context(data, r.pos, end), { data, pos: r.pos, end });
  const patterns = [];
  for (let g = 0; g <= grayMax; g++) {
    const p = bitmap(pw, ph);
    for (let y = 0; y < ph; y++) p[y].set(collective[y].subarray(g * pw, (g + 1) * pw));
    patterns.push(p);
  }
  return patterns;
}

function decodeHalftone(data, start, end, info, patterns) {
  const r = new Reader(data, start);
  const flags = r.u8();
  const mmr = flags & 1;
  const template = (flags >> 1) & 3;
  const enableSkip = (flags >> 3) & 1;
  const op = (flags >> 4) & 7;
  const defPixel = (flags >> 7) & 1;
  const gw = r.u32();
  const gh = r.u32();
  const gx = r.i32();
  const gy = r.i32();
  const rx = r.u16();
  const ry = r.u16();
  const out = bitmap(info.width, info.height, defPixel);
  if (!patterns.length) return out;
  const pw = widthOf(patterns[0]);
  const ph = patterns[0].length;
  let skip = null;
  if (enableSkip) {
    skip = bitmap(gw, gh);
    for (let m = 0; m < gh; m++) {
      for (let n = 0; n < gw; n++) {
        const x = (gx + m * ry + n * rx) >> 8;
        const y = (gy + m * rx - n * ry) >> 8;
        if (x + pw <= 0 || x >= info.width || y + ph <= 0 || y >= info.height) skip[m][n] = 1;
      }
    }
  }
  let bpp = 0;
  while (1 << bpp < patterns.length) bpp++;
  const at = [{ x: template <= 1 ? 3 : 2, y: -1 }];
  if (template === 0) at.push({ x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 });
  const ctx = mmr ? null : new Context(data, r.pos, end);
  const mmrInput = { data, pos: r.pos, end };
  const planes = [];
  for (let j = bpp - 1; j >= 0; j--) planes[j] = decodeGeneric(mmr, gw, gh, template, false, skip, at, ctx, mmrInput);
  // Gray code to binary (C.5).
  for (let j = bpp - 2; j >= 0; j--) for (let m = 0; m < gh; m++) for (let n = 0; n < gw; n++) planes[j][m][n] ^= planes[j + 1][m][n];
  for (let m = 0; m < gh; m++) {
    for (let n = 0; n < gw; n++) {
      if (skip && skip[m][n]) continue;
      let v = 0;
      for (let j = 0; j < bpp; j++) v |= planes[j][m][n] << j;
      const p = patterns[Math.min(v, patterns.length - 1)];
      const x = (gx + m * ry + n * rx) >> 8;
      const y = (gy + m * rx - n * ry) >> 8;
      compose(out, p, x, y, op);
    }
  }
  return out;
}

// --- Segments and the page ------------------------------------------------------------------------

class Reader {
  constructor(data, pos) {
    this.data = data;
    this.pos = pos;
  }
  u8() {
    return this.data[this.pos++] ?? 0;
  }
  i8() {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  i32() {
    return (this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8();
  }
}

// The segments of `data` (embedded organisation): { number, type, refs, page, start, end }.
function readSegments(data) {
  const segments = [];
  let pos = 0;
  // A file header, which an embedded stream shouldn't have but some do.
  if (data[0] === 0x97 && data[1] === 0x4a && data[2] === 0x42 && data[3] === 0x32) {
    const flags = data[8];
    pos = 9 + (flags & 2 ? 0 : 4);
  }
  while (pos + 11 <= data.length) {
    const r = new Reader(data, pos);
    const number = r.u32();
    const flags = r.u8();
    const type = flags & 63;
    const pageAssoc4 = (flags >> 6) & 1;
    let refByte = r.u8();
    let refCount = refByte >> 5;
    if (refCount === 7) {
      r.pos--;
      refCount = r.u32() & 0x1fffffff;
      r.pos += Math.ceil((refCount + 1) / 8);
    } else if (refCount > 4) throw new Jbig2Error('bad referred-to segment count');
    const refSize = number <= 256 ? 1 : number <= 65536 ? 2 : 4;
    const refs = [];
    for (let i = 0; i < refCount; i++) refs.push(refSize === 1 ? r.u8() : refSize === 2 ? r.u16() : r.u32());
    const page = pageAssoc4 ? r.u32() : r.u8();
    let length = r.u32();
    const start = r.pos;
    if (length === 0xffffffff) {
      // An immediate generic region of unknown length: it ends at its end marker and row count.
      if (type === 38) {
        const mmr = data[start + 17] & 1;
        let i = start + 18;
        for (; i + 5 < data.length; i++) {
          if (mmr ? data[i] === 0 && data[i + 1] === 0 : data[i] === 0xff && data[i + 1] === 0xac) break;
        }
        length = i + 6 - start;
      } else throw new Jbig2Error('segment of unknown length');
    }
    segments.push({ number, type, refs, page, start, end: Math.min(data.length, start + length) });
    pos = start + length;
    if (type === 51) break; // end of file
  }
  return segments;
}

function regionInfo(r) {
  const info = { width: r.u32(), height: r.u32(), x: r.i32(), y: r.i32() };
  info.op = r.u8() & 7;
  return info;
}

export function decodeJBIG2(data, globals, pdfWidth, pdfHeight) {
  const segments = [...(globals ? readSegments(globals).map((s) => ({ ...s, data: globals })) : []), ...readSegments(data).map((s) => ({ ...s, data }))];
  const results = new Map();
  let page = null;
  let pageInfo = null;
  for (const seg of segments) {
    const d = seg.data;
    try {
      const r = new Reader(d, seg.start);
      switch (seg.type) {
        case 48: {
          // Page information.
          const w = r.u32();
          const h = r.u32();
          r.u32();
          r.u32();
          const flags = r.u8();
          r.u16(); // striping
          pageInfo = { width: w, height: h, defaultPixel: (flags >> 2) & 1, op: (flags >> 3) & 3 };
          const width = w > 0 && w < 0xffffffff ? w : pdfWidth;
          const height = h > 0 && h < 0xffffffff ? h : pdfHeight;
          page = bitmap(width, height, pageInfo.defaultPixel);
          break;
        }
        case 0: {
          // Symbol dictionary.
          const input = [];
          const tables = [];
          let retained = null;
          for (const ref of seg.refs) {
            const v = results.get(ref);
            if (v?.symbols) {
              input.push(...v.symbols);
              retained = v.symbols.retained ?? retained;
            } else if (v?.table) tables.push(v.table);
          }
          results.set(seg.number, { symbols: decodeSymbolDictionary(seg, d, seg.start, seg.end, input, tables, retained) });
          break;
        }
        case 4:
        case 6:
        case 7: {
          // Text region.
          const info = regionInfo(r);
          const flags = r.u16();
          const huffman = flags & 1;
          const refine = (flags >> 1) & 1;
          const logStrip = (flags >> 2) & 3;
          const corner = (flags >> 4) & 3;
          const transposed = (flags >> 6) & 1;
          const op = (flags >> 7) & 3;
          const defaultPixel = (flags >> 9) & 1;
          let dsOffset = (flags >> 10) & 31;
          if (dsOffset > 15) dsOffset -= 32;
          const rTemplate = (flags >> 15) & 1;
          let hflags = 0;
          if (huffman) hflags = r.u16();
          const rat = [];
          if (refine && rTemplate === 0) for (let i = 0; i < 2; i++) rat.push({ x: r.i8(), y: r.i8() });
          const instances = r.u32();
          const symbols = [];
          const custom = [];
          for (const ref of seg.refs) {
            const v = results.get(ref);
            if (v?.symbols) symbols.push(...v.symbols);
            else if (v?.table) custom.push(v.table);
          }
          let codeLength = 0;
          while (1 << codeLength < symbols.length) codeLength++;
          let tables = null;
          let input = null;
          let ctx = null;
          if (huffman) {
            let c = 0;
            const pick = (choice, list) => (choice === 3 ? custom[c++] : standard(list[choice]));
            tables = {
              fs: pick(hflags & 3, [6, 7]),
              ds: pick((hflags >> 2) & 3, [8, 9, 10]),
              dt: pick((hflags >> 4) & 3, [11, 12, 13]),
              rdw: pick((hflags >> 6) & 3, [14, 15]),
              rdh: pick((hflags >> 8) & 3, [14, 15]),
              rdx: pick((hflags >> 10) & 3, [14, 15]),
              rdy: pick((hflags >> 12) & 3, [14, 15]),
              rsize: (hflags >> 14) & 1 ? custom[c++] : standard(1),
            };
            input = new BitInput(d, r.pos, seg.end);
            // The symbol ID code (7.4.3.1.7): run codes' lengths, then each symbol's code length.
            const runLines = [];
            for (let k = 0; k < 35; k++) runLines.push(line(k, input.readBits(4), 0));
            const runTable = new HuffmanTable(runLines.filter((l) => l.prefixLength));
            const lengths = [];
            while (lengths.length < symbols.length) {
              const v = runTable.decode(input);
              if (v < 32) lengths.push(v);
              else if (v === 32) {
                const n = input.readBits(2) + 3;
                const prev = lengths[lengths.length - 1] ?? 0;
                for (let k = 0; k < n; k++) lengths.push(prev);
              } else if (v === 33) {
                const n = input.readBits(3) + 3;
                for (let k = 0; k < n; k++) lengths.push(0);
              } else {
                const n = input.readBits(7) + 11;
                for (let k = 0; k < n; k++) lengths.push(0);
              }
            }
            input.byteAlign();
            const idLines = lengths.slice(0, symbols.length).map((len, k) => line(k, len, 0)).filter((l) => l.prefixLength);
            tables.symbolId = new HuffmanTable(idLines);
          } else ctx = new Context(d, r.pos, seg.end);
          const bmp = decodeTextRegion({ huffman, refine, width: info.width, height: info.height, defaultPixel, instances, stripSize: 1 << logStrip, symbols, codeLength, transposed, dsOffset, corner, op, tables, rTemplate, rat, ctx, input, logStrip });
          place(seg, info, bmp);
          break;
        }
        case 16:
          results.set(seg.number, { patterns: decodePatternDictionary(d, seg.start, seg.end) });
          break;
        case 20:
        case 22:
        case 23: {
          const info = regionInfo(r);
          const patterns = seg.refs.map((ref) => results.get(ref)?.patterns).find(Boolean) ?? [];
          place(seg, info, decodeHalftone(d, r.pos, seg.end, info, patterns));
          break;
        }
        case 36:
        case 38:
        case 39: {
          // Generic region.
          const info = regionInfo(r);
          const flags = r.u8();
          const mmr = flags & 1;
          const template = (flags >> 1) & 3;
          const prediction = (flags >> 3) & 1;
          const at = [];
          if (!mmr) {
            const n = template === 0 ? 4 : 1;
            for (let i = 0; i < n; i++) at.push({ x: r.i8(), y: r.i8() });
          }
          let height = info.height;
          let end = seg.end;
          // Unknown height: the row count after the end marker.
          if (info.height === 0xffffffff) {
            height = (d[end - 4] << 24) | (d[end - 3] << 16) | (d[end - 2] << 8) | d[end - 1];
            end -= 6;
            info.height = height;
          }
          const bmp = decodeGeneric(mmr, info.width, height, template, prediction, null, at, mmr ? null : new Context(d, r.pos, end), { data: d, pos: r.pos, end });
          place(seg, info, bmp);
          break;
        }
        case 40:
        case 42:
        case 43: {
          // Generic refinement region.
          const info = regionInfo(r);
          const flags = r.u8();
          const template = flags & 1;
          const prediction = (flags >> 1) & 1;
          const at = [];
          if (template === 0) for (let i = 0; i < 2; i++) at.push({ x: r.i8(), y: r.i8() });
          let reference = seg.refs.map((ref) => results.get(ref)?.region).find(Boolean);
          if (!reference && page) {
            reference = bitmap(info.width, info.height);
            for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) reference[y][x] = page[info.y + y]?.[info.x + x] ?? 0;
          }
          if (!reference) break;
          const bmp = decodeRefinement(info.width, info.height, template, reference, 0, 0, prediction, at, new Context(d, r.pos, seg.end));
          place(seg, info, bmp);
          break;
        }
        case 50: {
          // End of stripe: the page grows to it when its height wasn't known.
          const y = r.u32();
          if (page && pageInfo?.height === 0xffffffff && y + 1 > page.length) {
            const w = widthOf(page);
            while (page.length < y + 1) page.push(new Uint8Array(w).fill(pageInfo.defaultPixel));
          }
          break;
        }
        case 53:
          results.set(seg.number, { table: customTable(d.subarray(seg.start, seg.end)) });
          break;
        default:
          break;
      }
    } catch (e) {
      if (!(e instanceof Jbig2Error) && !(e instanceof RangeError) && !(e instanceof TypeError)) throw e;
      // A damaged segment is left out.
    }
  }

  function place(seg, info, bmp) {
    // Intermediate regions (types 4, 20, 36, 40) are kept for refinement, not drawn.
    if ([4, 20, 36, 40].includes(seg.type)) {
      results.set(seg.number, { region: bmp });
      return;
    }
    if (!page) return;
    const ph = page.length;
    if (pageInfo?.height === 0xffffffff && info.y + bmp.length > ph) {
      const w = widthOf(page);
      while (page.length < info.y + bmp.length) page.push(new Uint8Array(w).fill(pageInfo.defaultPixel));
    }
    compose(page, bmp, info.x, info.y, info.op);
  }

  const width = pdfWidth || (page ? widthOf(page) : 0);
  const height = pdfHeight || (page ? page.length : 0);
  const rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * height).fill(0xff);
  if (page) {
    for (let y = 0; y < height; y++) {
      const row = page[y];
      if (!row) continue;
      for (let x = 0; x < width && x < row.length; x++) if (row[x]) out[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return out;
}
