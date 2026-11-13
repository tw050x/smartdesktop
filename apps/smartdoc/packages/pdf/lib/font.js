// TrueType and OpenType fonts (.ttf, .otf, and .ttc collections): what laying text out and
// embedding it in a PDF needs. Glyphs for characters (cmap), their advances (hmtx), pair kerning
// (the kern table, and GPOS pair adjustments, which most modern fonts use instead), the vertical
// metrics, names and style, whether the font may be embedded (OS/2 fsType), and a subset of a
// TrueType-outline font holding only the glyphs used. Fonts with CFF outlines are embedded whole.

export function parseFont(buffer, index = 0) {
  let base = 0;
  if (buffer.toString('latin1', 0, 4) === 'ttcf') {
    const count = buffer.readUInt32BE(8);
    if (index >= count) throw new Error(`The font collection has ${count} fonts, not ${index + 1}.`);
    base = buffer.readUInt32BE(12 + 4 * index);
  }
  const numTables = buffer.readUInt16BE(base + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const at = base + 12 + 16 * i;
    tables[buffer.toString('latin1', at, at + 4)] = { offset: buffer.readUInt32BE(at + 8), length: buffer.readUInt32BE(at + 12) };
  }
  const t = (tag) => tables[tag] ?? null;
  const need = (tag) => {
    if (!tables[tag]) throw new Error(`The font has no ${tag} table.`);
    return tables[tag].offset;
  };
  const u16 = (at) => buffer.readUInt16BE(at);
  const i16 = (at) => buffer.readInt16BE(at);
  const u32 = (at) => buffer.readUInt32BE(at);

  const head = need('head');
  const unitsPerEm = u16(head + 18);
  const bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];
  const macStyle = u16(head + 44);
  const indexToLocFormat = i16(head + 50);
  const hhea = need('hhea');
  const numberOfHMetrics = u16(hhea + 34);
  const numGlyphs = u16(need('maxp') + 4);

  // Advances: the last one repeats for glyphs past numberOfHMetrics.
  const hmtx = need('hmtx');
  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numberOfHMetrics) last = u16(hmtx + 4 * g);
    advances[g] = last;
  }

  // OS/2: the metrics Office and LibreOffice lay lines out by, weight, and embedding permission.
  const os2 = t('OS/2');
  const metrics = {
    hheaAscent: i16(hhea + 4),
    hheaDescent: i16(hhea + 6),
    hheaLineGap: i16(hhea + 8),
  };
  if (os2) {
    const version = u16(os2.offset);
    Object.assign(metrics, {
      weight: u16(os2.offset + 4),
      fsType: u16(os2.offset + 8),
      fsSelection: u16(os2.offset + 62),
      typoAscent: i16(os2.offset + 68),
      typoDescent: i16(os2.offset + 70),
      typoLineGap: i16(os2.offset + 72),
      winAscent: u16(os2.offset + 74),
      winDescent: u16(os2.offset + 76),
      xHeight: version >= 2 && os2.length >= 90 ? i16(os2.offset + 86) : null,
      capHeight: version >= 2 && os2.length >= 90 ? i16(os2.offset + 88) : null,
    });
  }
  const post = t('post');
  const italicAngle = post ? buffer.readInt32BE(post.offset + 4) / 65536 : 0;
  const fixedPitch = post ? u32(post.offset + 12) !== 0 : false;

  // Names: family, style, full and PostScript names, Windows (UTF-16) entries first.
  const names = {};
  const name = t('name');
  if (name) {
    const count = u16(name.offset + 2);
    const strings = name.offset + u16(name.offset + 4);
    const found = {};
    for (let i = 0; i < count; i++) {
      const at = name.offset + 6 + 12 * i;
      const platform = u16(at);
      const encoding = u16(at + 2);
      const language = u16(at + 4);
      const id = u16(at + 6);
      const length = u16(at + 8);
      const offset = u16(at + 10);
      if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
      const bytes = buffer.subarray(strings + offset, strings + offset + length);
      let value = null;
      let rank = 0;
      if (platform === 3 && (encoding === 1 || encoding === 10)) {
        value = Buffer.from(bytes).swap16().toString('utf16le');
        rank = language === 0x409 ? 3 : 2;
      } else if (platform === 0) {
        value = Buffer.from(bytes).swap16().toString('utf16le');
        rank = 2;
      } else if (platform === 1 && encoding === 0) {
        value = bytes.toString('latin1');
        rank = 1;
      }
      if (value != null && rank > (found[id]?.rank ?? 0)) found[id] = { value, rank };
    }
    names.family = found[16]?.value ?? found[1]?.value ?? null;
    names.style = found[17]?.value ?? found[2]?.value ?? null;
    names.legacyFamily = found[1]?.value ?? null;
    names.legacyStyle = found[2]?.value ?? null;
    names.full = found[4]?.value ?? null;
    names.postscript = found[6]?.value ?? null;
  }

  // A subset made for a PDF has no character map: its glyphs are reached by number.
  const cmap = t('cmap') ? readCmap(buffer, t('cmap').offset) : new Map();
  const kerning = readKerning(buffer, t('kern'), t('GPOS'));
  const cff = Boolean(t('CFF ') || t('CFF2'));

  const bold = (metrics.weight ?? 400) >= 600 || Boolean(macStyle & 1);
  const italic = Boolean(macStyle & 2) || Boolean((metrics.fsSelection ?? 0) & 1) || italicAngle !== 0;

  const font = {
    unitsPerEm,
    bbox,
    numGlyphs,
    names,
    bold,
    italic,
    italicAngle,
    fixedPitch,
    cff,
    metrics,
    // May it be embedded in a document? (fsType 2 is "restricted": no embedding at all.)
    embeddable: !((metrics.fsType ?? 0) & 0x000f) || ((metrics.fsType ?? 0) & 0x000f) !== 2,
    // The vertical metrics, in font units, as Windows lays lines out (win ascent and descent),
    // which Word follows; and the typographic ones, for fonts that ask for them (USE_TYPO_METRICS).
    ascent: metrics.winAscent ?? metrics.hheaAscent,
    descent: metrics.winDescent ?? -metrics.hheaDescent,
    capHeight: metrics.capHeight ?? Math.round(unitsPerEm * 0.7),
    xHeight: metrics.xHeight ?? Math.round(unitsPerEm * 0.5),
    glyph: (codePoint) => cmap.get(codePoint) ?? 0,
    has: (codePoint) => cmap.has(codePoint),
    advance: (gid) => advances[gid] ?? 0,
    kern: (left, right) => kerning.get(left * 65536 + right) ?? 0,
    // The font's file, as it is (a collection's own font is cut out by subset()).
    buffer,
    base,
    tables,
    subset: (gids) => subsetTrueType(buffer, tables, gids, indexToLocFormat, numGlyphs),
  };
  return font;
}

// The character → glyph map: a full Unicode table (format 12) if there is one, else the BMP's
// (format 4), else a symbol font's (3,0), whose characters sit at U+F000 and up.
function readCmap(buffer, at) {
  const count = buffer.readUInt16BE(at + 2);
  const subtables = [];
  for (let i = 0; i < count; i++) {
    const rec = at + 4 + 8 * i;
    subtables.push({ platform: buffer.readUInt16BE(rec), encoding: buffer.readUInt16BE(rec + 2), offset: at + buffer.readUInt32BE(rec + 4) });
  }
  const rank = (s) => {
    const format = buffer.readUInt16BE(s.offset);
    if (format === 12 && ((s.platform === 3 && s.encoding === 10) || s.platform === 0)) return 5;
    if (format === 4 && s.platform === 3 && s.encoding === 1) return 4;
    if (format === 4 && s.platform === 0) return 3;
    if (format === 4 && s.platform === 3 && s.encoding === 0) return 2;
    if (format === 0 || format === 6) return 1;
    return 0;
  };
  const best = subtables.filter((s) => rank(s) > 0).sort((a, b) => rank(b) - rank(a))[0];
  const map = new Map();
  if (!best) return map;
  const o = best.offset;
  const format = buffer.readUInt16BE(o);
  if (format === 4) {
    const segX2 = buffer.readUInt16BE(o + 6);
    const ends = o + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buffer.readUInt16BE(ends + 2 * s);
      const start = buffer.readUInt16BE(starts + 2 * s);
      const delta = buffer.readInt16BE(deltas + 2 * s);
      const rangeOffset = buffer.readUInt16BE(ranges + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (rangeOffset === 0) g = (c + delta) & 0xffff;
        else {
          const gAt = ranges + 2 * s + rangeOffset + 2 * (c - start);
          g = buffer.readUInt16BE(gAt);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g) map.set(c, g);
      }
    }
    // A symbol font: its characters are at U+F000+; plain codes reach them too, as Word's do.
    if (best.platform === 3 && best.encoding === 0) {
      for (const [c, g] of [...map]) if (c >= 0xf000 && c <= 0xf0ff && !map.has(c - 0xf000)) map.set(c - 0xf000, g);
    }
  } else if (format === 12) {
    const groups = buffer.readUInt32BE(o + 12);
    for (let i = 0; i < groups; i++) {
      const g = o + 16 + 12 * i;
      const start = buffer.readUInt32BE(g);
      const end = buffer.readUInt32BE(g + 4);
      const first = buffer.readUInt32BE(g + 8);
      for (let c = start; c <= end; c++) map.set(c, first + (c - start));
    }
  } else if (format === 0) {
    for (let c = 0; c < 256; c++) {
      const g = buffer[o + 6 + c];
      if (g) map.set(c, g);
    }
  } else if (format === 6) {
    const first = buffer.readUInt16BE(o + 6);
    const n = buffer.readUInt16BE(o + 8);
    for (let i = 0; i < n; i++) {
      const g = buffer.readUInt16BE(o + 10 + 2 * i);
      if (g) map.set(first + i, g);
    }
  }
  return map;
}

// Pair kerning, in font units, keyed left * 65536 + right: the kern table's format 0 pairs, then
// GPOS's horizontal pair adjustments for the default script and feature 'kern' (formats 1 and 2,
// through extension lookups too). GPOS wins where both have a pair.
function readKerning(buffer, kern, gpos) {
  const pairs = new Map();
  const u16 = (at) => buffer.readUInt16BE(at);
  const i16 = (at) => buffer.readInt16BE(at);
  if (kern) {
    const version = u16(kern.offset);
    if (version === 0) {
      const n = u16(kern.offset + 2);
      let at = kern.offset + 4;
      for (let t = 0; t < n; t++) {
        const length = u16(at + 2);
        const coverage = u16(at + 4);
        const format = coverage >> 8;
        const horizontal = coverage & 1;
        if (format === 0 && horizontal && !(coverage & 4)) {
          const count = u16(at + 6);
          for (let p = 0; p < count; p++) {
            const rec = at + 14 + 6 * p;
            pairs.set(u16(rec) * 65536 + u16(rec + 2), i16(rec + 4));
          }
        }
        at += length;
      }
    }
  }
  if (!gpos) return pairs;
  try {
    const g = gpos.offset;
    const featureList = g + u16(g + 6);
    const lookupList = g + u16(g + 8);
    // Every lookup a 'kern' feature names (any script: Word and LibreOffice apply kerning alike).
    const lookups = new Set();
    const features = u16(featureList);
    for (let f = 0; f < features; f++) {
      const rec = featureList + 2 + 6 * f;
      if (buffer.toString('latin1', rec, rec + 4) !== 'kern') continue;
      const feature = featureList + u16(rec + 4);
      const n = u16(feature + 2);
      for (let i = 0; i < n; i++) lookups.add(u16(feature + 4 + 2 * i));
    }
    for (const index of lookups) {
      const lookup = lookupList + u16(lookupList + 2 + 2 * index);
      let type = u16(lookup);
      const subtables = u16(lookup + 4);
      for (let s = 0; s < subtables; s++) {
        let sub = lookup + u16(lookup + 6 + 2 * s);
        let subType = type;
        if (type === 9) {
          subType = u16(sub + 2);
          sub = sub + buffer.readUInt32BE(sub + 4);
        }
        if (subType === 2) readPairPos(buffer, sub, pairs);
      }
    }
  } catch {
    // A table we can't read gives no kerning, rather than no font.
  }
  return pairs;
}

const VALUE_SIZE = (format) => {
  let n = 0;
  for (let b = 0; b < 8; b++) if (format & (1 << b)) n += 2;
  return n;
};
// The x advance in a value record (bit 4 of its format), if it has one.
function xAdvance(buffer, at, format) {
  if (!(format & 4)) return 0;
  let skip = 0;
  if (format & 1) skip += 2;
  if (format & 2) skip += 2;
  return buffer.readInt16BE(at + skip);
}

function coverageGlyphs(buffer, at) {
  const format = buffer.readUInt16BE(at);
  const out = [];
  if (format === 1) {
    const n = buffer.readUInt16BE(at + 2);
    for (let i = 0; i < n; i++) out.push(buffer.readUInt16BE(at + 4 + 2 * i));
  } else if (format === 2) {
    const n = buffer.readUInt16BE(at + 2);
    for (let i = 0; i < n; i++) {
      const rec = at + 4 + 6 * i;
      const start = buffer.readUInt16BE(rec);
      const end = buffer.readUInt16BE(rec + 2);
      for (let gid = start; gid <= end; gid++) out.push(gid);
    }
  }
  return out;
}

function classDef(buffer, at) {
  const map = new Map();
  const format = buffer.readUInt16BE(at);
  if (format === 1) {
    const start = buffer.readUInt16BE(at + 2);
    const n = buffer.readUInt16BE(at + 4);
    for (let i = 0; i < n; i++) map.set(start + i, buffer.readUInt16BE(at + 6 + 2 * i));
  } else if (format === 2) {
    const n = buffer.readUInt16BE(at + 2);
    for (let i = 0; i < n; i++) {
      const rec = at + 4 + 6 * i;
      const start = buffer.readUInt16BE(rec);
      const end = buffer.readUInt16BE(rec + 2);
      const cls = buffer.readUInt16BE(rec + 4);
      for (let gid = start; gid <= end; gid++) map.set(gid, cls);
    }
  }
  return map;
}

function readPairPos(buffer, at, pairs) {
  const u16 = (o) => buffer.readUInt16BE(o);
  const format = u16(at);
  const coverage = coverageGlyphs(buffer, at + u16(at + 2));
  const vf1 = u16(at + 4);
  const vf2 = u16(at + 6);
  const size1 = VALUE_SIZE(vf1);
  const size2 = VALUE_SIZE(vf2);
  if (format === 1) {
    const sets = u16(at + 8);
    for (let i = 0; i < sets && i < coverage.length; i++) {
      const set = at + u16(at + 10 + 2 * i);
      const n = u16(set);
      for (let p = 0; p < n; p++) {
        const rec = set + 2 + p * (2 + size1 + size2);
        const second = u16(rec);
        const value = xAdvance(buffer, rec + 2, vf1);
        const key = coverage[i] * 65536 + second;
        if (value && !pairs.has(key)) pairs.set(key, value);
      }
    }
  } else if (format === 2) {
    const class1 = classDef(buffer, at + u16(at + 8));
    const class2 = classDef(buffer, at + u16(at + 10));
    const count1 = u16(at + 12);
    const count2 = u16(at + 14);
    const records = at + 16;
    // Glyphs in each second class (class 0 is "every other glyph": too many to list, and kerning
    // against it is rare, so it's left out).
    const byClass2 = new Map();
    for (const [gid, cls] of class2) {
      if (!byClass2.has(cls)) byClass2.set(cls, []);
      byClass2.get(cls).push(gid);
    }
    for (const first of coverage) {
      const c1 = class1.get(first) ?? 0;
      if (c1 >= count1) continue;
      for (let c2 = 1; c2 < count2; c2++) {
        const rec = records + (c1 * count2 + c2) * (size1 + size2);
        const value = xAdvance(buffer, rec, vf1);
        if (!value) continue;
        for (const second of byClass2.get(c2) ?? []) {
          const key = first * 65536 + second;
          if (!pairs.has(key)) pairs.set(key, value);
        }
      }
    }
  }
}

// A TrueType-outline font holding only the glyphs in `used` (and glyph 0, and the parts of any
// composite glyph), the rest left empty so every glyph keeps its number (the PDF maps characters to
// glyphs by number). Hinting tables are kept, for crisp text on screens.
function subsetTrueType(buffer, tables, used, indexToLocFormat, numGlyphs) {
  const loca = tables.loca;
  const glyf = tables.glyf;
  if (!loca || !glyf) return null;
  const offsetOf = (gid) => (indexToLocFormat === 0 ? buffer.readUInt16BE(loca.offset + 2 * gid) * 2 : buffer.readUInt32BE(loca.offset + 4 * gid));
  const keep = new Set([0, ...used]);
  // Composite glyphs pull in their components.
  const queue = [...keep];
  while (queue.length) {
    const gid = queue.pop();
    if (gid >= numGlyphs) continue;
    const start = offsetOf(gid);
    const end = offsetOf(gid + 1);
    if (end <= start) continue;
    let at = glyf.offset + start;
    if (buffer.readInt16BE(at) >= 0) continue;
    at += 10;
    for (;;) {
      const flags = buffer.readUInt16BE(at);
      const component = buffer.readUInt16BE(at + 2);
      if (!keep.has(component)) {
        keep.add(component);
        queue.push(component);
      }
      at += 4 + (flags & 1 ? 4 : 2);
      if (flags & 8) at += 2;
      else if (flags & 0x40) at += 4;
      else if (flags & 0x80) at += 8;
      if (!(flags & 0x20)) break;
    }
  }
  const pieces = [];
  const newLoca = Buffer.alloc(4 * (numGlyphs + 1));
  let offset = 0;
  for (let gid = 0; gid < numGlyphs; gid++) {
    newLoca.writeUInt32BE(offset, 4 * gid);
    if (!keep.has(gid)) continue;
    const start = offsetOf(gid);
    const end = offsetOf(gid + 1);
    if (end <= start) continue;
    const data = buffer.subarray(glyf.offset + start, glyf.offset + end);
    pieces.push(data);
    offset += data.length;
    if (offset % 4) {
      const pad = 4 - (offset % 4);
      pieces.push(Buffer.alloc(pad));
      offset += pad;
    }
  }
  newLoca.writeUInt32BE(offset, 4 * numGlyphs);
  const copy = (tag) => (tables[tag] ? Buffer.from(buffer.subarray(tables[tag].offset, tables[tag].offset + tables[tag].length)) : null);
  const head = copy('head');
  head.writeUInt32BE(0, 8); // checkSumAdjustment, set below
  head.writeInt16BE(1, 50); // long loca
  const out = { head, hhea: copy('hhea'), hmtx: copy('hmtx'), maxp: copy('maxp'), loca: newLoca, glyf: Buffer.concat(pieces) };
  for (const tag of ['cvt ', 'fpgm', 'prep', 'OS/2', 'post']) if (tables[tag]) out[tag] = copy(tag);
  if (out.post) {
    // Only the post table's header: glyph names aren't needed and the table can be large.
    const header = Buffer.from(out.post.subarray(0, 32));
    header.writeUInt32BE(0x00030000, 0);
    out.post = header;
  }
  return writeSfnt(out);
}

function checksum(data) {
  const padded = data.length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]) : data;
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function writeSfnt(tables) {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  let power = 1;
  let log = 0;
  while (power * 2 <= n) {
    power *= 2;
    log++;
  }
  const header = Buffer.alloc(12 + 16 * n);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(log, 8);
  header.writeUInt16BE(n * 16 - power * 16, 10);
  let offset = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const data = tables[tag];
    const rec = 12 + 16 * i;
    header.write(tag, rec, 4, 'latin1');
    header.writeUInt32BE(checksum(data), rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(data.length, rec + 12);
    const padded = data.length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]) : data;
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headAt = font.readUInt32BE(12 + 16 * tags.indexOf('head') + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}
