// What Word, Excel and PowerPoint files share: a zip of XML parts tied together by relationships,
// and a theme (its fonts and colours).
import { readZip } from './zip.js';
import { child, children, parseXml } from './xml.js';

// The package: its parts parsed, and each part's relationships ({ id → { target, type, external } },
// targets resolved to part names).
export function openPackage(bytes) {
  const zip = readZip(bytes);
  const cache = new Map();
  const part = (name) => {
    if (!name || !zip.has(name)) return null;
    if (!cache.has(name)) cache.set(name, parseXml(zip.read(name)));
    return cache.get(name);
  };
  const rels = (name) => {
    const dir = name.slice(0, name.lastIndexOf('/') + 1);
    const map = new Map();
    for (const r of children(part(`${dir}_rels/${name.slice(dir.length)}.rels`), 'Relationship')) {
      const external = r.attrs.TargetMode === 'External';
      map.set(r.attrs.Id, { target: external ? r.attrs.Target : resolvePath(dir, r.attrs.Target), type: r.attrs.Type?.split('/').pop(), external });
    }
    return map;
  };
  // The main part, as the package's own relationships name it.
  const main = (fallback) => {
    for (const r of children(part('_rels/.rels'), 'Relationship')) if (r.attrs.Type?.endsWith('/officeDocument')) return r.attrs.Target.replace(/^\//, '');
    return fallback;
  };
  return { zip, part, rels, main };
}

export function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  for (const p of (dir + target).split('/')) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join('/');
}

// The theme's fonts and colours, by DrawingML's names (dk1, lt1, accent1 …) and Word's.
export function readTheme(theme) {
  const out = { major: 'Calibri Light', minor: 'Calibri', colors: {} };
  if (!theme) return out;
  const elements = child(theme, 'a:themeElements');
  const fonts = child(elements, 'a:fontScheme');
  const major = child(child(fonts, 'a:majorFont'), 'a:latin')?.attrs.typeface;
  const minor = child(child(fonts, 'a:minorFont'), 'a:latin')?.attrs.typeface;
  if (major) out.major = major;
  if (minor) out.minor = minor;
  for (const c of children(child(elements, 'a:clrScheme'))) {
    const value = child(c, 'a:srgbClr')?.attrs.val ?? child(c, 'a:sysClr')?.attrs.lastClr;
    if (value) out.colors[c.name.replace('a:', '')] = `#${value}`;
  }
  Object.assign(out.colors, { text1: out.colors.dk1, background1: out.colors.lt1, text2: out.colors.dk2, background2: out.colors.lt2, dark1: out.colors.dk1, light1: out.colors.lt1, dark2: out.colors.dk2, light2: out.colors.lt2 });
  return out;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

// A theme colour with Word's tint or shade (each 0–255, as hex).
export function themeColor(theme, name, tint, shade) {
  const base = theme.colors[name];
  if (!base) return null;
  let [r, g, b] = rgb(base);
  if (tint) {
    const t = parseInt(tint, 16) / 255;
    [r, g, b] = [r, g, b].map((v) => v * t + 255 * (1 - t));
  }
  if (shade) {
    const s = parseInt(shade, 16) / 255;
    [r, g, b] = [r, g, b].map((v) => v * s);
  }
  return hex(r, g, b);
}

// Excel's theme colour numbers (light before dark, unlike the scheme's order).
export const EXCEL_THEME = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

// A colour lightened (tint > 0) or darkened (tint < 0) as Excel does it: in HSL, on its luminance.
export function excelTint(color, tint) {
  if (!tint) return color;
  const [r, g, b] = rgb(color).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return s === 0 ? hex(l * 255, l * 255, l * 255) : hex(channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255);
}
