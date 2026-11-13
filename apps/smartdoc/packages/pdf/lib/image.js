// Pictures, ready for a PDF: a JPEG goes in as it is (its size and colours read from its header);
// a PNG is decoded to pixels, its colour and its transparency apart (a PDF keeps them as an image
// and its soft mask), every bit depth, palette and interlacing PNG allows.
import { inflateSync } from 'node:zlib';

export function imageInfo(data) {
  if (data[0] === 0xff && data[1] === 0xd8) return jpegInfo(data);
  if (data.readUInt32BE(0) === 0x89504e47) return decodePng(data);
  if (data.toString('latin1', 0, 3) === 'GIF') throw new Error('GIF pictures can’t be converted yet.');
  throw new Error('Not a JPEG or PNG picture.');
}

function jpegInfo(data) {
  let at = 2;
  let adobe = false;
  while (at < data.length) {
    if (data[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = data[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = data.readUInt16BE(at + 2);
    if (marker === 0xee && data.toString('latin1', at + 4, at + 9) === 'Adobe') adobe = true;
    // Start of frame (any kind but the arithmetic-coded and differential ones the PDF can't take).
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = data.readUInt16BE(at + 5);
      const width = data.readUInt16BE(at + 7);
      const components = data[at + 9];
      return { kind: 'jpeg', width, height, components, adobe, data };
    }
    at += 2 + length;
  }
  throw new Error('The JPEG picture is damaged.');
}

// A PNG's pixels: { kind: 'raw', width, height, colors (1 or 3), bits: 8, pixels, alpha? }.
function decodePng(data) {
  let at = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (at < data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!header) throw new Error('The PNG picture is damaged.');
  const { width, height, depth, color, interlace } = header;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  // Each pass of the image (one without interlacing; Adam7's seven with it), unfiltered.
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  const samples = new Uint16Array(width * height * channels);
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPerPixel) / 8);
    let previous = Buffer.alloc(stride);
    for (let y = 0; y < ph; y++) {
      const filter = raw[offset];
      const line = Buffer.from(raw.subarray(offset + 1, offset + 1 + stride));
      offset += 1 + stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
        const b = previous[i];
        const c = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
        let value = line[i];
        if (filter === 1) value += a;
        else if (filter === 2) value += b;
        else if (filter === 3) value += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        line[i] = value & 0xff;
      }
      previous = line;
      for (let x = 0; x < pw; x++) {
        for (let ch = 0; ch < channels; ch++) {
          const index = x * channels + ch;
          let sample;
          if (depth === 8) sample = line[index];
          else if (depth === 16) sample = line.readUInt16BE(index * 2);
          else {
            const bit = index * depth;
            sample = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
          }
          samples[((y0 + y * dy) * width + (x0 + x * dx)) * channels + ch] = sample;
        }
      }
    }
  }
  // To 8-bit colour (gray or RGB) and an 8-bit alpha, if there's any transparency.
  const max = (1 << depth) - 1;
  const to8 = (v) => (depth === 8 ? v : depth === 16 ? v >> 8 : Math.round((v * 255) / max));
  const gray = color === 0 || color === 4;
  const colors = gray ? 1 : 3;
  const pixels = Buffer.alloc(width * height * colors);
  let alpha = color === 4 || color === 6 || transparency ? Buffer.alloc(width * height, 255) : null;
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    if (color === 3) {
      const index = samples[s];
      pixels[p * 3] = palette[index * 3];
      pixels[p * 3 + 1] = palette[index * 3 + 1];
      pixels[p * 3 + 2] = palette[index * 3 + 2];
      if (transparency && index < transparency.length) alpha[p] = transparency[index];
    } else if (gray) {
      pixels[p] = to8(samples[s]);
      if (color === 4) alpha[p] = to8(samples[s + 1]);
      else if (transparency && samples[s] === transparency.readUInt16BE(0)) alpha[p] = 0;
    } else {
      pixels[p * 3] = to8(samples[s]);
      pixels[p * 3 + 1] = to8(samples[s + 1]);
      pixels[p * 3 + 2] = to8(samples[s + 2]);
      if (color === 6) alpha[p] = to8(samples[s + 3]);
      else if (transparency && samples[s] === transparency.readUInt16BE(0) && samples[s + 1] === transparency.readUInt16BE(2) && samples[s + 2] === transparency.readUInt16BE(4)) alpha[p] = 0;
    }
  }
  if (alpha && alpha.every((v) => v === 255)) alpha = null;
  return { kind: 'raw', width, height, colors, pixels, alpha };
}
