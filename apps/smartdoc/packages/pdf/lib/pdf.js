// Writes a PDF: pages drawn in points from the page's top left (as layout thinks of them), text in
// embedded font subsets placed glyph by glyph at the positions layout gave (so kerning, justified
// spaces and letter spacing come out exactly as laid out), with a ToUnicode map so it can be
// selected, searched and copied; pictures; rectangles, lines and paths; links; and an outline.
import { deflateSync } from 'node:zlib';
import { imageInfo } from './image.js';

const fmt = (n) => {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const pdfString = (text) => {
  // UTF-16BE with a byte order mark, as hex: any character, nothing to escape.
  const bytes = Buffer.from(`﻿${text}`, 'utf16le').swap16();
  return `<${bytes.toString('hex')}>`;
};
const safeDecode = (text) => {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
};
// A plain-ASCII string, escaped (what a link's address must be).
const asciiString = (text) => `(${encodeURI(safeDecode(text)).replace(/[\\()]/g, (c) => `\\${c}`)})`;
const colour = (c) => {
  if (!c) return null;
  if (Array.isArray(c)) return c.map((v) => fmt(v)).join(' ');
  const hex = c.replace('#', '');
  return [0, 2, 4].map((i) => fmt(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');
};

export function createPdf({ title = null, author = null, lang = null } = {}) {
  const objects = []; // each { body: string | Buffer } (null until written)
  const reserve = () => {
    objects.push(null);
    return objects.length; // object numbers start at 1
  };
  const set = (n, body) => {
    objects[n - 1] = body;
  };
  const stream = (dict, data, compress = true) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    const body = compress ? deflateSync(bytes) : bytes;
    const filter = compress ? ' /Filter /FlateDecode' : '';
    return Buffer.concat([Buffer.from(`<< ${dict}${filter} /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]);
  };

  const pages = [];
  const fonts = new Map(); // font object → { key, ref, used: Map<gid, text> }
  const images = [];
  const outline = [];
  let fontCount = 0;

  function fontEntry(font) {
    if (!fonts.has(font)) fonts.set(font, { key: `F${++fontCount}`, ref: reserve(), used: new Map() });
    return fonts.get(font);
  }

  function addImage(data) {
    const info = imageInfo(data);
    const ref = reserve();
    const key = `I${images.length + 1}`;
    images.push({ key, ref, info });
    return { key, width: info.width, height: info.height };
  }

  function addPage({ width, height }) {
    const ops = [];
    const links = [];
    const used = { fonts: new Set(), images: new Set(), alphas: new Set() };
    const y = (top) => height - top;
    const page = {
      width,
      height,
      // A run of glyphs on one baseline: `glyphs` is [{ gid, text, advance }] with each advance in
      // points, as laid out; `x`, `baseline` from the page's top left.
      glyphs(font, size, x, baseline, glyphs, { color = '#000000', rise = 0, scaleX = 1, render = 0, outline: outlineWidth = 0 } = {}) {
        if (!glyphs.length) return;
        const entry = fontEntry(font);
        used.fonts.add(entry);
        const parts = [];
        let hex = '';
        for (let i = 0; i < glyphs.length; i++) {
          const g = glyphs[i];
          if (!entry.used.has(g.gid)) entry.used.set(g.gid, g.text ?? '');
          hex += g.gid.toString(16).padStart(4, '0');
          const natural = (font.advance(g.gid) / font.unitsPerEm) * size * scaleX;
          const adjust = ((natural - g.advance) * 1000) / (size * scaleX);
          if (Math.abs(adjust) > 0.01 && i < glyphs.length - 1) {
            parts.push(`<${hex}>`, fmt(adjust));
            hex = '';
          }
        }
        if (hex) parts.push(`<${hex}>`);
        const fill = colour(color);
        ops.push(`BT /${entry.key} ${fmt(size)} Tf ${scaleX !== 1 ? `${fmt(scaleX * 100)} Tz ` : ''}${rise ? `${fmt(rise)} Ts ` : ''}${render ? `${render} Tr ${fmt(outlineWidth)} w ${fill} RG ` : ''}${fill} rg ${fmt(x)} ${fmt(y(baseline))} Td [${parts.join(' ')}] TJ ET`);
      },
      rect(x, top, w, h, { fill = null, stroke = null, lineWidth = 1, dash = null } = {}) {
        const parts = ['q'];
        if (fill) parts.push(`${colour(fill)} rg`);
        if (stroke) parts.push(`${colour(stroke)} RG ${fmt(lineWidth)} w`);
        if (dash) parts.push(`[${dash.map(fmt).join(' ')}] 0 d`);
        parts.push(`${fmt(x)} ${fmt(y(top + h))} ${fmt(w)} ${fmt(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'} Q`);
        ops.push(parts.join(' '));
      },
      line(x1, top1, x2, top2, { stroke = '#000000', lineWidth = 1, dash = null, cap = 0 } = {}) {
        ops.push(`q ${colour(stroke)} RG ${fmt(lineWidth)} w ${cap} J ${dash ? `[${dash.map(fmt).join(' ')}] 0 d ` : ''}${fmt(x1)} ${fmt(y(top1))} m ${fmt(x2)} ${fmt(y(top2))} l S Q`);
      },
      // A path: [['M', x, top], ['L', x, top], ['C', x1, t1, x2, t2, x, top], ['Z']].
      path(commands, { fill = null, stroke = null, lineWidth = 1, evenOdd = false, dash = null } = {}) {
        const parts = ['q'];
        if (fill) parts.push(`${colour(fill)} rg`);
        if (stroke) parts.push(`${colour(stroke)} RG ${fmt(lineWidth)} w`);
        if (stroke && dash) parts.push(`[${dash.map(fmt).join(' ')}] 0 d`);
        for (const [op, ...v] of commands) {
          if (op === 'M') parts.push(`${fmt(v[0])} ${fmt(y(v[1]))} m`);
          else if (op === 'L') parts.push(`${fmt(v[0])} ${fmt(y(v[1]))} l`);
          else if (op === 'C') parts.push(`${fmt(v[0])} ${fmt(y(v[1]))} ${fmt(v[2])} ${fmt(y(v[3]))} ${fmt(v[4])} ${fmt(y(v[5]))} c`);
          else if (op === 'Z') parts.push('h');
        }
        parts.push(`${fill && stroke ? (evenOdd ? 'B*' : 'B') : fill ? (evenOdd ? 'f*' : 'f') : 'S'} Q`);
        ops.push(parts.join(' '));
      },
      // A picture from addImage, in the box (x, top, w, h); `clip` keeps it inside another box.
      image(image, x, top, w, h, { clip = null, rotate = 0 } = {}) {
        const entry = images.find((i) => i.key === image.key);
        used.images.add(entry);
        const parts = ['q'];
        if (clip) parts.push(`${fmt(clip.x)} ${fmt(y(clip.top + clip.h))} ${fmt(clip.w)} ${fmt(clip.h)} re W n`);
        if (rotate) {
          const cx = x + w / 2;
          const cy = y(top + h / 2);
          const r = (-rotate * Math.PI) / 180;
          parts.push(`1 0 0 1 ${fmt(cx)} ${fmt(cy)} cm ${fmt(Math.cos(r))} ${fmt(Math.sin(r))} ${fmt(-Math.sin(r))} ${fmt(Math.cos(r))} 0 0 cm 1 0 0 1 ${fmt(-cx)} ${fmt(-cy)} cm`);
        }
        parts.push(`${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y(top + h))} cm /${image.key} Do Q`);
        ops.push(parts.join(' '));
      },
      // Everything drawn by `draw` only shows inside the box.
      clipped(x, top, w, h, draw) {
        ops.push(`q ${fmt(x)} ${fmt(y(top + h))} ${fmt(w)} ${fmt(h)} re W n`);
        draw();
        ops.push('Q');
      },
      link(x, top, w, h, url) {
        links.push({ rect: [x, y(top + h), x + w, y(top)], url });
      },
      // Raw content, for what nothing above draws.
      raw(content) {
        ops.push(content);
      },
      ops,
      links,
      used,
    };
    pages.push(page);
    return page;
  }

  // A bookmark in the PDF's outline: a heading's text, its page, and how far down it is.
  function bookmark(text, page, top, level = 0) {
    outline.push({ text, page, top, level });
  }

  function finish() {
    const catalog = reserve();
    const pagesRef = reserve();
    const pageRefs = pages.map(() => reserve());
    // Pages.
    pages.forEach((page, i) => {
      const content = reserve();
      set(content, stream('', page.ops.join('\n')));
      const fontRes = [...page.used.fonts].map((f) => `/${f.key} ${f.ref} 0 R`).join(' ');
      const imageRes = [...page.used.images].map((im) => `/${im.key} ${im.ref} 0 R`).join(' ');
      const annots = page.links.map((link) => {
        const ref = reserve();
        set(ref, `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(fmt).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${asciiString(link.url)} >> >>`);
        return `${ref} 0 R`;
      });
      set(pageRefs[i], `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${fmt(page.width)} ${fmt(page.height)}] /Contents ${content} 0 R /Resources << /Font << ${fontRes} >> /XObject << ${imageRes} >> >>${annots.length ? ` /Annots [${annots.join(' ')}]` : ''} >>`);
    });
    set(pagesRef, `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pages.length} >>`);

    // Fonts: each a Type 0 font over a CID font, glyph ids straight through (Identity-H).
    let tagCount = 0;
    for (const [font, entry] of fonts) {
      const tag = subsetTag(tagCount++);
      const base = `${tag}+${(font.names.postscript ?? font.names.family ?? 'Font').replace(/[^A-Za-z0-9-]/g, '')}`;
      const k = 1000 / font.unitsPerEm;
      const gids = [...entry.used.keys()].sort((a, b) => a - b);
      const widths = gids.map((g) => `${g} [${fmt(font.advance(g) * k)}]`).join(' ');
      const fileRef = reserve();
      if (font.cff) {
        // The font file whole (an OpenType font with CFF outlines).
        set(fileRef, stream('/Subtype /OpenType', font.base ? extractFromCollection(font) : font.buffer));
      } else {
        const subset = font.subset(gids) ?? font.buffer;
        set(fileRef, stream(`/Length1 ${subset.length}`, subset));
      }
      const descriptor = reserve();
      let flags = 32; // non-symbolic
      if (font.fixedPitch) flags |= 1;
      if (font.italic) flags |= 64;
      const bbox = font.bbox.map((v) => fmt(v * k)).join(' ');
      set(descriptor, `<< /Type /FontDescriptor /FontName /${base} /Flags ${flags} /FontBBox [${bbox}] /ItalicAngle ${fmt(font.italicAngle)} /Ascent ${fmt(font.ascent * k)} /Descent ${fmt(-font.descent * k)} /CapHeight ${fmt(font.capHeight * k)} /StemV ${font.bold ? 120 : 80} /${font.cff ? 'FontFile3' : 'FontFile2'} ${fileRef} 0 R >>`);
      const cid = reserve();
      set(cid, `<< /Type /Font /Subtype /${font.cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /W [${widths}]${font.cff ? '' : ' /CIDToGIDMap /Identity'} >>`);
      const toUnicode = reserve();
      set(toUnicode, stream('', toUnicodeCmap(entry.used)));
      set(entry.ref, `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
    }

    // Pictures.
    for (const image of images) {
      const { info } = image;
      if (info.kind === 'jpeg') {
        const space = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
        const decode = info.components === 4 && info.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
        set(image.ref, stream(`/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${decode}`, info.data, false));
      } else {
        let mask = '';
        if (info.alpha) {
          const ref = reserve();
          set(ref, stream(`/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /DeviceGray /BitsPerComponent 8`, info.alpha));
          mask = ` /SMask ${ref} 0 R`;
        }
        set(image.ref, stream(`/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${info.colors === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8${mask}`, info.pixels));
      }
    }

    // The outline, nested by level.
    let outlineRef = null;
    if (outline.length) {
      outlineRef = reserve();
      const refs = outline.map(() => reserve());
      const parentOf = outline.map((item, i) => {
        for (let j = i - 1; j >= 0; j--) if (outline[j].level < item.level) return j;
        return -1;
      });
      const kidsOf = (p) => outline.map((_, i) => i).filter((i) => parentOf[i] === p);
      const countOf = (p) => kidsOf(p).reduce((n, i) => n + 1 + countOf(i), 0);
      outline.forEach((item, i) => {
        const siblings = kidsOf(parentOf[i]);
        const at = siblings.indexOf(i);
        const kids = kidsOf(i);
        const pageIndex = pages.indexOf(item.page);
        const dest = `[${pageRefs[pageIndex]} 0 R /XYZ 0 ${fmt(item.page.height - item.top)} 0]`;
        const parent = parentOf[i] < 0 ? outlineRef : refs[parentOf[i]];
        set(refs[i], `<< /Title ${pdfString(item.text)} /Parent ${parent} 0 R${at > 0 ? ` /Prev ${refs[siblings[at - 1]]} 0 R` : ''}${at < siblings.length - 1 ? ` /Next ${refs[siblings[at + 1]]} 0 R` : ''}${kids.length ? ` /First ${refs[kids[0]]} 0 R /Last ${refs[kids.at(-1)]} 0 R /Count ${countOf(i)}` : ''} /Dest ${dest} >>`);
      });
      const top = kidsOf(-1);
      set(outlineRef, `<< /Type /Outlines /First ${refs[top[0]]} 0 R /Last ${refs[top.at(-1)]} 0 R /Count ${countOf(-1)} >>`);
    }

    set(catalog, `<< /Type /Catalog /Pages ${pagesRef} 0 R${outlineRef ? ` /Outlines ${outlineRef} 0 R /PageMode /UseOutlines` : ''}${lang ? ` /Lang ${pdfString(lang)}` : ''} >>`);
    const info = reserve();
    const now = new Date();
    const stamp = `D:${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
    set(info, `<< /Producer (SmartDoc) /CreationDate (${stamp})${title ? ` /Title ${pdfString(title)}` : ''}${author ? ` /Author ${pdfString(author)}` : ''} >>`);

    // The file: header, objects, cross-reference table, trailer.
    const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(offset);
      const bytes = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body ?? 'null', 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
      chunks.push(bytes);
      offset += bytes.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }

  return { addPage, addImage, bookmark, finish, pages };
}

// Six capital letters naming a subset, different for each font in the file.
function subsetTag(n) {
  let tag = '';
  let v = n + 1;
  for (let i = 0; i < 6; i++) {
    tag = String.fromCharCode(65 + (v % 26)) + tag;
    v = Math.floor(v / 26);
  }
  return tag;
}

// Glyph ids back to the characters they show, so the PDF's text can be selected and searched.
function toUnicodeCmap(used) {
  const entries = [...used].filter(([, text]) => text).sort((a, b) => a[0] - b[0]);
  const lines = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [gid, text] of chunk) lines.push(`<${gid.toString(16).padStart(4, '0')}> <${Buffer.from(text, 'utf16le').swap16().toString('hex')}>`);
    lines.push('endbfchar');
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
${lines.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

// A collection's one font as a file of its own: its tables, from the collection.
function extractFromCollection(font) {
  const tags = Object.keys(font.tables);
  const header = Buffer.alloc(12 + 16 * tags.length);
  font.buffer.copy(header, 0, font.base, font.base + 12);
  let offset = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const { offset: from, length } = font.tables[tag];
    const rec = 12 + 16 * i;
    header.write(tag, rec, 4, 'latin1');
    header.writeUInt32BE(0, rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(length, rec + 12);
    const data = font.buffer.subarray(from, from + length);
    const padded = length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (length % 4))]) : data;
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}
