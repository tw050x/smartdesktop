// Finding fonts by the names documents use ("Calibri Light", "Aptos", "Times New Roman"): every
// font in the Mac's font folders, Office's own (inside Word, Excel and PowerPoint, when they're
// installed), and the stand-ins this package ships (fonts/), with the same measurements as
// Office's commonest fonts, so lines and pages break the same when those aren't on the Mac. Only
// each file's names and style are read to index it; a font is read whole when a document uses it.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFont } from './font.js';

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fonts');

// SMARTDOC_PDF_BUNDLED_FONTS=1 uses the bundled fonts alone (to see what a machine without Office's
// fonts makes, as the tests' Linux runner is).
const FOLDERS = () => process.env.SMARTDOC_PDF_BUNDLED_FONTS === '1' ? [BUNDLED] : [
  BUNDLED,
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  path.join(homedir(), 'Library/Fonts'),
  ...['Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint', 'Microsoft Outlook'].map((app) => `/Applications/${app}.app/Contents/Resources/DFonts`),
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  path.join(homedir(), '.fonts'),
  'C:\\Windows\\Fonts',
];

// What stands in for a font that isn't there: the same measurements first (so the text breaks the
// same), then the nearest in look. Word and LibreOffice substitute much the same way.
export const SUBSTITUTES = {
  calibri: ['Carlito'],
  'calibri light': ['Carlito'],
  cambria: ['Caladea'],
  'cambria math': ['Caladea'],
  arial: ['Liberation Sans', 'Helvetica', 'Arimo'],
  helvetica: ['Arial', 'Liberation Sans'],
  'times new roman': ['Liberation Serif', 'Times', 'Tinos'],
  times: ['Times New Roman', 'Liberation Serif'],
  'courier new': ['Liberation Mono', 'Courier', 'Cousine'],
  courier: ['Courier New', 'Liberation Mono'],
  'arial narrow': ['Liberation Sans Narrow'],
  aptos: ['Aptos Display', 'Carlito'],
  'aptos display': ['Aptos', 'Carlito'],
  'segoe ui': ['Helvetica Neue', 'Arial'],
  tahoma: ['Verdana', 'DejaVu Sans'],
  'century gothic': ['Avenir', 'Futura'],
  garamond: ['Garamond Premier Pro', 'EB Garamond', 'Times New Roman'],
  symbol: ['Symbol'],
  wingdings: ['Wingdings'],
};

// The stand-ins with exactly the same measurements as the font they replace (each checked, see
// fonts/README.md): text set in them breaks and sits where it would in the original.
export const METRIC_COMPATIBLE = { calibri: 'Carlito', cambria: 'Caladea', arial: 'Liberation Sans', 'times new roman': 'Liberation Serif', 'courier new': 'Liberation Mono' };

let index = null; // family (lower case) → [{ file, face, family, bold, italic, weight, style }]

function readRange(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, offset);
  return buffer;
}

// A font file's faces, from its table directory and name, OS/2 and head tables only.
function describe(file) {
  const fd = openSync(file, 'r');
  try {
    const start = readRange(fd, 0, 12);
    const tag = start.toString('latin1', 0, 4);
    const bases = [];
    if (tag === 'ttcf') {
      const count = start.readUInt32BE(8);
      const offsets = readRange(fd, 12, 4 * count);
      for (let i = 0; i < count; i++) bases.push(offsets.readUInt32BE(4 * i));
    } else if (['\0\x01\0\0', 'OTTO', 'true'].includes(tag)) bases.push(0);
    else return [];
    return bases.map((base, face) => {
      const head = readRange(fd, base, 12);
      const n = head.readUInt16BE(4);
      const dir = readRange(fd, base + 12, 16 * n);
      const tables = {};
      for (let i = 0; i < n; i++) tables[dir.toString('latin1', 16 * i, 16 * i + 4)] = { offset: dir.readUInt32BE(16 * i + 8), length: dir.readUInt32BE(16 * i + 12) };
      const names = {};
      if (tables.name) {
        const t = readRange(fd, tables.name.offset, tables.name.length);
        const count = t.readUInt16BE(2);
        const strings = t.readUInt16BE(4);
        for (let i = 0; i < count; i++) {
          const at = 6 + 12 * i;
          const platform = t.readUInt16BE(at);
          const id = t.readUInt16BE(at + 6);
          if (![1, 2, 4, 16, 17].includes(id)) continue;
          const bytes = t.subarray(strings + t.readUInt16BE(at + 10), strings + t.readUInt16BE(at + 10) + t.readUInt16BE(at + 8));
          const value = platform === 1 ? bytes.toString('latin1') : Buffer.from(bytes).swap16().toString('utf16le');
          const english = platform !== 3 || t.readUInt16BE(at + 4) === 0x409;
          if (!names[id] || (english && platform === 3)) names[id] = value;
        }
      }
      let weight = 400;
      let italic = false;
      if (tables['OS/2']) {
        const os2 = readRange(fd, tables['OS/2'].offset, Math.min(64, tables['OS/2'].length));
        weight = os2.readUInt16BE(4);
        italic = Boolean(os2.readUInt16BE(62) & 1);
      }
      if (tables.head) {
        const h = readRange(fd, tables.head.offset, 54);
        const macStyle = h.readUInt16BE(44);
        if (macStyle & 2) italic = true;
        if (macStyle & 1 && weight < 600) weight = 700;
      }
      return { file, face, family: names[1] ?? null, style: names[2] ?? null, typoFamily: names[16] ?? null, typoStyle: names[17] ?? null, full: names[4] ?? null, weight, italic };
    });
  } finally {
    closeSync(fd);
  }
}

function buildIndex() {
  index = new Map();
  const add = (key, entry) => {
    if (!key) return;
    const k = key.toLowerCase();
    if (!index.has(k)) index.set(k, []);
    if (!index.get(k).some((e) => e.file === entry.file && e.face === entry.face)) index.get(k).push(entry);
  };
  for (const folder of FOLDERS()) {
    if (!existsSync(folder)) continue;
    let files;
    try {
      files = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!/\.(ttf|otf|ttc)$/i.test(name)) continue;
      const file = path.join(folder, name);
      try {
        if (!statSync(file).isFile()) continue;
        for (const entry of describe(file)) {
          // By the family Word names (the legacy family, "Calibri Light"), and by the typographic
          // family ("Calibri") with its weight and slant, and by its full name.
          add(entry.family, entry);
          add(entry.typoFamily, entry);
          add(entry.full, entry);
        }
      } catch {
        // A font that can't be read is left out.
      }
    }
  }
}

const loaded = new Map(); // file#face → parsed font

function load(entry) {
  const key = `${entry.file}#${entry.face}`;
  if (!loaded.has(key)) loaded.set(key, parseFont(readFileSync(entry.file), entry.face));
  return loaded.get(key);
}

// The face of `family` nearest to bold and italic as asked: an exact style first, else the nearest
// weight with the right slant. `exact` says whether the family itself was found (not a stand-in),
// and `synthetic` whether bold or italic must be made (the family has no such face).
export function findFont(family, { bold = false, italic = false } = {}) {
  if (!index) buildIndex();
  const tried = [];
  const candidates = [family, ...(SUBSTITUTES[family?.toLowerCase()] ?? [])];
  for (const name of candidates) {
    if (!name) continue;
    tried.push(name);
    const faces = index.get(name.toLowerCase());
    if (!faces?.length) continue;
    const wanted = bold ? 700 : 400;
    // Faces whose family is exactly this name (by Word's name or the typographic one).
    const own = faces.filter((f) => [f.family, f.typoFamily].some((n) => n?.toLowerCase() === name.toLowerCase()));
    const pool = own.length ? own : faces;
    const score = (f) => Math.abs(f.weight - wanted) + (f.italic === italic ? 0 : 1000) + (f.family?.toLowerCase() === name.toLowerCase() ? 0 : 1);
    const best = [...pool].sort((a, b) => score(a) - score(b))[0];
    return {
      font: load(best),
      name,
      exact: name === family,
      syntheticBold: bold && best.weight < 600,
      syntheticItalic: italic && !best.italic,
    };
  }
  return null;
}

// Whether a family is on this Mac (or bundled) under its own name.
export function hasFamily(family) {
  if (!index) buildIndex();
  return Boolean(family && index.has(family.toLowerCase()));
}

// Another font file of the same family that has a glyph for `codePoint`: Office's own Symbol and
// Wingdings (inside Word) have Word's symbol codes (U+F0xx), which the Mac's Symbol doesn't.
export function sameFamilyWith(family, codePoint, { bold = false, italic = false } = {}) {
  if (!index || !family) return null;
  const faces = index.get(family.toLowerCase()) ?? [];
  const wanted = bold ? 700 : 400;
  const sorted = [...faces].sort((a, b) => Math.abs(a.weight - wanted) + (a.italic === italic ? 0 : 1000) - (Math.abs(b.weight - wanted) + (b.italic === italic ? 0 : 1000)));
  for (const face of sorted) {
    const font = load(face);
    if (font.has(codePoint)) return { font, name: family, exact: true, syntheticBold: bold && face.weight < 600, syntheticItalic: italic && !face.italic };
  }
  return null;
}

// A font with a glyph for `codePoint`, for text the document's font doesn't cover (symbols, other
// scripts): the usual fallbacks, in order.
const FALLBACKS = ['Arial Unicode MS', 'Helvetica Neue', 'Apple Symbols', 'Menlo', 'Hiragino Sans', 'PingFang SC', 'Apple SD Gothic Neo', 'Geeza Pro', 'Kohinoor Devanagari', 'Apple Color Emoji', 'Liberation Sans', 'Arial'];
export function fallbackFor(codePoint, { bold = false, italic = false } = {}) {
  for (const family of FALLBACKS) {
    const found = findFont(family, { bold, italic });
    if (found?.exact && found.font.has(codePoint)) return found;
  }
  return null;
}

// For tests: forget what's been found, and look again.
export function resetFonts() {
  index = null;
  loaded.clear();
}
