// Which glyph each character code of a font draws, and its outline. An embedded font is drawn from
// its own program: a simple font's codes by glyph name (its Encoding over the program's built-in
// one, as PDF 32000-1 9.6.6 says) or, for TrueType, by the cmap pdf.js would choose; a composite
// font's by CID. A font that isn't embedded, or whose program can't be used, is drawn with the
// bundled font nearest it (Liberation for the standard 14 and their like, Carlito for Calibri,
// Caladea for Cambria), by each code's text; Symbol and ZapfDingbats have none bundled, and are
// drawn as text by the canvas.

import { CFFOutlines, TrueTypeOutlines, Type1Outlines } from './glyphs.js';
import { parseCFF } from './cff.js';
import { ENCODINGS, MAC_GLYPH_ORDER, NON_STD_FONT_MAP, STD_FONT_MAP, dingbatsUnicode, glyphsUnicode } from './data.js';
import { getEncoding, unicodeForGlyph } from './encodings.js';
import { FontFlags, normalizeFontName } from './font.js';
import { readCmap, readPost, readSfnt } from './sfnt.js';

// A glyph name the glyph list knows that means the same as `name` (pdf.js's recoverGlyphName).
function recoverGlyphName(name, map) {
  if (map[name] !== undefined) return name;
  const u = unicodeForGlyph(name, map);
  if (u !== -1) for (const key in map) if (map[key] === u) return key;
  return name;
}

const EMPTY = { cmds: [] };

// A font's drawing side, made once: { glyph(code) -> { cmds } | { text } }.
export function drawingFont(font, fonts) {
  if (font.drawing) return font.drawing;
  let d = null;
  try {
    if (!font.missingFile && font.program) d = embedded(font);
  } catch {
    d = null;
  }
  d ??= substitute(font, fonts);
  font.drawing = d;
  return d;
}

function cidOf(font, code) {
  let cid = code;
  if (font.cMap?.contains(code)) {
    cid = font.cMap.lookup(code);
    if (typeof cid === 'string') {
      let v = 0;
      for (let i = 0; i < cid.length; i++) v = (v << 8) | cid.charCodeAt(i);
      cid = v;
    }
  }
  return cid;
}

// The glyph name each code of a simple font names: its Encoding's base (or the program's built-in
// encoding, or StandardEncoding), with Differences over it.
function nameFor(font, code, builtIn) {
  const p = font.props;
  let name;
  if (p.differences.has(code)) name = p.differences.get(code);
  else if (p.baseEncodingName) name = getEncoding(p.baseEncodingName)[code];
  else if (builtIn) name = builtIn[code];
  else name = (font.defaultEncoding ?? ENCODINGS.StandardEncoding)[code];
  return name;
}

function embedded(font) {
  const { program, props } = font;
  const cache = new Map();
  const cached = (fn) => (code) => {
    let g = cache.get(code);
    if (!g) {
      g = fn(code) ?? EMPTY;
      cache.set(code, g);
    }
    return g;
  };
  const map = glyphsUnicode();
  if (program.kind === 'type1') {
    const outlines = new Type1Outlines(program.type1);
    const builtIn = program.type1.encoding;
    return {
      glyph: cached((code) => {
        let name = nameFor(font, code, builtIn);
        if (name && !outlines.has(name)) name = recoverGlyphName(name, map);
        return name && outlines.has(name) ? { cmds: outlines.outline(name) } : null;
      }),
    };
  }
  if (program.kind === 'cff' || (program.kind === 'sfnt' && program.sfnt.tables['CFF '] && !program.sfnt.tables.glyf)) {
    const cff = program.kind === 'cff' ? program.cff : parseCFF(program.sfnt.tables['CFF '].data);
    const outlines = new CFFOutlines(cff);
    if (program.kind === 'sfnt') return trueType(font, program.sfnt, outlines, cached);
    if (props.composite) {
      return {
        glyph: cached((code) => {
          const cid = cidOf(font, code);
          const gid = cff.isCID ? outlines.cidToGid.get(cid) : cid;
          return gid !== undefined && outlines.has(gid) ? { cmds: outlines.outline(gid) } : null;
        }),
      };
    }
    const builtIn = cff.builtInEncoding;
    return {
      glyph: cached((code) => {
        let name = nameFor(font, code, builtIn);
        let gid = name ? outlines.gidOfName(name) : -1;
        if (gid < 0 && name) gid = outlines.gidOfName(recoverGlyphName(name, map));
        // A symbolic font's codes may name nothing: its built-in encoding's glyph for the code.
        if (gid < 0 && cff.encoding?.[code] !== undefined) gid = cff.encoding[code];
        return gid > 0 && outlines.has(gid) ? { cmds: outlines.outline(gid) } : null;
      }),
    };
  }
  if (program.kind === 'sfnt') return trueType(font, program.sfnt, new TrueTypeOutlines(program.sfnt.tables), cached);
  return null;
}

// TrueType (and OpenType with CFF glyphs mapped the same way): pdf.js's charCodeToGlyphId.
function trueType(font, sfnt, outlines, cached) {
  const props = font.props;
  const tables = sfnt.tables;
  if (props.composite) {
    const cidToGid = props.cidToGidMap;
    return {
      glyph: cached((code) => {
        const cid = cidOf(font, code);
        const gid = cidToGid?.size ? cidToGid.get(cid) ?? 0 : cid;
        return gid > 0 && outlines.has(gid) ? { cmds: outlines.outline(gid) } : null;
      }),
    };
  }
  const symbolic = Boolean(props.flags & FontFlags.Symbolic);
  const numGlyphs = tables.maxp ? (tables.maxp.data[4] << 8) | tables.maxp.data[5] : 0;
  const glyphNames = readPost(tables.post, numGlyphs, MAC_GLYPH_ORDER, props.defaultEncoding);
  const cmap = readCmap(tables.cmap, symbolic, props.hasEncoding);
  const codeToGid = new Map();
  const map = glyphsUnicode();
  let baseEncoding = [];
  let forcePost = false;
  if (props.hasEncoding && (props.baseEncodingName === 'MacRomanEncoding' || props.baseEncodingName === 'WinAnsiEncoding')) baseEncoding = getEncoding(props.baseEncodingName);
  const { platformId, encodingId, mappings } = cmap;
  if (props.hasEncoding && !symbolic && ((platformId === 3 && encodingId === 1) || (platformId === 1 && encodingId === 0))) {
    for (let code = 0; code < 256; code++) {
      let name;
      if (font.differences.has(code)) name = font.differences.get(code);
      else if (baseEncoding.length && baseEncoding[code] !== '') name = baseEncoding[code];
      else name = ENCODINGS.StandardEncoding[code];
      if (!name) continue;
      const standard = recoverGlyphName(name, map);
      let key;
      if (platformId === 3) key = map[standard];
      else {
        const i = ENCODINGS.MacRomanEncoding.indexOf(standard);
        key = i >= 0 ? i : undefined;
      }
      if (key === undefined && !glyphNames && props.hasIncludedToUnicodeMap && !font.toUnicode.identity) {
        const u = font.toUnicode.get(code);
        if (u) key = u.codePointAt(0);
      }
      if (key !== undefined && mappings.has(key)) codeToGid.set(code, mappings.get(key));
    }
  } else if (platformId === 0) {
    for (const [c, g] of mappings) codeToGid.set(c, g);
    forcePost = true;
  } else if (platformId === 3 && encodingId === 0) {
    for (const [c, g] of mappings) codeToGid.set(c >= 0xf000 && c <= 0xf0ff ? c & 0xff : c, g);
  } else for (const [c, g] of mappings) codeToGid.set(c, g);
  if (glyphNames && (baseEncoding.length || font.differences.size)) {
    for (let code = 0; code < 256; code++) {
      if (!forcePost && codeToGid.has(code)) continue;
      const name = font.differences.get(code) || baseEncoding[code];
      if (!name) continue;
      const gid = glyphNames.indexOf(name);
      if (gid > 0 && outlines.has(gid)) codeToGid.set(code, gid);
    }
  }
  // Code 0, if nothing else, draws glyph 0 (.notdef), as pdf.js and Preview draw it.
  if (!codeToGid.has(0) && outlines.has(0)) codeToGid.set(0, 0);
  return {
    glyph: cached((code) => {
      const gid = codeToGid.get(code);
      return gid !== undefined && outlines.has(gid) ? { cmds: outlines.outline(gid) } : null;
    }),
  };
}

// --- Fonts that aren't embedded ---------------------------------------------------------------

// The bundled font file for a font's name and flags, or null for Symbol and ZapfDingbats.
export function substituteFile(font) {
  const raw = (font.name || '').replace(/^[A-Z]{6}\+/, '');
  let name = normalizeFontName(raw);
  name = STD_FONT_MAP[name] || NON_STD_FONT_MAP[name] || name;
  const flags = font.props?.flags ?? 0;
  if (/^Symbol/i.test(name) || /Dingbats|Wingdings|Webdings/i.test(name)) return null;
  const bold = /bold|black|heavy|semibold|demi/i.test(raw) || /Bold/.test(name) || Boolean(flags & FontFlags.ForceBold);
  const italic = /italic|oblique/i.test(raw) || /Italic|Oblique/.test(name) || Boolean(flags & FontFlags.Italic);
  let family;
  if (/^Courier|Mono|Consol|Menlo|Lucida-?Console/i.test(name) || flags & FontFlags.FixedPitch) family = 'LiberationMono';
  else if (/Calibri|Carlito/i.test(name)) family = 'Carlito';
  else if (/Cambria|Caladea/i.test(name)) family = 'Caladea';
  else if (/^Times|Georgia|Garamond|Palatino|Book|Serif|Roman|Minion|Cambria/i.test(name) && !/Sans/i.test(name)) family = 'LiberationSerif';
  else if (/^Helvetica|Arial|Sans|Verdana|Tahoma|Gothic|Segoe|Frutiger|Univers|Myriad/i.test(name)) family = 'LiberationSans';
  else family = flags & FontFlags.Serif ? 'LiberationSerif' : 'LiberationSans';
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return `${family}-${style}.ttf`;
}

const bundled = new Map();
const bundledBytes = new Map();
// Fetches a bundled font's bytes ahead of drawing with it, when `fonts` gives them asynchronously.
export async function prepareBundledFont(font, fonts) {
  if (!fonts || font.isType3Font || font.systemFamily || !font.missingFile) return;
  const file = substituteFile(font);
  if (!file || bundledBytes.has(file) || bundled.has(file)) return;
  try {
    bundledBytes.set(file, await fonts(file));
  } catch {
    bundledBytes.set(file, null);
  }
}
function bundledFont(file, fonts) {
  if (bundled.has(file)) return bundled.get(file);
  let f = null;
  try {
    let bytes = bundledBytes.get(file);
    if (bytes === undefined) bytes = fonts?.(file);
    if (bytes && typeof bytes.then === 'function') bytes = null;
    if (bytes) {
      const sfnt = readSfnt(bytes);
      const cmap = readUnicodeCmap(sfnt.tables.cmap);
      f = { outlines: new TrueTypeOutlines(sfnt.tables), cmap };
    }
  } catch {
    f = null;
  }
  bundled.set(file, f);
  return f;
}

// A font's Unicode cmap (3, 1 or 0, x), for the bundled fonts.
function readUnicodeCmap(table) {
  return readCmap(table, false, true).mappings;
}

// What each code is as text, for drawing it in another font.
function textOf(font, code) {
  // Dingbats are named a1, a2…: their own list gives their characters.
  if (/Dingbats/i.test(font.name) && !font.composite) {
    const name = nameFor(font, code, null);
    const u = name ? dingbatsUnicode()[name] : undefined;
    if (u) return String.fromCodePoint(u);
  }
  const glyph = font.charToGlyph(code);
  let t = glyph.unicode;
  if ((!t || t === String.fromCharCode(code)) && !font.composite) {
    const name = nameFor(font, code, null);
    const u = name ? unicodeForGlyph(name) : -1;
    if (u > 0) t = String.fromCodePoint(u);
  }
  return t ?? '';
}

// Fonts installed on the computer, found by name as the canvas's text engine sees them: a PDF's
// font that isn't embedded is drawn with the installed font of its name if there is one, as
// Preview does (and pdf.js), else with a bundled one. `prepareSystemFont` looks once per name.
const systemFonts = new Map();
async function loadLocal(name) {
  if (systemFonts.has(name)) return systemFonts.get(name);
  let family = null;
  try {
    if (typeof FontFace !== 'undefined' && (globalThis.document?.fonts || globalThis.fonts)) {
      const set = globalThis.document?.fonts ?? globalThis.fonts;
      family = `pdf-local-${systemFonts.size}`;
      const face = new FontFace(family, `local("${name.replace(/"/g, '')}")`);
      await face.load();
      set.add(face);
    }
  } catch {
    family = null;
  }
  systemFonts.set(name, family);
  return family;
}

export async function prepareSystemFont(font) {
  if (font.systemFamily !== undefined || !font.missingFile || font.isType3Font) return;
  font.systemFamily = null;
  const raw = (font.name || '').replace(/^[A-Z]{6}\+/, '');
  if (!raw) return;
  const ps = raw.replace(/,/g, '-').replace(/\s/g, '');
  const standard = STD_FONT_MAP[normalizeFontName(raw)];
  // Its PostScript name, that with Microsoft's "MT" ("Arial,Bold" is Arial-BoldMT), and the
  // standard font it stands for ("Helvetica-Narrow" is Helvetica).
  // Some are PS…MT ("CourierNew" is CourierNewPSMT, "TimesNewRoman,Bold" TimesNewRomanPS-BoldMT).
  const [family, style] = ps.split('-', 2);
  const psmt = style ? `${family}PS-${style}MT` : `${family}PSMT`;
  const candidates = [...new Set([ps, `${ps}MT`, psmt, standard].filter(Boolean))];
  for (const name of candidates) {
    const family = await loadLocal(name);
    if (family) {
      font.systemFamily = family;
      font.drawing = null;
      return;
    }
  }
}

function substitute(font, fonts) {
  if (font.systemFamily) {
    const cache = new Map();
    return {
      substitute: 'system',
      glyph(code) {
        let g = cache.get(code);
        if (!g) {
          const text = textOf(font, code);
          g = text.trim() ? { text, family: font.systemFamily } : EMPTY;
          cache.set(code, g);
        }
        return g;
      },
    };
  }
  const file = substituteFile(font);
  const sub = file ? bundledFont(file, fonts) : null;
  const cache = new Map();
  return {
    substitute: file ?? 'text',
    glyph(code) {
      let g = cache.get(code);
      if (g) return g;
      const text = textOf(font, code);
      if (sub) {
        const cp = text.codePointAt(0);
        const gid = sub.cmap.get(cp) ?? sub.cmap.get(0xf000 + code);
        g = gid ? { cmds: sub.outlines.outline(gid) } : text.trim() ? { text } : EMPTY;
      } else g = text.trim() ? { text } : EMPTY;
      cache.set(code, g);
      return g;
    },
  };
}
