// Draws an ad at one size, at any moment. Each layer is an absolutely positioned element in a box
// of the size's exact pixels; seek(t) sets every layer from the model's stateAt, so a moment is
// always drawn the same way (no CSS animations or transitions: time is set, never run). Scaling to
// fit the element is a transform on the box alone, so the layout is the same at any scale, and at
// scale 1 (fit: false) in a hidden window for exporting frames.
//
//   const renderer = createAdRenderer(el, { assetUrl: (id) => url })
//   renderer.show(ad, sizeId)   // builds the layers (the ad raw or normalised)
//   renderer.seek(t)            // seconds
//   await renderer.ready()      // pictures decoded, so a frame can be captured
//   renderer.destroy()
//
// Options: assetUrl(id) gives an image's URL (none draws a placeholder); fit (default true) scales
// the ad to fit el, centred, on a sheet with a soft shadow, at most maxScale (default 2) and with
// margin (default 24) px round it; fit: false draws it at scale 1 at el's top left.

import { layersAt, layoutText, normalizeAd, stateAt } from '../main/ad-model.js';

const SHEET_SHADOW = '0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.1), 0 8px 28px rgba(0, 0, 0, 0.12)';
const FAR = '-100000px'; // a wipe's sides that don't move, so a shadow isn't cut off there

export function createAdRenderer(el, { assetUrl = () => null, fit = true, margin = 24, maxScale = 2 } = {}) {
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  const sheet = document.createElement('div');
  sheet.className = 'ad-sheet';
  Object.assign(sheet.style, { position: 'absolute', left: '0', top: '0', overflow: 'hidden' });
  if (fit) sheet.style.boxShadow = SHEET_SHADOW;
  const box = document.createElement('div');
  box.className = 'ad-box';
  Object.assign(box.style, { position: 'absolute', left: '0', top: '0', overflow: 'hidden', transformOrigin: '0 0', isolation: 'isolate' });
  sheet.append(box);
  el.append(sheet);

  let ad = null;
  let size = null;
  let nodes = [];
  let time = 0;
  let scale = 1;
  let images = [];

  // Exact text widths, from the same font engine the page draws with.
  const ctx = document.createElement('canvas').getContext('2d');
  const widths = new Map();
  const measure = (text, font) => {
    const key = `${font.italic ? 'i' : ''}${font.weight}|${font.size}|${font.letterSpacing}|${font.family}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      ctx.font = `${font.italic ? 'italic ' : ''}${font.weight} ${font.size}px ${font.family}`;
      ctx.letterSpacing = `${font.letterSpacing}px`;
      w = ctx.measureText(text).width;
      widths.set(key, w);
    }
    return w;
  };

  function place() {
    if (!size) return;
    if (!fit) {
      scale = 1;
      Object.assign(sheet.style, { width: `${size.width}px`, height: `${size.height}px`, transform: '' });
      box.style.transform = '';
      return;
    }
    const W = el.clientWidth;
    const H = el.clientHeight;
    scale = Math.max(0.01, Math.min((W - 2 * margin) / size.width, (H - 2 * margin) / size.height, maxScale));
    const w = size.width * scale;
    const h = size.height * scale;
    Object.assign(sheet.style, { width: `${w}px`, height: `${h}px`, transform: `translate(${Math.round((W - w) / 2)}px, ${Math.round((H - h) / 2)}px)` });
    box.style.transform = `scale(${scale})`;
  }
  const resizes = new ResizeObserver(() => place());
  if (fit) resizes.observe(el);

  function textInto(node, entry) {
    const { style } = entry;
    const fitted = layoutText(entry, measure);
    const inner = document.createElement('div');
    Object.assign(inner.style, {
      display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
      justifyContent: { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[style.valign],
      fontFamily: style.family, fontWeight: String(style.weight), fontStyle: style.italic ? 'italic' : 'normal',
      fontSize: `${fitted.size}px`, letterSpacing: `${fitted.letterSpacing}px`, color: style.color,
      fontKerning: 'normal', textRendering: 'geometricPrecision',
    });
    const words = [];
    const lines = [];
    for (const line of fitted.lines) {
      const div = document.createElement('div');
      Object.assign(div.style, { height: `${fitted.lineHeight}px`, lineHeight: `${fitted.lineHeight}px`, whiteSpace: 'pre', textAlign: style.align, flex: 'none' });
      line.words.forEach((word, i) => {
        if (i) div.append(' ');
        const span = document.createElement('span');
        span.textContent = word;
        div.append(span);
        words.push(span);
      });
      inner.append(div);
      lines.push(div);
    }
    node.append(inner);
    return { words, lines, fitted };
  }

  function build(entry) {
    const { layer, frame, style } = entry;
    const node = document.createElement('div');
    node.className = `ad-layer ad-${layer.kind}`;
    node.dataset.layer = layer.id;
    Object.assign(node.style, {
      position: 'absolute', boxSizing: 'border-box',
      left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.w}px`, height: `${frame.h}px`,
      transformOrigin: '50% 50%', background: style.background ?? 'transparent',
    });
    if (style.border) node.style.border = `${style.border.width}px solid ${style.border.color}`;
    if (style.shadow) node.style.filter = `drop-shadow(${style.shadow.x}px ${style.shadow.y}px ${style.shadow.blur}px ${style.shadow.color})`;
    const out = { id: layer.id, node, kind: layer.kind, reveal: style.reveal, words: null, lines: null, last: {} };
    if (layer.kind === 'shape') {
      if (layer.shape === 'line') {
        node.style.background = 'transparent';
        const bar = document.createElement('div');
        const across = frame.w >= frame.h;
        const t = style.thickness;
        Object.assign(bar.style, across
          ? { position: 'absolute', left: '0', right: '0', top: `${(frame.h - t) / 2}px`, height: `${t}px` }
          : { position: 'absolute', top: '0', bottom: '0', left: `${(frame.w - t) / 2}px`, width: `${t}px` });
        bar.style.background = style.background;
        if (style.radius) bar.style.borderRadius = `${t / 2}px`;
        node.append(bar);
      } else {
        node.style.borderRadius = layer.shape === 'ellipse' ? '50%' : `${style.radius}px`;
      }
    } else if (layer.kind === 'image') {
      node.style.borderRadius = `${style.radius}px`;
      node.style.overflow = 'hidden';
      const url = assetUrl(layer.asset);
      if (url) {
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.decoding = 'sync';
        Object.assign(img.style, { display: 'block', width: '100%', height: '100%', objectFit: style.fit, userSelect: 'none', pointerEvents: 'none' });
        img.src = url;
        images.push(img.decode().catch(() => {}));
        node.append(img);
      } else {
        Object.assign(node.style, {
          background: 'repeating-linear-gradient(135deg, rgba(128,128,128,0.16) 0 8px, rgba(128,128,128,0.08) 8px 16px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(110,110,115,0.9)',
          font: '600 11px -apple-system, sans-serif', textAlign: 'center',
        });
        node.textContent = ad.assets.find((a) => a.id === layer.asset)?.name ?? layer.asset;
      }
    } else {
      node.style.borderRadius = `${style.radius}px`;
      const text = textInto(node, entry);
      node.style.padding = `${text.fitted.inset.y - (style.border?.width ?? 0)}px ${text.fitted.inset.x - (style.border?.width ?? 0)}px`;
      out.words = text.words;
      out.lines = text.lines;
      out.fitted = text.fitted;
    }
    return out;
  }

  const set = (n, key, value) => {
    if (n.last[key] === value) return;
    n.last[key] = value;
    n.node.style[key] = value;
  };

  function wipe(way, r) {
    if (r >= 1) return 'none';
    const cut = `${((1 - r) * 100).toFixed(3)}%`;
    const half = `${((1 - r) * 50).toFixed(3)}%`;
    switch (way) {
      case 'right': return `inset(${FAR} ${FAR} ${FAR} ${cut})`;
      case 'top': return `inset(${FAR} ${FAR} ${cut} ${FAR})`;
      case 'bottom': return `inset(${cut} ${FAR} ${FAR} ${FAR})`;
      case 'center': return `inset(${FAR} ${half} ${FAR} ${half})`;
      default: return `inset(${FAR} ${cut} ${FAR} ${FAR})`;
    }
  }

  function fade(parts, r) {
    const n = parts.length;
    parts.forEach((part, i) => {
      const o = Math.min(1, Math.max(0, r * n - i));
      const v = o >= 1 ? '' : String(Math.round(o * 1000) / 1000);
      if (part.style.opacity !== v) part.style.opacity = v;
    });
  }

  function seek(t) {
    time = t;
    if (!ad) return;
    const state = stateAt(ad, size.id, t);
    const byId = new Map(state.layers.map((s) => [s.id, s]));
    for (const n of nodes) {
      const s = byId.get(n.id);
      if (!s) { set(n, 'display', 'none'); continue; }
      set(n, 'display', 'block');
      const moved = s.x || s.y || s.rotate || s.scale !== 1;
      set(n, 'transform', moved ? `translate(${s.x}px, ${s.y}px) rotate(${s.rotate}deg) scale(${s.scale})` : 'none');
      set(n, 'opacity', s.opacity >= 1 ? '' : String(Math.round(s.opacity * 1000) / 1000));
      if (n.reveal === 'words' && n.words) { fade(n.words, s.reveal); set(n, 'clipPath', 'none'); }
      else if (n.reveal === 'lines' && n.lines) { fade(n.lines, s.reveal); set(n, 'clipPath', 'none'); }
      else set(n, 'clipPath', wipe(n.reveal, s.reveal));
    }
  }

  function show(next, sizeId) {
    ad = normalizeAd(next);
    size = ad.sizes.find((s) => s.id === sizeId) ?? ad.sizes[0];
    widths.clear();
    images = [];
    box.replaceChildren();
    Object.assign(box.style, { width: `${size.width}px`, height: `${size.height}px`, background: ad.background });
    nodes = layersAt(ad, size.id).map(build);
    for (const n of nodes) box.append(n.node);
    place();
    time = Math.min(time, ad.duration);
    seek(time);
  }

  return {
    show,
    seek,
    // Resolves once the pictures are decoded and the fonts loaded, so what's drawn is complete.
    ready: () => Promise.all([...images, document.fonts?.ready]).then(() => {}),
    destroy() {
      resizes.disconnect();
      sheet.remove();
      ad = null;
      nodes = [];
    },
    // How a text or button layer's words were fitted at this size ({ size, lines, overflow, … }).
    textLayout: (id) => nodes.find((n) => n.id === id)?.fitted ?? null,
    measure,
    get ad() { return ad; },
    get size() { return size; },
    get time() { return time; },
    get scale() { return scale; },
    get element() { return box; },
  };
}
