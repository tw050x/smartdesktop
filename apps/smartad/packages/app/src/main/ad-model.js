// The ad: what the AI sends, what the app stores, and what the window draws. Plain JavaScript with
// no Electron and no DOM, so the main process (the MCP tools) and the renderer (through Vite) share
// one truth: validateAd checks and normalises what the AI wrote, and stateAt says where everything
// is at any moment, as numbers, which the renderer only applies.
//
// The AI writes the ad as JSON. Everything is checked, and every mistake is reported with the path
// to it and what to write instead ("layers[2].animation[0].keyframes[1].t: 7 is past the end…").
//
// The format is MODEL_GUIDE, below the sizes: what the AI is told (propose_ad in mcp-tools.js).
//
// The normalised ad (validateAd's) has every default filled in, sizes resolved and animation as a
// list of tracks; validating it again gives the same. Treat ads as immutable: stateAt keeps what it
// works out for each ad object.
//
// Exports: SIZE_PRESETS, resolveSize(idOrSize); validateAd(content) → { ok, ad } | { ok: false,
// errors }, normalizeAd(content) (the ad, or throws); layerAt(ad, layer, sizeId), layersAt(ad,
// sizeId); stateAt(ad, sizeId, t); valueAt(keyframes, t), ease(name, p), EASES; layoutText(state,
// measure?), estimateWidth; summarize(ad); changedSpans(before, after); checkSize(ad, size,
// { measure }), checkAd(ad, { measure }); FONTS, fontStack(name), isColor, lengthPx, seconds; and
// the limits (MAX_DURATION, MAX_LOOPS, DISPLAY_PLAYTIME, DISPLAY_LOOPS, READABLE_PX, MIN_FONT_PX).

// --- Sizes ------------------------------------------------------------------------------------

export const SIZE_PRESETS = Object.freeze([
  { id: '300x250', width: 300, height: 250, name: 'Medium rectangle', kind: 'display' },
  { id: '728x90', width: 728, height: 90, name: 'Leaderboard', kind: 'display' },
  { id: '160x600', width: 160, height: 600, name: 'Wide skyscraper', kind: 'display' },
  { id: '300x600', width: 300, height: 600, name: 'Half page', kind: 'display' },
  { id: '320x50', width: 320, height: 50, name: 'Mobile banner', kind: 'display' },
  { id: '320x100', width: 320, height: 100, name: 'Large mobile banner', kind: 'display' },
  { id: '336x280', width: 336, height: 280, name: 'Large rectangle', kind: 'display' },
  { id: '970x250', width: 970, height: 250, name: 'Billboard', kind: 'display' },
  { id: 'square', width: 1080, height: 1080, name: 'Square', kind: 'social' },
  { id: 'portrait', width: 1080, height: 1350, name: 'Portrait 4:5', kind: 'social' },
  { id: 'story', width: 1080, height: 1920, name: 'Story 9:16', kind: 'social' },
  { id: 'landscape', width: 1200, height: 628, name: 'Landscape 1.91:1', kind: 'social' },
].map(Object.freeze));

export const MAX_DURATION = 60; // seconds, for any ad
export const MAX_LOOPS = 10;
export const DISPLAY_PLAYTIME = 30; // seconds, loops included: Google's and most display networks' limit
export const DISPLAY_LOOPS = 3;
export const READABLE_PX = 10; // text smaller than this is hard to read
export const MIN_FONT_PX = 4; // shrinking text stops here
const MIN_SIDE = 10;
const MAX_SIDE = 4096;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

// The format, as the AI is told it (propose_ad's content: mcp-tools.js), and as this module
// checks it. Keep it the one description of the format.
export const MODEL_GUIDE = `{
  duration: seconds it runs, 0 for a still ad, at most 60 (display networks allow 30 in all,
    loops included: checkSize warns past that).
  loops: how many times it plays, 1 to 10 (display networks allow 3: checkSize warns). Default 1.
    A still ignores it.
  background: a CSS colour, or a linear-, radial- or conic-gradient(…). Default white.
  sizes: the formats it's made in, at least one: a preset's id ("300x250", "story": SIZE_PRESETS),
    any "WIDTHxHEIGHT", or { id?, width, height, name?, kind? } (kind 'display' or 'social';
    id defaults to "WIDTHxHEIGHT", and must be lower-case letters, digits and hyphens).
  assets?: [ { id, name?, type?, width?, height? } ], the images the user gave (the files are the
    app's); type a MIME type or png, jpeg, webp, svg, gif.
  layers: [ layer… ], drawn in order, the first at the back.
  fonts: filled in by validateAd: the fonts the layers use (for exports to bring with them).
}

layer = {
  id: unique, lower-case letters, digits and hyphens ("headline", "call-to-action").
  name?: what to call it, for people.
  kind: 'text' | 'image' | 'shape' | 'button'.
  text: the words (text and button; "\\n" breaks a line).
  asset: an asset's id (image).
  shape: 'rect' (default) | 'ellipse' | 'line' (shape). A line runs through the middle of its
    frame along its longer side, style.thickness thick.
  frame: { x, y, w, h }, fractions of the size's width (x, w) and height (y, h): 0.5 is half.
    It may go past 0–1, to start off the edge. Default the whole ad.
  style?: see below; what isn't given is filled in for its kind.
  from?, until?: seconds; it shows only from \`from\` until (not at) \`until\`, default the whole ad.
  animation?: tracks of keyframes, as [ { property, keyframes: [ { t, value, ease? } ] } ] or,
    shorter, { property: [ { t, value, ease? } ] }. Properties:
      opacity  0–1, multiplied with style.opacity
      x, y     an offset from the frame, in fractions of the size's width and height
      scale    a factor, about the frame's centre (1 is as it is)
      rotate   degrees, clockwise, about the frame's centre
      reveal   0–1: how much of it shows, as style.reveal says (text: word by word)
    t is seconds from the start, within 0–duration. Before the first keyframe the value is the
    first's, after the last the last's. Keyframes are sorted by t; two at the same t jump.
    ease is how the value moves from the keyframe before to this one: 'linear', 'in' (starts
    slowly), 'out' (ends slowly), 'in-out' (both; the default), 'back-out' (overshoots a little
    and settles: a pop), 'bounce' (bounces to a stop) or 'step' (holds, then jumps at this
    keyframe). All but bounce are cubic Béziers, as CSS's (EASES has each one's CSS).
  sizes?: { [size id]: { hidden?, frame?, style?, text?, asset?, from?, until?, animation? } },
    overrides for one size, merged over the layer there: frame and style key by key, the rest
    replaced. hidden: true leaves the layer out of that size.
}

style (lengths are a number, a fraction of the size's unit u = √(width × height), so one design
reads alike at every size, or a string in pixels at every size, "2px"; u is 274 at 300x250, 256
at 728x90 and 1440 at 1080x1920):
  color          text's colour (text, button)
  background     a colour or gradient: behind text, a button's fill, a shape's fill (for a shape,
                 color is taken as background), an image's backdrop
  radius         corner rounding, a fraction of the layer's smaller side (0.5 is fully round) or
                 "px"
  font           a font on every Mac (FONTS; default "SF Pro"), or a generic family
  weight         100–900 (or 'normal', 'bold')
  italic         true or false
  size           the font's size, a length (default 0.08 for text, 0.055 for a button)
  fit            text and button: 'shrink' (default: made smaller until it fits its frame) or
                 'none'; image: 'cover' (default: fills the frame, cropped) or 'contain'
  align          'left' | 'center' | 'right' (text default left, button center)
  valign         'top' | 'middle' | 'bottom' (text default top, button middle)
  lineHeight     a multiple of the font's size (default 1.15)
  letterSpacing  in ems, a fraction of the font's size (default 0)
  padding        a length, inside the frame round the text
  opacity        0–1
  border         { width: length, color }
  shadow         { x, y, blur: lengths, color }, or true for a soft one; it follows what's drawn
  reveal         how reveal shows it: 'words' (text's default: word by word), 'lines', or a wipe
                 from 'left' (the default for the rest), 'right', 'top', 'bottom' or 'center'
  thickness      a line's thickness, a length (default 0.006, at least 1 px)`;


const dims = (s) => /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(s);

// A size from a preset's id, "WIDTHxHEIGHT", or { id?, width, height, name?, kind? }; null if it
// can't be one. A "WIDTHxHEIGHT" matching a preset is that preset.
export function resolveSize(idOrSize) {
  const errors = [];
  const size = sizeFrom(idOrSize, 'size', errors);
  return errors.length ? null : size;
}

function sizeFrom(value, path, errors) {
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    const preset = SIZE_PRESETS.find((p) => p.id === key || p.name.toLowerCase() === key);
    if (preset) return { ...preset };
    const m = dims(key);
    if (m) {
      const width = Number(m[1]);
      const height = Number(m[2]);
      const same = SIZE_PRESETS.find((p) => p.width === width && p.height === height);
      if (same) return { ...same };
      if (!sideOk(width) || !sideOk(height)) {
        errors.push(`${path}: ${width}×${height} is outside ${MIN_SIDE}–${MAX_SIDE} px a side`);
        return null;
      }
      return { id: `${width}x${height}`, width, height, name: `${width}×${height}`, kind: 'display' };
    }
    errors.push(`${path}: "${value}" isn't a size; use a preset (${SIZE_PRESETS.map((p) => p.id).join(', ')}), "WIDTHxHEIGHT" such as "640x480", or { width, height }`);
    return null;
  }
  if (!isObject(value)) {
    errors.push(`${path}: a size is a preset's id such as "300x250", or { width, height, name? }`);
    return null;
  }
  checkKeys(value, ['id', 'width', 'height', 'name', 'kind'], path, errors, 'a size');
  if (value.width === undefined && value.height === undefined && typeof value.id === 'string') {
    const preset = SIZE_PRESETS.find((p) => p.id === value.id);
    if (preset) return { ...preset, ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}) };
  }
  let ok = true;
  for (const side of ['width', 'height']) {
    if (!Number.isInteger(value[side]) || !sideOk(value[side])) {
      errors.push(`${path}.${side}: must be a whole number of pixels, ${MIN_SIDE}–${MAX_SIDE}`);
      ok = false;
    }
  }
  if (!ok) return null;
  const { width, height } = value;
  const preset = SIZE_PRESETS.find((p) => p.width === width && p.height === height);
  let id = value.id ?? preset?.id ?? `${width}x${height}`;
  if (typeof id !== 'string' || !ID.test(id)) {
    errors.push(`${path}.id: ${JSON.stringify(id)} must be lower-case letters, digits and hyphens, such as "${width}x${height}"`);
    return null;
  }
  if (value.name !== undefined && typeof value.name !== 'string') errors.push(`${path}.name: must be text`);
  if (value.kind !== undefined && value.kind !== 'display' && value.kind !== 'social') {
    errors.push(`${path}.kind: must be 'display' or 'social'`);
  }
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : preset?.name ?? `${width}×${height}`;
  const kind = value.kind === 'social' || value.kind === 'display' ? value.kind : preset?.kind ?? 'display';
  return { id, width, height, name, kind };
}

const sideOk = (n) => n >= MIN_SIDE && n <= MAX_SIDE;

// --- Fonts ------------------------------------------------------------------------------------

// The fonts every Mac has, each with the CSS stack it's drawn with. Names are matched without case;
// the normalised ad uses these spellings.
export const FONTS = Object.freeze({
  'SF Pro': '-apple-system, BlinkMacSystemFont, "SF Pro", "Helvetica Neue", sans-serif',
  'SF Pro Rounded': 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif',
  'SF Mono': 'ui-monospace, "SF Mono", Menlo, monospace',
  'New York': 'ui-serif, "New York", Georgia, serif',
  'Helvetica Neue': '"Helvetica Neue", Helvetica, Arial, sans-serif',
  Helvetica: 'Helvetica, Arial, sans-serif',
  Arial: 'Arial, Helvetica, sans-serif',
  'Avenir Next': '"Avenir Next", Avenir, "Helvetica Neue", sans-serif',
  Avenir: 'Avenir, "Avenir Next", sans-serif',
  Futura: 'Futura, "Trebuchet MS", sans-serif',
  'Gill Sans': '"Gill Sans", "Gill Sans MT", sans-serif',
  Optima: 'Optima, Candara, sans-serif',
  Verdana: 'Verdana, Geneva, sans-serif',
  'Trebuchet MS': '"Trebuchet MS", sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  'Times New Roman': '"Times New Roman", Times, serif',
  Palatino: 'Palatino, "Palatino Linotype", serif',
  Baskerville: 'Baskerville, "Baskerville Old Face", serif',
  Didot: 'Didot, "Bodoni 72", serif',
  'Hoefler Text': '"Hoefler Text", Georgia, serif',
  'American Typewriter': '"American Typewriter", "Courier New", serif',
  Menlo: 'Menlo, Monaco, monospace',
  'Courier New': '"Courier New", Courier, monospace',
  'sans-serif': 'sans-serif',
  serif: 'serif',
  monospace: 'monospace',
  'system-ui': 'system-ui, -apple-system, sans-serif',
});
const FONT_ALIASES = { '-apple-system': 'SF Pro', 'sf pro display': 'SF Pro', 'sf pro text': 'SF Pro', 'san francisco': 'SF Pro', 'ui-rounded': 'SF Pro Rounded', 'ui-monospace': 'SF Mono', 'ui-serif': 'New York', 'ui-sans-serif': 'SF Pro', 'times': 'Times New Roman', 'courier': 'Courier New', 'sans serif': 'sans-serif' };
const MONO = new Set(['SF Mono', 'Menlo', 'Courier New', 'monospace', 'American Typewriter']);
const SERIF = new Set(['New York', 'Georgia', 'Times New Roman', 'Palatino', 'Baskerville', 'Didot', 'Hoefler Text', 'serif']);

function fontName(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (FONT_ALIASES[key]) return FONT_ALIASES[key];
  return Object.keys(FONTS).find((name) => name.toLowerCase() === key) ?? null;
}

export const fontStack = (name) => FONTS[fontName(name) ?? 'SF Pro'];

// --- Easing -----------------------------------------------------------------------------------

// A cubic Bézier timing curve, as CSS's cubic-bezier(): p (0–1, time) to progress. Exact at 0 and 1.
function cubic(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  const Y = (s) => ((ay * s + by) * s + cy) * s;
  const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let s = p;
    for (let i = 0; i < 8; i++) {
      const e = X(s) - p;
      if (Math.abs(e) < 1e-7) return Y(s);
      const d = dX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    let lo = 0, hi = 1;
    s = p;
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      if (X(s) < p) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return Y(s);
  };
}

function bounce(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
}

// Each ease: its function, and its CSS timing function where there is one (for HTML5 exports).
export const EASES = Object.freeze({
  linear: { fn: (p) => Math.min(1, Math.max(0, p)), css: 'linear' },
  in: { fn: cubic(0.4, 0, 1, 1), css: 'cubic-bezier(0.4, 0, 1, 1)' },
  out: { fn: cubic(0, 0, 0.2, 1), css: 'cubic-bezier(0, 0, 0.2, 1)' },
  'in-out': { fn: cubic(0.4, 0, 0.6, 1), css: 'cubic-bezier(0.4, 0, 0.6, 1)' },
  'back-out': { fn: cubic(0.34, 1.56, 0.64, 1), css: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  bounce: { fn: bounce, css: null },
  step: { fn: (p) => (p >= 1 ? 1 : 0), css: 'steps(1, end)' },
});
export const DEFAULT_EASE = 'in-out';
export const ease = (name, p) => (EASES[name] ?? EASES[DEFAULT_EASE]).fn(p);

// --- Animation --------------------------------------------------------------------------------

export const PROPERTIES = Object.freeze({
  opacity: { rest: 1, min: 0, max: 1, says: 'from 0 (unseen) to 1' },
  x: { rest: 0, min: -3, max: 3, says: 'an offset in fractions of the width, -3 to 3' },
  y: { rest: 0, min: -3, max: 3, says: 'an offset in fractions of the height, -3 to 3' },
  scale: { rest: 1, min: 0, max: 10, says: 'a factor from 0 to 10 (1 is as it is)' },
  rotate: { rest: 0, min: -3600, max: 3600, says: 'degrees, -3600 to 3600' },
  reveal: { rest: 1, min: 0, max: 1, says: 'from 0 (none of it) to 1 (all of it)' },
});

// A track's value at t (keyframes sorted by t).
export function valueAt(keyframes, t) {
  const first = keyframes[0];
  if (t <= first.t) return first.value;
  const last = keyframes[keyframes.length - 1];
  if (t >= last.t) return last.value;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i], b = keyframes[i + 1];
    if (t >= b.t) continue;
    const p = (t - a.t) / (b.t - a.t);
    return a.value + (b.value - a.value) * ease(b.ease, p);
  }
  return last.value;
}

// --- Styles -----------------------------------------------------------------------------------

const TEXT_STYLE = ['color', 'background', 'radius', 'font', 'weight', 'italic', 'size', 'fit', 'align', 'valign', 'lineHeight', 'letterSpacing', 'padding', 'opacity', 'border', 'shadow', 'reveal'];
const STYLE_KEYS = {
  text: TEXT_STYLE,
  button: TEXT_STYLE,
  image: ['background', 'radius', 'fit', 'opacity', 'border', 'shadow', 'reveal'],
  shape: ['background', 'color', 'radius', 'opacity', 'border', 'shadow', 'reveal', 'thickness'],
};
const DEFAULTS = {
  text: { color: '#1d1d1f', background: 'transparent', radius: 0, font: 'SF Pro', weight: 400, italic: false, size: 0.08, fit: 'shrink', align: 'left', valign: 'top', lineHeight: 1.15, letterSpacing: 0, padding: 0, opacity: 1, border: null, shadow: null, reveal: 'words' },
  button: { color: '#ffffff', background: '#1d1d1f', radius: 0.3, font: 'SF Pro', weight: 600, italic: false, size: 0.055, fit: 'shrink', align: 'center', valign: 'middle', lineHeight: 1.15, letterSpacing: 0, padding: 0.02, opacity: 1, border: null, shadow: null, reveal: 'left' },
  image: { background: 'transparent', radius: 0, fit: 'cover', opacity: 1, border: null, shadow: null, reveal: 'left' },
  shape: { background: '#1d1d1f', radius: 0, opacity: 1, border: null, shadow: null, reveal: 'left', thickness: 0.006 },
};
const SHADOW = { x: 0, y: 0.008, blur: 0.024, color: 'rgba(0, 0, 0, 0.25)' };
const WIPES = ['left', 'right', 'top', 'bottom', 'center'];

// A length in pixels at a size whose unit is u: a number is a fraction of u, "Npx" pixels.
export const lengthPx = (value, u) => (typeof value === 'number' ? value * u : parseFloat(value));

// A layer's style worked out in pixels for one size (frame in px, u the size's unit).
function resolveStyle(style, kind, frame, u) {
  const out = { ...style };
  const side = Math.min(frame.w, frame.h);
  out.radius = typeof style.radius === 'number' ? style.radius * side : parseFloat(style.radius);
  if ('size' in style) out.size = lengthPx(style.size, u);
  if ('padding' in style) out.padding = lengthPx(style.padding, u);
  if ('thickness' in style) out.thickness = Math.max(1, lengthPx(style.thickness, u));
  if (style.border) out.border = { width: lengthPx(style.border.width, u), color: style.border.color };
  if (style.shadow) out.shadow = { x: lengthPx(style.shadow.x, u), y: lengthPx(style.shadow.y, u), blur: lengthPx(style.shadow.blur, u), color: style.shadow.color };
  if ('font' in style) out.family = fontStack(style.font);
  return out;
}

// --- Validation -------------------------------------------------------------------------------

const isEmpty = (v) => (Array.isArray(v) ? !v.length : isObject(v) && !Object.keys(v).length);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (n) => String(Math.round(n * 1000) / 1000);
export const seconds = (t) => {
  const r = Math.round(t * 100) / 100;
  return Number.isInteger(r * 10) ? r.toFixed(1) : String(r);
};

function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return d[b.length];
}
const ALIASES = { colour: 'color', fill: 'background', bg: 'background', 'font-size': 'size', fontSize: 'size', fontWeight: 'weight', fontFamily: 'font', textAlign: 'align', verticalAlign: 'valign', borderRadius: 'radius', cornerRadius: 'radius', start: 'from', end: 'until', to: 'until', keys: 'keyframes', frames: 'keyframes', time: 't', at: 't', easing: 'ease', type: 'kind', src: 'asset', image: 'asset', content: 'text', label: 'text', width: 'w', height: 'h', left: 'x', top: 'y', rotation: 'rotate', alpha: 'opacity', overrides: 'sizes', animations: 'animation', tracks: 'animation' };
function suggest(word, options) {
  if (ALIASES[word] && options.includes(ALIASES[word])) return ALIASES[word];
  let best = null, bestD = 3;
  for (const option of options) {
    const d = distance(String(word).toLowerCase(), option.toLowerCase());
    if (d < bestD) { best = option; bestD = d; }
  }
  return best;
}
const didYouMean = (word, options) => {
  const s = suggest(word, options);
  return s ? `; did you mean ${s}?` : '';
};
const oneOf = (options) => {
  const q = options.map((o) => `'${o}'`);
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}` : q[0];
};

function checkKeys(obj, allowed, path, errors, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}.${key}: not something ${what} has${didYouMean(key, allowed)} (${what} takes ${allowed.join(', ')})`);
    }
  }
}

const NAMED_COLORS = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent'.split(' '));
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const FUNC = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[-+0-9.%,\s/a-z]*\)$/;

export function isColor(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return HEX.test(v) || NAMED_COLORS.has(v) || FUNC.test(v);
}

function isGradient(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  if (!/^(repeating-)?(linear|radial|conic)-gradient\(.+\)$/.test(v)) return false;
  if (/url\(|[;{}<>"\\]/.test(v)) return false;
  let depth = 0;
  for (const c of v) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

const colorHelp = 'use a hex colour such as "#1d1d1f", rgb(…) or hsl(…), or a CSS colour name';

function checkColor(value, path, errors, { gradient = false } = {}) {
  if (isColor(value) || (gradient && isGradient(value))) return value.trim();
  errors.push(`${path}: ${JSON.stringify(value)} isn't a colour${gradient ? ' or gradient' : ''}; ${colorHelp}${gradient ? ', or linear-gradient(…)' : ''}`);
  return undefined;
}

const PX = /^\s*(-?\d+(?:\.\d+)?)\s*px\s*$/i;

// A length: a fraction of u (min–max), or "Npx" (pxMin–pxMax).
function checkLength(value, path, errors, { min = 0, max = 1, above = false, pxMax = 2000 } = {}) {
  if (isNum(value)) {
    if ((above ? value > min : value >= min) && value <= max) return value;
    errors.push(`${path}: ${fmt(value)} must be ${above ? 'above' : 'at least'} ${min} and at most ${max} (a fraction of the size's unit, √(width × height)), or pixels such as "2px"`);
    return undefined;
  }
  const m = typeof value === 'string' && PX.exec(value);
  if (m) {
    const px = Number(m[1]);
    const pxMin = min < 0 ? -pxMax : 0;
    if ((above ? px > pxMin : px >= pxMin) && px <= pxMax) return `${px}px`;
    errors.push(`${path}: ${value} must be within ${pxMin}–${pxMax}px`);
    return undefined;
  }
  errors.push(`${path}: ${JSON.stringify(value)} must be a number (a fraction of the size's unit, √(width × height): 0.05 is 5%) or pixels such as "2px"`);
  return undefined;
}

function checkNumber(value, path, errors, min, max, says) {
  if (isNum(value) && value >= min && value <= max) return value;
  errors.push(`${path}: ${isNum(value) ? fmt(value) : JSON.stringify(value)} must be a number from ${min} to ${max}${says ? ` (${says})` : ''}`);
  return undefined;
}

function checkStyle(style, kind, shape, path, errors, partial) {
  if (!isObject(style)) {
    errors.push(`${path}: must be an object of style properties`);
    return partial ? {} : { ...DEFAULTS[kind] };
  }
  const allowed = STYLE_KEYS[kind];
  for (const key of Object.keys(style)) {
    if (!allowed.includes(key)) {
      const all = Object.values(STYLE_KEYS).flat();
      errors.push(all.includes(key)
        ? `${path}.${key}: doesn't apply to a ${kind} layer (it takes ${allowed.join(', ')})`
        : `${path}.${key}: not a style property${didYouMean(key, allowed)} (a ${kind} layer takes ${allowed.join(', ')})`);
    }
  }
  const out = {};
  const s = { ...style };
  if (kind === 'shape' && s.color !== undefined) {
    if (s.background === undefined) s.background = s.color;
    delete s.color;
  }
  for (const key of allowed) {
    const value = s[key];
    if (value === undefined) continue;
    const p = `${path}.${key}`;
    let v;
    switch (key) {
      case 'color': v = checkColor(value, p, errors); break;
      case 'background': v = checkColor(value, p, errors, { gradient: true }); break;
      case 'radius':
        if (isNum(value)) v = checkNumber(value, p, errors, 0, 0.5, "a fraction of the layer's smaller side: 0.5 is fully round");
        else v = checkLength(value, p, errors, { pxMax: 4096 });
        break;
      case 'font':
        v = fontName(value) ?? undefined;
        if (!v) errors.push(`${p}: ${JSON.stringify(value)} isn't a font SmartAd can use yet${typeof value === 'string' ? didYouMean(value, Object.keys(FONTS)) : ''}; use one every Mac has: ${Object.keys(FONTS).join(', ')}`);
        break;
      case 'weight':
        if (value === 'normal') v = 400;
        else if (value === 'bold') v = 700;
        else if (Number.isInteger(value) && value >= 100 && value <= 900) v = value;
        else errors.push(`${p}: ${JSON.stringify(value)} must be a whole number from 100 to 900 (400 regular, 700 bold), 'normal' or 'bold'`);
        break;
      case 'italic':
        if (typeof value === 'boolean') v = value;
        else errors.push(`${p}: must be true or false`);
        break;
      case 'size': v = checkLength(value, p, errors, { min: 0, max: 1, above: true }); break;
      case 'padding': v = checkLength(value, p, errors, { min: 0, max: 0.5 }); break;
      case 'thickness':
        if (shape !== 'line') errors.push(`${p}: only a line has a thickness`);
        else v = checkLength(value, p, errors, { min: 0, max: 0.5, above: true });
        break;
      case 'fit': {
        const fits = kind === 'image' ? ['cover', 'contain'] : ['shrink', 'none'];
        if (fits.includes(value)) v = value;
        else errors.push(`${p}: ${JSON.stringify(value)} must be ${oneOf(fits)} on ${kind === 'image' ? 'an image' : `a ${kind} layer`}`);
        break;
      }
      case 'align': {
        const a = value === 'centre' || value === 'middle' ? 'center' : value;
        if (['left', 'center', 'right'].includes(a)) v = a;
        else errors.push(`${p}: ${JSON.stringify(value)} must be 'left', 'center' or 'right'`);
        break;
      }
      case 'valign': {
        const a = value === 'center' || value === 'centre' ? 'middle' : value;
        if (['top', 'middle', 'bottom'].includes(a)) v = a;
        else errors.push(`${p}: ${JSON.stringify(value)} must be 'top', 'middle' or 'bottom'`);
        break;
      }
      case 'lineHeight': v = checkNumber(value, p, errors, 0.5, 3, "a multiple of the font's size, such as 1.2"); break;
      case 'letterSpacing': v = checkNumber(value, p, errors, -0.2, 1, "in ems: 0.05 is a twentieth of the font's size"); break;
      case 'opacity': v = checkNumber(value, p, errors, 0, 1); break;
      case 'border':
        if (value === null || value === false) { v = null; break; }
        if (!isObject(value)) { errors.push(`${p}: must be { width, color }, or null for none`); break; }
        checkKeys(value, ['width', 'color'], p, errors, 'a border');
        if (value.width === undefined) { errors.push(`${p}.width: a border needs a width, such as 0.004 or "1px"`); break; }
        {
          const width = checkLength(value.width, `${p}.width`, errors, { min: 0, max: 0.2 });
          const color = value.color === undefined ? '#000000' : checkColor(value.color, `${p}.color`, errors);
          if (width !== undefined && color !== undefined) v = { width, color };
        }
        break;
      case 'shadow':
        if (value === null || value === false) { v = null; break; }
        if (value === true) { v = { ...SHADOW }; break; }
        if (!isObject(value)) { errors.push(`${p}: must be { x, y, blur, color }, true for a soft shadow, or null for none`); break; }
        checkKeys(value, ['x', 'y', 'blur', 'color'], p, errors, 'a shadow');
        {
          const x = value.x === undefined ? SHADOW.x : checkLength(value.x, `${p}.x`, errors, { min: -0.5, max: 0.5 });
          const y = value.y === undefined ? SHADOW.y : checkLength(value.y, `${p}.y`, errors, { min: -0.5, max: 0.5 });
          const blur = value.blur === undefined ? SHADOW.blur : checkLength(value.blur, `${p}.blur`, errors, { min: 0, max: 0.5 });
          const color = value.color === undefined ? SHADOW.color : checkColor(value.color, `${p}.color`, errors);
          if (x !== undefined && y !== undefined && blur !== undefined && color !== undefined) v = { x, y, blur, color };
        }
        break;
      case 'reveal': {
        const a = value === 'centre' ? 'center' : value;
        const ways = kind === 'text' ? ['words', 'lines', ...WIPES] : WIPES;
        if (ways.includes(a)) v = a;
        else if (a === 'words' || a === 'lines') errors.push(`${p}: '${a}' is for text layers; a ${kind} wipes in: use ${oneOf(WIPES)}`);
        else errors.push(`${p}: ${JSON.stringify(value)} must be ${oneOf(ways)}`);
        break;
      }
    }
    if (v !== undefined) out[key] = v;
  }
  if (partial) return out;
  const filled = { ...DEFAULTS[kind], ...out };
  if (kind === 'shape' && shape !== 'line') delete filled.thickness;
  return filled;
}

function checkFrame(frame, path, errors, partial) {
  if (!isObject(frame)) {
    errors.push(`${path}: must be { x, y, w, h }, fractions of the size's width and height`);
    return undefined;
  }
  checkKeys(frame, ['x', 'y', 'w', 'h'], path, errors, 'a frame');
  const out = {};
  for (const key of ['x', 'y', 'w', 'h']) {
    const value = frame[key];
    const of = key === 'x' || key === 'w' ? 'width' : 'height';
    if (value === undefined) {
      if (!partial) errors.push(`${path}.${key}: missing; a frame is { x, y, w, h }, fractions of the size's width and height`);
      continue;
    }
    if (key === 'w' || key === 'h') {
      if (isNum(value) && value > 0 && value <= 4) out[key] = value;
      else errors.push(`${path}.${key}: ${JSON.stringify(value)} must be a number above 0 and at most 4 (a fraction of the ${of}: 0.5 is half)`);
    } else if (isNum(value) && value >= -3 && value <= 3) out[key] = value;
    else errors.push(`${path}.${key}: ${JSON.stringify(value)} must be a number from -3 to 3 (a fraction of the ${of}: 0 is the ${key === 'x' ? 'left' : 'top'} edge, 1 the ${key === 'x' ? 'right' : 'bottom'})`);
  }
  return out;
}

function checkTime(value, path, errors, duration) {
  if (!isNum(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} must be a number of seconds, within 0–${seconds(duration)} (the duration)`);
    return undefined;
  }
  if (value < 0) errors.push(`${path}: ${fmt(value)} is before the start; it must be within 0–${seconds(duration)} (the duration)`);
  else if (value > duration + 1e-9) errors.push(`${path}: ${fmt(value)} is past the ad's end; it must be within 0–${seconds(duration)} (the duration)`);
  else return value;
  return undefined;
}

function checkAnimation(animation, path, errors, duration) {
  let tracks = animation;
  if (isObject(animation)) {
    tracks = Object.entries(animation).map(([property, keyframes]) => ({ property, keyframes }));
  } else if (!Array.isArray(animation)) {
    errors.push(`${path}: must be a list of tracks, [ { property, keyframes: [ { t, value } ] } ], or { property: [ { t, value } ] }`);
    return [];
  }
  const out = [];
  const seen = new Map();
  tracks.forEach((track, i) => {
    const p = isObject(animation) ? `${path}.${track.property}` : `${path}[${i}]`;
    if (!isObject(track)) { errors.push(`${p}: a track is { property, keyframes: [ { t, value, ease? } ] }`); return; }
    if (!isObject(animation)) checkKeys(track, ['property', 'keyframes'], p, errors, 'a track');
    const props = Object.keys(PROPERTIES);
    if (!props.includes(track.property)) {
      errors.push(`${isObject(animation) ? p : `${p}.property`}: ${JSON.stringify(track.property)} can't be animated${typeof track.property === 'string' ? didYouMean(track.property, props) : ''}; use ${oneOf(props)}`);
      return;
    }
    if (seen.has(track.property)) {
      errors.push(`${p}: ${track.property} is already animated by ${seen.get(track.property)}; put all its keyframes in one track`);
      return;
    }
    seen.set(track.property, p);
    const kp = isObject(animation) ? p : `${p}.keyframes`;
    if (!Array.isArray(track.keyframes) || !track.keyframes.length) {
      errors.push(`${kp}: must be a list of at least one keyframe, [ { t, value, ease? } ]`);
      return;
    }
    const range = PROPERTIES[track.property];
    const keyframes = [];
    track.keyframes.forEach((kf, j) => {
      const q = `${kp}[${j}]`;
      if (!isObject(kf)) { errors.push(`${q}: a keyframe is { t, value, ease? }`); return; }
      checkKeys(kf, ['t', 'value', 'ease'], q, errors, 'a keyframe');
      const t = kf.t === undefined ? (errors.push(`${q}.t: missing; when it is, in seconds`), undefined) : checkTime(kf.t, `${q}.t`, errors, duration);
      const value = kf.value === undefined
        ? (errors.push(`${q}.value: missing; ${track.property} is ${range.says}`), undefined)
        : checkNumber(kf.value, `${q}.value`, errors, range.min, range.max, `${track.property} is ${range.says}`);
      let easeName = DEFAULT_EASE;
      if (kf.ease !== undefined) {
        if (EASES[kf.ease]) easeName = kf.ease;
        else errors.push(`${q}.ease: ${JSON.stringify(kf.ease)} isn't an ease${typeof kf.ease === 'string' ? didYouMean(kf.ease, Object.keys(EASES)) : ''}; use ${oneOf(Object.keys(EASES))}`);
      }
      if (t !== undefined && value !== undefined) keyframes.push({ t, value, ease: easeName });
    });
    if (keyframes.length) {
      keyframes.sort((a, b) => a.t - b.t); // stable: keyframes at the same t keep their order
      out.push({ property: track.property, keyframes });
    }
  });
  return out;
}

function checkText(value, path, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path}: must be the words to show, as text`);
    return undefined;
  }
  if (value.length > 500) {
    errors.push(`${path}: ${value.length} characters is too long for an ad; at most 500`);
    return undefined;
  }
  return value;
}

const LAYER_KEYS = ['id', 'name', 'kind', 'text', 'asset', 'shape', 'frame', 'style', 'sizes', 'from', 'until', 'animation'];
const OVERRIDE_KEYS = ['hidden', 'frame', 'style', 'text', 'asset', 'from', 'until', 'animation'];
const KINDS = ['text', 'image', 'shape', 'button'];
const SHAPES = ['rect', 'ellipse', 'line'];
const KIND_ALIASES = { cta: 'button', 'call-to-action': 'button', logo: 'image', picture: 'image', photo: 'image', rectangle: 'shape', ellipse: 'shape', circle: 'shape', line: 'shape', label: 'text', headline: 'text' };

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'layer';
}

// Checks an ad as the AI wrote it (an object, or its JSON). { ok: true, ad } with the ad normalised,
// or { ok: false, errors: [ 'path: message', … ] }.
export function validateAd(content) {
  const errors = [];
  let raw = content;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (error) { return { ok: false, errors: [`ad: not valid JSON (${error.message})`] }; }
  }
  if (!isObject(raw)) return { ok: false, errors: ['ad: must be an object, { duration, sizes, layers, … }'] };
  checkKeys(raw, ['duration', 'loops', 'background', 'sizes', 'fonts', 'assets', 'layers'], 'ad', errors, 'an ad');
  for (let i = 0; i < errors.length; i++) errors[i] = errors[i].replace(/^ad\./, '');

  let duration = 0;
  if (raw.duration !== undefined) {
    if (isNum(raw.duration) && raw.duration >= 0 && raw.duration <= MAX_DURATION) duration = raw.duration;
    else {
      duration = MAX_DURATION; // so the layers' times are checked against the longest it may be
      errors.push(`duration: ${JSON.stringify(raw.duration)} must be seconds from 0 (a still ad) to ${MAX_DURATION}`);
    }
  }
  const still = duration === 0;
  let loops = 1;
  if (raw.loops !== undefined) {
    if (Number.isInteger(raw.loops) && raw.loops >= 1 && raw.loops <= MAX_LOOPS) loops = raw.loops;
    else errors.push(`loops: ${JSON.stringify(raw.loops)} must be a whole number from 1 to ${MAX_LOOPS} (how many times it plays; display networks allow ${DISPLAY_LOOPS})`);
  }
  const background = raw.background === undefined ? '#ffffff' : checkColor(raw.background, 'background', errors, { gradient: true }) ?? '#ffffff';

  const sizes = [];
  if (!Array.isArray(raw.sizes) || !raw.sizes.length) {
    errors.push(`sizes: must list at least one size, such as ["300x250"]; presets: ${SIZE_PRESETS.map((p) => p.id).join(', ')}`);
  } else {
    raw.sizes.forEach((value, i) => {
      const size = sizeFrom(value, `sizes[${i}]`, errors);
      if (!size) return;
      if (sizes.some((s) => s.id === size.id)) errors.push(`sizes[${i}]: "${size.id}" is listed twice; give each size its own id`);
      else sizes.push(size);
    });
    if (sizes.length > 24) errors.push(`sizes: ${sizes.length} sizes is too many; at most 24`);
  }
  const sizeIds = sizes.map((s) => s.id);

  const assets = [];
  if (raw.assets !== undefined) {
    if (!Array.isArray(raw.assets)) errors.push('assets: must be a list of { id, name?, type? }');
    else raw.assets.forEach((asset, i) => {
      const p = `assets[${i}]`;
      if (!isObject(asset)) { errors.push(`${p}: an asset is { id, name?, type? }`); return; }
      checkKeys(asset, ['id', 'name', 'type', 'width', 'height'], p, errors, 'an asset');
      if (typeof asset.id !== 'string' || !ID.test(asset.id)) { errors.push(`${p}.id: ${JSON.stringify(asset.id)} must be lower-case letters, digits and hyphens`); return; }
      if (assets.some((a) => a.id === asset.id)) { errors.push(`${p}.id: "${asset.id}" is used by another asset`); return; }
      const out = { id: asset.id, name: typeof asset.name === 'string' && asset.name.trim() ? asset.name.trim() : asset.id };
      if (asset.type !== undefined) {
        const type = MIME[String(asset.type).toLowerCase()];
        if (type) out.type = type;
        else errors.push(`${p}.type: ${JSON.stringify(asset.type)} must be png, jpeg, webp, svg or gif (or their MIME types)`);
      }
      for (const side of ['width', 'height']) {
        if (asset[side] === undefined) continue;
        if (Number.isInteger(asset[side]) && asset[side] > 0) out[side] = asset[side];
        else errors.push(`${p}.${side}: must be the picture's ${side} in whole pixels`);
      }
      assets.push(out);
    });
  }
  const assetIds = assets.map((a) => a.id);

  const layers = [];
  if (!Array.isArray(raw.layers)) {
    errors.push('layers: must be a list of layers, drawn in order, the first at the back');
  } else {
    raw.layers.forEach((layer, i) => {
      const out = checkLayer(layer, `layers[${i}]`, errors, { duration, still, sizes, assetIds });
      if (!out) return;
      if (layers.some((l) => l.id === out.id)) errors.push(`layers[${i}].id: "${out.id}" is used by another layer; each layer needs its own id`);
      else layers.push(out);
    });
    if (layers.length > 100) errors.push(`layers: ${layers.length} layers is too many; at most 100`);
  }

  if (raw.fonts !== undefined) {
    if (!Array.isArray(raw.fonts)) errors.push('fonts: must be a list of font names (it is filled in from the layers, so it can be left out)');
    else raw.fonts.forEach((f, i) => {
      if (!fontName(f)) errors.push(`fonts[${i}]: ${JSON.stringify(f)} isn't a font SmartAd can use yet; use one every Mac has: ${Object.keys(FONTS).join(', ')}`);
    });
  }

  if (errors.length) return { ok: false, errors };
  const fonts = new Set();
  for (const layer of layers) {
    if (layer.style.font) fonts.add(layer.style.font);
    for (const o of Object.values(layer.sizes ?? {})) if (o.style?.font) fonts.add(o.style.font);
  }
  const ad = { duration, loops, background, sizes, fonts: [...fonts].sort(), assets, layers };
  normalised.add(ad);
  return { ok: true, ad };
}

const normalised = new WeakSet();

// The ad normalised (itself, if validateAd made it), or an Error listing what's wrong with it.
export function normalizeAd(content) {
  if (normalised.has(content)) return content;
  const result = validateAd(content);
  if (!result.ok) throw new Error(`Not a valid ad: ${result.errors.join('; ')}`);
  return result.ad;
}

const MIME = { png: 'image/png', 'image/png': 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', 'image/jpeg': 'image/jpeg', webp: 'image/webp', 'image/webp': 'image/webp', svg: 'image/svg+xml', 'image/svg+xml': 'image/svg+xml', gif: 'image/gif', 'image/gif': 'image/gif' };

function checkLayer(layer, path, errors, { duration, still, sizes, assetIds }) {
  const sizeIds = sizes.map((s) => s.id);
  if (!isObject(layer)) {
    errors.push(`${path}: a layer is { id, kind, frame, … }`);
    return null;
  }
  checkKeys(layer, LAYER_KEYS, path, errors, 'a layer');
  let id = layer.id;
  if (typeof id !== 'string' || !ID.test(id)) {
    const hint = slug(id ?? layer.name ?? layer.text ?? layer.kind ?? 'layer');
    errors.push(`${path}.id: ${id === undefined ? 'missing' : JSON.stringify(id)}; give it an id of lower-case letters, digits and hyphens, such as "${hint}"`);
    id = null;
  }
  const kind = layer.kind;
  if (!KINDS.includes(kind)) {
    const guess = KIND_ALIASES[kind] ?? suggest(String(kind), KINDS);
    errors.push(`${path}.kind: ${kind === undefined ? 'missing' : JSON.stringify(kind)}; it must be ${oneOf(KINDS)}${guess ? `; did you mean '${guess}'?` : ''}`);
    return null;
  }
  const out = { id, kind };
  if (layer.name !== undefined) {
    if (typeof layer.name === 'string' && layer.name.trim()) out.name = layer.name.trim();
    else errors.push(`${path}.name: must be text`);
  }
  if (kind === 'text' || kind === 'button') {
    if (layer.text === undefined) errors.push(`${path}.text: missing; a ${kind} layer needs the words to show`);
    else out.text = checkText(layer.text, `${path}.text`, errors);
  } else if (layer.text !== undefined) errors.push(`${path}.text: only text and button layers have text`);
  if (kind === 'image') {
    if (layer.asset === undefined) errors.push(`${path}.asset: missing; an image layer shows an asset, by its id${assetIds.length ? ` (${assetIds.join(', ')})` : ' (the ad has no assets yet)'}`);
    else if (!assetIds.includes(layer.asset)) errors.push(`${path}.asset: no asset "${layer.asset}"${assetIds.length ? `; the ad's assets are ${assetIds.join(', ')}` : '; the ad has no assets yet'}`);
    else out.asset = layer.asset;
  } else if (layer.asset !== undefined) errors.push(`${path}.asset: only image layers show an asset`);
  if (kind === 'shape') {
    if (layer.shape === undefined) out.shape = 'rect';
    else if (SHAPES.includes(layer.shape)) out.shape = layer.shape;
    else errors.push(`${path}.shape: ${JSON.stringify(layer.shape)} must be ${oneOf(SHAPES)}${layer.shape === 'circle' ? "; a circle is an 'ellipse' in a square frame" : ''}`);
  } else if (layer.shape !== undefined) errors.push(`${path}.shape: only shape layers have a shape`);

  out.frame = layer.frame === undefined ? { x: 0, y: 0, w: 1, h: 1 } : checkFrame(layer.frame, `${path}.frame`, errors, false) ?? { x: 0, y: 0, w: 1, h: 1 };
  out.style = checkStyle(layer.style ?? {}, kind, out.shape, `${path}.style`, errors, false);

  const timing = (src, p, base) => {
    if (still) {
      for (const key of ['from', 'until']) {
        if (src[key] !== undefined && src[key] !== 0) errors.push(`${p}.${key}: a still ad (duration 0) shows everything at once; give the ad a duration to time its layers`);
      }
      return { from: 0, until: 0 };
    }
    const from = src.from === undefined ? base.from : checkTime(src.from, `${p}.from`, errors, duration);
    const until = src.until === undefined ? base.until : checkTime(src.until, `${p}.until`, errors, duration);
    if (from !== undefined && until !== undefined && until <= from) {
      errors.push(`${p}.until: ${fmt(until)} must be after from (${fmt(from)})`);
    }
    return { from, until };
  };
  Object.assign(out, timing(layer, path, { from: 0, until: duration }));

  if (layer.animation !== undefined) {
    if (still && !isEmpty(layer.animation)) errors.push(`${path}.animation: a still ad (duration 0) can't animate; give the ad a duration in seconds`);
    else if (still) out.animation = [];
    else out.animation = checkAnimation(layer.animation, `${path}.animation`, errors, duration);
  }
  out.animation ??= [];

  if (layer.sizes !== undefined) {
    if (!isObject(layer.sizes)) errors.push(`${path}.sizes: must be { [size id]: { hidden?, frame?, style?, text?, … } }`);
    else {
      const overrides = {};
      for (const [sizeId, o] of Object.entries(layer.sizes)) {
        const p = `${path}.sizes.${sizeId}`;
        if (!sizeIds.includes(sizeId)) {
          const named = sizes.find((s) => s.name.toLowerCase() === sizeId.toLowerCase() || s.id === resolveSize(sizeId)?.id);
          errors.push(`${p}: no size with id "${sizeId}"${named ? `; did you mean ${named.id}?` : didYouMean(sizeId, sizeIds)} (the ad's sizes are ${sizeIds.join(', ')})`);
          continue;
        }
        if (!isObject(o)) { errors.push(`${p}: must be { hidden?, frame?, style?, text?, asset?, from?, until?, animation? }`); continue; }
        checkKeys(o, OVERRIDE_KEYS, p, errors, 'a size override');
        const v = {};
        if (o.hidden !== undefined) {
          if (typeof o.hidden !== 'boolean') errors.push(`${p}.hidden: must be true or false`);
          else if (o.hidden) v.hidden = true;
        }
        if (o.frame !== undefined) v.frame = checkFrame(o.frame, `${p}.frame`, errors, true);
        if (o.style !== undefined) v.style = checkStyle(o.style, kind, out.shape, `${p}.style`, errors, true);
        if (o.text !== undefined) {
          if (kind === 'text' || kind === 'button') v.text = checkText(o.text, `${p}.text`, errors);
          else errors.push(`${p}.text: only text and button layers have text`);
        }
        if (o.asset !== undefined) {
          if (kind !== 'image') errors.push(`${p}.asset: only image layers show an asset`);
          else if (!assetIds.includes(o.asset)) errors.push(`${p}.asset: no asset "${o.asset}"${assetIds.length ? `; the ad's assets are ${assetIds.join(', ')}` : ''}`);
          else v.asset = o.asset;
        }
        if (o.from !== undefined || o.until !== undefined) {
          const t = timing(o, p, { from: out.from, until: out.until });
          if (o.from !== undefined && t.from !== undefined) v.from = t.from;
          if (o.until !== undefined && t.until !== undefined) v.until = t.until;
        }
        if (o.animation !== undefined) {
          if (still && !isEmpty(o.animation)) errors.push(`${p}.animation: a still ad (duration 0) can't animate`);
          else if (still) v.animation = [];
          else v.animation = checkAnimation(o.animation, `${p}.animation`, errors, duration);
        }
        for (const key of Object.keys(v)) if (v[key] === undefined) delete v[key];
        if (v.frame && !Object.keys(v.frame).length) delete v.frame;
        if (v.style && !Object.keys(v.style).length) delete v.style;
        if (Object.keys(v).length) overrides[sizeId] = v;
      }
      if (Object.keys(overrides).length) out.sizes = overrides;
    }
  }
  return id ? out : null;
}

// --- Layers at a size -------------------------------------------------------------------------

// The layer (or the id of one) as it is at one size, its overrides merged; null if it's hidden
// there. The result has no `sizes`.
export function layerAt(ad, layer, sizeId) {
  const base = typeof layer === 'string' ? ad.layers.find((l) => l.id === layer) : layer;
  if (!base) return null;
  const o = base.sizes?.[sizeId];
  const { sizes, ...rest } = base;
  void sizes;
  if (!o) return rest;
  if (o.hidden) return null;
  return {
    ...rest,
    frame: { ...rest.frame, ...o.frame },
    style: { ...rest.style, ...o.style },
    ...(o.text !== undefined ? { text: o.text } : {}),
    ...(o.asset !== undefined ? { asset: o.asset } : {}),
    ...(o.from !== undefined ? { from: o.from } : {}),
    ...(o.until !== undefined ? { until: o.until } : {}),
    ...(o.animation !== undefined ? { animation: o.animation } : {}),
  };
}

const prepared = new WeakMap();

function sizeOf(ad, sizeOrId) {
  if (isObject(sizeOrId)) return sizeOrId;
  const size = ad.sizes.find((s) => s.id === sizeOrId);
  if (size) return size;
  const preset = resolveSize(sizeOrId);
  if (preset) return preset;
  throw new Error(`No size "${sizeOrId}" in this ad; its sizes are ${ad.sizes.map((s) => s.id).join(', ')}`);
}

// What doesn't change with time, for one size: each layer there with its frame and style in px.
function prepare(ad, sizeOrId) {
  const size = sizeOf(ad, sizeOrId);
  let bySize = prepared.get(ad);
  if (!bySize) prepared.set(ad, (bySize = new Map()));
  const key = `${size.id}:${size.width}x${size.height}`;
  let p = bySize.get(key);
  if (p) return p;
  const u = Math.sqrt(size.width * size.height);
  const layers = [];
  for (const base of ad.layers) {
    const layer = layerAt(ad, base, size.id);
    if (!layer) continue;
    const frame = { x: layer.frame.x * size.width, y: layer.frame.y * size.height, w: layer.frame.w * size.width, h: layer.frame.h * size.height };
    const style = resolveStyle(layer.style, layer.kind, frame, u);
    const tracks = {};
    for (const track of layer.animation) tracks[track.property] = track.keyframes;
    layers.push({ layer, frame, style, tracks });
  }
  p = { size, u, layers };
  bySize.set(key, p);
  return p;
}

const visibleAt = (layer, t, duration) => t >= layer.from && (t < layer.until || (layer.until >= duration && t <= duration));

function valuesAt(tracks, t) {
  const v = {};
  for (const [property, info] of Object.entries(PROPERTIES)) v[property] = tracks[property] ? valueAt(tracks[property], t) : info.rest;
  return v;
}

function stateOf(entry, size, t) {
  const { layer, frame, style, tracks } = entry;
  const v = valuesAt(tracks, t);
  const x = v.x * size.width;
  const y = v.y * size.height;
  const w = frame.w * v.scale;
  const h = frame.h * v.scale;
  return {
    id: layer.id,
    kind: layer.kind,
    name: layer.name ?? layer.id,
    ...(layer.text !== undefined ? { text: layer.text } : {}),
    ...(layer.asset !== undefined ? { asset: layer.asset } : {}),
    ...(layer.shape !== undefined ? { shape: layer.shape } : {}),
    frame,
    x,
    y,
    scale: v.scale,
    rotate: v.rotate,
    opacity: Math.min(1, Math.max(0, v.opacity)) * style.opacity,
    reveal: Math.min(1, Math.max(0, v.reveal)),
    box: { x: frame.x + x + (frame.w - w) / 2, y: frame.y + y + (frame.h - h) / 2, w, h },
    style,
  };
}

// Everything showing at one size at time t (seconds, clamped to the ad's length), in drawing order:
// { t, size, background, layers: [ { id, kind, name, text?, asset?, shape?, frame (px, at rest),
// x, y (offsets, px), scale, rotate (degrees), opacity (style's times the animation's), reveal,
// box (px: where it is now, scaled, not rotated), style (in px; shared: don't change it) } ] }.
export function stateAt(ad, sizeId, t) {
  const p = prepare(ad, sizeId);
  const time = Math.min(ad.duration, Math.max(0, Number(t) || 0));
  const layers = [];
  for (const entry of p.layers) {
    if (visibleAt(entry.layer, time, ad.duration)) layers.push(stateOf(entry, p.size, time));
  }
  return { t: time, size: p.size, background: ad.background, layers };
}

// The layers at a size, whether showing or not, with what's fixed for the size: for drawing, which
// builds them once and then sets their state at each moment.
export function layersAt(ad, sizeId) {
  return prepare(ad, sizeId).layers.map(({ layer, frame, style }) => ({ layer, frame, style }));
}

// --- Text -------------------------------------------------------------------------------------

// A width for text without a browser: an estimate from typical character widths, close enough for
// checking (the renderer measures exactly).
export function estimateWidth(text, { font = 'SF Pro', weight = 400, size, letterSpacing = 0 }) {
  const name = fontName(font) ?? 'SF Pro';
  if (MONO.has(name)) return text.length * (0.6 * size + letterSpacing);
  let em = 0;
  for (const c of text) {
    if (c === ' ') em += 0.28;
    else if ('il.,:;!|\'’'.includes(c)) em += 0.26;
    else if ('fjtrI()[]-'.includes(c)) em += 0.36;
    else if ('mwMW'.includes(c)) em += 0.86;
    else if (c >= 'A' && c <= 'Z') em += 0.66;
    else if (c >= '0' && c <= '9') em += 0.57;
    else if (c >= 'a' && c <= 'z') em += 0.53;
    else em += 0.6;
  }
  if (SERIF.has(name)) em *= 0.96;
  if (weight >= 600) em *= 1.06;
  return em * size + text.length * letterSpacing;
}

function wrap(text, width, font, measure) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/ +/).filter(Boolean);
    if (!words.length) { lines.push({ text: '', words: [] }); continue; }
    let line = [words[0]];
    for (const word of words.slice(1)) {
      const candidate = [...line, word].join(' ');
      if (measure(candidate, font) <= width) line.push(word);
      else { lines.push({ text: line.join(' '), words: line }); line = [word]; }
    }
    lines.push({ text: line.join(' '), words: line });
  }
  for (const line of lines) line.width = line.text ? measure(line.text, font) : 0;
  return lines;
}

// How a text or button layer's words lie in its frame (a state from stateAt, or layersAt's entry):
// the font size (shrunk to fit, if its fit is 'shrink'), the lines and their words, and the inset
// (px, { x, y }, padding and border included) they're laid out in. measure(text,
// { font, family, weight, italic, size, letterSpacing (px) }) gives a width in px (default an
// estimate). Deterministic for a given measure: the size is the largest quarter pixel that fits.
export function layoutText(state, measure = estimateWidth) {
  const { style, frame } = state;
  const text = state.text ?? state.layer?.text ?? '';
  // Inside its padding and border, and clear of rounded ends: a pill's text keeps half its
  // radius from each end.
  const border = style.border?.width ?? 0;
  const padding = style.padding ?? 0;
  const round = Math.min(style.radius ?? 0, frame.w / 2, frame.h / 2);
  const inset = { x: Math.max(padding, round * 0.5) + border, y: padding + border };
  const width = Math.max(0, frame.w - 2 * inset.x);
  const height = Math.max(0, frame.h - 2 * inset.y);
  const fontAt = (size) => ({ font: style.font, family: style.family, weight: style.weight, italic: style.italic, size, letterSpacing: style.letterSpacing * size });
  const attempt = (size) => {
    const font = fontAt(size);
    const lines = wrap(text, width, font, measure);
    const fits = lines.length * size * style.lineHeight <= height + 0.5 && lines.every((l) => l.width <= width + 0.5);
    return { size, lines, fits };
  };
  const nominal = style.size;
  let best = attempt(nominal);
  let shrunk = false;
  if (!best.fits && style.fit === 'shrink') {
    shrunk = true;
    const floor = attempt(MIN_FONT_PX);
    if (!floor.fits || nominal <= MIN_FONT_PX) best = floor;
    else {
      let lo = MIN_FONT_PX, hi = nominal;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (attempt(mid).fits) lo = mid; else hi = mid;
      }
      const size = Math.max(MIN_FONT_PX, Math.floor(lo * 4) / 4);
      best = attempt(size);
      if (!best.fits) best = floor;
    }
  }
  return {
    size: best.size,
    lineHeight: best.size * style.lineHeight,
    letterSpacing: style.letterSpacing * best.size,
    lines: best.lines,
    inset,
    width,
    height,
    overflow: !best.fits,
    shrunk,
  };
}

// --- For the AI -------------------------------------------------------------------------------

const range = (a, b) => `${seconds(a)}–${seconds(b)} s`;

function phrase(property, a, b, layer) {
  const style = layer.style;
  switch (property) {
    case 'opacity':
      if (b > a) return b >= 1 && a <= 0 ? 'fades in' : `fades to ${fmt(b)}`;
      return b <= 0 ? 'fades out' : `fades to ${fmt(b)}`;
    case 'x':
      if (Math.abs(b) < Math.abs(a) && b === 0) return a < 0 ? 'slides in from the left' : 'slides in from the right';
      if (a === 0) return b < 0 ? 'slides out to the left' : 'slides out to the right';
      return b < a ? 'moves left' : 'moves right';
    case 'y':
      if (b === 0) return a > 0 ? 'slides up into place' : 'slides down into place';
      if (a === 0) return b > 0 ? 'slides down and away' : 'slides up and away';
      return b < a ? 'moves up' : 'moves down';
    case 'scale':
      if (b > a) return a === 0 ? 'pops in' : b === 1 ? 'grows to full size' : `grows to ${fmt(b)}×`;
      return b === 0 ? 'shrinks away' : b === 1 ? 'shrinks back' : `shrinks to ${fmt(b)}×`;
    case 'rotate':
      return `turns ${fmt(Math.abs(b - a))}° ${b > a ? 'clockwise' : 'anticlockwise'}`;
    case 'reveal': {
      const way = style.reveal;
      if (b > a) return way === 'words' ? 'appears word by word' : way === 'lines' ? 'appears line by line' : way === 'center' ? 'wipes in from the middle' : `wipes in from the ${way}`;
      return way === 'words' ? 'disappears word by word' : way === 'lines' ? 'disappears line by line' : 'wipes out';
    }
  }
  return `${property} changes`;
}

// What a layer's animation does, as [ { from, to, says } ], in time order.
function moves(layer) {
  const spans = [];
  for (const track of layer.animation) {
    const k = track.keyframes;
    for (let i = 0; i < k.length - 1; i++) {
      const a = k[i], b = k[i + 1];
      if (a.value === b.value) continue;
      const says = phrase(track.property, a.value, b.value, layer);
      const same = spans.find((s) => Math.abs(s.from - a.t) < 0.005 && Math.abs(s.to - b.t) < 0.005);
      if (same) { if (!same.says.includes(says)) same.says.push(says); }
      else spans.push({ from: a.t, to: b.t, says: [says] });
    }
  }
  return spans.sort((a, b) => a.from - b.from || a.to - b.to);
}

const quote = (text) => `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`.replace(/\n/g, ' / ');

function describeLayer(ad, layer) {
  const what = layer.kind === 'text' ? `text ${quote(layer.text)}`
    : layer.kind === 'button' ? `button ${quote(layer.text)}`
      : layer.kind === 'image' ? `image of ${ad.assets.find((a) => a.id === layer.asset)?.name ?? layer.asset}`
        : `${layer.shape}`;
  const parts = [`${layer.id}: ${what}`];
  if (ad.duration > 0 && (layer.from > 0 || layer.until < ad.duration)) parts.push(`shows ${range(layer.from, layer.until)}`);
  for (const m of moves(layer)) parts.push(`${m.says.join(' and ')} ${range(m.from, m.to)}`);
  const own = [];
  for (const [sizeId, o] of Object.entries(layer.sizes ?? {})) {
    if (o.hidden) own.push(`hidden at ${sizeId}`);
    else own.push(`at ${sizeId} its own ${Object.keys(o).map((k) => (k === 'animation' ? 'animation' : k)).join(', ')}`);
  }
  return [parts.join('; '), ...own].join('; ');
}

// A short plain description of the ad for the AI: one line for the ad, then one per layer, back
// to front, saying what it is and what it does when.
export function summarize(ad) {
  const sizes = ad.sizes.map((s) => (s.id === `${s.width}x${s.height}` ? `${s.id} (${s.name})` : `${s.id} (${s.name}, ${s.width}x${s.height})`));
  const head = ad.duration > 0
    ? `Animated ad, ${seconds(ad.duration)} s${ad.loops > 1 ? `, played ${ad.loops} times` : ''}`
    : 'Still ad';
  const lines = [`${head}, background ${ad.background}, in ${ad.sizes.length} size${ad.sizes.length === 1 ? '' : 's'}: ${sizes.join(', ')}. ${ad.layers.length} layer${ad.layers.length === 1 ? '' : 's'}, back to front:`];
  for (const layer of ad.layers) lines.push(`- ${describeLayer(ad, layer)}`);
  return lines.join('\n');
}

// Where a proposal changes the ad in time, for marking its timeline: [ { layer, from, to, kind } ],
// kind 'added', 'removed' or 'changed'. A layer added or removed is marked while it shows; one whose
// content, look or place changed while it shows (before or after); one whose animation or timing
// changed only where it moves or shows differently, at any size. A changed background is
// { layer: null, … } across the whole ad.
export function changedSpans(before, after) {
  const a = normalizeAd(before);
  const b = normalizeAd(after);
  const spans = [];
  const end = Math.max(a.duration, b.duration);
  const beforeById = new Map(a.layers.map((l) => [l.id, l]));
  const afterById = new Map(b.layers.map((l) => [l.id, l]));
  const common = b.layers.filter((l) => beforeById.has(l.id)).map((l) => l.id);
  const commonBefore = a.layers.filter((l) => afterById.has(l.id)).map((l) => l.id);
  const round = (n) => Math.round(n * 100) / 100;
  if (a.background !== b.background) spans.push({ layer: null, from: 0, to: round(b.duration), kind: 'changed' });
  const content = (l) => {
    const { animation, from, until, sizes, name, ...rest } = l;
    void animation; void from; void until; void name;
    const own = {};
    for (const [id, o] of Object.entries(sizes ?? {})) {
      const { animation: anim, from: f, until: u, ...r } = o;
      void anim; void f; void u;
      own[id] = r;
    }
    return JSON.stringify({ ...rest, own });
  };
  for (const layer of b.layers) {
    const old = beforeById.get(layer.id);
    if (!old) { spans.push({ layer: layer.id, from: round(layer.from), to: round(layer.until), kind: 'added' }); continue; }
    const moved = common.indexOf(layer.id) !== commonBefore.indexOf(layer.id);
    if (moved || content(old) !== content(layer)) {
      spans.push({ layer: layer.id, from: round(Math.min(old.from, layer.from)), to: round(Math.max(old.until, layer.until)), kind: 'changed' });
      continue;
    }
    // Timing and animation: compare what it does, moment by moment, at every size.
    const sizeIds = b.sizes.map((s) => s.id);
    const times = new Set();
    const step = 1 / 60;
    for (let t = 0; t <= end + 1e-9; t += step) times.add(Math.round(t * 1e6) / 1e6);
    for (const l of [old, layer]) {
      for (const id of [undefined, ...sizeIds]) {
        const at = id ? layerAt(null, l, id) : l;
        if (!at) continue;
        times.add(at.from).add(at.until);
        for (const track of at.animation) for (const k of track.keyframes) times.add(k.t);
      }
    }
    const sorted = [...times].filter((t) => t <= end + 1e-9).sort((x, y) => x - y);
    const signature = (ad, l, t) => sizeIds.map((id) => {
      const at = layerAt(ad, l, id);
      if (!at || !visibleAt(at, t, ad.duration)) return '-';
      const tracks = {};
      for (const track of at.animation) tracks[track.property] = track.keyframes;
      const v = valuesAt(tracks, t);
      return Object.values(v).map((n) => Math.round(n * 1e4)).join(',');
    }).join('|');
    let start = null, last = null;
    const close = () => {
      if (start === null) return;
      let from = start, to = last;
      if (to - from < step) { from = Math.max(0, from - step / 2); to = Math.min(end, to + step / 2); }
      spans.push({ layer: layer.id, from: round(from), to: round(to), kind: 'changed' });
      start = null;
    };
    for (const t of sorted) {
      if (signature(a, old, t) !== signature(b, layer, t)) {
        if (start === null) start = t;
        last = t;
      } else close();
    }
    close();
  }
  for (const layer of a.layers) {
    if (!afterById.has(layer.id)) spans.push({ layer: layer.id, from: round(layer.from), to: round(layer.until), kind: 'removed' });
  }
  return spans;
}

// What may go wrong with the ad at one size (an id, or a size it isn't made in yet): [ { size,
// layer, message } ], layer null for the ad as a whole. Text sizes are estimated unless measure is
// given (the renderer's, for exact ones).
export function checkSize(ad, sizeOrId, { measure } = {}) {
  const p = prepare(ad, sizeOrId);
  const { size } = p;
  const warnings = [];
  const warn = (layer, message) => warnings.push({ size: size.id, layer, message: `${size.id}${layer ? ` › ${layer}` : ''}: ${message}` });
  if (size.kind === 'display' && ad.duration > 0) {
    const total = ad.duration * ad.loops;
    if (total > DISPLAY_PLAYTIME + 1e-9) {
      warn(null, `plays ${seconds(total)} s in all${ad.loops > 1 ? ` (${seconds(ad.duration)} s × ${ad.loops})` : ''}, past the ${DISPLAY_PLAYTIME} s that Google and most display networks allow; shorten it or play it fewer times`);
    }
    if (ad.loops > DISPLAY_LOOPS) warn(null, `plays ${ad.loops} times; display networks allow ${DISPLAY_LOOPS} at most`);
  }
  const off = (b) => b.x >= size.width || b.y >= size.height || b.x + b.w <= 0 || b.y + b.h <= 0;
  for (const entry of p.layers) {
    const { layer, frame } = entry;
    // At rest is where its frame puts it, before animation moves it.
    if (off(frame)) {
      const times = new Set([layer.from]);
      for (let t = layer.from; t < layer.until; t += 0.1) times.add(t);
      for (const keyframes of Object.values(entry.tracks)) for (const k of keyframes) times.add(k.t);
      const seen = [...times].some((t) => t >= layer.from && t <= layer.until && !off(stateOf(entry, size, t).box));
      warn(layer.id, seen
        ? 'is off the canvas at rest (its frame is outside it), shown only while its animation brings it in; check that is meant'
        : "is off the canvas and never comes into view; bring its frame inside 0–1, or animate it in");
    } else if ((layer.kind === 'text' || layer.kind === 'button') && (frame.x < -0.5 || frame.y < -0.5 || frame.x + frame.w > size.width + 0.5 || frame.y + frame.h > size.height + 0.5)) {
      warn(layer.id, "runs past the canvas's edge at rest, cutting its text off; keep its frame within 0–1");
    }
    if (layer.kind === 'text' || layer.kind === 'button') {
      const fit = layoutText(entry, measure);
      if (fit.overflow) {
        warn(layer.id, layer.style.fit === 'shrink'
          ? `its text doesn't fit its frame even shrunk to ${MIN_FONT_PX} px; give it a larger frame or shorter text at this size`
          : `its text overflows its frame (fit 'none'); give it a larger frame, shorter text, or fit 'shrink'`);
      } else if (fit.size < READABLE_PX) {
        warn(layer.id, `its text is ${fmt(fit.size)} px${fit.shrunk ? ' (shrunk to fit)' : ''}, below the ${READABLE_PX} px that reads; shorten it, give it more room, or hide it at this size`);
      }
    }
  }
  return warnings;
}

// checkSize for every size the ad is made in.
export function checkAd(ad, options) {
  return ad.sizes.flatMap((size) => checkSize(ad, size.id, options));
}
