// Drawing a page on a canvas (a CanvasRenderingContext2D, in the app's window or any browser): its
// content stream's graphics state, paths, clipping, colours, text, images, forms, shadings and
// patterns, transparency (constant alpha, blend modes and groups), optional content, and the
// appearances of its annotations. What isn't drawn yet: JPEG 2000, JBIG2 and CCITT images.

import { CMYK_SPACE, GRAY, RGB_SPACE, makeColorSpace } from './colorspace.js';
import { readOperators } from './content.js';
import { drawingFont, prepareBundledFont, prepareSystemFont } from './drawfont.js';
import { streamBytes } from './filters.js';
import { loadTextFont } from './font.js';
import { makeFunction } from './function.js';
import { decodeImage, inlineImageStream, makeCanvas } from './image.js';
import { shadingCanvas } from './shading.js';
import { textString } from './document.js';
import { Dict, Name, Ref, Stream } from './objects.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
// The operators that paint, for knockout groups: those that paint the current path, and the rest.
const PAINTS_PATH = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const PAINTS = new Set(["'", '"', 'Tj', 'TJ', 'Do', 'BI', 'sh']);
const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
const invert = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
const isMatrix = (m) => Array.isArray(m) && m.length === 6 && m.every((v) => typeof v === 'number' && Number.isFinite(v));
const css = ([r, g, b]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

const BLEND = {
  Normal: 'source-over', Compatible: 'source-over', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten',
  ColorDodge: 'color-dodge', ColorBurn: 'color-burn', HardLight: 'hard-light', SoftLight: 'soft-light', Difference: 'difference', Exclusion: 'exclusion',
  Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity',
};

// The transform from page space to the canvas's pixels, and the canvas's size, for a scale and the
// page's rotation (as pdf.js's PageViewport).
export function viewport(page, scale = 1) {
  const [x0, y0, x1, y1] = page.view;
  const w = (x1 - x0) * scale;
  const h = (y1 - y0) * scale;
  let transform;
  switch (page.rotate) {
    case 90:
      transform = [0, scale, scale, 0, -y0 * scale, -x0 * scale];
      return { transform, width: h, height: w };
    case 180:
      transform = [-scale, 0, 0, scale, x1 * scale, -y0 * scale];
      return { transform, width: w, height: h };
    case 270:
      transform = [0, -scale, -scale, 0, y1 * scale, x1 * scale];
      return { transform, width: h, height: w };
    default:
      transform = [scale, 0, 0, -scale, -x0 * scale, y1 * scale];
      return { transform, width: w, height: h };
  }
}

class GState {
  constructor() {
    this.ctm = IDENTITY;
    this.fillSpace = GRAY;
    this.strokeSpace = GRAY;
    this.fillColor = [0, 0, 0];
    this.strokeColor = [0, 0, 0];
    this.fillPattern = null;
    this.strokePattern = null;
    this.lineWidth = 1;
    this.lineCap = 0;
    this.lineJoin = 0;
    this.miterLimit = 10;
    this.dash = [];
    this.dashPhase = 0;
    this.fillAlpha = 1;
    this.strokeAlpha = 1;
    this.blend = 'source-over';
    this.font = null;
    this.fontSize = 0;
    this.charSpacing = 0;
    this.wordSpacing = 0;
    this.hScale = 1;
    this.leading = 0;
    this.rise = 0;
    this.renderMode = 0;
    this.softMask = null;
  }
  clone() {
    return Object.assign(new GState(), this);
  }
}

// Draws `page` (a PdfPage) on `ctx`, whose canvas is `viewport(page, scale)`'s size. `fonts(file)`
// gives a bundled font's bytes (fonts/*.ttf, or a promise of them) for fonts that aren't embedded.
// `textDarken` thickens filled text by that many device pixels, as macOS's font smoothing does.
// `systemFonts` draws fonts that aren't embedded with the installed fonts of their names, when
// there are any.
// `onError(error, operator)` hears of each operator passed over because it couldn't be carried out.
export async function renderPage(page, ctx, { scale = 1, fonts = null, background = '#ffffff', annotations = true, textDarken = 0.2, systemFonts = true, onError = null } = {}) {
  const vp = viewport(page, scale);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, vp.width, vp.height);
  }
  const r = new Renderer(page.doc, ctx, vp.transform, fonts);
  r.textDarken = textDarken;
  r.systemFonts = systemFonts;
  r.onError = onError;
  try {
    await r.run(page.contents(), page.resources, new GState());
    if (annotations) await r.annotations(page);
  } finally {
    ctx.restore();
  }
}

class Renderer {
  constructor(doc, ctx, base, fonts) {
    this.doc = doc;
    this.ctx = ctx;
    this.base = base;
    this.fonts = fonts;
    this.depth = 0;
    this.hidden = hiddenGroups(doc);
    this.images = new Map();
  }

  setTransform(m) {
    const t = mul(this.base, m);
    this.ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  }

  // Runs a content stream with its resources, from state `gs`.
  async run(bytes, resources, gs, knockout = false) {
    const ops = [];
    readOperators(bytes, (op, args) => void ops.push(op, args), this.doc);
    return this.runOps(ops, 0, ops.length, resources, gs, knockout);
  }

  // Runs operators `from` to `to` (indexes into `ops`, two entries each). `knockout`: they're a
  // knockout group's own, each object it paints taking the place of what's under it (knockStart).
  async runOps(ops, from, to, resources, gs, knockout = false) {
    const doc = this.doc;
    const ctx = this.ctx;
    const stack = [];
    let pendingClip = null;
    let hasPath = false;
    let textMatrix = IDENTITY;
    let lineMatrix = IDENTITY;
    let textClip = null;
    // The current point and the start of the subpath (a canvas keeps them, but doesn't say).
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    // Optional content switched off: a count of the marked sections we're inside that are hidden.
    const marked = [];
    let hiddenDepth = 0;
    const visible = () => hiddenDepth === 0;
    const startPath = () => {
      if (!hasPath) {
        ctx.beginPath();
        hasPath = true;
        this.setTransform(gs.ctm);
      }
    };
    const endPath = () => {
      if (pendingClip) {
        this.setTransform(gs.ctm);
        ctx.clip(pendingClip);
        pendingClip = null;
      }
      ctx.beginPath();
      hasPath = false;
    };
    const paint = async (fill, stroke, rule) => {
      if (visible() && hasPath) {
        this.setTransform(gs.ctm);
        ctx.globalCompositeOperation = gs.blend;
        if (fill) {
          ctx.globalAlpha = gs.fillAlpha;
          if (gs.fillPattern && (await this.drawTiles(gs, rule))) {
            // drawn tile by tile
          } else if (await this.fillStyle(gs, false)) ctx.fill(rule);
        }
        if (stroke) {
          ctx.globalAlpha = gs.strokeAlpha;
          this.strokeStyle(gs);
          if (await this.fillStyle(gs, true)) ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      endPath();
    };

    for (let i = from; i < to; i += 2) {
      const op = ops[i];
      const a = ops[i + 1];
      const knocking = knockout && visible() && (PAINTS_PATH.has(op) ? hasPath : PAINTS.has(op)) ? this.knockStart(gs, op) : null;
      try {
        switch (op) {
          case 'q':
            stack.push(gs);
            gs = gs.clone();
            ctx.save();
            break;
          case 'Q':
            if (stack.length) {
              gs = stack.pop();
              ctx.restore();
            }
            break;
          case 'cm':
            if (isMatrix(a)) gs.ctm = mul(gs.ctm, a);
            break;
          case 'w':
            gs.lineWidth = a[0];
            break;
          case 'J':
            gs.lineCap = a[0];
            break;
          case 'j':
            gs.lineJoin = a[0];
            break;
          case 'M':
            gs.miterLimit = a[0];
            break;
          case 'd':
            gs.dash = Array.isArray(a[0]) ? a[0].map((v) => doc.fetchIfRef(v)).filter((v) => typeof v === 'number') : [];
            gs.dashPhase = typeof a[1] === 'number' ? a[1] : 0;
            break;
          case 'gs': {
            const before = gs.softMask;
            this.extGState(gs, resources?.dict('ExtGState')?.get(a[0]?.name), resources);
            if (gs.softMask && gs.softMask !== before) {
              // A soft mask: the rest of this level (to the Q that ends it) is drawn on its own,
              // masked, then laid on the page.
              let depth = 0;
              let end = i + 2;
              for (; end < to; end += 2) {
                if (ops[end] === 'q') depth++;
                else if (ops[end] === 'Q' && depth-- === 0) break;
              }
              await this.masked(ops, i + 2, end, resources, gs, knockout);
              i = end - 2;
            }
            break;
          }
          // Paths.
          case 'm':
            startPath();
            ctx.moveTo(a[0], a[1]);
            [cx, cy, sx, sy] = [a[0], a[1], a[0], a[1]];
            break;
          case 'l':
            startPath();
            ctx.lineTo(a[0], a[1]);
            [cx, cy] = [a[0], a[1]];
            break;
          case 'c':
            startPath();
            ctx.bezierCurveTo(a[0], a[1], a[2], a[3], a[4], a[5]);
            [cx, cy] = [a[4], a[5]];
            break;
          case 'v':
            startPath();
            ctx.bezierCurveTo(cx, cy, a[0], a[1], a[2], a[3]);
            [cx, cy] = [a[2], a[3]];
            break;
          case 'y':
            startPath();
            ctx.bezierCurveTo(a[0], a[1], a[2], a[3], a[2], a[3]);
            [cx, cy] = [a[2], a[3]];
            break;
          case 'h':
            if (hasPath) ctx.closePath();
            [cx, cy] = [sx, sy];
            break;
          case 're':
            startPath();
            ctx.rect(a[0], a[1], a[2], a[3]);
            [cx, cy, sx, sy] = [a[0], a[1], a[0], a[1]];
            break;
          case 'S':
            await paint(false, true);
            break;
          case 's':
            if (hasPath) ctx.closePath();
            await paint(false, true);
            break;
          case 'f':
          case 'F':
            await paint(true, false, 'nonzero');
            break;
          case 'f*':
            await paint(true, false, 'evenodd');
            break;
          case 'B':
            await paint(true, true, 'nonzero');
            break;
          case 'B*':
            await paint(true, true, 'evenodd');
            break;
          case 'b':
            if (hasPath) ctx.closePath();
            await paint(true, true, 'nonzero');
            break;
          case 'b*':
            if (hasPath) ctx.closePath();
            await paint(true, true, 'evenodd');
            break;
          case 'n':
            endPath();
            break;
          case 'W':
            pendingClip = 'nonzero';
            break;
          case 'W*':
            pendingClip = 'evenodd';
            break;
          // Colour.
          case 'CS':
          case 'cs': {
            const space = makeColorSpace(doc, a[0], resources);
            if (op === 'CS') {
              gs.strokeSpace = space;
              gs.strokePattern = null;
              gs.strokeColor = space.isPattern ? [0, 0, 0] : space.rgb(space.initial());
            } else {
              gs.fillSpace = space;
              gs.fillPattern = null;
              gs.fillColor = space.isPattern ? [0, 0, 0] : space.rgb(space.initial());
            }
            break;
          }
          case 'SC':
          case 'SCN':
          case 'sc':
          case 'scn': {
            const stroke = op[0] === 'S';
            const space = stroke ? gs.strokeSpace : gs.fillSpace;
            const nums = a.filter((v) => typeof v === 'number');
            if (space.isPattern) {
              const name = a[a.length - 1];
              const pattern = name instanceof Name ? resources?.dict('Pattern')?.get(name.name) : null;
              const tint = space.base && nums.length ? space.base.rgb(nums) : null;
              if (stroke) {
                gs.strokePattern = pattern ? { pattern, tint } : null;
                if (tint) gs.strokeColor = tint;
              } else {
                gs.fillPattern = pattern ? { pattern, tint } : null;
                if (tint) gs.fillColor = tint;
              }
            } else if (nums.length >= space.n) {
              const rgb = space.rgb(nums.slice(0, space.n));
              if (stroke) gs.strokeColor = rgb;
              else gs.fillColor = rgb;
            }
            break;
          }
          case 'G':
          case 'g': {
            const rgb = GRAY.rgb(a);
            if (op === 'G') [gs.strokeSpace, gs.strokeColor, gs.strokePattern] = [GRAY, rgb, null];
            else [gs.fillSpace, gs.fillColor, gs.fillPattern] = [GRAY, rgb, null];
            break;
          }
          case 'RG':
          case 'rg': {
            const rgb = RGB_SPACE.rgb(a);
            if (op === 'RG') [gs.strokeSpace, gs.strokeColor, gs.strokePattern] = [RGB_SPACE, rgb, null];
            else [gs.fillSpace, gs.fillColor, gs.fillPattern] = [RGB_SPACE, rgb, null];
            break;
          }
          case 'K':
          case 'k': {
            const rgb = CMYK_SPACE.rgb(a);
            if (op === 'K') [gs.strokeSpace, gs.strokeColor, gs.strokePattern] = [CMYK_SPACE, rgb, null];
            else [gs.fillSpace, gs.fillColor, gs.fillPattern] = [CMYK_SPACE, rgb, null];
            break;
          }
          case 'sh':
            if (visible()) this.shade(gs, resources?.dict('Shading')?.get(a[0]?.name), resources);
            break;
          // Text.
          case 'BT':
            textMatrix = IDENTITY;
            lineMatrix = IDENTITY;
            textClip = null;
            break;
          case 'ET':
            if (textClip?.texts.length) {
              // Clipping to text an installed font draws: a canvas can't make a path of it, so the
              // rest of this level (to the Q that ends it) is drawn on its own and masked by it.
              const clip = textClip;
              textClip = null;
              let depth = 0;
              let end = i + 2;
              for (; end < to; end += 2) {
                if (ops[end] === 'q') depth++;
                else if (ops[end] === 'Q' && depth-- === 0) break;
              }
              await this.textClipped(ops, i + 2, end, resources, gs, clip, knockout);
              i = end - 2;
            } else if (textClip) {
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.clip(textClip.path);
              textClip = null;
            }
            break;
          case 'Tc':
            gs.charSpacing = a[0];
            break;
          case 'Tw':
            gs.wordSpacing = a[0];
            break;
          case 'Tz':
            gs.hScale = a[0] / 100;
            break;
          case 'TL':
            gs.leading = a[0];
            break;
          case 'Tf': {
            const ref = resources?.dict('Font')?.raw(a[0]?.name);
            gs.font = ref ? loadTextFont(doc, ref) : null;
            gs.fontSize = a[1];
            break;
          }
          case 'Tr':
            gs.renderMode = a[0];
            break;
          case 'Ts':
            gs.rise = a[0];
            break;
          case 'Td':
            lineMatrix = mul(lineMatrix, [1, 0, 0, 1, a[0], a[1]]);
            textMatrix = lineMatrix;
            break;
          case 'TD':
            gs.leading = -a[1];
            lineMatrix = mul(lineMatrix, [1, 0, 0, 1, a[0], a[1]]);
            textMatrix = lineMatrix;
            break;
          case 'Tm':
            if (isMatrix(a)) textMatrix = lineMatrix = a.slice();
            break;
          case 'T*':
            lineMatrix = mul(lineMatrix, [1, 0, 0, 1, 0, -gs.leading]);
            textMatrix = lineMatrix;
            break;
          case "'":
          case '"':
          case 'Tj':
          case 'TJ': {
            if (op === '"') {
              gs.wordSpacing = a[0];
              gs.charSpacing = a[1];
            }
            if (op === "'" || op === '"') {
              lineMatrix = mul(lineMatrix, [1, 0, 0, 1, 0, -gs.leading]);
              textMatrix = lineMatrix;
            }
            const parts = op === 'TJ' ? (Array.isArray(a[0]) ? a[0] : []) : [a[a.length - 1]];
            const clip = gs.renderMode >= 4 ? (textClip ??= { path: new Path2D(), texts: [] }) : null;
            textMatrix = await this.showText(gs, textMatrix, parts, resources, visible(), clip);
            break;
          }
          // XObjects and inline images.
          case 'Do':
            if (visible()) await this.xobject(gs, a[0], resources);
            break;
          case 'BI':
            if (visible()) await this.image(gs, inlineImageStream(doc, a[0]), resources, null);
            break;
          // Optional content.
          case 'BDC':
          case 'BMC': {
            let hide = false;
            if (op === 'BDC' && a[0]?.name === 'OC') {
              hide = this.isHidden(a[1] instanceof Name ? resources?.dict('Properties')?.raw(a[1].name) : a[1]);
            }
            marked.push(hide);
            if (hide) hiddenDepth++;
            break;
          }
          case 'EMC':
            if (marked.pop()) hiddenDepth--;
            break;
          case 'd0':
          case 'd1':
            break;
        }
      } catch (e) {
        // An operator that can't be carried out is passed over, as other readers do.
        this.onError?.(e, op);
      }
      if (knocking) this.knockEnd(gs, knocking);
    }
    while (stack.length) {
      stack.pop();
      ctx.restore();
    }
    return gs;
  }

  // Draws ops `from` to `to` under the state's soft mask.
  async masked(ops, from, to, resources, gs, knockout = false) {
    const main = this.ctx;
    const mask = gs.softMask;
    const w = main.canvas.width;
    const h = main.canvas.height;
    const layer = makeCanvas(w, h);
    const lctx = layer.getContext('2d');
    const inner = gs.clone();
    inner.softMask = null;
    this.ctx = lctx;
    try {
      await this.runOps(ops, from, to, resources, inner, knockout);
    } finally {
      this.ctx = main;
    }
    const alpha = await this.maskAlpha(mask, gs, resources, w, h);
    if (alpha) {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = 'destination-in';
      lctx.drawImage(alpha, 0, 0);
    }
    main.save();
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalCompositeOperation = gs.blend;
    main.drawImage(layer, 0, 0);
    main.restore();
  }

  // Draws ops `from` to `to` clipped to text (`clip`: glyph outlines in device space, `path`, and
  // text the canvas's text engine draws, `texts`), on a canvas of its own masked by it.
  async textClipped(ops, from, to, resources, gs, clip, knockout = false) {
    const main = this.ctx;
    const w = main.canvas.width;
    const h = main.canvas.height;
    const layer = makeCanvas(w, h);
    const lctx = layer.getContext('2d');
    this.ctx = lctx;
    try {
      await this.runOps(ops, from, to, resources, gs.clone(), knockout);
    } finally {
      this.ctx = main;
    }
    const mask = makeCanvas(w, h);
    const mctx = mask.getContext('2d');
    mctx.fillStyle = '#000';
    mctx.fill(clip.path);
    for (const { t, font, text } of clip.texts) {
      mctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      mctx.font = font;
      mctx.fillText(text, 0, 0);
    }
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'destination-in';
    lctx.drawImage(mask, 0, 0);
    main.save();
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalAlpha = 1;
    main.globalCompositeOperation = 'source-over';
    main.drawImage(layer, 0, 0);
    main.restore();
  }

  // A knockout group (drawn on a canvas of its own, see form()) paints each object in place of what
  // its shape covers, rather than over it. Around each painting operator: what was there is kept
  // (knockStart) and the object drawn alone at full opacity, giving its shape; then what was there
  // comes back except under that shape, and the object goes over it at its own opacity (knockEnd),
  // so one with none cuts a hole. Its blend mode has nothing to blend with there, as in pdf.js and
  // PDFKit, which both treat the group's backdrop as empty. All through the current clip.
  knockStart(gs, op) {
    const ctx = this.ctx;
    const { width: w, height: h } = ctx.canvas;
    const before = makeCanvas(w, h);
    before.getContext('2d').drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.restore();
    const saved = { fillAlpha: gs.fillAlpha, strokeAlpha: gs.strokeAlpha, blend: gs.blend };
    const opacity = op === 'S' || op === 's' ? gs.strokeAlpha : gs.fillAlpha;
    gs.fillAlpha = gs.strokeAlpha = 1;
    gs.blend = 'source-over';
    return { before, saved, opacity };
  }
  knockEnd(gs, { before, saved, opacity }) {
    Object.assign(gs, saved);
    const ctx = this.ctx;
    const { width: w, height: h } = ctx.canvas;
    const object = makeCanvas(w, h);
    object.getContext('2d').drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(before, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(object, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    ctx.drawImage(object, 0, 0);
    ctx.restore();
  }

  // A soft mask's alpha as a canvas (its pixels' alpha): the mask group drawn (over its backdrop,
  // for a luminosity mask), in the space in force when the mask was set.
  async maskAlpha(mask, gs, resources, w, h) {
    const group = mask.get('G');
    if (!(group instanceof Stream)) return null;
    const luminosity = mask.name('S') !== 'Alpha';
    const canvas = makeCanvas(w, h);
    const mctx = canvas.getContext('2d');
    if (luminosity) {
      let backdrop = [0, 0, 0];
      const bc = mask.get('BC');
      if (Array.isArray(bc)) {
        try {
          const space = makeColorSpace(this.doc, group.dict.dict('Group')?.get('CS') ?? Name.of('DeviceRGB'), resources);
          backdrop = space.rgb(bc.map((v) => this.doc.fetchIfRef(v)));
        } catch {
          backdrop = [0, 0, 0];
        }
      }
      mctx.fillStyle = css(backdrop);
      mctx.fillRect(0, 0, w, h);
    }
    const saved = this.ctx;
    this.ctx = mctx;
    const g = new GState();
    g.ctm = gs.ctm;
    try {
      await this.form(g, group, resources);
    } finally {
      this.ctx = saved;
    }
    const img = mctx.getImageData(0, 0, w, h);
    const d = img.data;
    const tr = mask.get('TR');
    let transfer = null;
    if (tr && !(tr instanceof Name)) {
      try {
        transfer = makeFunction(this.doc, tr);
      } catch {
        transfer = null;
      }
    }
    const table = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) table[v] = transfer ? transfer([v / 255])[0] * 255 : v;
    for (let i = 0; i < d.length; i += 4) {
      const v = luminosity ? Math.round(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) : d[i + 3];
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = table[v];
    }
    mctx.putImageData(img, 0, 0);
    return canvas;
  }

  // Sets the context's fill (or stroke) style from the state; false if nothing can be painted.
  async fillStyle(gs, stroke) {
    const ctx = this.ctx;
    const pat = stroke ? gs.strokePattern : gs.fillPattern;
    const prop = stroke ? 'strokeStyle' : 'fillStyle';
    if (pat) {
      const style = await this.patternStyle(gs, pat);
      if (!style) return false;
      ctx[prop] = style;
      return true;
    }
    if ((stroke ? gs.strokeSpace : gs.fillSpace).isPattern) return false;
    ctx[prop] = css(stroke ? gs.strokeColor : gs.fillColor);
    return true;
  }

  strokeStyle(gs) {
    const ctx = this.ctx;
    let w = gs.lineWidth;
    if (!(w > 0)) {
      // Width 0: the thinnest line the device can show, a pixel.
      const t = mul(this.base, gs.ctm);
      w = 1 / Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]) || 1);
    }
    ctx.lineWidth = w;
    ctx.lineCap = ['butt', 'round', 'square'][gs.lineCap] ?? 'butt';
    ctx.lineJoin = ['miter', 'round', 'bevel'][gs.lineJoin] ?? 'miter';
    ctx.miterLimit = gs.miterLimit > 0 ? gs.miterLimit : 10;
    const dash = gs.dash.length && gs.dash.some((v) => v > 0) && gs.dash.every((v) => v >= 0) ? gs.dash : [];
    ctx.setLineDash(dash);
    ctx.lineDashOffset = dash.length ? gs.dashPhase : 0;
  }

  extGState(gs, egs, resources) {
    if (!(egs instanceof Dict)) return;
    const doc = this.doc;
    for (const [key] of egs.map) {
      const v = egs.get(key);
      switch (key) {
        case 'LW':
          if (typeof v === 'number') gs.lineWidth = v;
          break;
        case 'LC':
          gs.lineCap = v;
          break;
        case 'LJ':
          gs.lineJoin = v;
          break;
        case 'ML':
          gs.miterLimit = v;
          break;
        case 'D':
          if (Array.isArray(v)) {
            const arr = doc.fetchIfRef(v[0]);
            gs.dash = Array.isArray(arr) ? arr.map((x) => doc.fetchIfRef(x)) : [];
            gs.dashPhase = doc.fetchIfRef(v[1]) ?? 0;
          }
          break;
        case 'CA':
          if (typeof v === 'number') gs.strokeAlpha = Math.max(0, Math.min(1, v));
          break;
        case 'ca':
          if (typeof v === 'number') gs.fillAlpha = Math.max(0, Math.min(1, v));
          break;
        case 'BM': {
          const name = Array.isArray(v) ? doc.fetchIfRef(v[0]) : v;
          gs.blend = (name instanceof Name && BLEND[name.name]) || 'source-over';
          break;
        }
        case 'SMask':
          gs.softMask = v instanceof Dict ? v : null;
          break;
        case 'Font':
          if (Array.isArray(v)) {
            gs.font = loadTextFont(doc, v[0]);
            gs.fontSize = doc.fetchIfRef(v[1]);
          }
          break;
      }
    }
  }

  // --- Text ------------------------------------------------------------------------------------

  async showText(gs, tm, parts, resources, visible, clip) {
    const font = gs.font;
    const ctx = this.ctx;
    if (!font || font.error) return tm;
    const fs = gs.fontSize;
    const h = gs.hScale;
    const vertical = font.vertical;
    const type3 = font.isType3Font;
    if (this.systemFonts) await prepareSystemFont(font);
    await prepareBundledFont(font, this.fonts);
    const drawing = type3 ? null : drawingFont(font, this.fonts);
    const mode = gs.renderMode;
    const fill = visible && (mode === 0 || mode === 2 || mode === 4 || mode === 6);
    const stroke = visible && (mode === 1 || mode === 2 || mode === 5 || mode === 6);
    const fm = font.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
    if (fill || stroke) ctx.globalCompositeOperation = gs.blend;
    for (const part of parts) {
      if (typeof part === 'number') {
        const d = (-part / 1000) * fs;
        tm = vertical ? mul(tm, [1, 0, 0, 1, 0, d]) : mul(tm, [1, 0, 0, 1, d * h, 0]);
        continue;
      }
      if (typeof part !== 'string') continue;
      for (const glyph of font.glyphs(part)) {
        const code = glyph.originalCharCode;
        // The glyph's place: text space to the page, at the font size and rise.
        let trm = mul(gs.ctm, mul(tm, [fs * h, 0, 0, fs, 0, gs.rise]));
        if (vertical) {
          const vm = glyph.vmetric;
          const vx = vm ? vm[1] * 0.001 : glyph.width * 0.0005;
          const vy = vm ? vm[2] * 0.001 : 0.88;
          trm = mul(trm, [1, 0, 0, 1, -vx, -vy]);
        }
        if (type3) {
          if (fill || stroke || clip) await this.type3Glyph(gs, font, code, trm, resources);
        } else {
          const g = drawing.glyph(code);
          if (g.cmds?.length) {
            g.path ??= toPath(g.cmds);
            const t = mul(this.base, trm);
            if (fill || stroke) {
              ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
              if (fill) {
                ctx.globalAlpha = gs.fillAlpha;
                if (await this.fillStyle(gs, false)) {
                  ctx.fill(g.path);
                  if (this.textDarken > 0 && !gs.fillPattern) {
                    ctx.strokeStyle = ctx.fillStyle;
                    ctx.lineWidth = this.textDarken / (Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1);
                    ctx.lineJoin = 'round';
                    ctx.setLineDash([]);
                    ctx.stroke(g.path);
                  }
                }
              }
              if (stroke) {
                ctx.globalAlpha = gs.strokeAlpha;
                this.strokeStyle(gs);
                // The line width is in user space; the path is in glyph space.
                const glyphScale = Math.sqrt(Math.abs((fs * h) * fs * (tm[0] * tm[3] - tm[1] * tm[2]))) || 1;
                ctx.lineWidth = gs.lineWidth > 0 ? gs.lineWidth / glyphScale : 1 / Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]) || 1);
                if (await this.fillStyle(gs, true)) ctx.stroke(g.path);
              }
              ctx.globalAlpha = 1;
            }
            if (clip) clip.path.addPath(g.path, new DOMMatrix(t));
          } else if (g.text && (fill || stroke || clip)) {
            // Drawn by the canvas's text engine, at 100 pixels scaled down (small sizes are rounded).
            const t = mul(this.base, mul(trm, [0.01, 0, 0, -0.01, 0, 0]));
            ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
            ctx.font = g.family ? `100px "${g.family}"` : `100px ${/Dingbats/i.test(font.name) ? '"Zapf Dingbats", ' : ''}"Symbol", sans-serif`;
            // Clipping to it: kept, to mask what follows (see ET).
            if (clip) clip.texts.push({ t, font: ctx.font, text: g.text });
            if (fill) {
              ctx.globalAlpha = gs.fillAlpha;
              if (await this.fillStyle(gs, false)) ctx.fillText(g.text, 0, 0);
            }
            if (stroke) {
              ctx.globalAlpha = gs.strokeAlpha;
              this.strokeStyle(gs);
              const glyphScale = Math.sqrt(Math.abs(fs * h * fs * (tm[0] * tm[3] - tm[1] * tm[2]))) || 1;
              ctx.lineWidth = gs.lineWidth > 0 ? (gs.lineWidth / glyphScale) * 100 : 1 / (Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1);
              if (await this.fillStyle(gs, true)) ctx.strokeText(g.text, 0, 0);
            }
            ctx.globalAlpha = 1;
          }
        }
        // The advance.
        const isSpace = glyph.width !== undefined && code === 32 && !font.composite;
        if (vertical) {
          const w1 = glyph.vmetric ? glyph.vmetric[0] * 0.001 : -1;
          const ty = w1 * fs + gs.charSpacing + (isSpace ? gs.wordSpacing : 0);
          tm = mul(tm, [1, 0, 0, 1, 0, ty]);
        } else {
          const w0 = (glyph.width ?? 0) * fm[0];
          const tx = (w0 * fs + gs.charSpacing + (isSpace ? gs.wordSpacing : 0)) * h;
          tm = mul(tm, [1, 0, 0, 1, tx, 0]);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    return tm;
  }

  async type3Glyph(gs, font, code, trm, resources) {
    if (this.depth > 8) return;
    const base = font.dict;
    const procs = base?.dict('CharProcs');
    const name = font.differences.get(code) ?? font.defaultEncoding?.[code];
    const proc = name ? procs?.get(name) : null;
    if (!(proc instanceof Stream)) return;
    const inner = gs.clone();
    inner.ctm = mul(trm, font.fontMatrix);
    inner.renderMode = 0;
    const res = base.get('Resources');
    this.depth++;
    this.ctx.save();
    try {
      await this.run(streamBytes(proc), res instanceof Dict ? res : resources, inner);
    } finally {
      this.ctx.restore();
      this.depth--;
    }
  }

  // --- XObjects and images -------------------------------------------------------------------

  async xobject(gs, name, resources) {
    if (!(name instanceof Name) || this.depth > 12) return;
    const xobjs = resources?.dict('XObject');
    const raw = xobjs?.raw(name.name);
    const x = xobjs?.get(name.name);
    if (!(x instanceof Stream)) return;
    if (this.isHidden(x.dict.raw('OC'))) return;
    const subtype = x.dict.name('Subtype');
    if (subtype === 'Image') return this.image(gs, x, resources, raw instanceof Ref ? raw.key : null);
    if (subtype === 'Form') return this.form(gs, x, resources);
  }

  async form(gs, x, resources, { matrix = null } = {}) {
    const ctx = this.ctx;
    const dict = x.dict;
    const inner = gs.clone();
    const m = matrix ?? dict.array('Matrix');
    if (isMatrix(m)) inner.ctm = mul(gs.ctm, m);
    const group = dict.get('Group');
    // A transparency group is drawn on a canvas of its own when it's isolated (its blending starts
    // from nothing rather than the page) or is laid on the page with alpha or a blend mode.
    const transparency = group instanceof Dict && group.name('S') === 'Transparency';
    const knockout = transparency && group.get('K') === true;
    const isolated = transparency && (group.get('I') === true || knockout || gs.fillAlpha < 1 || gs.blend !== 'source-over');
    this.depth++;
    ctx.save();
    try {
      const bbox = dict.array('BBox');
      if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((v) => typeof v === 'number')) {
        this.setTransform(inner.ctm);
        ctx.beginPath();
        ctx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
        ctx.clip();
        ctx.beginPath();
      }
      const res = dict.get('Resources');
      const formResources = res instanceof Dict ? res : resources;
      if (isolated) {
        // Laid on the page afterwards with the alpha and blend mode, so what overlaps inside it
        // doesn't show through itself.
        const canvas = makeCanvas(ctx.canvas.width, ctx.canvas.height);
        const sub = canvas.getContext('2d');
        const saved = this.ctx;
        this.ctx = sub;
        inner.fillAlpha = inner.strokeAlpha = 1;
        inner.blend = 'source-over';
        try {
          await this.run(streamBytes(x), formResources, inner, knockout);
        } finally {
          this.ctx = saved;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = gs.fillAlpha;
        ctx.globalCompositeOperation = gs.blend;
        ctx.drawImage(canvas, 0, 0);
      } else await this.run(streamBytes(x), formResources, inner);
    } finally {
      ctx.restore();
      this.depth--;
    }
  }

  async image(gs, stream, resources, key) {
    const ctx = this.ctx;
    const mask = stream.dict.get('ImageMask') === true || stream.dict.get('IM') === true;
    let img;
    const cacheKey = key && !mask ? key : null;
    if (cacheKey && this.images.has(cacheKey)) img = this.images.get(cacheKey);
    else {
      img = await decodeImage(this.doc, stream, resources, gs.fillColor);
      if (cacheKey) this.images.set(cacheKey, img);
    }
    if (!img) return;
    if (mask && gs.fillPattern) {
      // A stencil painted with a pattern: the stencil drawn on a canvas of its own, the pattern
      // filled into it, and that laid on the page.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const style = await this.patternStyle(gs, gs.fillPattern);
      if (!style) return;
      const layer = makeCanvas(ctx.canvas.width, ctx.canvas.height);
      const lctx = layer.getContext('2d');
      const t = mul(this.base, mul(gs.ctm, [1 / img.width, 0, 0, -1 / img.height, 0, 1]));
      lctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      lctx.drawImage(img.canvas, 0, 0);
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = 'source-in';
      lctx.fillStyle = style;
      lctx.fillRect(0, 0, layer.width, layer.height);
      ctx.globalAlpha = gs.fillAlpha;
      ctx.globalCompositeOperation = gs.blend;
      ctx.drawImage(layer, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    this.setTransform(mul(gs.ctm, [1 / img.width, 0, 0, -1 / img.height, 0, 1]));
    ctx.globalAlpha = gs.fillAlpha;
    ctx.globalCompositeOperation = gs.blend;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- Shadings and patterns ----------------------------------------------------------------

  // A canvas gradient for an axial or radial shading, in its own space; null for other types.
  gradient(shading) {
    const doc = this.doc;
    const dict = shading instanceof Stream ? shading.dict : shading;
    if (!(dict instanceof Dict)) return null;
    const type = dict.get('ShadingType');
    if (type !== 2 && type !== 3) return null;
    const space = makeColorSpace(doc, dict.get('ColorSpace'), null);
    const coords = dict.array('Coords');
    const domain = dict.array('Domain') ?? [0, 1];
    const extend = dict.array('Extend') ?? [false, false];
    const fn = makeFunction(doc, dict.get('Function'));
    const ctx = this.ctx;
    const g = type === 2 ? ctx.createLinearGradient(coords[0], coords[1], coords[2], coords[3]) : ctx.createRadialGradient(coords[0], coords[1], coords[2], coords[3], coords[4], coords[5]);
    // Colour stops sampled along the domain; where the colour jumps between two samples (a
    // stitched function's hard edge), the edge is found by halving and kept sharp.
    const rgbAt = (t) => space.rgb(fn([domain[0] + t * (domain[1] - domain[0])]));
    const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 48;
    const steps = 256;
    let prevT = 0;
    let prev = rgbAt(0);
    g.addColorStop(0, css(prev));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const c = rgbAt(t);
      if (far(prev, c)) {
        let lo = prevT;
        let hi = t;
        let cl = prev;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          const cm = rgbAt(mid);
          if (far(cl, cm)) hi = mid;
          else {
            lo = mid;
            cl = cm;
          }
        }
        g.addColorStop(lo, css(cl));
        g.addColorStop(hi, css(rgbAt(hi)));
      }
      g.addColorStop(t, css(c));
      prevT = t;
      prev = c;
    }
    // Where a pattern's shading doesn't reach, its Background (shading operators ignore it).
    const bg = dict.get('Background');
    let background = null;
    if (Array.isArray(bg) && bg.length === space.n) background = css(space.rgb(bg.map((v) => doc.fetchIfRef(v))));
    return { gradient: g, extend, type, coords, background };
  }

  shade(gs, shading, resources) {
    const ctx = this.ctx;
    const g = this.gradient(shading);
    if (!g) {
      // Function-based and mesh shadings: rasterised, then laid on the page through the clip.
      const canvas = shadingCanvas(this.doc, this.doc.fetchIfRef(shading), mul(this.base, gs.ctm), ctx.canvas.width, ctx.canvas.height, resources);
      if (!canvas) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = gs.fillAlpha;
      ctx.globalCompositeOperation = gs.blend;
      ctx.drawImage(canvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    this.setTransform(gs.ctm);
    ctx.globalAlpha = gs.fillAlpha;
    ctx.globalCompositeOperation = gs.blend;
    ctx.fillStyle = g.gradient;
    // Fill everything the clip lets through: the canvas, in the shading's space.
    const inv = invert(mul(this.base, gs.ctm));
    if (inv) {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]]);
      ctx.beginPath();
      if (!g.extend[0] || !g.extend[1]) {
        this.shadingArea(ctx, g, pts);
      } else {
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.lineTo(pts[3][0], pts[3][1]);
        ctx.lineTo(pts[2][0], pts[2][1]);
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.beginPath();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Where a shading that isn't extended paints: between its ends (an axial one's band, a radial
  // one's circles).
  shadingArea(ctx, g, pts) {
    const [x0, y0, x1, y1] = g.coords;
    if (g.type === 2) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const reach = Math.max(...pts.map(([x, y]) => Math.hypot(x - x0, y - y0))) + len;
      const s = g.extend[0] ? -reach / len : 0;
      const e = g.extend[1] ? 1 + reach / len : 1;
      const p = (t, k) => [x0 + dx * t + nx * k, y0 + dy * t + ny * k];
      const a = p(s, -reach);
      const b = p(e, -reach);
      const c = p(e, reach);
      const d = p(s, reach);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(d[0], d[1]);
      ctx.closePath();
    } else {
      const [cx0, cy0, r0, cx1, cy1, r1] = g.coords;
      // Extended past the end circle: everywhere; else within it. Not extended before the start
      // circle: not inside that.
      if (g.extend[1]) {
        const far = 1e7;
        ctx.rect(-far, -far, 2 * far, 2 * far);
      } else ctx.arc(cx1, cy1, Math.max(0, r1), 0, Math.PI * 2);
      if (!g.extend[0] && r0 > 0) {
        ctx.moveTo(cx0 + r0, cy0);
        ctx.arc(cx0, cy0, r0, 0, Math.PI * 2, true);
      }
    }
  }

  async patternStyle(gs, { pattern, tint }) {
    const dict = pattern instanceof Stream ? pattern.dict : pattern;
    if (!(dict instanceof Dict)) return null;
    const pm = dict.array('Matrix');
    const matrix = isMatrix(pm) ? pm : IDENTITY;
    // Patterns live in the space of the page's default coordinates (the form's, inside a form):
    // taken here as the page's.
    const toDevice = mul(this.base, matrix);
    if (dict.get('PatternType') === 2) {
      const g = this.gradient(dict.get('Shading'));
      if (g) return this.matrixPattern(g, toDevice);
      const canvas = shadingCanvas(this.doc, this.doc.fetchIfRef(dict.get('Shading')), toDevice, this.ctx.canvas.width, this.ctx.canvas.height, null);
      if (!canvas) return null;
      const style = this.ctx.createPattern(canvas, 'no-repeat');
      style.setTransform(this.ctx.getTransform().inverse());
      return style;
    }
    if (dict.get('PatternType') === 1 && pattern instanceof Stream) return this.tiling(gs, pattern, dict, toDevice, tint);
    return null;
  }

  // A gradient in pattern space, drawn as a canvas pattern the size of the canvas.
  matrixPattern(g, toDevice) {
    const w = this.ctx.canvas.width;
    const h = this.ctx.canvas.height;
    const c = makeCanvas(w, h);
    const cx = c.getContext('2d');
    cx.setTransform(toDevice[0], toDevice[1], toDevice[2], toDevice[3], toDevice[4], toDevice[5]);
    const inv = invert(toDevice);
    if (!inv) return null;
    if (g.background) {
      cx.save();
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.fillStyle = g.background;
      cx.fillRect(0, 0, w, h);
      cx.restore();
    }
    cx.fillStyle = g.gradient;
    const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]]);
    cx.beginPath();
    if (!g.extend[0] || !g.extend[1]) this.shadingArea(cx, g, pts);
    else {
      cx.moveTo(pts[0][0], pts[0][1]);
      cx.lineTo(pts[1][0], pts[1][1]);
      cx.lineTo(pts[3][0], pts[3][1]);
      cx.lineTo(pts[2][0], pts[2][1]);
      cx.closePath();
    }
    cx.fill('evenodd');
    const style = this.ctx.createPattern(c, 'no-repeat');
    // The pattern is in device pixels: undo the path's transform when painting.
    const cur = this.ctx.getTransform();
    style.setTransform(cur.inverse());
    return style;
  }

  // A tiling pattern with few tiles over the page (large ones), drawn tile by tile through the
  // current path as a clip, so each is drawn at full resolution; false if it isn't one.
  async drawTiles(gs, rule) {
    const { pattern, tint } = gs.fillPattern;
    if (!(pattern instanceof Stream) || pattern.dict.get('PatternType') !== 1) return false;
    const dict = pattern.dict;
    const bbox = dict.array('BBox');
    const xStep = dict.get('XStep');
    const yStep = dict.get('YStep');
    if (!Array.isArray(bbox) || !(Math.abs(xStep) > 0) || !(Math.abs(yStep) > 0)) return false;
    const pm = dict.array('Matrix');
    const matrix = isMatrix(pm) ? pm : IDENTITY;
    const toDevice = mul(this.base, matrix);
    const inv = invert(toDevice);
    if (!inv) return false;
    const ctx = this.ctx;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const i0 = Math.floor((Math.min(...xs) - bbox[2]) / Math.abs(xStep));
    const i1 = Math.ceil((Math.max(...xs) - bbox[0]) / Math.abs(xStep));
    const j0 = Math.floor((Math.min(...ys) - bbox[3]) / Math.abs(yStep));
    const j1 = Math.ceil((Math.max(...ys) - bbox[1]) / Math.abs(yStep));
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 64) return false;
    const res = dict.get('Resources');
    ctx.save();
    ctx.clip(rule);
    try {
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const inner = new GState();
          inner.ctm = mul(matrix, [1, 0, 0, 1, i * Math.abs(xStep), j * Math.abs(yStep)]);
          if (dict.get('PaintType') === 2) inner.fillColor = inner.strokeColor = tint ?? gs.fillColor;
          ctx.save();
          this.setTransform(inner.ctm);
          ctx.beginPath();
          ctx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
          ctx.clip();
          ctx.beginPath();
          this.depth++;
          try {
            await this.run(streamBytes(pattern), res instanceof Dict ? res : null, inner);
          } finally {
            this.depth--;
            ctx.restore();
          }
        }
      }
    } finally {
      ctx.restore();
    }
    return true;
  }

  async tiling(gs, stream, dict, toDevice, tint) {
    const bbox = dict.array('BBox');
    const xStep = dict.get('XStep');
    const yStep = dict.get('YStep');
    if (!Array.isArray(bbox) || !(Math.abs(xStep) > 0) || !(Math.abs(yStep) > 0)) return null;
    // One cell, drawn at the device's resolution.
    const sx = Math.hypot(toDevice[0], toDevice[1]);
    const sy = Math.hypot(toDevice[2], toDevice[3]);
    const cw = Math.min(2048, Math.max(1, Math.ceil(Math.abs(xStep) * sx)));
    const ch = Math.min(2048, Math.max(1, Math.ceil(Math.abs(yStep) * sy)));
    const c = makeCanvas(cw, ch);
    const cx = c.getContext('2d');
    const cellBase = [cw / xStep, 0, 0, -ch / yStep, -bbox[0] * (cw / xStep), ch + bbox[1] * (ch / yStep)];
    const sub = new Renderer(this.doc, cx, cellBase, this.fonts);
    sub.depth = this.depth + 1;
    const inner = new GState();
    if (dict.get('PaintType') === 2 && tint) {
      inner.fillColor = inner.strokeColor = tint;
    } else if (dict.get('PaintType') === 2) inner.fillColor = inner.strokeColor = gs.fillColor;
    const res = dict.get('Resources');
    await sub.run(streamBytes(stream), res instanceof Dict ? res : null, inner);
    const style = this.ctx.createPattern(c, 'repeat');
    const m = mul(toDevice, [xStep / cw, 0, 0, -yStep / ch, bbox[0], bbox[1] + yStep]);
    const cur = this.ctx.getTransform().inverse();
    style.setTransform(cur.multiply(new DOMMatrix(m)));
    return style;
  }

  // --- Optional content and annotations -------------------------------------------------------

  // Whether optional content (a group or membership dictionary, or a reference to one) is off.
  isHidden(raw) {
    const key = raw instanceof Ref ? raw.key : null;
    const oc = this.doc.fetchIfRef(raw);
    if (!(oc instanceof Dict)) return false;
    if (oc.name('Type') === 'OCMD') {
      const ocgs = oc.get('OCGs');
      const list = Array.isArray(ocgs) ? ocgs : oc.raw('OCGs') ? [oc.raw('OCGs')] : [];
      const refs = list.map((r) => (r instanceof Ref ? r.key : null)).filter(Boolean);
      if (!refs.length) return false;
      const policy = oc.name('P') ?? 'AnyOn';
      const on = refs.map((k) => !this.hidden.has(k));
      if (policy === 'AllOn') return !on.every(Boolean);
      if (policy === 'AnyOff') return !on.some((v) => !v);
      if (policy === 'AllOff') return !on.every((v) => !v);
      return !on.some(Boolean);
    }
    return key ? this.hidden.has(key) : false;
  }

  async annotations(page) {
    const doc = this.doc;
    const annots = page.dict.get('Annots');
    if (!Array.isArray(annots)) return;
    for (const ref of annots) {
      try {
        const annot = doc.fetchIfRef(ref);
        if (!(annot instanceof Dict)) continue;
        const flags = annot.get('F') ?? 0;
        if (flags & 2 || flags & 32 || flags & 1) continue; // Hidden, NoView, Invisible
        if (annot.name('Subtype') === 'Popup') continue;
        if (this.isHidden(annot.raw('OC'))) continue;
        let ap = annot.dict('AP')?.get('N');
        if (ap instanceof Dict) {
          const as = annot.get('AS');
          ap = as instanceof Name ? ap.get(as.name) : null;
        }
        if (!(ap instanceof Stream)) {
          if (annot.name('Subtype') === 'Widget') await this.fieldAppearance(annot);
          else this.defaultAppearance(annot);
          continue;
        }
        const rect = annot.array('Rect');
        const bbox = ap.dict.array('BBox');
        if (!Array.isArray(rect) || !Array.isArray(bbox) || rect.length !== 4 || bbox.length !== 4) continue;
        const m = ap.dict.array('Matrix');
        const matrix = isMatrix(m) ? m : IDENTITY;
        // PDF 32000-1 12.5.5: the box transformed by Matrix, mapped onto the annotation's Rect.
        const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        const bx0 = Math.min(...xs);
        const by0 = Math.min(...ys);
        const bw = Math.max(...xs) - bx0 || 1;
        const bh = Math.max(...ys) - by0 || 1;
        const rx0 = Math.min(rect[0], rect[2]);
        const ry0 = Math.min(rect[1], rect[3]);
        const rw = Math.abs(rect[2] - rect[0]);
        const rh = Math.abs(rect[3] - rect[1]);
        const a = [rw / bw, 0, 0, rh / bh, rx0 - (bx0 * rw) / bw, ry0 - (by0 * rh) / bh];
        const gs = new GState();
        gs.ctm = a;
        await this.form(gs, ap, page.resources, { matrix });
      } catch {
        // an annotation that can't be drawn is left out
      }
    }
  }
}

// What a markup annotation with no appearance stream looks like, drawn from its description as
// Preview draws it: highlights (multiplied over the text, ends rounded), underlines, strike-outs,
// squiggles, squares, circles, lines and ink.
Renderer.prototype.defaultAppearance = function (annot) {
  const doc = this.doc;
  const ctx = this.ctx;
  const nums = (key) => {
    const v = annot.get(key);
    return Array.isArray(v) ? v.map((x) => doc.fetchIfRef(x)).filter((x) => typeof x === 'number') : null;
  };
  const colorOf = (key) => {
    const c = nums(key);
    if (!c || !c.length) return null;
    if (c.length === 1) return GRAY.rgb(c);
    if (c.length === 3) return RGB_SPACE.rgb(c);
    if (c.length === 4) return CMYK_SPACE.rgb(c);
    return null;
  };
  const type = annot.name('Subtype');
  const color = colorOf('C');
  const alpha = typeof annot.get('CA') === 'number' ? annot.get('CA') : 1;
  // The border's width: BS's W, or the older Border array's third number.
  const bs = annot.dict('BS');
  const border = nums('Border');
  const width = typeof bs?.get('W') === 'number' ? bs.get('W') : border?.length >= 3 ? border[2] : 1;
  this.setTransform(IDENTITY);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.setLineDash([]);
  try {
    const quads = nums('QuadPoints');
    const eachQuad = (fn) => {
      for (let i = 0; quads && i + 7 < quads.length; i += 8) {
        const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]];
        const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]];
        fn(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
      }
    };
    switch (type) {
      case 'Highlight':
        if (!color) break;
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = css(color);
        eachQuad((x0, y0, x1, y1) => {
          const r = Math.min((y1 - y0) / 2, (x1 - x0) / 2) * 0.5;
          ctx.beginPath();
          ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r);
          ctx.fill();
        });
        break;
      case 'Underline':
      case 'StrikeOut':
      case 'Squiggly':
        if (!color) break;
        ctx.strokeStyle = css(color);
        eachQuad((x0, y0, x1, y1) => {
          const h = y1 - y0;
          ctx.lineWidth = Math.max(0.5, h / 14);
          ctx.beginPath();
          if (type === 'Squiggly') {
            const step = h / 6;
            for (let x = x0, up = 0; x <= x1; x += step, up ^= 1) {
              const y = y0 + step * (up ? 1.5 : 0.5);
              if (x === x0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
          } else {
            const y = type === 'StrikeOut' ? y0 + h / 2 : y0 + h / 14;
            ctx.moveTo(x0, y);
            ctx.lineTo(x1, y);
          }
          ctx.stroke();
        });
        break;
      case 'Square':
      case 'Circle': {
        const rect = nums('Rect');
        if (!rect || rect.length !== 4) break;
        const x0 = Math.min(rect[0], rect[2]) + width / 2;
        const y0 = Math.min(rect[1], rect[3]) + width / 2;
        const w = Math.abs(rect[2] - rect[0]) - width;
        const h = Math.abs(rect[3] - rect[1]) - width;
        ctx.beginPath();
        if (type === 'Square') ctx.rect(x0, y0, w, h);
        else ctx.ellipse(x0 + w / 2, y0 + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
        const interior = colorOf('IC');
        if (interior) {
          ctx.fillStyle = css(interior);
          ctx.fill();
        }
        if (color && width > 0) {
          ctx.strokeStyle = css(color);
          ctx.stroke();
        }
        break;
      }
      case 'Line': {
        const l = nums('L');
        if (!color || !l || l.length !== 4) break;
        ctx.strokeStyle = css(color);
        ctx.beginPath();
        ctx.moveTo(l[0], l[1]);
        ctx.lineTo(l[2], l[3]);
        ctx.stroke();
        break;
      }
      case 'Ink': {
        const ink = annot.get('InkList');
        if (!color || !Array.isArray(ink)) break;
        ctx.strokeStyle = css(color);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const list of ink) {
          const pts = doc.fetchIfRef(list);
          if (!Array.isArray(pts)) continue;
          ctx.beginPath();
          for (let i = 0; i + 1 < pts.length; i += 2) {
            const x = doc.fetchIfRef(pts[i]);
            const y = doc.fetchIfRef(pts[i + 1]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        break;
      }
    }
  } finally {
    ctx.restore();
  }
};

// A text field with no appearance stream, drawn from its value and default appearance (DA: font,
// size, colour), aligned by Q, a comb field's characters one to a cell, as Preview draws it.
Renderer.prototype.fieldAppearance = async function (annot) {
  const doc = this.doc;
  const acro = doc.catalog?.dict('AcroForm');
  // Field entries are inherited from parent fields.
  const inherited = (key) => {
    for (let d = annot, n = 0; d instanceof Dict && n < 20; d = d.get('Parent'), n++) if (d.has(key)) return d.get(key);
    return acro?.get(key);
  };
  if (inherited('FT')?.name !== 'Tx') return;
  const value = textString(inherited('V'));
  if (!value) return;
  const rect = annot.array('Rect');
  if (!Array.isArray(rect) || rect.length !== 4) return;
  const w = Math.abs(rect[2] - rect[0]);
  const h = Math.abs(rect[3] - rect[1]);
  const da = typeof inherited('DA') === 'string' ? inherited('DA') : '';
  const fontMatch = da.match(/\/([^\s/]+)\s+([\d.]+)\s+Tf/);
  const color = da.match(/([\d.]+\s+){0,3}[\d.]+\s+(g|rg|k)\b/)?.[0] ?? '0 g';
  const dr = acro?.dict('DR');
  const fontName = fontMatch?.[1];
  const fontRef = fontName ? dr?.dict('Font')?.raw(fontName) : null;
  const font = fontRef ? loadTextFont(doc, fontRef) : null;
  if (!font || font.error) return;
  let size = fontMatch ? Number(fontMatch[2]) : 12;
  if (!(size > 0)) size = Math.max(4, Math.min(12, (h - 4) * 0.8));
  const flags = Number(inherited('Ff')) || 0;
  const maxLen = Number(inherited('MaxLen')) || 0;
  const comb = flags & (1 << 24) && maxLen > 0;
  const q = Number(inherited('Q')) || 0;
  // The value's bytes: one per character for a simple font.
  const bytes = [...value].map((ch) => {
    const c = ch.charCodeAt(0);
    const enc = font.toUnicode?.charCodeOf?.(ch);
    return String.fromCharCode(typeof enc === 'number' && enc >= 0 ? enc : c & 0xff);
  });
  const widthOf = (str) => font.glyphs(str).reduce((a, g) => a + (g.width ?? 0) * (font.fontMatrix?.[0] ?? 0.001), 0) * size;
  const baseline = (h - size * 0.78) / 2 + size * 0.22;
  const esc = (str) => str.replace(/[\\()]/g, (m) => '\\' + m);
  let body;
  if (comb) {
    const cell = w / maxLen;
    body = bytes
      .slice(0, maxLen)
      .map((b, i) => `1 0 0 1 ${(i * cell + (cell - widthOf(b)) / 2).toFixed(3)} ${baseline.toFixed(3)} Tm (${esc(b)}) Tj`)
      .join(' ');
  } else {
    const text = bytes.join('');
    const tw = widthOf(text);
    const x = q === 1 ? (w - tw) / 2 : q === 2 ? w - 2 - tw : 2;
    body = `1 0 0 1 ${x.toFixed(3)} ${baseline.toFixed(3)} Tm (${esc(text)}) Tj`;
  }
  const content = `/Tx BMC q 1 1 ${(w - 2).toFixed(3)} ${(h - 2).toFixed(3)} re W n BT /${fontName} ${size} Tf ${color} ${body} ET Q EMC`;
  const gs = new GState();
  gs.ctm = [1, 0, 0, 1, Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3])];
  const resources = new Dict(doc);
  if (dr?.dict('Font')) resources.set('Font', dr.dict('Font'));
  this.ctx.save();
  try {
    await this.run(Uint8Array.from(content, (c) => c.charCodeAt(0) & 0xff), resources, gs);
  } finally {
    this.ctx.restore();
  }
};

// Optional content groups switched off in the document's default configuration, by reference.
function hiddenGroups(doc) {
  const off = new Set();
  try {
    const ocp = doc.catalog?.dict('OCProperties');
    const d = ocp?.dict('D');
    if (!d) return off;
    const all = ocp.get('OCGs');
    const keys = (arr) => (Array.isArray(arr) ? arr.filter((r) => r instanceof Ref).map((r) => r.key) : []);
    if (d.name('BaseState') === 'OFF') {
      for (const k of keys(all)) off.add(k);
      for (const k of keys(d.get('ON'))) off.delete(k);
    }
    for (const k of keys(d.get('OFF'))) off.add(k);
  } catch {
    // no optional content to go by
  }
  return off;
}

function toPath(cmds) {
  const p = new Path2D();
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        p.moveTo(c[1], c[2]);
        break;
      case 'L':
        p.lineTo(c[1], c[2]);
        break;
      case 'Q':
        p.quadraticCurveTo(c[1], c[2], c[3], c[4]);
        break;
      case 'C':
        p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        break;
      case 'Z':
        p.closePath();
        break;
    }
  }
  return p;
}
