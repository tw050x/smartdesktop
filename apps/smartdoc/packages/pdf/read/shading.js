// Shadings a canvas gradient can't draw (PDF 32000-1 8.7.4.5): function-based (type 1), and the
// meshes: free-form and lattice triangles (4, 5), Coons and tensor-product patches (6, 7), the
// patches cut into triangles. Each is rasterised into device pixels, colours interpolated across
// each triangle (through the shading's function, if it has one, on the interpolated parameter).

import { makeColorSpace } from './colorspace.js';
import { decodeStream } from './filters.js';
import { makeFunction } from './function.js';
import { makeCanvas } from './image.js';
import { Dict, Stream } from './objects.js';

const num = (doc, v) => {
  const x = doc.fetchIfRef(v);
  return typeof x === 'number' ? x : null;
};

// A canvas `width` × `height` with the shading drawn on it, `toDevice` taking the shading's space to
// the canvas's pixels; null if the shading can't be drawn.
export function shadingCanvas(doc, shading, toDevice, width, height, resources) {
  const dict = shading instanceof Stream ? shading.dict : shading;
  if (!(dict instanceof Dict)) return null;
  const type = dict.get('ShadingType');
  const space = makeColorSpace(doc, dict.get('ColorSpace'), resources);
  const fnValue = dict.get('Function');
  const fn = fnValue ? makeFunction(doc, fnValue) : null;
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const image = new ImageData(w, h);
  const rgb = (c) => space.rgb(fn ? fn(c) : c);
  if (type === 1) functionBased(doc, dict, toDevice, image, rgb);
  else if (type >= 4 && type <= 7 && shading instanceof Stream) {
    const triangles = mesh(doc, shading, type, space.n, fn);
    for (const t of triangles) {
      const pts = t.map(({ x, y, c }) => ({ x: toDevice[0] * x + toDevice[2] * y + toDevice[4], y: toDevice[1] * x + toDevice[3] * y + toDevice[5], c }));
      fillTriangle(image, pts, rgb);
    }
  } else return null;
  const canvas = makeCanvas(w, h);
  canvas.getContext('2d').putImageData(image, 0, 0);
  return canvas;
}

function functionBased(doc, dict, toDevice, image, rgb) {
  const domain = (dict.get('Domain') ?? [0, 1, 0, 1]).map((v) => doc.fetchIfRef(v));
  const m = dict.get('Matrix');
  const matrix = Array.isArray(m) && m.length === 6 ? m.map((v) => doc.fetchIfRef(v)) : [1, 0, 0, 1, 0, 0];
  const t = mul(toDevice, matrix);
  const det = t[0] * t[3] - t[1] * t[2];
  if (!det) return;
  const inv = [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det];
  const { width, height, data } = image;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const u = inv[0] * px + inv[2] * py + inv[4];
      const v = inv[1] * px + inv[3] * py + inv[5];
      if (u < domain[0] || u > domain[1] || v < domain[2] || v > domain[3]) continue;
      const [r, g, b] = rgb([u, v]);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
}

const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

// The mesh's triangles, each three { x, y, c } (c the colour components, or the function's input).
function mesh(doc, stream, type, nComps, fn) {
  const dict = stream.dict;
  const bpc = num(doc, dict.get('BitsPerCoordinate'));
  const bpcomp = num(doc, dict.get('BitsPerComponent'));
  const bpf = num(doc, dict.get('BitsPerFlag')) ?? 8;
  const decode = (dict.get('Decode') ?? []).map((v) => doc.fetchIfRef(v));
  const n = fn ? 1 : nComps;
  const data = decodeStream(stream).data;
  let bit = 0;
  const bits = (count) => {
    let v = 0;
    for (let i = 0; i < count; i++, bit++) v = v * 2 + (((data[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    return v;
  };
  const align = () => {
    bit = (bit + 7) & ~7;
  };
  const more = () => bit + 8 <= data.length * 8;
  const coord = (k) => {
    const v = bits(bpc);
    const max = 2 ** bpc - 1;
    return decode[2 * k] + (v * (decode[2 * k + 1] - decode[2 * k])) / max;
  };
  const color = () => {
    const c = [];
    const max = 2 ** bpcomp - 1;
    for (let k = 0; k < n; k++) c.push(decode[4 + 2 * k] + (bits(bpcomp) * (decode[5 + 2 * k] - decode[4 + 2 * k])) / max);
    return c;
  };
  const vertex = () => ({ x: coord(0), y: coord(1), c: color() });
  const triangles = [];
  if (type === 4) {
    // A flag of 1 or 2 makes a triangle of the last one's second and third (or first and third)
    // vertices and the new one.
    let lastT = null;
    while (more() && triangles.length < 200000) {
      const flag = bits(bpf);
      const v = vertex();
      align();
      if (flag === 0) {
        bits(bpf);
        const v2 = vertex();
        align();
        bits(bpf);
        const v3 = vertex();
        align();
        lastT = [v, v2, v3];
      } else if (lastT) lastT = flag === 1 ? [lastT[1], lastT[2], v] : [lastT[0], lastT[2], v];
      else continue;
      triangles.push(lastT);
    }
  } else if (type === 5) {
    const perRow = num(doc, dict.get('VerticesPerRow')) ?? 2;
    const rows = [];
    let row = [];
    while (more()) {
      row.push(vertex());
      if (row.length === perRow) {
        rows.push(row);
        row = [];
      }
    }
    for (let r = 0; r + 1 < rows.length; r++) {
      for (let i = 0; i + 1 < perRow; i++) {
        const [p, q, s, t] = [rows[r][i], rows[r][i + 1], rows[r + 1][i], rows[r + 1][i + 1]];
        triangles.push([p, q, s], [q, s, t]);
      }
    }
  } else {
    // Coons (16 control points) and tensor (16) patches; a flagged patch shares an edge with the last.
    let last = null;
    const pointCount = type === 6 ? 12 : 16;
    while (more() && triangles.length < 400000) {
      const flag = bits(bpf);
      const pts = [];
      const cs = [];
      const newPts = flag === 0 ? pointCount : pointCount - 4;
      const newCs = flag === 0 ? 4 : 2;
      for (let i = 0; i < newPts; i++) pts.push([coord(0), coord(1)]);
      for (let i = 0; i < newCs; i++) cs.push(color());
      align();
      if (bit > data.length * 8) break;
      let P;
      let C;
      if (flag === 0) {
        P = pts;
        C = cs;
      } else {
        if (!last) break;
        const [lp, lc] = last;
        // The shared edge: the last patch's side, by flag (in the order of the 12 boundary points).
        const edges = { 1: [3, 4, 5, 6], 2: [6, 7, 8, 9], 3: [9, 10, 11, 0] };
        const ecs = { 1: [1, 2], 2: [2, 3], 3: [3, 0] };
        P = [...edges[flag].map((i) => lp[i]), ...pts];
        C = [...ecs[flag].map((i) => lc[i]), ...cs];
      }
      last = [P, C];
      patchTriangles(P, C, type, triangles);
    }
  }
  return triangles;
}

// A patch's 12 boundary points (and a tensor patch's 4 inner ones) as a 4×4 grid of control points.
function grid(P, type) {
  const g = [
    [P[0], P[11], P[10], P[9]],
    [P[1], null, null, P[8]],
    [P[2], null, null, P[7]],
    [P[3], P[4], P[5], P[6]],
  ];
  if (type === 7) {
    g[1][1] = P[12];
    g[2][1] = P[13];
    g[2][2] = P[14];
    g[1][2] = P[15];
  } else {
    // Coons: the inner points from the boundary (PDF 32000-1 8.7.4.5.7's formulas).
    for (const [i, j] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
      const ei = i === 1 ? 0 : 3;
      const ej = j === 1 ? 0 : 3;
      const fi = i === 1 ? 3 : 0;
      const fj = j === 1 ? 3 : 0;
      const pt = [0, 1].map((a) => (-4 * g[ei][ej][a] + 6 * (g[ei][j][a] + g[i][ej][a]) - 2 * (g[ei][fj][a] + g[fi][ej][a]) + 3 * (g[fi][j][a] + g[i][fj][a]) - g[fi][fj][a]) / 9);
      g[i][j] = pt;
    }
  }
  return g;
}

function patchTriangles(P, C, type, out) {
  const g = grid(P, type);
  const bern = (t) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
  const at = (u, v) => {
    const bu = bern(u);
    const bv = bern(v);
    let x = 0;
    let y = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      x += g[i][j][0] * bu[i] * bv[j];
      y += g[i][j][1] * bu[i] * bv[j];
    }
    return [x, y];
  };
  // The corners' colours (at p00, p03, p33, p30), interpolated bilinearly.
  const col = (u, v) => C[0].map((_, k) => (1 - u) * (1 - v) * C[0][k] + u * (1 - v) * C[1][k] + u * v * C[2][k] + (1 - u) * v * C[3][k]);
  const n = 12;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const rowPts = [];
    for (let j = 0; j <= n; j++) {
      const [x, y] = at(i / n, j / n);
      rowPts.push({ x, y, c: col(i / n, j / n) });
    }
    pts.push(rowPts);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([pts[i][j], pts[i][j + 1], pts[i + 1][j]], [pts[i][j + 1], pts[i + 1][j + 1], pts[i + 1][j]]);
}

// Fills a triangle in device pixels, colours interpolated (barycentric) across it.
function fillTriangle(image, [a, b, c], rgb) {
  const { width, height, data } = image;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!det || minX > maxX || minY > maxY) return;
  const cache = new Map();
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / det;
      const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / det;
      const l3 = 1 - l1 - l2;
      const e = -1e-6;
      if (l1 < e || l2 < e || l3 < e) continue;
      const comps = a.c.map((v, k) => l1 * v + l2 * b.c[k] + l3 * c.c[k]);
      const key = comps.map((v) => v.toFixed(3)).join(',');
      let color = cache.get(key);
      if (!color) {
        color = rgb(comps);
        cache.set(key, color);
      }
      const o = (y * width + x) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }
}
