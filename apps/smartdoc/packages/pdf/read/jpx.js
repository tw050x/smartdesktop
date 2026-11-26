// JPEG 2000 decoding (JPXDecode; ITU-T T.800 Part 1): a JP2 file's boxes (its colour, palette,
// channels) or a bare codestream; tiles and tile-parts; the five progression orders; packet
// headers (tag trees, code-block inclusion, passes, lengths; SOP and EPH markers); code-block
// bit-plane decoding with the MQ coder (all code-block styles); scalar dequantisation; the 5/3
// and 9/7 inverse wavelet transforms; the reversible and irreversible component transforms; and
// subsampled components. Gives 8-bit samples, interleaved: { width, height, components, data,
// alpha (the index of an opacity channel, if any) }.

import { ArithmeticDecoder } from './jbig2.js';

class JpxError extends Error {}

const u16 = (d, p) => (d[p] << 8) | d[p + 1];
const u32 = (d, p) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const log2 = (x) => {
  let n = 0;
  while (1 << n < x) n++;
  return n;
};

export function decodeJpx(data, { smaskInData = false } = {}) {
  const info = { palette: null, channelMap: null, channelDefs: null, colorSpace: null };
  let codestream = null;
  if (u16(data, 0) === 0xff4f) codestream = data;
  else {
    // JP2 boxes.
    const boxes = (start, end, fn) => {
      let p = start;
      while (p + 8 <= end) {
        let len = u32(data, p);
        const type = String.fromCharCode(data[p + 4], data[p + 5], data[p + 6], data[p + 7]);
        let header = 8;
        if (len === 1) {
          len = u32(data, p + 8) * 2 ** 32 + u32(data, p + 12);
          header = 16;
        }
        if (len === 0) len = end - p;
        if (len < header) break;
        fn(type, p + header, Math.min(end, p + len));
        p += len;
      }
    };
    boxes(0, data.length, (type, s, e) => {
      if (type === 'jp2c') codestream ??= data.subarray(s, e);
      else if (type === 'jp2h') {
        boxes(s, e, (t, bs, be) => {
          if (t === 'colr' && data[bs] === 1) info.colorSpace = u32(data, bs + 3);
          else if (t === 'pclr') {
            const entries = u16(data, bs);
            const n = data[bs + 2];
            const depths = [];
            for (let i = 0; i < n; i++) depths.push((data[bs + 3 + i] & 0x7f) + 1);
            const table = [];
            let q = bs + 3 + n;
            for (let i = 0; i < entries; i++) {
              const row = [];
              for (let c = 0; c < n; c++) {
                const bytes = Math.ceil(depths[c] / 8);
                let v = 0;
                for (let k = 0; k < bytes; k++) v = v * 256 + data[q++];
                row.push(Math.round((v * 255) / (2 ** depths[c] - 1)));
              }
              table.push(row);
            }
            info.palette = { table, n };
          } else if (t === 'cmap') {
            info.channelMap = [];
            for (let q = bs; q + 3 < be; q += 4) info.channelMap.push({ component: u16(data, q), type: data[q + 2], column: data[q + 3] });
          } else if (t === 'cdef') {
            const n = u16(data, bs);
            info.channelDefs = [];
            for (let i = 0; i < n; i++) info.channelDefs.push({ channel: u16(data, bs + 2 + i * 6), type: u16(data, bs + 4 + i * 6), assoc: u16(data, bs + 6 + i * 6) });
          }
        });
      }
    });
    if (!codestream) throw new JpxError('no codestream');
  }
  const image = parseCodestream(codestream);
  return toSamples(image, info, smaskInData);
}

// --- The codestream -------------------------------------------------------------------------------

function parseCodestream(d) {
  const ctx = { siz: null, cod: null, coc: [], qcd: null, qcc: [], tiles: [], ppm: [] };
  let p = 0;
  let tile = null;
  while (p + 1 < d.length) {
    const marker = u16(d, p);
    p += 2;
    if (marker === 0xff4f) continue; // SOC
    if (marker === 0xffd9) break; // EOC
    if (marker === 0xff93) {
      // SOD: the tile-part's data, to its end.
      const end = tile.partEnd;
      tile.data.push(d.subarray(p, end));
      p = end;
      continue;
    }
    if ((marker & 0xff00) !== 0xff00) {
      // Lost: look for the next marker.
      p--;
      continue;
    }
    const len = u16(d, p);
    const s = p + 2;
    const e = p + len;
    switch (marker) {
      case 0xff51: {
        // SIZ
        const siz = {
          xsiz: u32(d, s + 2), ysiz: u32(d, s + 6), xosiz: u32(d, s + 10), yosiz: u32(d, s + 14),
          xtsiz: u32(d, s + 18), ytsiz: u32(d, s + 22), xtosiz: u32(d, s + 26), ytosiz: u32(d, s + 30),
          components: [],
        };
        const n = u16(d, s + 34);
        for (let i = 0; i < n; i++) {
          const q = s + 36 + i * 3;
          siz.components.push({ precision: (d[q] & 0x7f) + 1, signed: (d[q] & 0x80) !== 0, xrsiz: d[q + 1] || 1, yrsiz: d[q + 2] || 1 });
        }
        ctx.siz = siz;
        break;
      }
      case 0xff52:
      case 0xff53: {
        const target = marker === 0xff52 ? null : d[s];
        const cod = parseCOD(d, marker === 0xff52 ? s : s + (ctx.siz.components.length < 257 ? 1 : 2), marker === 0xff52);
        const holder = tile ?? ctx;
        if (marker === 0xff52) holder.cod = { ...(holder.cod ?? {}), ...cod };
        else (holder.coc ??= [])[ctx.siz.components.length < 257 ? target : u16(d, s)] = cod;
        break;
      }
      case 0xff5c:
      case 0xff5d: {
        const comp = marker === 0xff5d ? (ctx.siz.components.length < 257 ? d[s] : u16(d, s)) : null;
        const q = parseQCD(d, marker === 0xff5c ? s : s + (ctx.siz.components.length < 257 ? 1 : 2), e);
        const holder = tile ?? ctx;
        if (marker === 0xff5c) holder.qcd = q;
        else (holder.qcc ??= [])[comp] = q;
        break;
      }
      case 0xff5f: {
        // POC
        const holder = tile ?? ctx;
        holder.poc = [];
        const wide = ctx.siz.components.length >= 257;
        for (let q = s; q < e; ) {
          const c = { rs: d[q], cs: wide ? u16(d, q + 1) : d[q + 1] };
          q += wide ? 3 : 2;
          c.lye = u16(d, q);
          c.re = d[q + 2];
          c.ce = wide ? u16(d, q + 3) : d[q + 3] || 256;
          c.order = d[q + (wide ? 5 : 4)];
          q += wide ? 6 : 5;
          holder.poc.push(c);
        }
        break;
      }
      case 0xff90: {
        // SOT
        const index = u16(d, s);
        let psot = u32(d, s + 2);
        const partStart = p - 2;
        if (psot === 0) psot = d.length - partStart;
        let t = ctx.tiles[index];
        if (!t) {
          t = { index, data: [], cod: null, coc: [], qcd: null, qcc: [], ppt: [] };
          ctx.tiles[index] = t;
        }
        t.partEnd = Math.min(d.length, partStart + psot);
        tile = t;
        break;
      }
      case 0xff60:
        // PPM: packed packet headers for all tiles.
        ctx.ppm.push(d.subarray(s + 1, e));
        break;
      case 0xff61:
        tile?.ppt.push(d.subarray(s + 1, e));
        break;
      default:
        break;
    }
    p = e;
  }
  if (!ctx.siz) throw new JpxError('no SIZ marker');
  return decodeTiles(ctx);
}

function parseCOD(d, s, full) {
  const cod = {};
  let q = s;
  if (full) {
    const scod = d[q++];
    cod.precinctsDefined = (scod & 1) !== 0;
    cod.sop = (scod & 2) !== 0;
    cod.eph = (scod & 4) !== 0;
    cod.order = d[q++];
    cod.layers = u16(d, q);
    q += 2;
    cod.mct = d[q++];
  } else {
    const scoc = d[q++];
    cod.precinctsDefined = (scoc & 1) !== 0;
  }
  cod.levels = d[q++];
  cod.xcb = (d[q++] & 0xf) + 2;
  cod.ycb = (d[q++] & 0xf) + 2;
  const style = d[q++];
  cod.style = {
    bypass: (style & 1) !== 0,
    reset: (style & 2) !== 0,
    termall: (style & 4) !== 0,
    causal: (style & 8) !== 0,
    predictable: (style & 16) !== 0,
    segsym: (style & 32) !== 0,
  };
  cod.reversible = d[q++] === 1;
  cod.precincts = [];
  for (let r = 0; r <= cod.levels; r++) {
    if (cod.precinctsDefined) {
      const v = d[q++];
      cod.precincts.push({ ppx: v & 0xf, ppy: v >> 4 });
    } else cod.precincts.push({ ppx: 15, ppy: 15 });
  }
  return cod;
}

function parseQCD(d, s, e) {
  const sqcd = d[s];
  const style = sqcd & 0x1f;
  const guard = sqcd >> 5;
  const steps = [];
  if (style === 0) for (let q = s + 1; q < e; q++) steps.push({ epsilon: d[q] >> 3, mu: 0 });
  else for (let q = s + 1; q + 1 < e; q += 2) {
    const v = u16(d, q);
    steps.push({ epsilon: v >> 11, mu: v & 0x7ff });
  }
  return { style, guard, steps };
}

// --- Tiles, components, resolutions, precincts, code-blocks -------------------------------------

function decodeTiles(ctx) {
  const siz = ctx.siz;
  const nc = siz.components.length;
  const width = siz.xsiz - siz.xosiz;
  const height = siz.ysiz - siz.yosiz;
  const numXTiles = Math.ceil((siz.xsiz - siz.xtosiz) / siz.xtsiz);
  const numYTiles = Math.ceil((siz.ysiz - siz.ytosiz) / siz.ytsiz);
  // Each component's whole image.
  const comps = siz.components.map((c) => {
    const x0 = Math.ceil(siz.xosiz / c.xrsiz);
    const y0 = Math.ceil(siz.yosiz / c.yrsiz);
    const w = Math.ceil(siz.xsiz / c.xrsiz) - x0;
    const h = Math.ceil(siz.ysiz / c.yrsiz) - y0;
    return { ...c, x0, y0, w, h, samples: new Float32Array(Math.max(0, w * h)) };
  });
  const ppm = ctx.ppm.length ? concat(ctx.ppm) : null;
  let ppmPos = 0;
  for (let ty = 0; ty < numYTiles; ty++) {
    for (let tx = 0; tx < numXTiles; tx++) {
      const index = ty * numXTiles + tx;
      const t = ctx.tiles[index];
      if (!t) continue;
      const tx0 = Math.max(siz.xtosiz + tx * siz.xtsiz, siz.xosiz);
      const ty0 = Math.max(siz.ytosiz + ty * siz.ytsiz, siz.yosiz);
      const tx1 = Math.min(siz.xtosiz + (tx + 1) * siz.xtsiz, siz.xsiz);
      const ty1 = Math.min(siz.ytosiz + (ty + 1) * siz.ytsiz, siz.ysiz);
      const cod = { ...ctx.cod, ...(t.cod ?? {}) };
      const tileComps = siz.components.map((c, ci) => {
        const ccod = { ...cod, ...(ctx.coc[ci] ?? {}), ...(t.coc?.[ci] ?? {}) };
        const qcd = t.qcc?.[ci] ?? t.qcd ?? ctx.qcc[ci] ?? ctx.qcd;
        const x0 = Math.ceil(tx0 / c.xrsiz);
        const y0 = Math.ceil(ty0 / c.yrsiz);
        const x1 = Math.ceil(tx1 / c.xrsiz);
        const y1 = Math.ceil(ty1 / c.yrsiz);
        return buildComponent(ccod, qcd, x0, y0, x1, y1, c);
      });
      // Packet headers: in the tile's data, or in PPT / PPM markers.
      let headers = null;
      if (t.ppt.length) headers = concat(t.ppt);
      else if (ppm) {
        // PPM holds each tile-part's headers, prefixed by its length.
        const parts = [];
        for (let k = 0; k < t.data.length && ppmPos + 4 <= ppm.length; k++) {
          const n = u32(ppm, ppmPos);
          parts.push(ppm.subarray(ppmPos + 4, ppmPos + 4 + n));
          ppmPos += 4 + n;
        }
        headers = concat(parts);
      }
      const body = concat(t.data);
      try {
        readPackets(tileComps, cod, t.poc ?? ctx.poc, body, headers);
      } catch (e) {
        if (!(e instanceof JpxError) && !(e instanceof RangeError) && !(e instanceof TypeError)) throw e;
        // What was read before the damage is kept.
      }
      // Each component's samples, through the code-blocks, dequantisation and wavelet.
      const results = tileComps.map((tc) => reconstruct(tc));
      // Multiple component transform (G.2, G.3).
      if (cod.mct && nc >= 3) {
        const [a, b, c] = results;
        const n = Math.min(a.data.length, b.data.length, c.data.length);
        if (tileComps[0].reversible) {
          for (let i = 0; i < n; i++) {
            const y = a.data[i];
            const u = b.data[i];
            const v = c.data[i];
            const g = y - Math.floor((u + v) / 4);
            a.data[i] = v + g;
            b.data[i] = g;
            c.data[i] = u + g;
          }
        } else {
          for (let i = 0; i < n; i++) {
            const y = a.data[i];
            const cb = b.data[i];
            const cr = c.data[i];
            a.data[i] = y + 1.402 * cr;
            b.data[i] = y - 0.34413 * cb - 0.71414 * cr;
            c.data[i] = y + 1.772 * cb;
          }
        }
      }
      // DC level shift, then into the component's image.
      results.forEach((r, ci) => {
        const c = comps[ci];
        const shift = c.signed ? 0 : 2 ** (c.precision - 1);
        const tc = tileComps[ci];
        for (let y = 0; y < tc.h; y++) {
          const gy = tc.y0 + y - c.y0;
          if (gy < 0 || gy >= c.h) continue;
          for (let x = 0; x < tc.w; x++) {
            const gx = tc.x0 + x - c.x0;
            if (gx < 0 || gx >= c.w) continue;
            c.samples[gy * c.w + gx] = r.data[y * tc.w + x] + shift;
          }
        }
      });
    }
  }
  return { width, height, comps };
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A tile-component's resolutions, subbands and code-blocks (B.5 to B.7).
function buildComponent(cod, qcd, x0, y0, x1, y1, comp) {
  const levels = cod.levels;
  const tc = { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, levels, reversible: cod.reversible, cod, qcd, comp, resolutions: [] };
  for (let r = 0; r <= levels; r++) {
    const scale = 2 ** (levels - r);
    const rx0 = Math.ceil(x0 / scale);
    const ry0 = Math.ceil(y0 / scale);
    const rx1 = Math.ceil(x1 / scale);
    const ry1 = Math.ceil(y1 / scale);
    const { ppx, ppy } = cod.precincts[r] ?? { ppx: 15, ppy: 15 };
    const res = { r, x0: rx0, y0: ry0, x1: rx1, y1: ry1, ppx, ppy, subbands: [] };
    // Precinct counts.
    res.px0 = Math.floor(rx0 / 2 ** ppx);
    res.py0 = Math.floor(ry0 / 2 ** ppy);
    res.npx = rx1 > rx0 ? Math.ceil(rx1 / 2 ** ppx) - res.px0 : 0;
    res.npy = ry1 > ry0 ? Math.ceil(ry1 / 2 ** ppy) - res.py0 : 0;
    // Code-block size within this resolution's precincts.
    const xcb = r === 0 ? Math.min(cod.xcb, ppx) : Math.min(cod.xcb, ppx - 1);
    const ycb = r === 0 ? Math.min(cod.ycb, ppy) : Math.min(cod.ycb, ppy - 1);
    const bands = r === 0 ? [{ type: 'LL', xo: 0, yo: 0 }] : [{ type: 'HL', xo: 1, yo: 0 }, { type: 'LH', xo: 0, yo: 1 }, { type: 'HH', xo: 1, yo: 1 }];
    for (const b of bands) {
      const n = r === 0 ? levels : levels - r + 1;
      const s = 2 ** n;
      const bx0 = Math.ceil((x0 - (s / 2) * b.xo) / s);
      const by0 = Math.ceil((y0 - (s / 2) * b.yo) / s);
      const bx1 = Math.ceil((x1 - (s / 2) * b.xo) / s);
      const by1 = Math.ceil((y1 - (s / 2) * b.yo) / s);
      const band = { type: b.type, x0: bx0, y0: by0, x1: bx1, y1: by1, w: bx1 - bx0, h: by1 - by0, xcb, ycb, blocks: [], level: n, index: r === 0 ? 0 : 3 * (r - 1) + bands.indexOf(b) + 1 };
      res.subbands.push(band);
    }
    tc.resolutions.push(res);
  }
  // Each precinct's code-blocks, by subband: a code-block belongs to the precinct its origin falls in.
  for (const res of tc.resolutions) {
    res.precincts = [];
    for (let k = 0; k < res.npx * res.npy; k++) res.precincts.push({ index: k, bands: res.subbands.map(() => ({ blocks: [], cbw: 0, cbh: 0 })) });
    const shift = res.r === 0 ? 0 : 1;
    res.subbands.forEach((band, bi) => {
      if (band.w <= 0 || band.h <= 0) return;
      const cw = 2 ** band.xcb;
      const ch = 2 ** band.ycb;
      const cbx0 = Math.floor(band.x0 / cw);
      const cby0 = Math.floor(band.y0 / ch);
      const cbx1 = Math.ceil(band.x1 / cw);
      const cby1 = Math.ceil(band.y1 / ch);
      for (let j = cby0; j < cby1; j++) {
        for (let i = cbx0; i < cbx1; i++) {
          const blk = {
            x0: Math.max(band.x0, i * cw), y0: Math.max(band.y0, j * ch),
            x1: Math.min(band.x1, (i + 1) * cw), y1: Math.min(band.y1, (j + 1) * ch),
            included: false, zeroBitPlanes: 0, lblock: 3, passes: 0, segments: [], data: [],
          };
          // The precinct: by the code-block's position in the resolution's grid.
          const px = Math.floor((i * cw) / 2 ** (res.ppx - shift)) - res.px0;
          const py = Math.floor((j * ch) / 2 ** (res.ppy - shift)) - res.py0;
          const prec = res.precincts[py * res.npx + px];
          if (!prec) continue;
          const pb = prec.bands[bi];
          pb.blocks.push(blk);
          blk.cx = i;
          blk.cy = j;
          band.blocks.push(blk);
        }
      }
    });
    // Each precinct's block grid, for the tag trees.
    for (const prec of res.precincts) {
      prec.bands.forEach((pb) => {
        if (!pb.blocks.length) return;
        const xs = pb.blocks.map((b) => b.cx);
        const ys = pb.blocks.map((b) => b.cy);
        pb.gx0 = Math.min(...xs);
        pb.gy0 = Math.min(...ys);
        pb.cbw = Math.max(...xs) - pb.gx0 + 1;
        pb.cbh = Math.max(...ys) - pb.gy0 + 1;
        pb.inclusion = new TagTree(pb.cbw, pb.cbh);
        pb.zeros = new TagTree(pb.cbw, pb.cbh);
      });
    }
  }
  return tc;
}

// A tag tree (B.10.2), decoded as the standard describes (and OpenJPEG implements): each node a
// lower bound and, once known, its value.
class TagTree {
  constructor(w, h) {
    this.levels = [];
    for (;;) {
      this.levels.push({ w, low: new Int32Array(w * h), value: new Int32Array(w * h).fill(0x7fffffff) });
      if (w <= 1 && h <= 1) break;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
  }
  // Whether leaf (x, y)'s value is below `threshold`, reading what's needed to tell.
  decode(bits, x, y, threshold) {
    let low = 0;
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const lv = this.levels[l];
      const k = (y >> l) * lv.w + (x >> l);
      if (low > lv.low[k]) lv.low[k] = low;
      else low = lv.low[k];
      while (low < threshold && low < lv.value[k]) {
        if (bits.readBit()) lv.value[k] = low;
        else low++;
      }
      lv.low[k] = low;
    }
    const leaf = this.levels[0];
    return leaf.value[y * leaf.w + x] < threshold;
  }
  value(x, y) {
    const leaf = this.levels[0];
    return leaf.value[y * leaf.w + x];
  }
}

class HeaderBits {
  constructor(data, pos = 0) {
    this.data = data;
    this.pos = pos;
    this.bit = 0;
    this.byte = 0;
    this.stuffed = false;
  }
  readBit() {
    if (this.bit === 0) {
      if (this.pos >= this.data.length) throw new JpxError('end of packet headers');
      // After an 0xFF byte, the next carries 7 bits (bit stuffing).
      this.byte = this.data[this.pos++];
      this.bit = this.stuffed ? 7 : 8;
      this.stuffed = this.byte === 0xff;
    }
    this.bit--;
    return (this.byte >> this.bit) & 1;
  }
  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }
  // The header's end: a header ending in 0xFF is followed by a stuffed byte, passed over.
  align() {
    this.bit = 0;
    if (this.stuffed) this.pos++;
    this.stuffed = false;
  }
}

// The order packets come in (B.12): [component, resolution, precinct, layer] tuples.
function* packetOrder(tcs, cod, poc) {
  const layers = cod.layers || 1;
  const maxRes = Math.max(...tcs.map((t) => t.levels)) + 1;
  const progressions = poc?.length ? poc.map((c) => ({ ...c })) : [{ rs: 0, cs: 0, lye: layers, re: maxRes, ce: tcs.length, order: cod.order }];
  const seen = new Set();
  for (const pg of progressions) {
    const ce = Math.min(pg.ce, tcs.length);
    const re = Math.min(pg.re, maxRes);
    const lye = Math.min(pg.lye, layers);
    const emit = function* (c, r, p, l) {
      const key = `${c}/${r}/${p}/${l}`;
      if (seen.has(key)) return;
      const res = tcs[c].resolutions[r];
      if (!res || p >= res.npx * res.npy) return;
      seen.add(key);
      yield [c, r, p, l];
    };
    const precinctsOf = (c, r) => {
      const res = tcs[c].resolutions[r];
      return res ? res.npx * res.npy : 0;
    };
    switch (pg.order) {
      case 0: // LRCP
        for (let l = 0; l < lye; l++) for (let r = pg.rs; r < re; r++) for (let c = pg.cs; c < ce; c++) for (let p = 0; p < precinctsOf(c, r); p++) yield* emit(c, r, p, l);
        break;
      case 1: // RLCP
        for (let r = pg.rs; r < re; r++) for (let l = 0; l < lye; l++) for (let c = pg.cs; c < ce; c++) for (let p = 0; p < precinctsOf(c, r); p++) yield* emit(c, r, p, l);
        break;
      case 2: // RPCL: by resolution, then position (the precincts' places on the canvas)
      case 3: // PCRL
      case 4: {
        // CPRL
        const items = [];
        for (let c = pg.cs; c < ce; c++) {
          const tc = tcs[c];
          for (let r = pg.rs; r < re && r <= tc.levels; r++) {
            const res = tc.resolutions[r];
            const scale = 2 ** (tc.levels - r);
            for (let p = 0; p < res.npx * res.npy; p++) {
              const px = (p % res.npx) + res.px0;
              const py = Math.floor(p / res.npx) + res.py0;
              // The precinct's place on the reference grid.
              const gx = Math.max(px * 2 ** res.ppx * scale * tc.comp.xrsiz, tc.x0 * tc.comp.xrsiz);
              const gy = Math.max(py * 2 ** res.ppy * scale * tc.comp.yrsiz, tc.y0 * tc.comp.yrsiz);
              items.push({ c, r, p, gx, gy });
            }
          }
        }
        const cmp =
          pg.order === 2 ? (a, b) => a.r - b.r || a.gy - b.gy || a.gx - b.gx || a.c - b.c :
          pg.order === 3 ? (a, b) => a.gy - b.gy || a.gx - b.gx || a.c - b.c || a.r - b.r :
          (a, b) => a.c - b.c || a.gy - b.gy || a.gx - b.gx || a.r - b.r;
        items.sort(cmp);
        for (const it of items) for (let l = 0; l < lye; l++) yield* emit(it.c, it.r, it.p, l);
        break;
      }
      default:
        throw new JpxError(`unknown progression order ${pg.order}`);
    }
  }
}

function readPackets(tcs, cod, poc, body, headers) {
  let pos = 0;
  const hb = headers ? new HeaderBits(headers) : null;
  for (const [c, r, p, l] of packetOrder(tcs, cod, poc)) {
    if (pos >= body.length && !hb) break;
    const tc = tcs[c];
    const res = tc.resolutions[r];
    const prec = res.precincts[p];
    // An SOP marker before the packet.
    if (cod.sop && body[pos] === 0xff && body[pos + 1] === 0x91) pos += 6;
    const bits = hb ?? new HeaderBits(body, pos);
    const contributions = [];
    const present = bits.readBit();
    if (present) {
      prec.bands.forEach((pb) => {
        for (const blk of pb.blocks) {
          const bx = blk.cx - pb.gx0;
          const by = blk.cy - pb.gy0;
          let include;
          if (!blk.included) {
            include = pb.inclusion.decode(bits, bx, by, l + 1);
            if (include) {
              let i = 0;
              while (!pb.zeros.decode(bits, bx, by, i)) i++;
              blk.zeroBitPlanes = i - 1;
            }
          } else include = bits.readBit() === 1;
          if (!include) continue;
          blk.included = true;
          // Number of coding passes (B.10.6).
          let passes;
          if (!bits.readBit()) passes = 1;
          else if (!bits.readBit()) passes = 2;
          else {
            const v = bits.readBits(2);
            if (v < 3) passes = 3 + v;
            else {
              const w = bits.readBits(5);
              passes = w < 31 ? 6 + w : 37 + bits.readBits(7);
            }
          }
          // Lblock increments (B.10.7).
          while (bits.readBit()) blk.lblock++;
          const style = tc.cod.style;
          // Lengths: one per codeword segment the new passes fall in.
          const segs = splitPasses(blk.passes, passes, style);
          const lens = segs.map((n) => bits.readBits(blk.lblock + (31 - Math.clz32(n))));
          contributions.push({ blk, segs, lens, first: blk.passes });
          blk.passes += passes;
        }
      });
    }
    if (hb) hb.align();
    else {
      bits.align();
      pos = bits.pos;
    }
    // An EPH marker after the header.
    if (cod.eph && !hb && body[pos] === 0xff && body[pos + 1] === 0x92) pos += 2;
    if (cod.eph && hb && headers[hb.pos] === 0xff && headers[hb.pos + 1] === 0x92) hb.pos += 2;
    for (const { blk, segs, lens, first } of contributions) {
      let passIndex = first;
      const style = tc.cod.style;
      segs.forEach((n, i) => {
        const len = lens[i];
        // Joined to the codeword segment it continues (a segment can span layers).
        const id = segmentOf(passIndex, style);
        const last = blk.data[blk.data.length - 1];
        if (last && last.id === id) {
          last.chunks.push(body.subarray(pos, pos + len));
          last.passes += n;
        } else blk.data.push({ id, start: passIndex, chunks: [body.subarray(pos, pos + len)], passes: n });
        passIndex += n;
        pos += len;
      });
    }
  }
}

// The codeword segment a pass belongs to: one for all, unless every pass is terminated, or in
// bypass mode, where after the first ten each bit-plane has a raw segment and a cleanup one.
function segmentOf(pass, style) {
  if (style.termall) return pass;
  if (!style.bypass || pass < 10) return 0;
  const k = pass - 10;
  return 1 + Math.floor(k / 3) * 2 + (k % 3 === 2 ? 1 : 0);
}

// How `count` new passes, after `done` earlier ones, split into codeword segments (for lengths):
// one, unless the code-block terminates every pass, or uses the bypass (lazy) mode.
function splitPasses(done, count, style) {
  if (style.termall) return new Array(count).fill(1);
  if (!style.bypass) return [count];
  const out = [];
  let k = done;
  let left = count;
  while (left > 0) {
    // Passes 0 to 9 (the first ten) are one segment; after that, each cleanup pass is followed by a
    // raw segment of two passes (significance and refinement), then the cleanup pass alone.
    let segEnd;
    if (k < 10) segEnd = 10;
    else {
      const phase = (k - 10) % 3;
      segEnd = phase === 0 ? k + 2 : phase === 1 ? k + 1 : k + 1;
    }
    const n = Math.min(left, segEnd - k);
    out.push(n);
    k += n;
    left -= n;
  }
  return out;
}

// --- Code-block decoding (Annex D) ----------------------------------------------------------------

// Significance contexts by neighbour counts (Table D.1): for LL and LH, HL (transposed), HH.
function sigContext(band, h, v, d) {
  if (band === 'HL') [h, v] = [v, h];
  if (band === 'HH') {
    const hv = h + v;
    if (d >= 3) return 8;
    if (d === 2) return hv >= 1 ? 7 : 6;
    if (d === 1) return hv >= 2 ? 5 : hv === 1 ? 4 : 3;
    return hv >= 2 ? 2 : hv === 1 ? 1 : 0;
  }
  if (h === 2) return 8;
  if (h === 1) return v >= 1 ? 7 : d >= 1 ? 6 : 5;
  if (v === 2) return 4;
  if (v === 1) return 3;
  return d >= 2 ? 2 : d === 1 ? 1 : 0;
}

const UNIFORM = 18;
const RUNLENGTH = 17;

function decodeBlock(blk, band, style, totalBitPlanes) {
  const w = blk.x1 - blk.x0;
  const h = blk.y1 - blk.y0;
  const coeffs = new Int32Array(w * h);
  if (!blk.data.length || w <= 0 || h <= 0) return { coeffs, w, h, bitplanes: 0 };
  const totalPasses = blk.data.reduce((a, s) => a + s.passes, 0);
  const sig = new Uint8Array(w * h);
  const sign = new Uint8Array(w * h);
  const refined = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const magnitude = new Int32Array(w * h);
  const sigPlane = new Int8Array(w * h).fill(-1);
  const cx = new Uint8Array(19);
  const resetContexts = () => {
    cx.fill(0);
    cx[0] = 4 << 1; // context 0 starts at state 4
    cx[RUNLENGTH] = 3 << 1;
    cx[UNIFORM] = 46 << 1;
  };
  resetContexts();
  // Segment boundaries (where the decoder restarts): by pass, from the data's segments.
  const segStarts = blk.data.map((seg) => {
    const bytes = concat(seg.chunks);
    return { pass: seg.start, bytes };
  });
  let bitplane = totalBitPlanes - 1 - blk.zeroBitPlanes;
  if (bitplane < 0) return { coeffs, w, h, bitplanes: 0 };
  let dec = null;
  let raw = null;
  // Each segment of the code-block data is decoded with its own decoder (MQ, or raw for bypass).
  const segIndexForPass = (p) => {
    let k = 0;
    for (let i = 0; i < segStarts.length; i++) if (segStarts[i].pass <= p) k = i;
    return k;
  };
  let curSeg = -1;
  const isRawPass = (p) => style.bypass && p >= 10 && (p - 10) % 3 !== 2;
  const neighbours = (x, y) => {
    let hc = 0;
    let vc = 0;
    let dc = 0;
    const s = (xx, yy) => (xx >= 0 && xx < w && yy >= 0 && yy < h ? sig[yy * w + xx] : 0);
    hc = s(x - 1, y) + s(x + 1, y);
    // Vertically causal: the stripe below isn't looked at.
    const below = !(style.causal && (y & 3) === 3);
    vc = s(x, y - 1) + (below ? s(x, y + 1) : 0);
    dc = s(x - 1, y - 1) + s(x + 1, y - 1) + (below ? s(x - 1, y + 1) + s(x + 1, y + 1) : 0);
    return [hc, vc, dc];
  };
  const decodeSign = (x, y) => {
    // Sign context (Table D.3).
    const at = (xx, yy) => {
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) return 0;
      if (yy === y + 1 && style.causal && (y & 3) === 3) return 0;
      const k = yy * w + xx;
      return sig[k] ? (sign[k] ? -1 : 1) : 0;
    };
    const hc = Math.max(-1, Math.min(1, at(x - 1, y) + at(x + 1, y)));
    const vc = Math.max(-1, Math.min(1, at(x, y - 1) + at(x, y + 1)));
    const table = { '1,1': [13, 0], '1,0': [12, 0], '1,-1': [11, 0], '0,1': [10, 0], '0,0': [9, 0], '0,-1': [10, 1], '-1,1': [11, 1], '-1,0': [12, 1], '-1,-1': [13, 1] };
    const [ctxIndex, xorBit] = table[`${hc},${vc}`];
    return readBit(ctxIndex) ^ xorBit;
  };
  const readBit = (ctxIndex) => (raw ? raw.read() : dec.readBit(cx, ctxIndex));
  const setSignificant = (k, x, y) => {
    sig[k] = 1;
    sigPlane[k] = bitplane;
    sign[k] = decodeSign(x, y);
    magnitude[k] |= 1 << bitplane;
  };
  let passType = 2; // starts with a cleanup pass
  for (let p = 0; p < totalPasses && bitplane >= 0; p++) {
    const segIndex = segIndexForPass(p);
    if (segIndex !== curSeg) {
      curSeg = segIndex;
      const seg = segStarts[segIndex];
      if (isRawPass(p)) raw = new RawBits(seg.bytes, 0, seg.bytes.length);
      else {
        raw = null;
        dec = new ArithmeticDecoder(seg.bytes, 0, seg.bytes.length);
      }
    }

    if (passType === 0) {
      // Significance propagation.
      visited.fill(0);
      for (let sy = 0; sy < h; sy += 4) {
        for (let x = 0; x < w; x++) {
          for (let y = sy; y < Math.min(sy + 4, h); y++) {
            const k = y * w + x;
            if (sig[k]) continue;
            const [hc, vc, dc] = neighbours(x, y);
            if (hc + vc + dc === 0) continue;
            visited[k] = 1;
            if (readBit(sigContext(band, hc, vc, dc))) setSignificant(k, x, y);
          }
        }
      }
    } else if (passType === 1) {
      // Magnitude refinement.
      for (let sy = 0; sy < h; sy += 4) {
        for (let x = 0; x < w; x++) {
          for (let y = sy; y < Math.min(sy + 4, h); y++) {
            const k = y * w + x;
            // Only what was significant before this bit-plane.
            if (!sig[k] || sigPlane[k] === bitplane) continue;
            let context;
            if (refined[k]) context = 16;
            else {
              const [hc, vc, dc] = neighbours(x, y);
              context = hc + vc + dc > 0 ? 15 : 14;
            }
            if (readBit(context)) magnitude[k] |= 1 << bitplane;
            refined[k] = 1;
          }
        }
      }
    } else {
      // Cleanup.
      for (let sy = 0; sy < h; sy += 4) {
        for (let x = 0; x < w; x++) {
          let y = sy;
          const stripeEnd = Math.min(sy + 4, h);
          // Run-length mode: a full stripe column with nothing significant round it.
          if (stripeEnd - sy === 4) {
            let allClear = true;
            for (let yy = sy; yy < stripeEnd && allClear; yy++) {
              const k = yy * w + x;
              if (sig[k] || visited[k]) allClear = false;
              else {
                const [hc, vc, dc] = neighbours(x, yy);
                if (hc + vc + dc) allClear = false;
              }
            }
            if (allClear) {
              if (!readBit(RUNLENGTH)) continue;
              const pos = (readBit(UNIFORM) << 1) | readBit(UNIFORM);
              y = sy + pos;
              const k = y * w + x;
              setSignificant(k, x, y);
              y++;
            }
          }
          for (; y < stripeEnd; y++) {
            const k = y * w + x;
            if (sig[k] || visited[k]) continue;
            const [hc, vc, dc] = neighbours(x, y);
            if (readBit(sigContext(band, hc, vc, dc))) setSignificant(k, x, y);
          }
        }
      }
      // Segmentation symbol (1010) after each cleanup pass.
      if (style.segsym) {
        readBit(UNIFORM);
        readBit(UNIFORM);
        readBit(UNIFORM);
        readBit(UNIFORM);
      }
      visited.fill(0);
    }
    // Contexts reset after each pass (RESET style).
    if (style.reset) resetContexts();
    passType = (passType + 1) % 3;
    if (passType === 0) bitplane--;
  }
  // The coefficients: magnitude with its sign, the half-step added where the decoding stopped
  // short of the last bit-plane (reconstruction at the middle of the interval).
  const lowest = bitplane + 1;
  for (let k = 0; k < w * h; k++) {
    if (!sig[k]) continue;
    let m = magnitude[k];
    if (lowest > 0) m += 1 << (lowest - 1);
    coeffs[k] = sign[k] ? -m : m;
  }
  return { coeffs, w, h, bitplanes: lowest };
}

class RawBits {
  constructor(data, start, end) {
    this.data = data;
    this.pos = start;
    this.end = end;
    this.bit = 0;
    this.byte = 0;
    this.prevFF = false;
  }
  read() {
    if (this.bit === 0) {
      this.byte = this.pos < this.end ? this.data[this.pos++] : 0xff;
      this.bit = this.prevFF ? 7 : 8;
      this.prevFF = this.byte === 0xff;
    }
    this.bit--;
    return (this.byte >> this.bit) & 1;
  }
}

// --- Reconstruction: dequantisation and the inverse wavelet ---------------------------------------

function reconstruct(tc) {
  const { levels, reversible, qcd, comp, cod } = tc;
  const precision = comp.precision;
  const guard = qcd.guard;
  // Each subband's coefficients, dequantised (E.1).
  const bandData = new Map();
  for (const res of tc.resolutions) {
    for (const band of res.subbands) {
      const out = new Float32Array(Math.max(0, band.w * band.h));
      const gain = band.type === 'LL' ? 0 : band.type === 'HH' ? 2 : 1;
      const step = qcd.style === 1 ? derivedStep(qcd.steps[0], levels, band) : qcd.steps[band.index] ?? qcd.steps[qcd.steps.length - 1] ?? { epsilon: precision, mu: 0 };
      const rb = precision + gain;
      const totalBitPlanes = guard + step.epsilon - 1;
      const delta = reversible ? 1 : 2 ** (rb - step.epsilon) * (1 + step.mu / 2048);
      for (const blk of band.blocks) {
        const { coeffs, w, h } = decodeBlock(blk, band.type, cod.style, totalBitPlanes);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let v = coeffs[y * w + x];
            if (!v) continue;
            const o = (blk.y0 - band.y0 + y) * band.w + (blk.x0 - band.x0 + x);
            // Coefficients carry one extra fractional bit from decodeBlock's half-step.
            out[o] = reversible ? (v > 0 ? Math.floor(v) : Math.ceil(v)) : v * delta;
          }
        }
        void totalBitPlanes;
      }
      bandData.set(band, out);
    }
  }
  // The inverse transform, level by level (F.3).
  const ll = tc.resolutions[0].subbands[0];
  let cur = { data: bandData.get(ll), x0: ll.x0, y0: ll.y0, w: ll.w, h: ll.h };
  for (let r = 1; r <= levels; r++) {
    const res = tc.resolutions[r];
    const [hl, lh, hh] = res.subbands;
    const w = res.x1 - res.x0;
    const h = res.y1 - res.y0;
    const out = new Float32Array(Math.max(0, w * h));
    // Interleave (F.3.3): LL at even, HL at odd columns, LH at odd rows, HH at both (relative to
    // the resolution's origin parity).
    const place = (src, sw, sh, ox, oy) => {
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const xx = 2 * x + ox;
          const yy = 2 * y + oy;
          if (xx < w && yy < h) out[yy * w + xx] = src[y * sw + x];
        }
      }
    };
    const ex = res.x0 & 1;
    const ey = res.y0 & 1;
    place(cur.data, cur.w, cur.h, ex, ey);
    place(bandData.get(hl), hl.w, hl.h, 1 - ex, ey);
    place(bandData.get(lh), lh.w, lh.h, ex, 1 - ey);
    place(bandData.get(hh), hh.w, hh.h, 1 - ex, 1 - ey);
    // Rows, then columns (2D_SR, F.3.2).
    const row = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) row[x] = out[y * w + x];
      synth1D(row, w, res.x0, reversible);
      for (let x = 0; x < w; x++) out[y * w + x] = row[x];
    }
    const col = new Float32Array(h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) col[y] = out[y * w + x];
      synth1D(col, h, res.y0, reversible);
      for (let y = 0; y < h; y++) out[y * w + x] = col[y];
    }
    cur = { data: out, x0: res.x0, y0: res.y0, w, h };
  }
  return { data: cur.data, w: cur.w, h: cur.h };
}

function derivedStep(base, levels, band) {
  // Derived quantisation (E.1.1.1): exponents from the LL band's, by decomposition level.
  const nb = band.type === 'LL' ? levels : band.level;
  return { epsilon: base.epsilon - levels + nb, mu: base.mu };
}

// One-dimensional synthesis (F.3.8), in place, of `n` samples starting at index parity `start`.
function synth1D(x, n, start, reversible) {
  if (n === 1) {
    if (start & 1) x[0] /= 2;
    return;
  }
  // Symmetric extension: index i outside [0, n) mirrors.
  const i0 = start & 1;
  const get = (i) => {
    if (i < 0) i = -i;
    const period = 2 * (n - 1);
    i %= period;
    if (i >= n) i = period - i;
    return x[i];
  };
  // Work on a padded copy so the lifting steps can read across the ends.
  const pad = 4;
  const y = new Float64Array(n + 2 * pad);
  for (let i = -pad; i < n + pad; i++) y[i + pad] = get(i);
  const at = (i) => i + pad;
  // Sample i is low-pass when (i + i0) is even.
  const isEven = (i) => ((i + i0) & 1) === 0;
  if (reversible) {
    // 5/3: x[2n] -= floor((x[2n-1] + x[2n+1] + 2) / 4); x[2n+1] += floor((x[2n] + x[2n+2]) / 2).
    for (let i = -pad + 1; i < n + pad - 1; i++) if (isEven(i)) y[at(i)] -= Math.floor((y[at(i - 1)] + y[at(i + 1)] + 2) / 4);
    for (let i = -pad + 1; i < n + pad - 1; i++) if (!isEven(i)) y[at(i)] += Math.floor((y[at(i - 1)] + y[at(i + 1)]) / 2);
  } else {
    const alpha = -1.586134342059924;
    const beta = -0.052980118572961;
    const gamma = 0.882911075530934;
    const delta = 0.443506852043971;
    const K = 1.230174104914001;
    for (let i = -pad; i < n + pad; i++) y[at(i)] *= isEven(i) ? K : 1 / K;
    for (let i = -pad + 1; i < n + pad - 1; i++) if (isEven(i)) y[at(i)] -= delta * (y[at(i - 1)] + y[at(i + 1)]);
    for (let i = -pad + 1; i < n + pad - 1; i++) if (!isEven(i)) y[at(i)] -= gamma * (y[at(i - 1)] + y[at(i + 1)]);
    for (let i = -pad + 1; i < n + pad - 1; i++) if (isEven(i)) y[at(i)] -= beta * (y[at(i - 1)] + y[at(i + 1)]);
    for (let i = -pad + 1; i < n + pad - 1; i++) if (!isEven(i)) y[at(i)] -= alpha * (y[at(i - 1)] + y[at(i + 1)]);
  }
  for (let i = 0; i < n; i++) x[i] = y[at(i)];
}

// --- To 8-bit samples -------------------------------------------------------------------------------

function toSamples(image, info, smaskInData) {
  const { comps } = image;
  // Components may be subsampled: each sample at full resolution takes its component's nearest.
  const width = comps[0].w * comps[0].xrsiz;
  const height = comps[0].h * comps[0].yrsiz;
  let channels = comps.map((c) => {
    const out = new Uint8ClampedArray(width * height);
    const max = 2 ** c.precision - 1;
    const scale = 255 / max;
    for (let y = 0; y < height; y++) {
      const sy = Math.min(c.h - 1, Math.floor(y / c.yrsiz));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(c.w - 1, Math.floor(x / c.xrsiz));
        let v = c.samples[sy * c.w + sx];
        if (c.signed) v += 2 ** (c.precision - 1);
        out[y * width + x] = Math.round(Math.max(0, Math.min(max, v)) * scale);
      }
    }
    return out;
  });
  // A palette: the index channel through it.
  if (info.palette) {
    const idx = channels[0];
    const map = info.channelMap ?? info.palette.table[0].map((_, i) => ({ component: 0, type: 1, column: i }));
    const raw = comps[0];
    const pal = [];
    for (const m of map) {
      if (m.type !== 1) {
        pal.push(channels[m.component]);
        continue;
      }
      const out = new Uint8ClampedArray(width * height);
      for (let i = 0; i < width * height; i++) {
        const y = Math.floor(i / width);
        const x = i % width;
        const v = raw.samples[Math.min(raw.h - 1, Math.floor(y / raw.yrsiz)) * raw.w + Math.min(raw.w - 1, Math.floor(x / raw.xrsiz))];
        out[i] = info.palette.table[Math.max(0, Math.min(info.palette.table.length - 1, Math.round(v)))]?.[m.column] ?? 0;
      }
      pal.push(out);
    }
    channels = pal;
    void idx;
  }
  let alpha = null;
  if (info.channelDefs) {
    const opacity = info.channelDefs.find((d) => d.type === 1 || d.type === 2);
    if (opacity && opacity.channel < channels.length) alpha = opacity.channel;
  } else if (smaskInData && (channels.length === 2 || channels.length === 4)) {
    // Gray or RGB with one more channel and no definitions: the last is opacity.
    alpha = channels.length - 1;
  }
  const colorChannels = channels.filter((_, i) => i !== alpha || !smaskInData);
  const n = alpha !== null && !smaskInData ? channels.length : colorChannels.length;
  const used = alpha !== null && !smaskInData ? channels : colorChannels;
  const data = new Uint8ClampedArray(width * height * n);
  for (let i = 0; i < width * height; i++) for (let k = 0; k < n; k++) data[i * n + k] = used[k][i];
  return { width, height, components: n, data, alpha: alpha !== null ? channels[alpha] : null, colorSpace: info.colorSpace };
}
