// Colour spaces (PDF 32000-1 8.6): each turns a colour's components into sRGB for the canvas. Device
// gray, RGB and CMYK (CMYK by pdf.js's fit to the US Web Coated SWOP profile, so colours come out as
// other readers show them), CIE-based spaces (CalGray and CalRGB as their device equivalents, Lab
// converted, ICC profiles by their number of components), Indexed, Separation and DeviceN (through
// their tint transforms), and Pattern.

import { streamBytes } from './filters.js';
import { makeFunction } from './function.js';
import { Dict, Name, Stream } from './objects.js';

// (NaN, as from a negative channel's square root in Lab, is 0, as in a byte array.)
const clamp255 = (v) => (v > 0 ? (v > 255 ? 255 : v) : 0);

export function cmykToRgb(c, m, y, k) {
  return [
    clamp255(255 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) + k * (-21.86122147463605 * k - 189.48180835922747)),
    clamp255(255 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) + k * (-20.737325471181034 * k - 187.80453709719578)),
    clamp255(255 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) + k * (-22.33816807309886 * k - 180.12613974708367)),
  ];
}

class ColorSpace {
  constructor(name, n) {
    this.name = name;
    this.n = n;
  }
  // The colour a space starts with (PDF 32000-1 8.6.5.1, and the tables for each space).
  initial() {
    return new Array(this.n).fill(0);
  }
  // Components (as in the content stream) to [r, g, b], 0 to 255.
  rgb() {
    return [0, 0, 0];
  }
  // Image samples (each 0 to 1 after Decode), `count` of them, into RGB bytes.
  rgbBuffer(src, count, out) {
    const n = this.n;
    const c = new Array(n);
    for (let i = 0, j = 0; i < count; i++) {
      for (let k = 0; k < n; k++) c[k] = src[i * n + k];
      const [r, g, b] = this.rgb(c);
      out[j++] = r;
      out[j++] = g;
      out[j++] = b;
    }
  }
}

class Gray extends ColorSpace {
  constructor() {
    super('DeviceGray', 1);
  }
  rgb([g]) {
    const v = clamp255(g * 255);
    return [v, v, v];
  }
}
class RGB extends ColorSpace {
  constructor() {
    super('DeviceRGB', 3);
  }
  rgb([r, g, b]) {
    return [clamp255(r * 255), clamp255(g * 255), clamp255(b * 255)];
  }
}
class CMYK extends ColorSpace {
  constructor() {
    super('DeviceCMYK', 4);
  }
  initial() {
    return [0, 0, 0, 1];
  }
  rgb([c, m, y, k]) {
    return cmykToRgb(c, m, y, k);
  }
}

// CIE-based spaces, converted as pdf.js converts them.
const arr = (doc, v, n) => (Array.isArray(v) && v.length === n ? v.map((x) => Number(doc.fetchIfRef(x)) || 0) : null);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

class CalGray extends ColorSpace {
  constructor(doc, dict) {
    super('CalGray', 1);
    const wp = arr(doc, dict?.get('WhitePoint'), 3);
    if (!wp || wp[0] < 0 || wp[2] < 0 || wp[1] !== 1) throw new Error('bad CalGray');
    this.YW = wp[1];
    const g = Number(doc.fetchIfRef(dict.get('Gamma'))) || 1;
    this.G = g < 1 ? 1 : g;
  }
  rgb([a]) {
    const L = this.YW * clamp01(a) ** this.G;
    const v = Math.max(295.8 * L ** (1 / 3) - 40.8, 0);
    return [clamp255(v), clamp255(v), clamp255(v)];
  }
}

const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INVERSE = [0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867];
const SRGB_D65 = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
const product = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const decodeL = (L) => (L < 0 ? -decodeL(-L) : L > 8 ? ((L + 16) / 116) ** 3 : (L * ((8 + 16) / 116) ** 3) / 8);
const transfer = (c) => (c <= 0.0031308 ? clamp01(12.92 * c) : c >= 0.99554525 ? 1 : clamp01(1.055 * c ** (1 / 2.4) - 0.055));

class CalRGB extends ColorSpace {
  constructor(doc, dict) {
    super('CalRGB', 3);
    const wp = arr(doc, dict?.get('WhitePoint'), 3);
    if (!wp || wp[0] < 0 || wp[2] < 0 || wp[1] !== 1) throw new Error('bad CalRGB');
    this.white = wp;
    let bp = arr(doc, dict.get('BlackPoint'), 3) ?? [0, 0, 0];
    if (bp.some((v) => v < 0)) bp = [0, 0, 0];
    this.black = bp;
    let g = arr(doc, dict.get('Gamma'), 3) ?? [1, 1, 1];
    if (g.some((v) => v < 0)) g = [1, 1, 1];
    this.gamma = g;
    this.matrix = arr(doc, dict.get('Matrix'), 9) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.cache = new Map();
  }
  rgb(c) {
    const key = c.join(',');
    let v = this.cache.get(key);
    if (v) return v;
    const [A, B, C] = c.map(clamp01);
    const ag = A === 1 ? 1 : A ** this.gamma[0];
    const bg = B === 1 ? 1 : B ** this.gamma[1];
    const cg = C === 1 ? 1 : C ** this.gamma[2];
    const m = this.matrix;
    let xyz = [m[0] * ag + m[3] * bg + m[6] * cg, m[1] * ag + m[4] * bg + m[7] * cg, m[2] * ag + m[5] * bg + m[8] * cg];
    const w = this.white;
    // To a flat white point, black point compensation, then to D65 and sRGB.
    if (!(w[0] === 1 && w[2] === 1)) {
      const lms = product(BRADFORD, xyz);
      xyz = product(BRADFORD_INVERSE, [lms[0] / w[0], lms[1] / w[1], lms[2] / w[2]]);
    }
    const b = this.black;
    if (b[0] || b[1] || b[2]) {
      const z = decodeL(0);
      xyz = xyz.map((v, i) => {
        const scale = (1 - z) / (1 - decodeL(b[i]));
        return v * scale + 1 - scale;
      });
    }
    const lms = product(BRADFORD, xyz);
    const d65 = product(BRADFORD_INVERSE, [lms[0] * 0.95047, lms[1], lms[2] * 1.08883]);
    const srgb = product(SRGB_D65, d65);
    v = [transfer(srgb[0]) * 255, transfer(srgb[1]) * 255, transfer(srgb[2]) * 255];
    if (this.cache.size < 4096) this.cache.set(key, v);
    return v;
  }
}

class Lab extends ColorSpace {
  constructor(doc, dict) {
    super('Lab', 3);
    const wp = arr(doc, dict?.get('WhitePoint'), 3);
    if (!wp || wp[0] < 0 || wp[2] < 0 || wp[1] !== 1) throw new Error('bad Lab');
    this.white = wp;
    let range = arr(doc, dict.get('Range'), 4) ?? [-100, 100, -100, 100];
    if (range[0] > range[1] || range[2] > range[3]) range = [-100, 100, -100, 100];
    this.range = range;
  }
  initial() {
    return [0, Math.max(0, this.range[0]), Math.max(0, this.range[2])];
  }
  // Image samples' default Decode: L from 0 to 100, a and b over their ranges.
  get defaultDecode() {
    return [0, 100, ...this.range];
  }
  rgb([L, a, b]) {
    a = Math.min(Math.max(a, this.range[0]), this.range[1]);
    b = Math.min(Math.max(b, this.range[2]), this.range[3]);
    const g = (x) => (x >= 6 / 29 ? x ** 3 : (108 / 841) * (x - 4 / 29));
    const M = (L + 16) / 116;
    const [XW, YW, ZW] = this.white;
    const X = XW * g(M + a / 500);
    const Y = YW * g(M);
    const Z = ZW * g(M - b / 200);
    let r, gr, bl;
    if (ZW < 1) {
      r = X * 3.1339 + Y * -1.617 + Z * -0.4906;
      gr = X * -0.9785 + Y * 1.916 + Z * 0.0333;
      bl = X * 0.072 + Y * -0.229 + Z * 1.4057;
    } else {
      r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
      gr = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
      bl = X * 0.0557 + Y * -0.204 + Z * 1.057;
    }
    return [clamp255(Math.sqrt(r) * 255), clamp255(Math.sqrt(gr) * 255), clamp255(Math.sqrt(bl) * 255)];
  }
}

class Indexed extends ColorSpace {
  constructor(base, hival, lookup) {
    super('Indexed', 1);
    this.base = base;
    this.hival = hival;
    this.lookup = lookup;
  }
  rgb([i]) {
    const n = this.base.n;
    const at = Math.max(0, Math.min(this.hival, Math.round(i))) * n;
    const c = [];
    for (let k = 0; k < n; k++) c.push((this.lookup[at + k] ?? 0) / 255);
    return this.base.rgb(c);
  }
}

class Alternate extends ColorSpace {
  constructor(name, n, base, tint) {
    super(name, n);
    this.base = base;
    this.tint = tint;
    this.cache = new Map();
  }
  initial() {
    return new Array(this.n).fill(1);
  }
  rgb(c) {
    const key = c.join(',');
    let v = this.cache.get(key);
    if (!v) {
      v = this.base.rgb(this.tint(c));
      if (this.cache.size < 4096) this.cache.set(key, v);
    }
    return v;
  }
}

class PatternSpace extends ColorSpace {
  constructor(base) {
    super('Pattern', base ? base.n : 0);
    this.base = base;
    this.isPattern = true;
  }
  rgb(c) {
    return this.base ? this.base.rgb(c) : [0, 0, 0];
  }
}

export const GRAY = new Gray();
export const RGB_SPACE = new RGB();
export const CMYK_SPACE = new CMYK();

// The colour space `value` names or is (a Name, an array, or a name in the resources'
// ColorSpace dictionary); throws if it can't be made out.
export function makeColorSpace(doc, value, resources, depth = 0) {
  value = doc.fetchIfRef(value);
  if (depth > 8) throw new Error('colour space nested too deep');
  if (value instanceof Name) {
    switch (value.name) {
      case 'DeviceGray':
      case 'G':
        return GRAY;
      case 'DeviceRGB':
      case 'RGB':
        return RGB_SPACE;
      case 'DeviceCMYK':
      case 'CMYK':
        return CMYK_SPACE;
      case 'Pattern':
        return new PatternSpace(null);
      default: {
        const named = resources?.dict('ColorSpace')?.get(value.name);
        if (named !== undefined) return makeColorSpace(doc, named, resources, depth + 1);
        throw new Error(`unknown colour space ${value.name}`);
      }
    }
  }
  if (!Array.isArray(value) || !(doc.fetchIfRef(value[0]) instanceof Name)) throw new Error('bad colour space');
  const family = doc.fetchIfRef(value[0]).name;
  const arg = (i) => doc.fetchIfRef(value[i]);
  switch (family) {
    case 'DeviceGray':
    case 'G':
      return GRAY;
    case 'CalGray':
      try {
        return new CalGray(doc, arg(1));
      } catch {
        return GRAY;
      }
    case 'DeviceRGB':
    case 'RGB':
      return RGB_SPACE;
    case 'CalRGB':
      try {
        return new CalRGB(doc, arg(1));
      } catch {
        return RGB_SPACE;
      }
    case 'DeviceCMYK':
    case 'CMYK':
      return CMYK_SPACE;
    case 'Lab':
      return new Lab(doc, arg(1));
    case 'ICCBased': {
      const stream = arg(1);
      const dict = stream instanceof Stream ? stream.dict : null;
      const n = dict?.get('N');
      const alt = dict?.get('Alternate');
      if (alt) {
        try {
          const space = makeColorSpace(doc, alt, resources, depth + 1);
          if (space.n === n) return space;
        } catch {
          // the alternate can't be used: go by the number of components
        }
      }
      if (n === 1) return GRAY;
      if (n === 4) return CMYK_SPACE;
      return RGB_SPACE;
    }
    case 'Indexed':
    case 'I': {
      const base = makeColorSpace(doc, arg(1), resources, depth + 1);
      const hival = Math.max(0, Math.min(255, Math.trunc(arg(2)) || 0));
      const lookupValue = arg(3);
      let lookup;
      if (lookupValue instanceof Stream) lookup = streamBytes(lookupValue);
      else if (typeof lookupValue === 'string') lookup = Uint8Array.from(lookupValue, (ch) => ch.charCodeAt(0) & 0xff);
      else lookup = new Uint8Array(0);
      return new Indexed(base, hival, lookup);
    }
    case 'Separation':
    case 'DeviceN': {
      const names = arg(1);
      const n = family === 'Separation' ? 1 : Array.isArray(names) ? names.length : 1;
      const base = makeColorSpace(doc, arg(2), resources, depth + 1);
      const tint = makeFunction(doc, value[3]);
      return new Alternate(family, n, base, tint);
    }
    case 'Pattern': {
      const base = value.length > 1 ? makeColorSpace(doc, value[1], resources, depth + 1) : null;
      return new PatternSpace(base);
    }
    default:
      throw new Error(`unknown colour space ${family}`);
  }
}

export const isDict = (v) => v instanceof Dict;
