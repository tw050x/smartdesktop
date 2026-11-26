// Reading a CFF font program (Adobe Technical Note 5176), as embedded for Type1C and CIDFontType0C
// fonts and inside OpenType fonts: its INDEXes, the Top and Private DICTs, the charset, the
// encoding, and for a CID font its FDArray and FDSelect. Charstrings stay as bytes, for drawing to
// read. Where a font is damaged, it's read as pdf.js reads it, failing where pdf.js fails.

import { CFF_CHARSETS, CFF_STANDARD_STRINGS, ENCODINGS } from './data.js';

const NUM_STANDARD_STRINGS = 391;

// [operator, name, kind, default]; kinds as the spec's: num, sid, offset, array, delta.
const TOP_DICT = [[[12, 30], 'ROS', ['sid', 'sid', 'num'], null], [[12, 20], 'SyntheticBase', 'num', null], [0, 'version', 'sid', null], [1, 'Notice', 'sid', null], [[12, 0], 'Copyright', 'sid', null], [2, 'FullName', 'sid', null], [3, 'FamilyName', 'sid', null], [4, 'Weight', 'sid', null], [[12, 1], 'isFixedPitch', 'num', 0], [[12, 2], 'ItalicAngle', 'num', 0], [[12, 3], 'UnderlinePosition', 'num', -100], [[12, 4], 'UnderlineThickness', 'num', 50], [[12, 5], 'PaintType', 'num', 0], [[12, 6], 'CharstringType', 'num', 2], [[12, 7], 'FontMatrix', ['num', 'num', 'num', 'num', 'num', 'num'], [0.001, 0, 0, 0.001, 0, 0]], [13, 'UniqueID', 'num', null], [5, 'FontBBox', ['num', 'num', 'num', 'num'], [0, 0, 0, 0]], [[12, 8], 'StrokeWidth', 'num', 0], [14, 'XUID', 'array', null], [15, 'charset', 'offset', 0], [16, 'Encoding', 'offset', 0], [17, 'CharStrings', 'offset', 0], [18, 'Private', ['offset', 'offset'], null], [[12, 21], 'PostScript', 'sid', null], [[12, 22], 'BaseFontName', 'sid', null], [[12, 23], 'BaseFontBlend', 'delta', null], [[12, 31], 'CIDFontVersion', 'num', 0], [[12, 32], 'CIDFontRevision', 'num', 0], [[12, 33], 'CIDFontType', 'num', 0], [[12, 34], 'CIDCount', 'num', 8720], [[12, 35], 'UIDBase', 'num', null], [[12, 37], 'FDSelect', 'offset', null], [[12, 36], 'FDArray', 'offset', null], [[12, 38], 'FontName', 'sid', null]];
const PRIVATE_DICT = [[6, 'BlueValues', 'delta', null], [7, 'OtherBlues', 'delta', null], [8, 'FamilyBlues', 'delta', null], [9, 'FamilyOtherBlues', 'delta', null], [[12, 9], 'BlueScale', 'num', 0.039625], [[12, 10], 'BlueShift', 'num', 7], [[12, 11], 'BlueFuzz', 'num', 1], [10, 'StdHW', 'num', null], [11, 'StdVW', 'num', null], [[12, 12], 'StemSnapH', 'delta', null], [[12, 13], 'StemSnapV', 'delta', null], [[12, 14], 'ForceBold', 'num', 0], [[12, 17], 'LanguageGroup', 'num', 0], [[12, 18], 'ExpansionFactor', 'num', 0.06], [[12, 19], 'initialRandomSeed', 'num', 0], [20, 'defaultWidthX', 'num', 0], [21, 'nominalWidthX', 'num', 0], [19, 'Subrs', 'offset', null]];

function layout(entries) {
  const byKey = new Map();
  const byName = new Map();
  for (const [op, name, kind, def] of entries) {
    const key = Array.isArray(op) ? (op[0] << 8) + op[1] : op;
    byKey.set(key, { name, kind, def });
    byName.set(name, key);
  }
  return { byKey, byName };
}
const TOP = layout(TOP_DICT);
const PRIVATE = layout(PRIVATE_DICT);

class CFFDict {
  constructor(table) {
    this.table = table;
    this.values = new Map();
    this.privateDict = null;
    this.subrs = null;
  }
  setByKey(key, value) {
    const entry = this.table.byKey.get(key);
    if (!entry) return;
    if (value.length === 0) return;
    if (value.some((v) => Number.isNaN(v))) return;
    this.values.set(key, entry.kind === 'num' || entry.kind === 'sid' || entry.kind === 'offset' ? value[0] : value);
  }
  key(name) {
    const key = this.table.byName.get(name);
    if (key === undefined) throw new Error(`no CFF dict entry ${name}`);
    return key;
  }
  has(name) {
    return this.values.has(this.key(name));
  }
  get(name) {
    const key = this.key(name);
    return this.values.has(key) ? this.values.get(key) : this.table.byKey.get(key).def;
  }
  set(name, value) {
    this.values.set(this.key(name), value);
  }
  remove(name) {
    this.values.delete(this.key(name));
  }
}

const latin1 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

export class CFF {
  constructor(bytes) {
    let offset = 0;
    while (offset < bytes.length && bytes[offset] !== 1) offset++;
    if (offset >= bytes.length) throw new Error('Invalid CFF header');
    this.bytes = offset ? bytes.subarray(offset) : bytes;
    this.strings = [];
  }

  string(sid) {
    if (sid >= 0 && sid < NUM_STANDARD_STRINGS) return CFF_STANDARD_STRINGS[sid];
    return sid - NUM_STANDARD_STRINGS <= this.strings.length ? this.strings[sid - NUM_STANDARD_STRINGS] : CFF_STANDARD_STRINGS[0];
  }

  index(pos) {
    const b = this.bytes;
    const count = (b[pos++] << 8) | b[pos++];
    const items = [];
    let end = pos;
    if (count !== 0) {
      const offSize = b[pos++];
      if (offSize < 1 || offSize > 4) throw new Error(`Invalid CFF INDEX offset size: ${offSize}`);
      const start = pos + (count + 1) * offSize - 1;
      const offsets = [];
      let prev = start;
      for (let i = 0; i <= count; i++) {
        let o = 0;
        for (let j = 0; j < offSize; j++) o = (o << 8) | b[pos++];
        prev = Math.min(Math.max(start + o, prev), b.length);
        offsets.push(prev);
      }
      end = offsets[count];
      for (let i = 0; i < count; i++) items.push(b.subarray(offsets[i], offsets[i + 1]));
    }
    return { items, end };
  }

  dict(data, table) {
    const dict = new CFFDict(table);
    const view = new DataView(data.buffer, data.byteOffset);
    let pos = 0;
    const real = () => {
      const lookup = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'E', 'E-', null, '-'];
      let s = '';
      while (pos < data.length) {
        const b = data[pos++];
        if (b >> 4 === 15) break;
        s += lookup[b >> 4];
        if ((b & 15) === 15) break;
        s += lookup[b & 15];
      }
      return parseFloat(s);
    };
    const operand = () => {
      const v = data[pos++];
      if (v === 30) return real();
      if (v === 28) {
        const n = view.getInt16(pos);
        pos += 2;
        return n;
      }
      if (v === 29) {
        const n = view.getInt32(pos);
        pos += 4;
        return n;
      }
      if (v >= 32 && v <= 246) return v - 139;
      if (v >= 247 && v <= 250) return (v - 247) * 256 + data[pos++] + 108;
      if (v >= 251 && v <= 254) return -((v - 251) * 256) - data[pos++] - 108;
      return NaN;
    };
    let operands = [];
    while (pos < data.length) {
      let b = data[pos];
      if (b <= 21) {
        if (b === 12) b = (b << 8) | data[++pos];
        dict.setByKey(b, operands);
        operands = [];
        pos++;
      } else operands.push(operand());
    }
    return dict;
  }

  privateDict(parent) {
    if (!parent.has('Private')) {
      parent.privateDict = new CFFDict(PRIVATE);
      parent.set('Private', [0, 0]);
      return;
    }
    const at = parent.get('Private');
    if (!Array.isArray(at) || at.length !== 2) {
      parent.remove('Private');
      return;
    }
    const [size, offset] = at;
    if (size === 0 || offset >= this.bytes.length) {
      parent.privateDict = new CFFDict(PRIVATE);
      parent.set('Private', [0, 0]);
      return;
    }
    if (offset + size > this.bytes.length) throw new Error('CFF Private DICT extends past end of font');
    const priv = this.dict(this.bytes.subarray(offset, offset + size), PRIVATE);
    parent.privateDict = priv;
    const subrs = priv.get('Subrs');
    if (!subrs) return;
    if (offset + subrs >= this.bytes.length) {
      parent.privateDict = new CFFDict(PRIVATE);
      parent.set('Private', [0, 0]);
      return;
    }
    priv.subrs = this.index(offset + subrs).items;
  }

  charset(pos, count, cid) {
    if (pos === 0) return CFF_CHARSETS.ISOAdobeCharset;
    if (pos === 1) return CFF_CHARSETS.ExpertCharset;
    if (pos === 2) return CFF_CHARSETS.ExpertSubsetCharset;
    const b = this.bytes;
    const format = b[pos++];
    const charset = [cid ? 0 : '.notdef'];
    const length = count - 1;
    const add = (id) => charset.push(cid ? id : this.string(id));
    if (format === 0) {
      for (let i = 0; i < length; i++) add((b[pos++] << 8) | b[pos++]);
    } else if (format === 1 || format === 2) {
      while (charset.length <= length) {
        let id = (b[pos++] << 8) | b[pos++];
        const left = format === 1 ? b[pos++] : (b[pos++] << 8) | b[pos++];
        for (let i = 0; i <= left; i++) add(id++);
      }
    } else throw new Error('Unknown charset format');
    return charset;
  }

  // Codes to glyph indexes.
  encoding(pos, charset) {
    const encoding = Object.create(null);
    const b = this.bytes;
    if (pos === 0 || pos === 1) {
      const base = pos ? ENCODINGS.ExpertEncoding : ENCODINGS.StandardEncoding;
      for (let i = 0; i < charset.length; i++) {
        const code = base.indexOf(charset[i]);
        if (code !== -1) encoding[code] = i;
      }
      return encoding;
    }
    const format = b[pos++];
    switch (format & 0x7f) {
      case 0: {
        const n = b[pos++];
        for (let i = 1; i <= n; i++) encoding[b[pos++]] = i;
        break;
      }
      case 1: {
        const ranges = b[pos++];
        let gid = 1;
        for (let i = 0; i < ranges; i++) {
          const first = b[pos++];
          const left = b[pos++];
          for (let j = first; j <= first + left; j++) encoding[j] = gid++;
        }
        break;
      }
      default:
        throw new Error(`Unknown encoding format: ${format} in CFF`);
    }
    if (format & 0x80) {
      const n = b[pos++];
      for (let i = 0; i < n; i++) {
        const code = b[pos++];
        const sid = (b[pos++] << 8) + (b[pos++] & 0xff);
        encoding[code] = charset.indexOf(this.string(sid));
      }
    }
    return encoding;
  }

  fdSelect(pos, count) {
    const b = this.bytes;
    const format = b[pos++];
    const select = [];
    if (format === 0) {
      for (let i = 0; i < count; i++) select.push(b[pos++]);
    } else if (format === 3) {
      const ranges = (b[pos++] << 8) | b[pos++];
      for (let i = 0; i < ranges; i++) {
        let first = (b[pos++] << 8) | b[pos++];
        if (i === 0) first = 0;
        const fd = b[pos++];
        const next = (b[pos] << 8) | b[pos + 1];
        if (next - first > count - select.length) throw new Error('parseFDSelect: Invalid font data.');
        for (let j = first; j < next; j++) select.push(fd);
      }
    } else throw new Error(`parseFDSelect: Unknown format "${format}".`);
    if (select.length !== count) throw new Error('parseFDSelect: Invalid font data.');
    return select;
  }
}

// { topDict, fontMatrix, bbox, isCID, charset, encoding (codes to glyph indexes, or null),
//   builtInEncoding (codes to glyph names, or null), charStrings, globalSubrs, fdArray, fdSelect }.
export function parseCFF(bytes) {
  const cff = new CFF(bytes);
  const b = cff.bytes;
  const names = cff.index(b[2]);
  const topDicts = cff.index(names.end);
  const strings = cff.index(topDicts.end);
  const globalSubrs = cff.index(strings.end);
  if (!topDicts.items.length) throw new Error('CFF font has no Top DICT');
  const topDict = cff.dict(topDicts.items[0], TOP);
  cff.strings = strings.items.map(latin1);
  cff.privateDict(topDict);
  const isCID = topDict.has('ROS');
  const charStrings = cff.index(topDict.get('CharStrings')).items;
  const count = charStrings.length;
  let charset;
  let encoding = null;
  const fdArray = [];
  let fdSelect = null;
  if (isCID) {
    const fds = cff.index(topDict.get('FDArray')).items;
    for (const raw of fds.slice(0, 256)) {
      const fd = cff.dict(raw, TOP);
      cff.privateDict(fd);
      fdArray.push(fd);
    }
    charset = cff.charset(topDict.get('charset'), count, true);
    fdSelect = cff.fdSelect(topDict.get('FDSelect'), count);
  } else {
    charset = cff.charset(topDict.get('charset'), count, false);
    encoding = cff.encoding(topDict.get('Encoding'), charset);
  }
  // A Private DICT that couldn't be read leaves the font without one: as in pdf.js, that fails.
  if (!topDict.privateDict) throw new Error('CFF font has no Private DICT');
  if (isCID && fdArray.some((fd) => !fd.privateDict)) throw new Error('CFF font dict has no Private DICT');
  let builtInEncoding = null;
  if (encoding) {
    const map = [];
    for (const code in encoding) {
      const gid = encoding[code];
      if (gid >= 0 && charset[gid]) map[code] = charset[gid];
    }
    if (map.length > 0) builtInEncoding = map;
  }
  return {
    topDict,
    fontMatrix: topDict.get('FontMatrix'),
    bbox: topDict.get('FontBBox'),
    isCID,
    names: names.items.map(latin1),
    charset,
    encoding,
    builtInEncoding,
    charStrings,
    globalSubrs: globalSubrs.items,
    privateDict: topDict.privateDict,
    fdArray,
    fdSelect,
  };
}
