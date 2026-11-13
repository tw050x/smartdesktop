// How close each converted document is to a reference PDF of it (Office's own, when there is one),
// and whether it's at least as close as another converter's PDF of it (LibreOffice's): the fidelity
// bar this package is held to.
//
//   node tools/compare.mjs <documents dir> <reference dir> [--other <dir>] [--out <dir>]
//
// For each document in the folder with a reference PDF of the same name, three measures:
//   pages: how many more or fewer pages than the reference;
//   lines: the share of the reference's lines (per page, by their text with the spaces taken out)
//          found on the same page, broken in the same place, and how far they are from where the
//          reference has them (the mean distance, in points);
//   ink:   the share of the pages' ink (drawn by Apple's PDFKit, so neither converter's own
//          renderer) not within a pixel of ink on the reference's page.
// --other compares another converter's PDFs (same names) with the reference too, and says for each
// document whether ours is at least as close. --out keeps our PDFs and the pages' images there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { convert } from '../index.js';
import { imageInfo } from '../lib/image.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjs = await import(path.join(here, '../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs'));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const otherDir = flag('--other');
const outDir = flag('--out') ?? path.join(tmpdir(), 'smartdoc-pdf-compare');
const [docsDir, refDir] = args;
if (!docsDir || !refDir) {
  console.error('usage: compare.mjs <documents dir> <reference dir> [--other <dir>] [--out <dir>]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// The PDFKit renderer, compiled once.
const renderer = path.join(outDir, 'render');
if (!existsSync(renderer) || statSync(renderer).mtimeMs < statSync(path.join(here, 'render.swift')).mtimeMs) {
  execFileSync('swiftc', ['-O', '-o', renderer, path.join(here, 'render.swift')], { stdio: 'inherit' });
}

const DPI = 72;

// Each page's lines: { text, x, y } from the top, in points, the text without its spaces.
async function linesOf(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const height = page.view[3];
    const rows = new Map();
    for (const item of (await page.getTextContent()).items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(height - item.transform[5]);
      // Items within 2pt of a row's baseline are on it (superscripts aside).
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ x: item.transform[4], str: item.str });
    }
    pages.push(
      [...rows]
        .sort((a, b) => a[0] - b[0])
        .map(([y, items]) => {
          items.sort((a, b) => a.x - b.x);
          return { y, x: items[0].x, text: items.map((i) => i.str).join('').replace(/\s+/g, '') };
        }),
    );
  }
  return pages;
}

function compareLines(ours, ref) {
  let total = 0;
  let found = 0;
  let distance = 0;
  ref.forEach((refLines, p) => {
    const pool = [...(ours[p] ?? [])];
    for (const line of refLines) {
      total++;
      const i = pool.findIndex((l) => l.text === line.text);
      if (i < 0) continue;
      found++;
      distance += Math.hypot(pool[i].x - line.x, pool[i].y - line.y);
      pool.splice(i, 1);
    }
  });
  return { share: total ? found / total : 1, distance: found ? distance / found : 0 };
}

// A page's ink: a mask of its darker pixels.
function inkOf(png) {
  const img = imageInfo(readFileSync(png));
  const n = img.width * img.height;
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = img.colors === 3 ? (img.pixels[3 * i] + img.pixels[3 * i + 1] + img.pixels[3 * i + 2]) / 3 : img.pixels[i];
    const a = img.alpha ? img.alpha[i] / 255 : 1;
    ink[i] = 255 - (255 - v) * a < 160 ? 1 : 0;
  }
  return { width: img.width, height: img.height, ink };
}

// Ink in `a` with no ink within a pixel of it in `b`, both ways, as a share of all the ink.
function inkApart(a, b) {
  let apart = 0;
  let all = 0;
  const near = (img, x, y) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx;
        const Y = y + dy;
        if (X >= 0 && Y >= 0 && X < img.width && Y < img.height && img.ink[Y * img.width + X]) return true;
      }
    return false;
  };
  for (const [from, to] of [[a, b], [b, a]]) {
    if (!from) continue;
    for (let y = 0; y < from.height; y++)
      for (let x = 0; x < from.width; x++) {
        if (!from.ink[y * from.width + x]) continue;
        all++;
        if (!to || !near(to, x, y)) apart++;
      }
  }
  return { apart, all };
}

function render(pdf, prefix) {
  const count = Number(execFileSync(renderer, [pdf, prefix, String(DPI)]).toString().trim());
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}.png`);
}

async function measure(pdfPath, refPath, refLines, refInk, name) {
  const bytes = readFileSync(pdfPath);
  const lines = compareLines(await linesOf(bytes), refLines);
  const pngs = render(pdfPath, path.join(outDir, name));
  let apart = 0;
  let all = 0;
  pngs.forEach((png, i) => {
    const r = inkApart(inkOf(png), refInk[i]);
    apart += r.apart;
    all += r.all;
  });
  // Reference pages with nothing of ours to compare: all their ink is apart.
  for (const ink of refInk.slice(pngs.length)) {
    const r = inkApart(ink, null);
    apart += r.apart;
    all += r.all;
  }
  return { pages: pngs.length - refInk.length, lines: lines.share, distance: lines.distance, ink: all ? apart / all : 0 };
}

const fmt = (m) => `${m.pages >= 0 ? '+' : ''}${m.pages} pages, lines ${(100 * m.lines).toFixed(0)}% (${m.distance.toFixed(1)}pt off), ink ${(100 * m.ink).toFixed(1)}% apart`;
// Ours is at least as close as the other if it's no worse on pages and lines, and its ink is no
// further apart (within half a point, as rendering noise).
const atLeastAsClose = (ours, other) => Math.abs(ours.pages) <= Math.abs(other.pages) && ours.lines >= other.lines - 1e-9 && ours.ink <= other.ink + 0.005;

const results = [];
for (const file of readdirSync(docsDir).sort()) {
  const base = file.replace(/\.[^.]+$/, '');
  const refPath = path.join(refDir, `${base}.pdf`);
  if (file.endsWith('.pdf') || !existsSync(refPath)) continue;
  const { pdf } = await convert(readFileSync(path.join(docsDir, file)), { name: file });
  const oursPath = path.join(outDir, `${base}.ours.pdf`);
  writeFileSync(oursPath, pdf);
  const refLines = await linesOf(readFileSync(refPath));
  const refInk = render(refPath, path.join(outDir, `${base}.ref`)).map(inkOf);
  const ours = await measure(oursPath, refPath, refLines, refInk, `${base}.ours`);
  const row = { file, ours };
  const otherPath = otherDir && path.join(otherDir, `${base}.pdf`);
  if (otherPath && existsSync(otherPath)) {
    row.other = await measure(otherPath, refPath, refLines, refInk, `${base}.other`);
    row.pass = atLeastAsClose(ours, row.other);
  }
  results.push(row);
  console.log(`${row.pass === undefined ? ' ' : row.pass ? '✓' : '✗'} ${file}\n    ours:  ${fmt(ours)}${row.other ? `\n    other: ${fmt(row.other)}` : ''}`);
}
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
if (otherDir) {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} of ${results.filter((r) => r.pass !== undefined).length} at least as close as the other`);
}
