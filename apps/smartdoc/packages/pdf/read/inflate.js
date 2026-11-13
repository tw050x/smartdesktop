// Inflate (RFC 1951), and the zlib wrapper round it (RFC 1950), on plain byte arrays, so reading a
// PDF works the same in Node and in the app's window with nothing else. A damaged or cut-off stream
// gives what was decoded before the damage, as PDF readers do, rather than nothing. Data that runs
// out where a block would start just ends; damage anywhere else marks the result `damaged`, with
// `complete` the length its whole blocks made, as pdf.js keeps only those (and gives up on a
// ToUnicode or font with any damage). Like pdf.js, a repeat or distance going too far is cut short
// or reads zeros rather than counting as damage.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// A Huffman table as a lookup on the next `bits` bits (read least significant first, codes
// reversed to match): each entry is symbol << 4 | code length.
function table(lengths) {
  let bits = 0;
  for (const l of lengths) if (l > bits) bits = l;
  const lookup = new Int32Array(1 << Math.max(bits, 1)).fill(-1);
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let l = 1; l < 16; l++) {
    code = (code + count[l - 1]) << 1;
    next[l] = code;
  }
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const l = lengths[symbol];
    if (!l) continue;
    let c = next[l]++;
    let reversed = 0;
    for (let i = 0; i < l; i++) {
      reversed = (reversed << 1) | (c & 1);
      c >>= 1;
    }
    for (let at = reversed; at < lookup.length; at += 1 << l) lookup[at] = (symbol << 4) | l;
  }
  return { lookup, bits };
}

let FIXED = null;
function fixedTables() {
  if (!FIXED) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144);
    lit.fill(9, 144, 256);
    lit.fill(7, 256, 280);
    lit.fill(8, 280, 288);
    FIXED = { lit: table(lit), dist: table(new Uint8Array(30).fill(5)) };
  }
  return FIXED;
}

// Raw deflate data from `start`; `expected` sizes the first buffer.
export function inflateRaw(data, start = 0, expected = 0) {
  let out = new Uint8Array(Math.max(1024, expected || data.length * 4));
  let size = 0;
  let pos = start;
  let bitBuf = 0;
  let bitCount = 0;
  const end = data.length;

  const need = (n) => {
    while (bitCount < n) {
      if (pos >= end) throw new RangeError('end');
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
  };
  const bits = (n) => {
    if (!n) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };
  const decode = ({ lookup, bits: width }) => {
    // Fill as many bits as there are, up to the table's width: a code near the end can be shorter.
    while (bitCount < width && pos < end) {
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const entry = lookup[bitBuf & ((1 << width) - 1)];
    const length = entry & 15;
    if (entry < 0 || length > bitCount) throw new RangeError('bad code');
    bitBuf >>>= length;
    bitCount -= length;
    return entry >> 4;
  };
  const grow = (n) => {
    if (size + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, size + n));
    bigger.set(out.subarray(0, size));
    out = bigger;
  };

  const available = () => bitCount + (end - pos) * 8;
  let complete = 0;
  let damaged = false;
  try {
    let last = 0;
    while (!last) {
      if (available() < 3) break; // the data ends where a block would start
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0;
        bitCount = 0;
        if (pos + 4 > end) break;
        const len = data[pos] | (data[pos + 1] << 8);
        const nlen = data[pos + 2] | (data[pos + 3] << 8);
        if (nlen !== (~len & 0xffff) && (len !== 0 || nlen !== 0)) throw new RangeError('bad stored length');
        pos += 4;
        const n = Math.min(len, end - pos);
        grow(n);
        out.set(data.subarray(pos, pos + n), size);
        size += n;
        pos += n;
        complete = size;
        if (n < len) break;
        continue;
      }
      let lit;
      let dist;
      if (type === 1) ({ lit, dist } = fixedTables());
      else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) codeLengths[ORDER[i]] = bits(3);
        const codes = table(codeLengths);
        const lengths = new Uint8Array(hlit + hdist);
        let len = 0;
        for (let i = 0; i < hlit + hdist; ) {
          const symbol = decode(codes);
          if (symbol < 16) {
            lengths[i++] = len = symbol;
            continue;
          }
          let repeat;
          let value = 0;
          if (symbol === 16) {
            value = len;
            repeat = 3 + bits(2);
          } else if (symbol === 17) {
            len = 0;
            repeat = 3 + bits(3);
          } else {
            len = 0;
            repeat = 11 + bits(7);
          }
          const stop = Math.min(lengths.length, i + repeat);
          lengths.fill(value, i, stop);
          i += repeat;
        }
        lit = table(lengths.subarray(0, hlit));
        dist = table(lengths.subarray(hlit));
      } else throw new RangeError('bad block');

      for (;;) {
        const symbol = decode(lit);
        if (symbol < 256) {
          grow(1);
          out[size++] = symbol;
        } else if (symbol === 256) {
          complete = size;
          break;
        } else {
          const li = Math.min(symbol - 257, 28);
          const length = LENGTH_BASE[li] + bits(symbol - 257 >= 29 ? 0 : LENGTH_EXTRA[li]);
          const di = decode(dist);
          const distance = di < 30 ? DIST_BASE[di] + bits(DIST_EXTRA[di]) : 0;
          grow(length);
          for (let i = 0; i < length; i++, size++) out[size] = distance > 0 && distance <= size ? out[size - distance] : 0;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Damaged or cut short: keep what came before, and say so.
    damaged = true;
  }
  const result = out.subarray(0, size);
  if (damaged) {
    result.damaged = true;
    result.complete = complete;
  }
  return result;
}

// zlib data (a two-byte header, then deflate); data without a valid header is taken as raw
// deflate, as some PDF writers leave it out.
export function inflate(data, expected = 0) {
  const zlib = data.length >= 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0;
  return inflateRaw(data, zlib ? 2 : 0, expected);
}
