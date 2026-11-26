// Reading a TrueType or OpenType font program (the sfnt format: Apple's TrueType Reference Manual,
// Microsoft's OpenType spec), and TrueType Collections: the table directory and the tables
// readers use. Which tables are kept, and what counts as too damaged to use, follow pdf.js, so a
// font pdf.js gives up on (and reads the page's text without) is given up on here too.

const KEPT = ['OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post', 'loca', 'glyf', 'fpgm', 'prep', 'cvt ', 'CFF '];

const tag = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const u16 = (b, p) => (p + 1 < b.length ? (b[p] << 8) | b[p + 1] : -1);
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

export const isTrueTypeFile = (b) => tag(b, 0) === '\x00\x01\x00\x00' || tag(b, 0) === 'true';
export const isCollectionFile = (b) => tag(b, 0) === 'ttcf';
export const isOpenTypeFile = (b) => tag(b, 0) === 'OTTO';

function readTables(bytes, at) {
  const version = tag(bytes, at);
  const numTables = Math.max(0, u16(bytes, at + 4));
  const tables = Object.create(null);
  for (const t of ['OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post']) tables[t] = null;
  let p = at + 12;
  for (let i = 0; i < numTables; i++, p += 16) {
    const name = tag(bytes, p);
    const offset = u32(bytes, p + 8);
    const length = u32(bytes, p + 12);
    if (!KEPT.includes(name) || length === 0) continue;
    const data = bytes.slice(offset, offset + length);
    tables[name] = { tag: name, offset, length, data };
  }
  return { version, tables };
}

// The name table's Macintosh Roman (1, 0, 0) and Windows Unicode English (3, 1, 0x409) records,
// and their strings by name id: [macNames, winNames].
export function readNameTable(table) {
  const names = [[], []];
  const records = [];
  if (!table) return [names, records];
  const d = table.data;
  const length = table.length;
  if (u16(d, 0) !== 0 || length < 6) return [names, records];
  const count = u16(d, 2);
  const stringsStart = u16(d, 4);
  for (let i = 0, p = 6; i < count && p + 12 <= length; i++, p += 12) {
    const r = { platform: u16(d, p), encoding: u16(d, p + 2), language: u16(d, p + 4), name: u16(d, p + 6), length: u16(d, p + 8), offset: u16(d, p + 10) };
    if ((r.platform === 1 && r.encoding === 0 && r.language === 0) || (r.platform === 3 && r.encoding === 1 && r.language === 0x409)) records.push(r);
  }
  for (const r of records) {
    if (r.length <= 0) continue;
    const p = stringsStart + r.offset;
    if (p + r.length > length) continue;
    let s = '';
    if (r.encoding) {
      for (let j = 0; j < r.length; j += 2) s += String.fromCharCode(u16(d, p + j));
      names[1][r.name] = s;
    } else {
      for (let j = 0; j < r.length; j++) s += String.fromCharCode(d[p + j]);
      names[0][r.name] = s;
    }
  }
  return [names, records];
}

// A collection's font: the one whose names include the PDF font's name, or failing that a part
// of it (a subset's name after its tag).
function collectionFont(bytes, fontName) {
  const major = u16(bytes, 4);
  if (major !== 1 && major !== 2) throw new Error(`Invalid TrueType Collection majorVersion: ${major}.`);
  const numFonts = u32(bytes, 8);
  const parts = fontName.split('+');
  let fallback = null;
  for (let i = 0; i < numFonts; i++) {
    const font = readTables(bytes, u32(bytes, 12 + i * 4));
    if (!font.tables.name) throw new Error('TrueType Collection font must contain a "name" table.');
    const [nameTable] = readNameTable(font.tables.name);
    for (const list of nameTable) {
      for (const entry of list) {
        const n = entry?.replaceAll(/\s/g, '');
        if (!n) continue;
        if (n === fontName) return font;
        if (parts.length < 2) continue;
        for (const part of parts) if (n === part) fallback = font;
      }
    }
  }
  if (fallback) return fallback;
  throw new Error(`TrueType Collection does not contain "${fontName}" font.`);
}

// { version, tables }: `version` is "OTTO" for CFF-based OpenType.
export function readSfnt(bytes, fontName = '') {
  return isCollectionFile(bytes) ? collectionFont(bytes, fontName) : readTables(bytes, 0);
}

// The checks pdf.js makes before using a TrueType font's glyphs, throwing where it does.
export function checkTrueType({ tables }) {
  if (!tables.loca) throw new Error('Required "loca" table is not found');
  if (!tables.maxp) throw new Error('Required "maxp" table is not found');
  const maxp = tables.maxp.data;
  let version = u32(maxp, 0);
  const numGlyphs = u16(maxp, 4);
  if (version !== 0x00010000 && version !== 0x00005000) {
    if (tables.maxp.length === 6) version = 0x5000;
    else if (tables.maxp.length >= 32) version = 0x10000;
    else throw new Error('"maxp" table has a wrong version number');
  }
  if (!tables.head) throw new Error('Required "head" table is not found');
  const head = tables.head.data;
  if (head.length < 4) throw new RangeError('head table too short');
  const format = (head[50] << 24) >> 16 | head[51];
  if (!(format >= 0 && format <= 1)) {
    const locaLength = tables.loca.length;
    if (locaLength !== (numGlyphs + 1) << 1 && locaLength !== (numGlyphs + 1) << 2) throw new Error(`Could not fix indexToLocFormat: ${format}`);
  }
  if (!tables.hhea) throw new Error('Required "hhea" table is not found');
  return { numGlyphs };
}

// The cmap subtable pdf.js would choose (its readCmapTable): Unicode (0, x), Macintosh Roman (1, 0),
// Windows Unicode (3, 1) for a font with an encoding or none chosen yet, Windows Symbol (3, 0) for
// a symbolic font. { platformId, encodingId, mappings: Map(code -> glyph) }, the first of each code.
export function readCmap(table, symbolic, hasEncoding) {
  const none = { platformId: -1, encodingId: -1, mappings: new Map() };
  if (!table) return none;
  const d = table.data;
  const numTables = u16(d, 2);
  let chosen = null;
  let canBreak = false;
  for (let i = 0, p = 4; i < numTables; i++, p += 8) {
    const platformId = u16(d, p);
    const encodingId = u16(d, p + 2);
    const offset = u32(d, p + 4);
    let use = false;
    if (chosen?.platformId === platformId && chosen?.encodingId === encodingId) continue;
    if (platformId === 0 && (encodingId === 0 || encodingId === 1 || encodingId === 3)) use = true;
    else if (platformId === 1 && encodingId === 0) use = true;
    else if (platformId === 3 && encodingId === 1 && (hasEncoding || !chosen)) {
      use = true;
      if (!symbolic) canBreak = true;
    } else if (symbolic && platformId === 3 && encodingId === 0) {
      use = true;
      const sorted = i >= numTables - 1 || (((d[p + 8] << 24) >> 16) | d[p + 9]) >= platformId;
      if (sorted) canBreak = true;
    }
    if (use) chosen = { platformId, encodingId, offset };
    if (canBreak) break;
  }
  if (!chosen || chosen.offset >= d.length) return none;
  const list = [];
  let p = chosen.offset;
  const format = u16(d, p);
  if (format === 0) {
    for (let j = 0; j < 256; j++) {
      const g = d[p + 6 + j];
      if (g) list.push([j, g]);
    }
  } else if (format === 2) {
    p += 6;
    const keys = [];
    let maxKey = 0;
    for (let i = 0; i < 256; i++) {
      const k = u16(d, p + i * 2) >> 3;
      keys.push(k);
      maxKey = Math.max(maxKey, k);
    }
    p += 512;
    const subs = [];
    for (let i = 0; i <= maxKey; i++, p += 8) subs.push({ first: u16(d, p), count: u16(d, p + 2), delta: (d[p + 4] << 24) >> 16 | d[p + 5], range: p + 6 + u16(d, p + 6) });
    for (let i = 0; i < 256; i++) {
      if (keys[i] === 0) list.push([i, u16(d, subs[0].range + 2 * i)]);
      else {
        const s = subs[keys[i]];
        for (let j = 0; j < s.count; j++) {
          let g = u16(d, s.range + 2 * j);
          if (g !== 0) g = (g + s.delta) % 65536;
          list.push([(i << 8) + j + s.first, g]);
        }
      }
    }
  } else if (format === 4) {
    const segCount = u16(d, p + 6) >> 1;
    const ends = p + 14;
    const starts = ends + segCount * 2 + 2;
    const deltas = starts + segCount * 2;
    const offsets = deltas + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const start = u16(d, starts + s * 2);
      const end = u16(d, ends + s * 2);
      const delta = u16(d, deltas + s * 2);
      const rangeOffset = u16(d, offsets + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (!rangeOffset) g = c;
        else {
          const at = offsets + s * 2 + rangeOffset + (c - start) * 2;
          g = at + 1 < d.length ? u16(d, at) : 0;
        }
        list.push([c, (g + delta) & 0xffff]);
      }
    }
  } else if (format === 6) {
    const first = u16(d, p + 6);
    const count = u16(d, p + 8);
    for (let j = 0; j < count; j++) list.push([first + j, u16(d, p + 10 + j * 2)]);
  } else if (format === 12) {
    const groups = u32(d, p + 12);
    for (let j = 0, q = p + 16; j < groups; j++, q += 12) {
      const start = u32(d, q);
      const end = u32(d, q + 4);
      let g = u32(d, q + 8);
      for (let c = start; c <= end && c - start < 0x10000; c++) list.push([c, g++]);
    }
  } else return none;
  const mappings = new Map();
  for (const [c, g] of list.sort((a, b) => a[0] - b[0])) if (!mappings.has(c)) mappings.set(c, g);
  return { platformId: chosen.platformId, encodingId: chosen.encodingId, mappings };
}

// The post table's glyph names (pdf.js's readPostScriptTable), or null.
export function readPost(table, numGlyphs, macOrder, defaultEncoding) {
  if (!table) return null;
  const d = table.data;
  const version = u32(d, 0);
  if (version === 0x10000) return macOrder;
  if (version === 0x20000) {
    const n = u16(d, 32);
    if (n !== numGlyphs) return null;
    const indexes = [];
    for (let i = 0; i < n; i++) {
      const ix = u16(d, 34 + i * 2);
      if (ix >= 32768) return null;
      indexes.push(ix);
    }
    const custom = [];
    for (let p = 34 + n * 2; p < d.length; ) {
      const len = d[p++];
      let s = '';
      for (let k = 0; k < len && p < d.length; k++) s += String.fromCharCode(d[p++]);
      custom.push(s);
    }
    return indexes.map((j) => (j < 258 ? macOrder[j] : custom[j - 258]));
  }
  if (version === 0x30000) return null;
  return defaultEncoding ?? null;
}
