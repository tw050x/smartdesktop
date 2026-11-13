// A page's text laid over its drawing, to select and search (in a browser): a span for each text
// item with text, and a line break after each item that ends a line, placed and sized as pdf.js's
// TextLayer places them, with the same CSS variables (--font-height, --scale-x, --rotate) and the
// layer sized by --total-scale-factor, so the same stylesheet lays out either, and positions in the
// text (offsets into its items, one span each) work the same.

const DEFAULT_FONT_SIZE = 30;
const ascents = new Map();
let measureCtx = null;

const ctx = () => {
  if (!measureCtx) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    measureCtx = canvas.getContext('2d', { alpha: false });
  }
  return measureCtx;
};

// The share of a font's height above its baseline: the browser's measure of the family, else the
// font's own ascent, else 0.8.
function ascentOf(fontFamily, style) {
  const cached = ascents.get(fontFamily);
  if (cached) return cached;
  const c = ctx();
  c.font = `${DEFAULT_FONT_SIZE}px ${fontFamily}`;
  const m = c.measureText('');
  const ascent = m.fontBoundingBoxAscent;
  const descent = Math.abs(m.fontBoundingBoxDescent);
  let ratio = 0.8;
  if (ascent) ratio = ascent / (ascent + descent);
  else if (style.ascent) ratio = style.ascent;
  else if (style.descent) ratio = 1 + style.descent;
  ascents.set(fontFamily, ratio);
  return ratio;
}

const quantize = (size) => {
  size = Math.fround(size);
  const d = Math.fround(size * ((1 << 17) + 1));
  return Math.fround(d - Math.fround(d - size));
};

// `textContent` as getTextContent gives it ({ items, styles }); `viewport` as viewport() gives it.
// Returns the spans, in the items' order (those with text).
export function renderTextLayer({ textContent, container, viewport }) {
  const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
  container.style.width = `round(down, var(--total-scale-factor) * ${pageWidth}px, var(--scale-round-x))`;
  container.style.height = `round(down, var(--total-scale-factor) * ${pageHeight}px, var(--scale-round-y))`;
  container.setAttribute('data-main-rotation', viewport.rotation);
  const transform = [1, 0, 0, -1, -pageX, pageY + pageHeight];
  const scale = viewport.scale * (globalThis.devicePixelRatio || 1);
  const pixelRatio = globalThis.devicePixelRatio || 1;
  const styles = textContent.styles ?? {};
  const divs = [];
  const fragment = document.createDocumentFragment();
  const c = ctx();
  for (const item of textContent.items) {
    if (typeof item.str !== 'string') continue;
    const div = document.createElement('span');
    divs.push(div);
    const m = item.transform;
    const tx = [
      transform[0] * m[0] + transform[2] * m[1],
      transform[1] * m[0] + transform[3] * m[1],
      transform[0] * m[2] + transform[2] * m[3],
      transform[1] * m[2] + transform[3] * m[3],
      transform[0] * m[4] + transform[2] * m[5] + transform[4],
      transform[1] * m[4] + transform[3] * m[5] + transform[5],
    ];
    const style = styles[item.fontName] ?? { fontFamily: 'sans-serif', vertical: false };
    let angle = Math.atan2(tx[1], tx[0]);
    if (style.vertical) angle += Math.PI / 2;
    const fontFamily = style.fontFamily || 'sans-serif';
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const fontAscent = fontHeight * ascentOf(fontFamily, style);
    const left = angle === 0 ? tx[4] : tx[4] + fontAscent * Math.sin(angle);
    const top = angle === 0 ? tx[5] - fontAscent : tx[5] - fontAscent * Math.cos(angle);
    const s = div.style;
    s.left = `${((100 * left) / pageWidth).toFixed(2)}%`;
    s.top = `${((100 * top) / pageHeight).toFixed(2)}%`;
    const fontSize = Math.round(fontHeight * 100) / 100;
    s.setProperty('--font-height', `${fontSize}px`);
    s.fontFamily = fontFamily;
    div.setAttribute('role', 'presentation');
    div.textContent = item.str;
    div.dir = item.dir;
    // Stretched to the item's width, as pdf.js does for more than one character (or a lone one
    // much squeezed).
    let scaleWidth = 0;
    if (item.str.length > 1) scaleWidth = style.vertical ? item.height : item.width;
    else if (item.str !== ' ' && m[0] !== m[3]) {
      const sx = Math.abs(m[0]);
      const sy = Math.abs(m[3]);
      if (sx !== sy && Math.max(sx, sy) / Math.min(sx, sy) > 1.5) scaleWidth = style.vertical ? item.height : item.width;
    }
    if (scaleWidth && fontSize && item.str) {
      const measured = quantize((fontSize * scale) / pixelRatio) * pixelRatio;
      c.font = `${measured}px ${fontFamily}`;
      const { width } = c.measureText(item.str);
      if (width > 0) s.setProperty('--scale-x', (scaleWidth * measured) / (width * fontSize));
    }
    if (angle !== 0) s.setProperty('--rotate', `${angle * (180 / Math.PI)}deg`);
    if (item.str) fragment.append(div);
    if (item.hasEOL) {
      const br = document.createElement('br');
      br.setAttribute('role', 'presentation');
      fragment.append(br);
    }
  }
  container.append(fragment);
  return divs;
}
