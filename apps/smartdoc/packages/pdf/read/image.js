// Images (PDF 32000-1 8.9): an image XObject's or inline image's samples as RGBA pixels on a canvas,
// ready to draw. Samples of 1 to 16 bits in any colour space, Decode arrays, image masks (painted in
// the fill colour), colour-key and stencil masks, and soft masks (SMask). JPEG (DCTDecode) is
// decoded by the browser, CCITT fax by ccitt.js, JBIG2 by jbig2.js and JPEG 2000 by jpx.js.

import { CMYK_SPACE, GRAY, RGB_SPACE, makeColorSpace } from './colorspace.js';
import { decodeCCITT } from './ccitt.js';
import { decodeJBIG2 } from './jbig2.js';
import { decodeJpx } from './jpx.js';
import { decodeStream } from './filters.js';
import { Dict, Name, Stream } from './objects.js';

const INLINE_NAMES = { W: 'Width', H: 'Height', BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', IM: 'ImageMask', I: 'Interpolate', F: 'Filter', DP: 'DecodeParms' };
const INLINE_SPACES = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' };

export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

// An inline image's dictionary with its abbreviations spelled out.
export function inlineImageStream(doc, { dict, data }) {
  const full = new Dict(doc);
  for (const [k, v] of dict.map) {
    let value = v;
    if (k === 'CS' || k === 'ColorSpace') {
      if (value instanceof Name && INLINE_SPACES[value.name]) value = Name.of(INLINE_SPACES[value.name]);
    }
    full.set(INLINE_NAMES[k] ?? k, value);
  }
  const s = new Stream(full, data);
  return s;
}

const num = (doc, v) => {
  const x = doc.fetchIfRef(v);
  return typeof x === 'number' ? x : null;
};

// The image's pixels: { canvas, width, height } or null if it can't be drawn. `fill` is the fill
// colour [r, g, b] for an image mask.
export async function decodeImage(doc, stream, resources, fill = [0, 0, 0], depth = 0) {
  const dict = stream.dict;
  const width = num(doc, dict.get('Width'));
  const height = num(doc, dict.get('Height'));
  if (!(width > 0 && height > 0) || width * height > 1e8) return null;
  const imageMask = dict.get('ImageMask') === true;
  const bpc = imageMask ? 1 : num(doc, dict.get('BitsPerComponent')) ?? 8;
  let { data, image } = decodeStream(stream);
  let rgba;
  let jpegSpace = null;
  if (image && image.name === 'CCITTFaxDecode') {
    data = decodeCCITT(data, image.params, 1728, height).data;
    image = null;
  } else if (image && image.name === 'JPXDecode') {
    // JPEG 2000: 8-bit samples in the PDF's colour space, or the file's own (by its components).
    // (A failure reaches the renderer, which leaves the image out and says why.)
    const j = decodeJpx(data, { smaskInData: (dict.get('SMaskInData') ?? 0) > 0 });
    let space = null;
    try {
      space = dict.get('ColorSpace') ? makeColorSpace(doc, dict.get('ColorSpace'), resources) : null;
    } catch {
      space = null;
    }
    space ??= j.components === 1 ? GRAY : j.components >= 4 ? CMYK_SPACE : RGB_SPACE;
    const count = j.width * j.height;
    const n = space.n;
    const comps = new Float32Array(count * n);
    for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) comps[i * n + k] = (j.data[i * j.components + Math.min(k, j.components - 1)] ?? 0) / (space.name === 'Indexed' ? 1 : 255);
    const rgb = new Uint8ClampedArray(count * 3);
    rgbBufferOf(space, comps, count, rgb);
    let out = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
      out[i * 4 + 3] = j.alpha ? j.alpha[i] : 255;
    }
    if (j.width !== width || j.height !== height) out = resize(out, j.width, j.height, width, height);
    if (depth === 0 && dict.get('SMask') instanceof Stream) await applyAlpha(doc, out, width, height, dict.get('SMask'), resources, false);
    return toCanvas(out, width, height);
  } else if (image && image.name === 'JBIG2Decode') {
    const globals = image.params?.get('JBIG2Globals');
    data = decodeJBIG2(data, globals instanceof Stream ? decodeStream(globals).data : null, width, height);
    image = null;
  }
  if (image && image.name === 'DCTDecode') {
    const pixels = await decodeJpeg(data);
    if (!pixels) return null;
    rgba = pixels.data;
    jpegSpace = true;
    if (pixels.width !== width || pixels.height !== height) rgba = resize(rgba, pixels.width, pixels.height, width, height);
  } else if (image) return null;

  const decode = dict.get('Decode');
  const decodeArray = Array.isArray(decode) ? decode.map((v) => doc.fetchIfRef(v)) : null;

  if (imageMask) {
    // A stencil: 1-bit samples, painted (0 by default, 1 with Decode [1 0]) in the fill colour.
    const paintOn = decodeArray && decodeArray[0] === 1 ? 1 : 0;
    rgba = new Uint8ClampedArray(width * height * 4);
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const o = (y * width + x) * 4;
        rgba[o] = fill[0];
        rgba[o + 1] = fill[1];
        rgba[o + 2] = fill[2];
        rgba[o + 3] = bit === paintOn ? 255 : 0;
      }
    }
    return toCanvas(rgba, width, height);
  }

  let space = null;
  const csValue = dict.get('ColorSpace');
  if (csValue) {
    try {
      space = makeColorSpace(doc, csValue, resources);
    } catch {
      space = null;
    }
  }
  if (!rgba) {
    space ??= GRAY;
    const n = space.n || 1;
    const max = 2 ** bpc - 1;
    const dmin = [];
    const dmax = [];
    for (let k = 0; k < n; k++) {
      if (decodeArray?.length >= 2 * n) {
        dmin.push(decodeArray[2 * k]);
        dmax.push(decodeArray[2 * k + 1]);
      } else if (space.name === 'Indexed') {
        dmin.push(0);
        dmax.push(max);
      } else if (space.defaultDecode) {
        dmin.push(space.defaultDecode[2 * k]);
        dmax.push(space.defaultDecode[2 * k + 1]);
      } else {
        dmin.push(0);
        dmax.push(1);
      }
    }
    const count = width * height;
    const comps = new Float32Array(count * n);
    const rowBits = width * n * bpc;
    const rowBytes = (rowBits + 7) >> 3;
    for (let y = 0; y < height; y++) {
      let bit = y * rowBytes * 8;
      for (let x = 0; x < width * n; x++) {
        let v;
        if (bpc === 8) {
          v = data[bit >> 3] ?? 0;
          bit += 8;
        } else if (bpc === 16) {
          v = ((data[bit >> 3] ?? 0) << 8) | (data[(bit >> 3) + 1] ?? 0);
          bit += 16;
        } else {
          v = 0;
          for (let b = 0; b < bpc; b++, bit++) v = (v << 1) | (((data[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
        }
        const k = x % n;
        comps[y * width * n + x] = dmin[k] + (v * (dmax[k] - dmin[k])) / max;
      }
    }
    const rgb = new Uint8ClampedArray(count * 3);
    rgbBufferOf(space, comps, count, rgb);
    rgba = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      rgba[i * 4] = rgb[i * 3];
      rgba[i * 4 + 1] = rgb[i * 3 + 1];
      rgba[i * 4 + 2] = rgb[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    // A colour-key mask: samples within its ranges aren't painted.
    const mask = dict.get('Mask');
    if (Array.isArray(mask)) {
      const ranges = mask.map((v) => doc.fetchIfRef(v));
      for (let y = 0; y < height; y++) {
        let bit = y * rowBytes * 8;
        for (let x = 0; x < width; x++) {
          let inside = true;
          for (let k = 0; k < n; k++) {
            let v = 0;
            for (let b = 0; b < bpc; b++, bit++) v = (v << 1) | (((data[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
            if (v < ranges[2 * k] || v > ranges[2 * k + 1]) inside = false;
          }
          if (inside) rgba[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
  } else if (jpegSpace && decodeArray && space?.n === 4 && decodeArray[0] === 1) {
    // An Adobe CMYK JPEG with an inverting Decode array: the browser has already inverted it.
  } else if (jpegSpace && decodeArray && decodeArray[0] === 1 && decodeArray[1] === 0) {
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 255 - rgba[i];
      rgba[i + 1] = 255 - rgba[i + 1];
      rgba[i + 2] = 255 - rgba[i + 2];
    }
  }

  if (depth === 0) {
    const smask = dict.get('SMask');
    const mask = dict.get('Mask');
    if (smask instanceof Stream) await applyAlpha(doc, rgba, width, height, smask, resources, false);
    else if (mask instanceof Stream) await applyAlpha(doc, rgba, width, height, mask, resources, true);
  }
  return toCanvas(rgba, width, height);
}

function rgbBufferOf(space, comps, count, out) {
  if (space.name === 'DeviceRGB') {
    for (let i = 0; i < count * 3; i++) out[i] = comps[i] * 255;
  } else if (space.name === 'DeviceGray') {
    for (let i = 0; i < count; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = comps[i] * 255;
  } else space.rgbBuffer(comps, count, out);
}

// A soft mask's gray samples (or a stencil mask's bits) as the image's alpha.
async function applyAlpha(doc, rgba, width, height, maskStream, resources, stencil) {
  const md = maskStream.dict;
  const mw = num(doc, md.get('Width'));
  const mh = num(doc, md.get('Height'));
  if (!(mw > 0 && mh > 0)) return;
  let alpha;
  if (stencil) {
    const { data } = decodeStream(maskStream);
    const decode = md.get('Decode');
    const paintOn = Array.isArray(decode) && doc.fetchIfRef(decode[0]) === 1 ? 1 : 0;
    alpha = new Uint8ClampedArray(mw * mh);
    const rowBytes = (mw + 7) >> 3;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) alpha[y * mw + x] = ((data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) === paintOn ? 255 : 0;
  } else {
    const m = await decodeImage(doc, maskStream, resources, [0, 0, 0], 1);
    if (!m) return;
    const px = m.canvas.getContext('2d').getImageData(0, 0, mw, mh).data;
    alpha = new Uint8ClampedArray(mw * mh);
    for (let i = 0; i < mw * mh; i++) alpha[i] = px[i * 4];
  }
  for (let y = 0; y < height; y++) {
    const sy = Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / width));
      const o = (y * width + x) * 4 + 3;
      rgba[o] = (rgba[o] * alpha[sy * mw + sx]) / 255;
    }
  }
}

function resize(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      out.set(src.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * dw + x) * 4);
    }
  }
  return out;
}

function toCanvas(rgba, width, height) {
  const canvas = makeCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return { canvas, width, height };
}

async function decodeJpeg(bytes) {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = makeCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close?.();
    return img;
  } catch {
    return null;
  }
}
