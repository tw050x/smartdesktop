// Decoding a stream's data through its filters (PDF 32000-1 7.4): Flate and LZW (with PNG and TIFF
// predictors), ASCIIHex, ASCII85 and RunLength. Image codecs (DCT, JPX, JBIG2, CCITTFax) are left
// to the image code: decoding stops before the first of them and says which it is.

import { inflate } from './inflate.js';
import { Dict, Name, Stream } from './objects.js';

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCF']);
const ALIASES = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode' };

// A stream's filters and their parameters, in order: [{ name, params }].
export function filtersOf(stream) {
  const dict = stream.dict;
  let names = dict.get('Filter', 'F');
  let params = dict.get('DecodeParms', 'DP');
  if (!names) return [];
  if (!Array.isArray(names)) names = [names];
  if (!Array.isArray(params)) params = [params];
  return names.map((n, i) => {
    const name = n instanceof Name ? ALIASES[n.name] ?? n.name : String(n);
    let p = params[i];
    if (p && !(p instanceof Dict) && dict.doc) p = dict.doc.fetchIfRef(p);
    return { name, params: p instanceof Dict ? p : null };
  });
}

// The stream's data with every filter but image codecs applied: { data, image: { name, params }
// | null, damaged, strict }. A damaged Flate stream gives what could be decoded as `data`, and as
// `strict` only what its whole blocks made, which is what pdf.js reads (text uses that). Kept on
// the stream after the first time.
export function decodeStream(stream) {
  if (stream.decoded) return stream.decoded;
  let data = stream.bytes;
  const doc = stream.dict.doc;
  const filters = filtersOf(stream);
  const crypt = doc?.decryptStream && stream.ref;
  // A stream with a Crypt filter is decrypted by that filter alone.
  if (crypt && !filters.some((f) => f.name === 'Crypt')) data = doc.decryptStream(data, stream.ref, stream);
  let image = null;
  let strict = null;
  for (const f of filters) {
    if (IMAGE_FILTERS.has(f.name)) {
      image = f;
      break;
    }
    if (f.name === 'Crypt') {
      if (crypt && doc.decryptStreamWith) {
        data = doc.decryptStreamWith(f.params?.name('Name') ?? 'Identity', data, stream.ref);
        if (strict) strict = doc.decryptStreamWith(f.params?.name('Name') ?? 'Identity', strict, stream.ref);
      }
      continue;
    }
    const next = applyFilter(f.name, data, f.params);
    if (strict) strict = applyFilter(f.name, strict, f.params);
    else if (next.damaged) strict = applyFilter(f.name, data, f.params, true);
    data = next;
  }
  stream.decoded = { data, image, damaged: Boolean(strict), strict: strict ?? data };
  return stream.decoded;
}

// A stream's bytes, decoded as pdf.js decodes them (for content streams, fonts and other data, not
// images).
export function streamBytes(stream) {
  return stream instanceof Stream ? decodeStream(stream).strict : new Uint8Array(0);
}

// Whether a stream decoded without damage: pdf.js sets aside a ToUnicode, CMap or font that didn't.
export const streamDamaged = (stream) => stream instanceof Stream && decodeStream(stream).damaged;

// `strict`: a damaged Flate stream gives only what its whole blocks made.
export function applyFilter(name, data, params, strict = false) {
  switch (name) {
    case 'FlateDecode': {
      let out = inflate(data);
      const damaged = out.damaged;
      if (damaged && strict) out = out.subarray(0, out.complete);
      const result = predict(out, params);
      if (damaged) result.damaged = true;
      return result;
    }
    case 'LZWDecode':
      return predict(lzw(data, params?.number('EarlyChange', 1) ?? 1), params);
    case 'ASCIIHexDecode':
      return asciiHex(data);
    case 'ASCII85Decode':
      return ascii85(data);
    case 'RunLengthDecode':
      return runLength(data);
    case 'Crypt':
      return data; // applied in decodeStream, which knows the document's encryption
    default:
      return data; // unknown: left as it is
  }
}

// PNG (Predictor 10 to 15) and TIFF (2) predictors.
function predict(data, params) {
  const predictor = params?.number('Predictor', 1) ?? 1;
  if (predictor <= 1) return data;
  const colors = params.number('Colors', 1);
  const bpc = params.number('BitsPerComponent', 8);
  const columns = params.number('Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    const out = new Uint8Array(data);
    if (bpc === 8) {
      for (let row = 0; row + rowLength <= out.length; row += rowLength)
        for (let i = row + bpp; i < row + rowLength; i++) out[i] = (out[i] + out[i - bpp]) & 0xff;
    } else if (bpc === 16) {
      for (let row = 0; row + rowLength <= out.length; row += rowLength)
        for (let i = row + 2 * colors; i + 1 < row + rowLength; i += 2) {
          const v = ((out[i] << 8) | out[i + 1]) + ((out[i - 2 * colors] << 8) | out[i - 2 * colors + 1]);
          out[i] = (v >> 8) & 0xff;
          out[i + 1] = v & 0xff;
        }
    } else {
      // Below a byte per component: undo per component, bit by bit.
      for (let row = 0; row + rowLength <= out.length; row += rowLength) {
        const prev = new Array(colors).fill(0);
        const mask = (1 << bpc) - 1;
        for (let x = 0; x < columns; x++)
          for (let c = 0; c < colors; c++) {
            const bit = (x * colors + c) * bpc;
            const at = row + (bit >> 3);
            const shift = 8 - bpc - (bit & 7);
            const v = (((out[at] >> shift) & mask) + prev[c]) & mask;
            out[at] = (out[at] & ~(mask << shift)) | (v << shift);
            prev[c] = v;
          }
      }
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let prior = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)];
    const src = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const row = out.subarray(r * rowLength, (r + 1) * rowLength);
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prior[i];
      const upLeft = i >= bpp ? prior[i - bpp] : 0;
      let v = src[i];
      switch (type) {
        case 1: v += left; break;
        case 2: v += up; break;
        case 3: v += (left + up) >> 1; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
      }
      row[i] = v & 0xff;
    }
    prior = row;
  }
  return out;
}

function lzw(data, earlyChange) {
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null); // 256 clear, 257 end
  };
  reset();
  let width = 9;
  let bitBuf = 0;
  let bitCount = 0;
  let prev = null;
  for (let pos = 0; pos < data.length || bitCount >= width; ) {
    while (bitCount < width && pos < data.length) {
      bitBuf = ((bitBuf << 8) | data[pos++]) >>> 0;
      bitCount += 8;
    }
    if (bitCount < width) break;
    const code = (bitBuf >>> (bitCount - width)) & ((1 << width) - 1);
    bitCount -= width;
    bitBuf &= (1 << bitCount) - 1;
    if (code === 256) {
      reset();
      width = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const c of entry) out.push(c);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    const size = dict.length + earlyChange;
    if (size >= 4096) width = 12;
    else if (size >= 2048) width = 12;
    else if (size >= 1024) width = 11;
    else if (size >= 512) width = 10;
  }
  return Uint8Array.from(out);
}

function asciiHex(data) {
  const out = [];
  let high = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) continue;
    if (high < 0) high = v;
    else {
      out.push((high << 4) | v);
      high = -1;
    }
  }
  if (high >= 0) out.push(high << 4);
  return Uint8Array.from(out);
}

function ascii85(data) {
  const out = [];
  let group = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // <~
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function runLength(data) {
  const out = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) {
      for (let j = 0; j <= n && i < data.length; j++) out.push(data[i++]);
    } else {
      const v = data[i++];
      for (let j = 0; j < 257 - n; j++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}
