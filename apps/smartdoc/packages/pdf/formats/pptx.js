// PowerPoint presentations (.pptx), a page a slide: each slide's background and shapes, over its
// layout's and master's own, with what its placeholders inherit from them (where they sit, how
// their text looks); shapes in their preset or drawn geometry, filled and outlined, rotated and
// flipped, in groups; text boxes laid out by the flowing engine (insets, anchoring, autofit,
// bullets and numbering); pictures, cropped; tables. Hidden slides are left out, as PowerPoint
// leaves them out of a PDF.
import { createPdf } from '../lib/pdf.js';
import { drawItems, layoutBlocks } from '../lib/flow.js';
import { openPackage, readTheme } from '../lib/office.js';
import { child, children, textOf } from '../lib/xml.js';

const EMU = 1 / 12700; // EMUs → points
const LEVELS = ['a:lvl1pPr', 'a:lvl2pPr', 'a:lvl3pPr', 'a:lvl4pPr', 'a:lvl5pPr', 'a:lvl6pPr', 'a:lvl7pPr', 'a:lvl8pPr', 'a:lvl9pPr'];

export function pptxToPdf(bytes, { report, title } = {}) {
  const pkg = openPackage(bytes);
  const mainName = pkg.main('ppt/presentation.xml');
  const pres = pkg.part(mainName);
  if (!pres) throw new Error('The PowerPoint presentation is damaged: it has no presentation part.');
  const rels = pkg.rels(mainName);
  const size = child(pres, 'p:sldSz')?.attrs ?? {};
  const width = Number(size.cx ?? 12192000) * EMU;
  const height = Number(size.cy ?? 6858000) * EMU;
  const pdf = createPdf({ title });
  const images = new Map();
  const imageFor = (part) => {
    if (!images.has(part)) {
      let image = null;
      try {
        image = pdf.addImage(pkg.zip.read(part));
      } catch {
        report?.note('Some pictures are in a format that can’t be shown yet (only PNG and JPEG are).');
      }
      images.set(part, image);
    }
    return images.get(part);
  };
  const defaultStyle = child(pres, 'p:defaultTextStyle');
  let number = 0;
  let pages = 0;
  for (const id of children(child(pres, 'p:sldIdLst'), 'p:sldId')) {
    number++;
    const slideName = rels.get(id.attrs['r:id'])?.target;
    const slide = pkg.part(slideName);
    if (!slide) continue;
    if (slide.attrs.show === '0' || slide.attrs.show === 'false') {
      report?.note('Hidden slides are left out, as PowerPoint leaves them out of a PDF.');
      continue;
    }
    const layoutName = relOfType(pkg, slideName, 'slideLayout');
    const masterName = layoutName && relOfType(pkg, layoutName, 'slideMaster');
    const themeName = masterName && relOfType(pkg, masterName, 'theme');
    const themeRoot = pkg.part(themeName);
    const theme = { ...readTheme(themeRoot), styles: readFormatScheme(themeRoot) };
    const master = { name: masterName, root: pkg.part(masterName) };
    const layout = { name: layoutName, root: pkg.part(layoutName) };
    const clrMap = { ...(child(master.root, 'p:clrMap')?.attrs ?? {}) };
    for (const part of [layout.root, slide]) {
      const over = child(child(part, 'p:clrMapOvr'), 'a:overrideClrMapping');
      if (over) Object.assign(clrMap, over.attrs);
    }
    const ctx = { pkg, theme, clrMap, master, layout, slide: { name: slideName, root: slide }, report, imageFor, number, defaultStyle, width, height };
    const page = pdf.addPage({ width, height });
    pages++;
    drawBackground(page, ctx);
    const showMaster = (root) => root?.attrs.showMasterSp !== '0' && root?.attrs.showMasterSp !== 'false';
    if (showMaster(slide) && showMaster(layout.root)) drawTree(page, master.root, { ...ctx, part: masterName, template: true });
    if (showMaster(slide)) drawTree(page, layout.root, { ...ctx, part: layoutName, template: true });
    drawTree(page, slide, { ...ctx, part: slideName, template: false });
  }
  if (!pages) {
    pdf.addPage({ width, height });
    pages = 1;
  }
  return { pdf: pdf.finish(), pages };
}

function relOfType(pkg, part, type) {
  for (const r of pkg.rels(part).values()) if (r.type === type) return r.target;
  return null;
}

// The theme's fill, line and background styles, for shapes that use them by number (p:style).
function readFormatScheme(theme) {
  const fmt = child(child(theme, 'a:themeElements'), 'a:fmtScheme');
  return {
    fills: children(child(fmt, 'a:fillStyleLst')),
    lines: children(child(fmt, 'a:lnStyleLst'), 'a:ln'),
    backgrounds: children(child(fmt, 'a:bgFillStyleLst')),
  };
}

// --- Colours -------------------------------------------------------------------------------------

const PRESET = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', darkGray: '#a9a9a9', lightGray: '#d3d3d3', orange: '#ffa500', purple: '#800080', navy: '#000080' };
const SCHEME_ALIAS = { bg1: 'bg1', tx1: 'tx1', bg2: 'bg2', tx2: 'tx2' };

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const hexOf = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')}`;
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

// A colour element (srgbClr, schemeClr …, with its modifiers) as { hex, alpha }, or null.
function colorOf(el, ctx, ph = null) {
  if (!el) return null;
  let hex = null;
  const a = el.attrs ?? {};
  if (el.name === 'a:srgbClr') hex = `#${a.val}`;
  else if (el.name === 'a:sysClr') hex = `#${a.lastClr ?? (a.val === 'window' ? 'FFFFFF' : '000000')}`;
  else if (el.name === 'a:prstClr') hex = PRESET[a.val] ?? '#000000';
  else if (el.name === 'a:scrgbClr') hex = hexOf([a.r, a.g, a.b].map((v) => toSrgb(Number(v) / 100000)));
  else if (el.name === 'a:hslClr') hex = hexOf(hslToRgb([Number(a.hue) / 21600000, Number(a.sat) / 100000, Number(a.lum) / 100000]));
  else if (el.name === 'a:schemeClr') {
    if (a.val === 'phClr') {
      if (!ph) return null;
      hex = ph.hex;
    } else {
      const mapped = SCHEME_ALIAS[a.val] ? ctx.clrMap[a.val] ?? { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[a.val] : a.val;
      hex = ctx.theme.colors[mapped] ?? null;
    }
  }
  if (!hex) return null;
  let rgb = rgbOf(hex);
  let alpha = 1;
  for (const m of el.children ?? []) {
    const v = Number(m.attrs?.val ?? 0) / 100000;
    if (m.name === 'a:tint') rgb = rgb.map((c) => toSrgb(toLinear(c) * v + (1 - v)));
    else if (m.name === 'a:shade') rgb = rgb.map((c) => toSrgb(toLinear(c) * v));
    else if (m.name === 'a:lumMod' || m.name === 'a:lumOff' || m.name === 'a:satMod') {
      const hsl = rgbToHsl(rgb);
      if (m.name === 'a:lumMod') hsl[2] = Math.min(1, hsl[2] * v);
      else if (m.name === 'a:lumOff') hsl[2] = Math.min(1, Math.max(0, hsl[2] + v));
      else hsl[1] = Math.min(1, hsl[1] * v);
      rgb = hslToRgb(hsl);
    } else if (m.name === 'a:alpha') alpha = v;
  }
  return { hex: hexOf(rgb), alpha };
}

const COLOR_NAMES = new Set(['a:srgbClr', 'a:schemeClr', 'a:sysClr', 'a:prstClr', 'a:scrgbClr', 'a:hslClr']);
const colorIn = (el, ctx, ph) => colorOf((el?.children ?? []).find((c) => COLOR_NAMES.has(c.name)), ctx, ph);

// A fill element's look: { color } | { image, crop } | null (none); gradients as their middle colour.
function fillOf(el, ctx, ph = null) {
  if (!el) return undefined;
  if (el.name === 'a:noFill') return null;
  if (el.name === 'a:solidFill') {
    const c = colorIn(el, ctx, ph);
    return c ? { color: c.hex, alpha: c.alpha } : null;
  }
  if (el.name === 'a:gradFill') {
    const stops = children(child(el, 'a:gsLst'), 'a:gs').map((g) => colorIn(g, ctx, ph)).filter(Boolean);
    if (!stops.length) return null;
    ctx.report?.note('Gradient fills are shown as a single colour.');
    const mid = stops.map((s) => rgbOf(s.hex)).reduce((acc, c) => acc.map((v, i) => v + c[i] / stops.length), [0, 0, 0]);
    return { color: hexOf(mid), alpha: stops[0].alpha };
  }
  if (el.name === 'a:pattFill') {
    const c = colorIn(child(el, 'a:fgClr'), ctx, ph);
    return c ? { color: c.hex, alpha: c.alpha } : null;
  }
  if (el.name === 'a:blipFill' || el.name === 'p:blipFill') {
    const blip = child(el, 'a:blip');
    const target = blip && ctx.pkg.rels(ctx.part).get(blip.attrs['r:embed'])?.target;
    if (!target) return null;
    const src = child(el, 'a:srcRect')?.attrs ?? {};
    return { image: target, crop: { l: Number(src.l ?? 0) / 100000, t: Number(src.t ?? 0) / 100000, r: Number(src.r ?? 0) / 100000, b: Number(src.b ?? 0) / 100000 } };
  }
  if (el.name === 'a:grpFill') return ctx.groupFill ?? null;
  return undefined;
}
const FILL_NAMES = new Set(['a:noFill', 'a:solidFill', 'a:gradFill', 'a:pattFill', 'a:blipFill', 'a:grpFill']);
const fillIn = (el, ctx, ph) => {
  const f = (el?.children ?? []).find((c) => FILL_NAMES.has(c.name));
  return f ? fillOf(f, ctx, ph) : undefined;
};

// --- Backgrounds ---------------------------------------------------------------------------------

function drawBackground(page, ctx) {
  for (const root of [ctx.slide.root, ctx.layout.root, ctx.master.root]) {
    const bg = child(child(root, 'p:cSld'), 'p:bg');
    if (!bg) continue;
    const part = root === ctx.slide.root ? ctx.slide.name : root === ctx.layout.root ? ctx.layout.name : ctx.master.name;
    const pr = child(bg, 'p:bgPr');
    let fill;
    if (pr) fill = fillIn(pr, { ...ctx, part });
    else {
      const ref = child(bg, 'p:bgRef');
      if (ref) {
        const idx = Number(ref.attrs.idx);
        const ph = colorIn(ref, ctx);
        const style = idx >= 1001 ? ctx.theme.styles.backgrounds[idx - 1001] : ctx.theme.styles.fills[idx - 1];
        fill = style ? fillOf(style, { ...ctx, part: ctx.master.name }, ph) : undefined;
      }
    }
    if (fill === undefined) continue;
    paint(page, fill, 0, 0, ctx.width, ctx.height, ctx);
    return;
  }
}

// Fills a box with a fill: a colour, or a picture stretched over it (cropped).
function paint(page, fill, x, y, w, h, ctx) {
  if (!fill) return;
  if (fill.color) {
    if ((fill.alpha ?? 1) < 0.02) return;
    page.rect(x, y, w, h, { fill: blend(fill) });
  } else if (fill.image) {
    const image = ctx.imageFor(fill.image);
    if (!image) return;
    const { l, t, r, b } = fill.crop;
    const fw = w / Math.max(0.01, 1 - l - r);
    const fh = h / Math.max(0.01, 1 - t - b);
    page.image(image, x - l * fw, y - t * fh, fw, fh, { clip: { x, top: y, w, h } });
  }
}

// A colour with transparency, shown over white (the PDF writer has no transparency for fills).
function blend(fill) {
  const a = fill.alpha ?? 1;
  if (a >= 0.999) return fill.color;
  return hexOf(rgbOf(fill.color).map((v) => v * a + (1 - a)));
}

// --- Shapes --------------------------------------------------------------------------------------

function drawTree(page, root, ctx) {
  const tree = child(child(root, 'p:cSld'), 'p:spTree');
  if (!tree) return;
  drawChildren(page, tree, ctx, null);
}

function drawChildren(page, container, ctx, group) {
  for (const el of container.children ?? []) {
    const name = el.name.replace(/^dsp:/, 'p:');
    if (name === 'p:sp' || name === 'p:cxnSp') drawShape(page, el, ctx, group);
    else if (name === 'p:pic') drawPicture(page, el, ctx, group);
    else if (name === 'p:grpSp') drawGroup(page, el, ctx, group);
    else if (name === 'p:graphicFrame') drawFrame(page, el, ctx, group);
    else if (name === 'mc:AlternateContent') {
      const choice = child(el, 'mc:Fallback') ?? child(el, 'mc:Choice');
      if (choice) drawChildren(page, choice, ctx, group);
    }
  }
}

// A shape's box in points: its own xfrm, or its placeholder's on the layout or master; mapped
// through the groups it's in.
function boxOf(xfrm, group) {
  if (!xfrm) return null;
  const off = child(xfrm, 'a:off')?.attrs ?? {};
  const ext = child(xfrm, 'a:ext')?.attrs ?? {};
  let box = { x: Number(off.x ?? 0) * EMU, y: Number(off.y ?? 0) * EMU, w: Number(ext.cx ?? 0) * EMU, h: Number(ext.cy ?? 0) * EMU };
  if (group) box = group.map(box);
  return {
    ...box,
    rot: Number(xfrm.attrs.rot ?? 0) / 60000 + (group?.rot ?? 0),
    flipH: (xfrm.attrs.flipH === '1') !== Boolean(group?.flipH),
    flipV: (xfrm.attrs.flipV === '1') !== Boolean(group?.flipV),
  };
}

function drawGroup(page, el, ctx, group) {
  const pr = child(el, 'p:grpSpPr') ?? child(el, 'dsp:grpSpPr');
  const xfrm = child(pr, 'a:xfrm');
  const off = child(xfrm, 'a:off')?.attrs ?? {};
  const ext = child(xfrm, 'a:ext')?.attrs ?? {};
  const chOff = child(xfrm, 'a:chOff')?.attrs ?? off;
  const chExt = child(xfrm, 'a:chExt')?.attrs ?? ext;
  const sx = Number(chExt.cx) ? Number(ext.cx) / Number(chExt.cx) : 1;
  const sy = Number(chExt.cy) ? Number(ext.cy) / Number(chExt.cy) : 1;
  const own = (b) => ({ x: (Number(off.x ?? 0) + (b.x / EMU - Number(chOff.x ?? 0)) * sx) * EMU, y: (Number(off.y ?? 0) + (b.y / EMU - Number(chOff.y ?? 0)) * sy) * EMU, w: b.w * sx, h: b.h * sy });
  const inner = {
    map: (b) => (group ? group.map(own(b)) : own(b)),
    rot: (group?.rot ?? 0),
    flipH: Boolean(group?.flipH),
    flipV: Boolean(group?.flipV),
  };
  if (Number(xfrm?.attrs.rot ?? 0)) ctx.report?.note('Rotated groups are shown unrotated.');
  drawChildren(page, el, { ...ctx, groupFill: fillIn(pr, ctx) }, inner);
}

// The placeholder a slide's (or layout's) shape fills, on the layout and then the master.
function placeholderOf(el) {
  const nv = child(el, 'p:nvSpPr') ?? child(el, 'p:nvPicPr') ?? child(el, 'p:nvGraphicFramePr') ?? child(el, 'p:nvCxnSpPr');
  const ph = child(child(nv, 'p:nvPr'), 'p:ph');
  return ph ? { type: ph.attrs.type ?? 'body', idx: ph.attrs.idx ?? null } : null;
}
const kindOf = (type) => (type === 'title' || type === 'ctrTitle' ? 'title' : ['dt', 'ftr', 'sldNum', 'hdr'].includes(type) ? type : 'body');

function findPlaceholder(root, ph) {
  const tree = child(child(root, 'p:cSld'), 'p:spTree');
  const shapes = [];
  const walk = (c) => {
    for (const el of c?.children ?? []) {
      if (el.name === 'p:grpSp') walk(el);
      else if (placeholderOf(el)) shapes.push(el);
    }
  };
  walk(tree);
  const of = (el) => placeholderOf(el);
  return (
    (ph.idx != null && shapes.find((s) => of(s).idx === ph.idx)) ||
    shapes.find((s) => of(s).type === ph.type) ||
    shapes.find((s) => kindOf(of(s).type) === kindOf(ph.type) && (kindOf(ph.type) !== 'body' || ph.idx == null || of(s).idx == null)) ||
    (kindOf(ph.type) === 'body' ? shapes.find((s) => of(s).type === 'body') : null) ||
    null
  );
}

// What a shape inherits: [master's placeholder, layout's placeholder] (outermost first).
function inheritedOf(el, ctx) {
  const ph = placeholderOf(el);
  if (!ph) return [];
  const chain = [];
  if (ctx.part === ctx.slide.name) {
    const fromLayout = findPlaceholder(ctx.layout.root, ph);
    const fromMaster = findPlaceholder(ctx.master.root, fromLayout ? placeholderOf(fromLayout) : ph) ?? findPlaceholder(ctx.master.root, ph);
    if (fromMaster) chain.push({ el: fromMaster, part: ctx.master.name });
    if (fromLayout) chain.push({ el: fromLayout, part: ctx.layout.name });
  } else if (ctx.part === ctx.layout.name) {
    const fromMaster = findPlaceholder(ctx.master.root, ph);
    if (fromMaster) chain.push({ el: fromMaster, part: ctx.master.name });
  }
  return chain;
}

const spPrOf = (el) => child(el, 'p:spPr') ?? child(el, 'dsp:spPr');

function drawShape(page, el, ctx, group) {
  const ph = placeholderOf(el);
  // A master's or layout's placeholders are templates: only the slide's own show (with their
  // text), apart from the master's and layout's other shapes.
  if (ctx.template && ph) return;
  const chain = inheritedOf(el, ctx);
  const spPr = spPrOf(el);
  let xfrm = child(spPr, 'a:xfrm');
  for (let i = chain.length - 1; !xfrm && i >= 0; i--) xfrm = child(spPrOf(chain[i].el), 'a:xfrm');
  const box = boxOf(xfrm, group);
  if (!box) return;
  const style = child(el, 'p:style') ?? child(el, 'dsp:style');
  // Fill and outline: the shape's own, its placeholder's, else its style's from the theme.
  let fill = fillIn(spPr, ctx);
  for (let i = chain.length - 1; fill === undefined && i >= 0; i--) fill = fillIn(spPrOf(chain[i].el), { ...ctx, part: chain[i].part });
  if (fill === undefined && style) {
    const ref = child(style, 'a:fillRef');
    const idx = Number(ref?.attrs.idx ?? 0);
    const tpl = idx >= 1001 ? ctx.theme.styles.backgrounds[idx - 1001] : ctx.theme.styles.fills[idx - 1];
    fill = idx && tpl ? fillOf(tpl, ctx, colorIn(ref, ctx)) : null;
  }
  const line = lineOf(spPr, style, ctx, chain);
  const geom = child(spPr, 'a:prstGeom') ?? child(spPr, 'a:custGeom');
  const isLine = ['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3'].includes(geom?.attrs?.prst);
  // The geometry: drawn flipped and rotated with the shape; its text only rotated.
  if (geom && (fill || line)) {
    withTransform(page, box, { flip: true }, () => {
      const paths = geometry(geom, box.w, box.h, ctx);
      for (const p of paths) {
        const commands = p.commands.map(([op, ...v]) => [op, ...v.map((n, i) => n + (i % 2 === 0 ? box.x : box.y))]);
        const f = p.fill === false || isLine ? null : fill;
        const showLine = p.stroke !== false && line;
        if (f?.image) {
          page.clipped(box.x, box.y, box.w, box.h, () => paint(page, f, box.x, box.y, box.w, box.h, ctx));
          if (showLine) page.path(commands, { stroke: line.color, lineWidth: line.width });
          continue;
        }
        if (!f && !showLine) continue;
        page.path(commands, { fill: f ? blend(f) : null, stroke: showLine ? line.color : null, lineWidth: line?.width ?? 1, dash: showLine ? line.dash : null });
      }
      if (line && (line.head || line.tail) && paths[0]) drawArrowHeads(page, paths[0].commands, box, line);
    });
  }
  const txBody = child(el, 'p:txBody') ?? child(el, 'dsp:txBody');
  if (txBody) {
    const fontRef = child(style, 'a:fontRef');
    const styleColor = fontRef ? colorIn(fontRef, ctx) : null;
    // A SmartArt shape's text has a box of its own (dsp:txXfrm).
    const textBox = boxOf(child(el, 'dsp:txXfrm'), group) ?? box;
    withTransform(page, textBox, { flip: false }, () => drawText(page, txBody, textBox, { ...ctx, chain, ph, styleColor }));
  }
}

// An outline: the shape's own a:ln, its placeholder's, else its style's line from the theme.
function lineOf(spPr, style, ctx, chain = []) {
  let ln = child(spPr, 'a:ln');
  for (let i = chain.length - 1; !ln && i >= 0; i--) ln = child(spPrOf(chain[i].el), 'a:ln');
  let ph = null;
  let themed = null;
  const ref = child(style, 'a:lnRef');
  if (ref && Number(ref.attrs.idx)) {
    themed = ctx.theme.styles.lines[Number(ref.attrs.idx) - 1];
    ph = colorIn(ref, ctx);
  }
  const fillOfLine = (l) => (l ? fillIn(l, ctx, ph) : undefined);
  let fill = fillOfLine(ln);
  if (fill === undefined) fill = fillOfLine(themed);
  if (!fill || !fill.color) return null;
  const w = Number(ln?.attrs.w ?? themed?.attrs.w ?? 12700) * EMU;
  const dashName = child(ln, 'a:prstDash')?.attrs.val ?? child(themed, 'a:prstDash')?.attrs.val ?? 'solid';
  const unit = Math.max(w, 0.75);
  const dash = { dash: [4, 3], dot: [1, 1], dashDot: [4, 3, 1, 3], lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDash: [3, 1], sysDot: [1, 1], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1] }[dashName];
  const end = (name) => {
    const e = child(ln, name)?.attrs;
    return e && e.type && e.type !== 'none' ? { type: e.type, w: e.w ?? 'med', len: e.len ?? 'med' } : null;
  };
  return { color: blend(fill), width: w, dash: dash?.map((d) => d * unit), head: end('a:headEnd'), tail: end('a:tailEnd') };
}

function drawArrowHeads(page, commands, box, line) {
  const pts = commands.filter((c) => c[0] !== 'Z').map((c) => [c[c.length - 2] + box.x, c[c.length - 1] + box.y]);
  if (pts.length < 2) return;
  const head = (tip, from, spec) => {
    const size = Math.max(line.width * 3, 4) * ({ sm: 0.7, med: 1, lg: 1.5 }[spec.len] ?? 1);
    const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
    const wing = (d) => [tip[0] - size * Math.cos(ang + d), tip[1] - size * Math.sin(ang + d)];
    page.path([['M', ...tip], ['L', ...wing(0.45)], ['L', ...wing(-0.45)], ['Z']], { fill: line.color });
  };
  if (line.head) head(pts[0], pts[1], line.head);
  if (line.tail) head(pts[pts.length - 1], pts[pts.length - 2], line.tail);
}

// Draws with the shape's rotation (and, for its geometry, its flips) about its middle.
function withTransform(page, box, { flip }, draw) {
  const rot = ((box.rot % 360) + 360) % 360;
  const fh = flip && box.flipH;
  const fv = flip && box.flipV;
  if (!rot && !fh && !fv) return draw();
  const cx = box.x + box.w / 2;
  const cy = page.height - (box.y + box.h / 2);
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const f = (v) => (Math.round(v * 10000) / 10000).toString();
  page.raw(`q 1 0 0 1 ${f(cx)} ${f(cy)} cm ${f(c)} ${f(-s)} ${f(s)} ${f(c)} 0 0 cm ${fh ? -1 : 1} 0 0 ${fv ? -1 : 1} 0 0 cm 1 0 0 1 ${f(-cx)} ${f(-cy)} cm`);
  draw();
  page.raw('Q');
}

function drawPicture(page, el, ctx, group) {
  if (ctx.template && placeholderOf(el)) return;
  const chain = inheritedOf(el, ctx);
  const spPr = spPrOf(el);
  let xfrm = child(spPr, 'a:xfrm');
  for (let i = chain.length - 1; !xfrm && i >= 0; i--) xfrm = child(spPrOf(chain[i].el), 'a:xfrm');
  const box = boxOf(xfrm, group);
  if (!box) return;
  const fill = fillOf(child(el, 'p:blipFill'), ctx);
  const geom = child(spPr, 'a:prstGeom');
  const line = lineOf(spPr, child(el, 'p:style'), ctx);
  withTransform(page, box, { flip: true }, () => {
    if (fill) {
      if (geom && geom.attrs.prst !== 'rect') {
        // A picture in a shape (an ellipse, a rounded rectangle): clipped to it.
        const [p] = geometry(geom, box.w, box.h, ctx);
        const commands = p.commands.map(([op, ...v]) => [op, ...v.map((n, i) => n + (i % 2 === 0 ? box.x : box.y))]);
        page.raw('q');
        clipPath(page, commands);
        paint(page, fill, box.x, box.y, box.w, box.h, ctx);
        page.raw('Q');
      } else paint(page, fill, box.x, box.y, box.w, box.h, ctx);
    }
    if (line) page.rect(box.x, box.y, box.w, box.h, { stroke: line.color, lineWidth: line.width });
  });
}

// Clips what follows (until the next Q) to a path.
function clipPath(page, commands) {
  const f = (v) => (Math.round(v * 1000) / 1000).toString();
  const y = (t) => page.height - t;
  const parts = [];
  for (const [op, ...v] of commands) {
    if (op === 'M') parts.push(`${f(v[0])} ${f(y(v[1]))} m`);
    else if (op === 'L') parts.push(`${f(v[0])} ${f(y(v[1]))} l`);
    else if (op === 'C') parts.push(`${f(v[0])} ${f(y(v[1]))} ${f(v[2])} ${f(y(v[3]))} ${f(v[4])} ${f(y(v[5]))} c`);
    else if (op === 'Z') parts.push('h');
  }
  page.raw(`${parts.join(' ')} W n`);
}

function drawFrame(page, el, ctx, group) {
  if (ctx.template && placeholderOf(el)) return;
  const xfrm = child(el, 'p:xfrm') ?? child(el, 'dsp:xfrm');
  const box = boxOf(xfrm, group);
  const data = child(child(el, 'a:graphic'), 'a:graphicData');
  const uri = data?.attrs.uri ?? '';
  if (!box || !data) return;
  if (uri.endsWith('/table')) drawTable(page, child(data, 'a:tbl'), box, ctx);
  else if (uri.endsWith('/chart')) ctx.report?.note('Charts aren’t shown yet.');
  else if (uri.endsWith('/diagram')) {
    // SmartArt: PowerPoint keeps a drawing of it, shapes like any other, which is what shows.
    // Its data part names the drawing (dsp:dataModelExt), among the slide's relationships.
    const ids = child(data, 'dgm:relIds');
    const rels = ctx.pkg.rels(ctx.part);
    const dataPart = ids && ctx.pkg.part(rels.get(ids.attrs['r:dm'])?.target);
    const ext = dataPart && findDeep(dataPart, 'dsp:dataModelExt');
    const drawingName = (ext && rels.get(ext.attrs.relId)?.target) ?? [...rels.values()].find((r) => r.type === 'diagramDrawing')?.target;
    const drawing = drawingName && ctx.pkg.part(drawingName);
    if (drawing) {
      const tree = child(drawing, 'dsp:spTree');
      const shift = { map: (b) => ({ ...b, x: b.x + box.x, y: b.y + box.y }), rot: 0 };
      drawChildren(page, tree, { ...ctx, part: drawingName, template: false }, shift);
    } else ctx.report?.note('SmartArt graphics aren’t shown yet.');
  } else if (uri.includes('/ole') || uri.includes('oleObj')) ctx.report?.note('Embedded objects aren’t shown yet.');
}

function findDeep(el, name) {
  for (const c of el?.children ?? []) {
    if (c.name === name) return c;
    const found = findDeep(c, name);
    if (found) return found;
  }
  return null;
}

// --- Geometry ------------------------------------------------------------------------------------

const K = 0.5523; // a quarter circle as a Bézier curve

function ellipsePath(x, y, w, h) {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry],
    ['C', cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy],
    ['C', cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry],
    ['C', cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy],
    ['Z'],
  ];
}

const poly = (pts) => [['M', ...pts[0]], ...pts.slice(1).map((p) => ['L', ...p]), ['Z']];

// A preset or custom geometry as paths ({ commands, fill?, stroke? }) in the shape's box (0,0 to w,h).
function geometry(geom, w, h, ctx) {
  if (geom.name === 'a:custGeom') return customGeometry(geom, w, h);
  const prst = geom.attrs.prst;
  const adj = {};
  for (const gd of children(child(geom, 'a:avLst'), 'a:gd')) {
    const m = /val\s+(-?\d+)/.exec(gd.attrs.fmla ?? '');
    if (m) adj[gd.attrs.name] = Number(m[1]);
  }
  const a = (name, d) => (adj[name] ?? d) / 100000;
  const ss = Math.min(w, h);
  switch (prst) {
    case 'rect': case 'flowChartProcess': case 'flowChartAlternateProcess': case 'snip1Rect': case 'round1Rect': case 'round2SameRect':
      if (prst === 'flowChartAlternateProcess') return [{ commands: roundRect(w, h, ss / 6) }];
      return [{ commands: poly([[0, 0], [w, 0], [w, h], [0, h]]) }];
    case 'roundRect':
      return [{ commands: roundRect(w, h, ss * a('adj', 16667)) }];
    case 'flowChartTerminator':
      return [{ commands: roundRect(w, h, h / 2) }];
    case 'ellipse': case 'flowChartConnector':
      return [{ commands: ellipsePath(0, 0, w, h) }];
    case 'triangle':
      return [{ commands: poly([[w * a('adj', 50000), 0], [w, h], [0, h]]) }];
    case 'rtTriangle':
      return [{ commands: poly([[0, 0], [w, h], [0, h]]) }];
    case 'diamond': case 'flowChartDecision':
      return [{ commands: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) }];
    case 'parallelogram': case 'flowChartInputOutput': {
      const d = prst === 'parallelogram' ? ss * a('adj', 25000) : w / 5;
      return [{ commands: poly([[d, 0], [w, 0], [w - d, h], [0, h]]) }];
    }
    case 'trapezoid': {
      const d = ss * a('adj', 25000);
      return [{ commands: poly([[d, 0], [w - d, 0], [w, h], [0, h]]) }];
    }
    case 'pentagon':
      return [{ commands: poly([[w / 2, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]]) }];
    case 'hexagon': {
      const d = ss * a('adj', 25000);
      return [{ commands: poly([[d, 0], [w - d, 0], [w, h / 2], [w - d, h], [d, h], [0, h / 2]]) }];
    }
    case 'octagon': {
      const d = ss * a('adj', 29289);
      return [{ commands: poly([[d, 0], [w - d, 0], [w, d], [w, h - d], [w - d, h], [d, h], [0, h - d], [0, d]]) }];
    }
    case 'homePlate': {
      const d = ss * a('adj', 50000);
      return [{ commands: poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h]]) }];
    }
    case 'chevron': {
      const d = ss * a('adj', 50000);
      return [{ commands: poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]]) }];
    }
    case 'plus': {
      const d = ss * a('adj', 25000);
      return [{ commands: poly([[d, 0], [w - d, 0], [w - d, d], [w, d], [w, h - d], [w - d, h - d], [w - d, h], [d, h], [d, h - d], [0, h - d], [0, d], [d, d]]) }];
    }
    case 'rightArrow': case 'leftArrow': case 'upArrow': case 'downArrow': {
      const vertical = prst === 'upArrow' || prst === 'downArrow';
      const [L, T] = vertical ? [h, w] : [w, h];
      const shaft = T * a('adj1', 50000);
      const headLen = Math.min(L, ss * a('adj2', 50000));
      let pts = [[0, (T - shaft) / 2], [L - headLen, (T - shaft) / 2], [L - headLen, 0], [L, T / 2], [L - headLen, T], [L - headLen, (T + shaft) / 2], [0, (T + shaft) / 2]];
      if (prst === 'leftArrow' || prst === 'upArrow') pts = pts.map(([x, y]) => [L - x, y]);
      if (vertical) pts = pts.map(([x, y]) => [y, x]);
      return [{ commands: poly(pts) }];
    }
    case 'star5': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.38 : 1;
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push([w / 2 + (w / 2) * r * Math.cos(ang), h / 2 + (h / 2) * r * Math.sin(ang) * 1.05 + h * 0.03]);
      }
      return [{ commands: poly(pts) }];
    }
    case 'line': case 'straightConnector1':
      return [{ commands: [['M', 0, 0], ['L', w, h]], fill: false }];
    case 'bentConnector2':
      return [{ commands: [['M', 0, 0], ['L', w, 0], ['L', w, h]], fill: false }];
    case 'bentConnector3': {
      const x = w * a('adj1', 50000);
      return [{ commands: [['M', 0, 0], ['L', x, 0], ['L', x, h], ['L', w, h]], fill: false }];
    }
    case 'curvedConnector3':
      return [{ commands: [['M', 0, 0], ['C', w / 2, 0, w / 2, h, w, h]], fill: false }];
    default:
      ctx.report?.note('Some shapes are drawn as rectangles: their outlines aren’t known yet.');
      return [{ commands: poly([[0, 0], [w, 0], [w, h], [0, h]]) }];
  }
}

function roundRect(w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const k = r * (1 - K);
  return [['M', r, 0], ['L', w - r, 0], ['C', w - k, 0, w, k, w, r], ['L', w, h - r], ['C', w, h - k, w - k, h, w - r, h], ['L', r, h], ['C', k, h, 0, h - k, 0, h - r], ['L', 0, r], ['C', 0, k, k, 0, r, 0], ['Z']];
}

// A drawn (custom) geometry: its paths, scaled from their own size to the shape's.
function customGeometry(geom, w, h) {
  const out = [];
  for (const path of children(child(geom, 'a:pathLst'), 'a:path')) {
    const pw = Number(path.attrs.w ?? 0) || null;
    const ph = Number(path.attrs.h ?? 0) || null;
    const sx = pw ? w / pw : EMU;
    const sy = ph ? h / ph : EMU;
    const pt = (el) => [Number(el.attrs.x) * sx, Number(el.attrs.y) * sy];
    const commands = [];
    let cur = [0, 0];
    for (const c of path.children ?? []) {
      const pts = children(c, 'a:pt').map(pt);
      if (c.name === 'a:moveTo') {
        commands.push(['M', ...pts[0]]);
        cur = pts[0];
      } else if (c.name === 'a:lnTo') {
        commands.push(['L', ...pts[0]]);
        cur = pts[0];
      } else if (c.name === 'a:cubicBezTo') {
        commands.push(['C', ...pts[0], ...pts[1], ...pts[2]]);
        cur = pts[2];
      } else if (c.name === 'a:quadBezTo') {
        const [q, e] = pts;
        commands.push(['C', cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1]), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), ...e]);
        cur = e;
      } else if (c.name === 'a:arcTo') {
        const wr = Number(c.attrs.wR) * sx;
        const hr = Number(c.attrs.hR) * sy;
        const st = (Number(c.attrs.stAng) / 60000) * (Math.PI / 180);
        const sw = (Number(c.attrs.swAng) / 60000) * (Math.PI / 180);
        const cx = cur[0] - wr * Math.cos(st);
        const cy = cur[1] - hr * Math.sin(st);
        const steps = Math.max(1, Math.ceil(Math.abs(sw) / (Math.PI / 2)));
        for (let i = 0; i < steps; i++) {
          const a0 = st + (sw * i) / steps;
          const a1 = st + (sw * (i + 1)) / steps;
          const t = (4 / 3) * Math.tan((a1 - a0) / 4);
          const p0 = [cx + wr * Math.cos(a0), cy + hr * Math.sin(a0)];
          const p3 = [cx + wr * Math.cos(a1), cy + hr * Math.sin(a1)];
          commands.push(['C', p0[0] - t * wr * Math.sin(a0), p0[1] + t * hr * Math.cos(a0), p3[0] + t * wr * Math.sin(a1), p3[1] - t * hr * Math.cos(a1), ...p3]);
          cur = p3;
        }
      } else if (c.name === 'a:close') commands.push(['Z']);
    }
    if (commands.length) out.push({ commands, fill: path.attrs.fill !== 'none', stroke: path.attrs.stroke !== '0' && path.attrs.stroke !== 'false' });
  }
  return out;
}

// --- Text ----------------------------------------------------------------------------------------

// The text styles that apply to a shape's paragraphs, outermost first: the presentation's
// defaults, the master's title, body or other style, then the lstStyles of its placeholder on the
// master and layout, then its own.
function textStyles(txBody, ctx) {
  const list = [];
  const kind = ctx.ph ? kindOf(ctx.ph.type) : null;
  if (ctx.defaultStyle) list.push(ctx.defaultStyle);
  const txStyles = child(ctx.master.root, 'p:txStyles');
  if (kind === 'title') list.push(child(txStyles, 'p:titleStyle'));
  else if (kind === 'body') list.push(child(txStyles, 'p:bodyStyle'));
  else if (kind) list.push(child(txStyles, 'p:otherStyle'));
  for (const link of ctx.chain ?? []) list.push(child(child(link.el, 'p:txBody'), 'a:lstStyle'));
  list.push(child(txBody, 'a:lstStyle'));
  return list.filter(Boolean);
}

// A level's paragraph properties, merged from the styles (and the paragraph's own pPr).
function levelProps(styles, level, pPr) {
  const merged = { attrs: {}, children: new Map(), defRPr: [] };
  for (const el of [...styles.map((s) => child(s, LEVELS[level])), pPr]) {
    if (!el) continue;
    Object.assign(merged.attrs, el.attrs);
    for (const c of el.children ?? []) {
      if (c.name === 'a:defRPr') merged.defRPr.push(c);
      else if (c.name.startsWith('a:bu')) {
        // A bullet's kind (none, a character, a number) replaces the others; its font, colour
        // and size are separate.
        if (['a:buNone', 'a:buChar', 'a:buAutoNum', 'a:buBlip'].includes(c.name)) for (const k of ['a:buNone', 'a:buChar', 'a:buAutoNum', 'a:buBlip']) merged.children.delete(k);
        if (['a:buFontTx', 'a:buFont'].includes(c.name)) for (const k of ['a:buFontTx', 'a:buFont']) merged.children.delete(k);
        if (['a:buClrTx', 'a:buClr'].includes(c.name)) for (const k of ['a:buClrTx', 'a:buClr']) merged.children.delete(k);
        if (['a:buSzTx', 'a:buSzPct', 'a:buSzPts'].includes(c.name)) for (const k of ['a:buSzTx', 'a:buSzPct', 'a:buSzPts']) merged.children.delete(k);
        merged.children.set(c.name, c);
      } else merged.children.set(c.name, c);
    }
  }
  return merged;
}

// A run's look: the level's defRPr, then the run's own rPr, as the flowing engine's style. A
// shape's style colour (its theme font colour) goes over the defaults (the first `defaults` of
// them), under the run's own.
function runStyle(rPrs, ctx, scale = 1, defaults = rPrs.length) {
  const s = { size: 18, family: ctx.theme.minor, color: '#000000' };
  let kernAt = null;
  if (ctx.styleColor && defaults === 0) s.color = ctx.styleColor.hex;
  for (const [i, r] of rPrs.entries()) {
    if (i === defaults && ctx.styleColor) s.color = ctx.styleColor.hex;
    if (!r) continue;
    const a = r.attrs ?? {};
    if (a.sz) s.size = Number(a.sz) / 100;
    if (a.b != null) s.bold = a.b === '1' || a.b === 'true';
    if (a.i != null) s.italic = a.i === '1' || a.i === 'true';
    if (a.u != null) s.underline = a.u === 'none' ? null : a.u === 'dbl' ? 'double' : 'single';
    if (a.strike != null) {
      s.strike = a.strike === 'sngStrike' || a.strike === 'dblStrike';
      s.dstrike = a.strike === 'dblStrike';
    }
    if (a.cap != null) {
      s.caps = a.cap === 'all';
      s.smallCaps = a.cap === 'small';
    }
    if (a.spc != null) s.spacing = Number(a.spc) / 100;
    if (a.kern != null) kernAt = Number(a.kern) / 100;
    if (a.baseline != null) {
      const b = Number(a.baseline);
      s.vertAlign = b > 0 ? 'superscript' : b < 0 ? 'subscript' : null;
    }
    const latin = child(r, 'a:latin')?.attrs.typeface;
    if (latin) s.family = latin === '+mj-lt' ? ctx.theme.major : latin === '+mn-lt' ? ctx.theme.minor : latin;
    const fill = (r.children ?? []).find((c) => FILL_NAMES.has(c.name));
    if (fill) {
      const f = fillOf(fill, ctx);
      if (f?.color) s.color = blend(f);
    }
    const hl = child(r, 'a:highlight');
    if (hl) s.highlight = colorIn(hl, ctx)?.hex;
    const link = child(r, 'a:hlinkClick');
    if (link?.attrs['r:id']) {
      const target = ctx.pkg.rels(ctx.part).get(link.attrs['r:id']);
      if (target?.external) s.link = target.target;
    }
  }
  if (ctx.styleColor && defaults >= rPrs.length) s.color = ctx.styleColor.hex;
  s.size *= scale;
  s.kern = kernAt != null && kernAt > 0 && s.size >= kernAt;
  return s;
}

const AUTONUM = {
  arabicPeriod: (n) => `${n}.`, arabicParenR: (n) => `${n})`, arabicParenBoth: (n) => `(${n})`, arabicPlain: (n) => `${n}`,
  alphaLcPeriod: (n) => `${alpha(n)}.`, alphaUcPeriod: (n) => `${alpha(n).toUpperCase()}.`, alphaLcParenR: (n) => `${alpha(n)})`, alphaUcParenR: (n) => `${alpha(n).toUpperCase()})`,
  alphaLcParenBoth: (n) => `(${alpha(n)})`, alphaUcParenBoth: (n) => `(${alpha(n).toUpperCase()})`,
  romanLcPeriod: (n) => `${roman(n)}.`, romanUcPeriod: (n) => `${roman(n).toUpperCase()}.`, romanLcParenR: (n) => `${roman(n)})`, romanUcParenR: (n) => `${roman(n).toUpperCase()})`,
};
function alpha(n) {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
}
function roman(n) {
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of table) while (n >= v) {
    s += r;
    n -= v;
  }
  return s;
}

const pts = (el, name) => {
  const c = child(el, name);
  if (!c) return null;
  const p = child(c, 'a:spcPts');
  if (p) return { pts: Number(p.attrs.val) / 100 };
  const q = child(c, 'a:spcPct');
  if (q) return { pct: Number(q.attrs.val) / 100000 };
  return null;
};

// A text body as the flowing engine's paragraphs, laid out in the shape's box (less its insets),
// anchored at its top, middle or bottom.
function drawText(page, txBody, box, ctx) {
  const styles = textStyles(txBody, ctx);
  // The body's properties: the placeholder's on the master and layout, then its own.
  const bodyPr = {};
  for (const link of ctx.chain ?? []) Object.assign(bodyPr, child(child(link.el, 'p:txBody'), 'a:bodyPr')?.attrs ?? {});
  const own = child(txBody, 'a:bodyPr');
  Object.assign(bodyPr, own?.attrs ?? {});
  const autofit = child(own, 'a:normAutofit');
  const fontScale = autofit?.attrs.fontScale ? Number(autofit.attrs.fontScale) / 100000 : 1;
  const spaceReduction = autofit?.attrs.lnSpcReduction ? Number(autofit.attrs.lnSpcReduction) / 100000 : 0;
  const ins = (k, d) => Number(bodyPr[k] ?? d) * EMU;
  const inset = { l: ins('lIns', 91440), t: ins('tIns', 45720), r: ins('rIns', 91440), b: ins('bIns', 45720) };
  if (bodyPr.vert && bodyPr.vert !== 'horz') ctx.report?.note('Vertical text is shown level.');
  if (Number(bodyPr.numCol ?? 1) > 1) ctx.report?.note('Text in columns is shown in one column.');
  const wrap = bodyPr.wrap !== 'none';
  const anchor = bodyPr.anchor ?? 't';

  const blocks = [];
  const counters = [];
  for (const p of children(txBody, 'a:p')) {
    const pPr = child(p, 'a:pPr');
    const level = Math.min(8, Number(pPr?.attrs.lvl ?? 0));
    const lp = levelProps(styles, level, pPr);
    const base = runStyle(lp.defRPr, ctx, fontScale);
    const content = [];
    let firstSize = null;
    for (const r of p.children ?? []) {
      if (r.name === 'a:r' || r.name === 'a:fld') {
        const style = runStyle([...lp.defRPr, child(r, 'a:rPr')], ctx, fontScale, lp.defRPr.length);
        let text = textOf(child(r, 'a:t'));
        if (r.name === 'a:fld' && r.attrs.type === 'slidenum') text = String(ctx.number);
        if (firstSize == null) firstSize = style.size;
        const pieces = text.split('\t');
        pieces.forEach((piece, i) => {
          if (i > 0) content.push({ type: 'tab', style });
          if (piece) content.push({ type: 'text', text: piece, style });
        });
      } else if (r.name === 'a:br') content.push({ type: 'break', kind: 'line' });
    }
    const mark = runStyle([...lp.defRPr, child(p, 'a:endParaRPr')], ctx, fontScale, lp.defRPr.length);
    const size = firstSize ?? mark.size;
    const a = lp.attrs;
    // Line spacing: a share of the font's line, or exactly so many points; less what autofit takes.
    const lnSpc = pts({ children: [...lp.children.values()] }, 'a:lnSpc');
    let spacing = { line: 1, rule: 'auto' };
    if (lnSpc?.pct != null) spacing = { line: Math.max(0.1, lnSpc.pct - spaceReduction), rule: 'auto' };
    else if (lnSpc?.pts != null) spacing = { line: lnSpc.pts * fontScale, rule: 'exact' };
    else if (spaceReduction) spacing = { line: 1 - spaceReduction, rule: 'auto' };
    const lineOf = size * 1.2;
    const before = pts({ children: [...lp.children.values()] }, 'a:spcBef');
    const after = pts({ children: [...lp.children.values()] }, 'a:spcAft');
    spacing.before = before ? before.pts ?? before.pct * lineOf : 0;
    spacing.after = after ? (after.pts ?? after.pct * lineOf) : 0;

    // The bullet: a character in its own font, colour and size, or a number, hanging in the
    // indent; none on an empty paragraph.
    let label = null;
    const hasText = content.some((c) => c.type === 'text');
    const buChar = lp.children.get('a:buChar');
    const buNum = lp.children.get('a:buAutoNum');
    if (!lp.children.get('a:buNone') && hasText && (buChar || buNum)) {
      const first = content.find((c) => c.type === 'text')?.style ?? base;
      const bulletStyle = { ...first, underline: null, strike: false, link: null };
      const buFont = lp.children.get('a:buFont')?.attrs.typeface;
      if (buFont) bulletStyle.family = buFont === '+mj-lt' ? ctx.theme.major : buFont === '+mn-lt' ? ctx.theme.minor : buFont;
      const buClr = lp.children.get('a:buClr');
      if (buClr) bulletStyle.color = colorIn(buClr, ctx)?.hex ?? bulletStyle.color;
      const pct = lp.children.get('a:buSzPct');
      const ptsSize = lp.children.get('a:buSzPts');
      if (pct) bulletStyle.size = first.size * (Number(pct.attrs.val) / 100000);
      else if (ptsSize) bulletStyle.size = (Number(ptsSize.attrs.val) / 100) * fontScale;
      let text;
      if (buChar) text = buChar.attrs.char ?? '•';
      else {
        const type = buNum.attrs.type ?? 'arabicPeriod';
        const start = Number(buNum.attrs.startAt ?? 1);
        const key = `${level}|${type}`;
        counters.length = level + 1;
        counters[level] = counters[level]?.key === key ? { key, n: counters[level].n + 1 } : { key, n: start };
        text = (AUTONUM[type] ?? AUTONUM.arabicPeriod)(counters[level].n);
      }
      label = [{ type: 'text', text, style: bulletStyle }, { type: 'tab', style: bulletStyle, label: true }];
    } else if (!hasText) counters.length = level;
    const marL = Number(a.marL ?? 0) * EMU;
    const indent = Number(a.indent ?? 0) * EMU;
    const algn = { l: 'left', ctr: 'center', r: 'right', just: 'both', dist: 'distribute', justLow: 'both', thaiDist: 'distribute' }[a.algn ?? 'l'] ?? 'left';
    const tabs = children(lp.children.get('a:tabLst'), 'a:tab').map((t) => ({ pos: Number(t.attrs.pos ?? 0) * EMU, align: { l: 'left', ctr: 'center', r: 'right', dec: 'decimal' }[t.attrs.algn ?? 'l'] ?? 'left' }));
    blocks.push({
      type: 'paragraph',
      props: { align: algn, indent: { left: marL, firstLine: indent, right: 0 }, spacing, tabs, powerpoint: true },
      content,
      label,
      mark,
    });
  }
  // PowerPoint leaves out the first paragraph's space before.
  if (blocks[0]) blocks[0].props.spacing.before = 0;

  const innerW = Math.max(1, box.w - inset.l - inset.r);
  let layoutW = innerW;
  if (!wrap) {
    const natural = layoutBlocks(blocks, 1e5, { report: ctx.report, defaultTab: 72 });
    const widest = Math.max(0, ...natural.items.filter((i) => i.type === 'line').map((i) => i.line.items.reduce((s, g) => s + g.advance, 0) + i.line.x));
    layoutW = Math.max(innerW, widest);
  }
  const laid = layoutBlocks(blocks, layoutW, { report: ctx.report, defaultTab: 72 });
  const innerH = box.h - inset.t - inset.b;
  let top = box.y + inset.t;
  if (anchor === 'ctr') top += (innerH - laid.height) / 2;
  else if (anchor === 'b') top += innerH - laid.height;
  let left = box.x + inset.l;
  if (!wrap && layoutW > innerW) {
    // Unwrapped text wider than its box spills out on the side its alignment points away from.
    const align = blocks[0]?.props.align;
    if (align === 'center') left -= (layoutW - innerW) / 2;
    else if (align === 'right') left -= layoutW - innerW;
  }
  drawItems(page, laid.items, left, top, { imageFor: () => null, total: 1 }, {});
}

// --- Tables --------------------------------------------------------------------------------------

// PowerPoint's default table style, Medium Style 2 (by accent), as its preset defines it.
const MEDIUM_STYLE_2 = {
  '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}': 'accent1', '{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}': 'accent2', '{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}': 'accent3',
  '{00A15C55-8517-42AA-B614-E9B94910E393}': 'accent4', '{7DF18680-E054-41AD-8BC1-D1AEF772440D}': 'accent5', '{93296810-A885-4BE3-A3E7-6D5BEEA58F35}': 'accent6',
  '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}': 'dk1',
};

function drawTable(page, tbl, box, ctx) {
  if (!tbl) return;
  const pr = child(tbl, 'a:tblPr');
  const flag = (k) => pr?.attrs[k] === '1' || pr?.attrs[k] === 'true';
  const styleId = textOf(child(pr, 'a:tableStyleId')) || null;
  const accent = styleId ? MEDIUM_STYLE_2[styleId] : null;
  if (styleId && !accent) ctx.report?.note('Some table styles are shown plainly: only PowerPoint’s default (Medium Style 2) is drawn.');
  const scheme = (name, tint = null) => {
    const hex = ctx.theme.colors[name] ?? '#000000';
    if (tint == null) return hex;
    return hexOf(rgbOf(hex).map((c) => toSrgb(toLinear(c) * tint + (1 - tint))));
  };
  const grid = children(child(tbl, 'a:tblGrid'), 'a:gridCol').map((g) => Number(g.attrs.w) * EMU);
  const rows = children(tbl, 'a:tr');
  const lastRow = rows.length - 1;
  // Each cell's look from the style: fill, text colour and weight, borders.
  const styled = (r, c, cols) => {
    if (!accent) return {};
    const white = scheme('lt1');
    const out = { fill: scheme(accent, 0.2), color: scheme('dk1'), border: { color: white, width: 1 } };
    const banded = flag('bandRow') && (r - (flag('firstRow') ? 1 : 0)) % 2 === 0;
    if (banded) out.fill = scheme(accent, 0.4);
    if ((flag('firstCol') && c === 0) || (flag('lastCol') && c === cols - 1)) Object.assign(out, { fill: scheme(accent), color: white, bold: true });
    if (flag('lastRow') && r === lastRow) Object.assign(out, { fill: scheme(accent), color: white, bold: true, topBorder: { color: white, width: 3 } });
    if (flag('firstRow') && r === 0) Object.assign(out, { fill: scheme(accent), color: white, bold: true, bottomBorder: { color: white, width: 3 } });
    return out;
  };
  // Lay out each row's cells; a row is as tall as it says, or as its tallest text needs.
  let y = box.y;
  const placed = [];
  rows.forEach((tr, r) => {
    let x = box.x;
    let col = 0;
    const cells = [];
    for (const tc of children(tr, 'a:tc')) {
      const span = Number(tc.attrs.gridSpan ?? 1);
      const w = grid.slice(col, col + span).reduce((a, b) => a + b, 0);
      if (tc.attrs.hMerge !== '1' && tc.attrs.vMerge !== '1') cells.push({ tc, x, w, col, span });
      x += grid[col] ?? 0;
      col += 1;
    }
    const height = Math.max(Number(tr.attrs.h ?? 0) * EMU, ...cells.map((cell) => cellHeight(cell, r, styled(r, cell.col, grid.length), ctx)));
    placed.push({ y, height, cells, r });
    y += height;
  });
  for (const row of placed) {
    for (const cell of row.cells) {
      const look = styled(row.r, cell.col, grid.length);
      const tcPr = child(cell.tc, 'a:tcPr');
      const own = fillIn(tcPr, ctx);
      const rowSpan = Number(cell.tc.attrs.rowSpan ?? 1);
      const h = placed.slice(row.r, row.r + rowSpan).reduce((s, p) => s + p.height, 0);
      const fill = own !== undefined ? own : look.fill ? { color: look.fill } : null;
      paint(page, fill, cell.x, row.y, cell.w, h, ctx);
      drawCellText(page, cell, row.y, h, look, ctx);
      // Borders: the cell's own lines, else the style's white lines between cells.
      const side = (name, x1, y1, x2, y2, fallback) => {
        const ln = child(tcPr, name);
        let stroke = null;
        let width = 0;
        if (ln) {
          const f = fillIn(ln, ctx);
          if (f?.color) {
            stroke = blend(f);
            width = Number(ln.attrs.w ?? 12700) * EMU;
          }
        } else if (fallback) {
          stroke = fallback.color;
          width = fallback.width;
        }
        if (stroke && width > 0) page.line(x1, y1, x2, y2, { stroke, lineWidth: width });
      };
      side('a:lnT', cell.x, row.y, cell.x + cell.w, row.y, look.topBorder ?? look.border);
      side('a:lnB', cell.x, row.y + h, cell.x + cell.w, row.y + h, look.bottomBorder ?? look.border);
      side('a:lnL', cell.x, row.y, cell.x, row.y + h, look.border);
      side('a:lnR', cell.x + cell.w, row.y, cell.x + cell.w, row.y + h, look.border);
    }
  }
}

function cellBody(cell, look, ctx) {
  const txBody = child(cell.tc, 'a:txBody');
  const tcPr = child(cell.tc, 'a:tcPr')?.attrs ?? {};
  const inset = { l: Number(tcPr.marL ?? 91440) * EMU, r: Number(tcPr.marR ?? 91440) * EMU, t: Number(tcPr.marT ?? 45720) * EMU, b: Number(tcPr.marB ?? 45720) * EMU };
  const cellCtx = { ...ctx, chain: [], ph: { type: 'tbl' }, styleColor: look.color ? { hex: look.color } : null };
  return { txBody, inset, anchor: tcPr.anchor ?? 't', cellCtx };
}

function cellHeight(cell, r, look, ctx) {
  const { txBody, inset } = cellBody(cell, look, ctx);
  if (!txBody) return 0;
  const blocks = tableBlocks(txBody, look, ctx);
  return layoutBlocks(blocks, Math.max(1, cell.w - inset.l - inset.r), { report: ctx.report, defaultTab: 72 }).height + inset.t + inset.b;
}

// A table cell's text: the presentation's other-text style, with the table style's colour and
// weight under the cell's own formatting.
function tableBlocks(txBody, look, ctx) {
  // Not a placeholder: the presentation's default text style (18pt in the Office Theme).
  const fake = { ...ctx, ph: null, chain: [], styleColor: look.color ? { hex: look.color } : null };
  const blocks = [];
  for (const p of children(txBody, 'a:p')) {
    const pPr = child(p, 'a:pPr');
    const lp = levelProps(textStyles(txBody, fake), Math.min(8, Number(pPr?.attrs.lvl ?? 0)), pPr);
    const extra = look.bold ? [{ attrs: { b: '1' }, children: [] }] : [];
    const content = [];
    for (const r of p.children ?? []) {
      if (r.name === 'a:r' || r.name === 'a:fld') content.push({ type: 'text', text: textOf(child(r, 'a:t')), style: runStyle([...lp.defRPr, ...extra, child(r, 'a:rPr')], fake, 1, lp.defRPr.length + extra.length) });
      else if (r.name === 'a:br') content.push({ type: 'break', kind: 'line' });
    }
    const algn = { l: 'left', ctr: 'center', r: 'right', just: 'both' }[lp.attrs.algn ?? 'l'] ?? 'left';
    blocks.push({ type: 'paragraph', props: { align: algn, indent: { left: Number(lp.attrs.marL ?? 0) * EMU, firstLine: Number(lp.attrs.indent ?? 0) * EMU }, spacing: { line: 1, rule: 'auto', before: 0, after: 0 }, powerpoint: true }, content, mark: runStyle([...lp.defRPr, ...extra, child(p, 'a:endParaRPr')], fake, 1, lp.defRPr.length + extra.length) });
  }
  return blocks;
}

function drawCellText(page, cell, top, height, look, ctx) {
  const { txBody, inset, anchor } = cellBody(cell, look, ctx);
  if (!txBody) return;
  const blocks = tableBlocks(txBody, look, ctx);
  const laid = layoutBlocks(blocks, Math.max(1, cell.w - inset.l - inset.r), { report: ctx.report, defaultTab: 72 });
  let y = top + inset.t;
  const inner = height - inset.t - inset.b;
  if (anchor === 'ctr') y += (inner - laid.height) / 2;
  else if (anchor === 'b') y += inner - laid.height;
  drawItems(page, laid.items, cell.x + inset.l, y, { imageFor: () => null, total: 1 }, {});
}
