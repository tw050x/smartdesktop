// How close the reader's drawing of each page (read/render.js) is to Apple's PDFKit's, beside how
// close pdf.js's is: the bar for replacing pdf.js is that ours is at least as close.
//
//   node tools/render-compare.mjs <file.pdf | list.txt | dir> … [--scale 1.333] [--pages 3] [--out dir] [--keep]
//     [--options '{"textDarken":0.5}']   (passed to renderPage)
//
// Pages are drawn by PDFKit (tools/pdfkit.swift), and by ours and pdf.js in a headless Chrome. A
// page's strict score is the share of its ink (pixels not white in either image) where the drawing
// differs from PDFKit's by more than a little, allowing a pixel's shift: 0 is the same. That counts
// every difference in how edges are shaded (text drawn by Chrome's text engine, as pdf.js draws it,
// is shaded more like macOS's), so the visible score, the one compared, takes the same measure
// after a 3×3 blur of both. --keep saves our and pdf.js's images, and a map of where ours differs
// (red), beside PDFKit's in --out.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
const root = path.join(pkg, '../..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, v] = args.splice(i, 2);
  return v;
};
const keep = args.includes('--keep') && args.splice(args.indexOf('--keep'), 1);
const scale = Number(flag('--scale', 4 / 3));
const maxPages = Number(flag('--pages', 3));
const outDir = flag('--out', path.join(tmpdir(), 'smartdoc-render-compare'));
const options = flag('--options', '{}');
mkdirSync(outDir, { recursive: true });

const files = args.flatMap((a) => {
  if (a.endsWith('.txt')) return readFileSync(a, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  if (statSync(a).isDirectory()) return readdirSync(a).filter((f) => f.endsWith('.pdf')).map((f) => path.join(a, f));
  return [a];
});

// PDFKit's renderer, compiled once.
const pdfkit = path.join(outDir, 'pdfkit');
if (!existsSync(pdfkit) || statSync(pdfkit).mtimeMs < statSync(path.join(here, 'pdfkit.swift')).mtimeMs) {
  execFileSync('swiftc', ['-O', '-o', pdfkit, path.join(here, 'pdfkit.swift')], { stdio: 'inherit' });
}

// A server for the reader's modules, the bundled fonts, pdf.js, the PDFs and PDFKit's images.
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.ttf': 'font/ttf', '.pdf': 'application/pdf' };
const HARNESS = `<!doctype html><meta charset="utf-8"><script type="module">
import { PdfDocument } from '/read/document.js';
import { renderPage, viewport } from '/read/render.js';
import * as pdfjs from '/pdfjs/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
const fonts = new Map();
for (const f of ${JSON.stringify(readdirSync(path.join(pkg, 'fonts')).filter((f) => f.endsWith('.ttf')))}) fonts.set(f, new Uint8Array(await (await fetch('/fonts/' + f)).arrayBuffer()));
const docs = new Map();
const png = (c) => c.convertToBlob({ type: 'image/png' }).then((b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }));
const pixels = async (src) => {
  const bmp = src instanceof OffscreenCanvas ? src : await createImageBitmap(await (await fetch(src)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0);
  return x.getImageData(0, 0, bmp.width, bmp.height);
};
// The share of ink that differs from the reference by more than a little, a pixel's shift allowed.
const score = (a, ref, map) => {
  const w = Math.min(a.width, ref.width), h = Math.min(a.height, ref.height);
  const marks = map ? new Uint8ClampedArray(w * h * 4) : null;
  if (marks) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const j = (y * ref.width + x) * 4, o = (y * w + x) * 4; const g = 255 - (255 - Math.min(ref.data[j], ref.data[j + 1], ref.data[j + 2])) * 0.3; marks[o] = marks[o + 1] = marks[o + 2] = g; marks[o + 3] = 255; }
  let ink = 0, bad = 0, sum = 0;
  const T = 64;
  const at = (img, x, y) => (y * img.width + x) * 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(a, x, y), j = at(ref, x, y);
    const d = Math.max(Math.abs(a.data[i] - ref.data[j]), Math.abs(a.data[i + 1] - ref.data[j + 1]), Math.abs(a.data[i + 2] - ref.data[j + 2]));
    const inked = Math.min(a.data[i], a.data[i + 1], a.data[i + 2]) < 235 || Math.min(ref.data[j], ref.data[j + 1], ref.data[j + 2]) < 235;
    if (!inked) continue;
    ink++;
    sum += d;
    if (d <= T) continue;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const k = at(ref, xx, yy), m = at(a, xx, yy);
      const d1 = Math.max(Math.abs(a.data[i] - ref.data[k]), Math.abs(a.data[i + 1] - ref.data[k + 1]), Math.abs(a.data[i + 2] - ref.data[k + 2]));
      const d2 = Math.max(Math.abs(a.data[m] - ref.data[j]), Math.abs(a.data[m + 1] - ref.data[j + 1]), Math.abs(a.data[m + 2] - ref.data[j + 2]));
      if (d1 <= T && d2 <= T) near = true;
    }
    if (!near) {
      bad++;
      if (marks) { const o = (y * w + x) * 4; marks[o] = 255; marks[o + 1] = marks[o + 2] = 0; }
    }
  }
  if (marks) { const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(marks, w, h), 0, 0); map.canvas = c; }
  return { score: ink ? bad / ink : 0, mean: ink ? sum / ink : 0, size: [a.width, a.height, ref.width, ref.height] };
};
// The same, after a 3×3 blur of both, so the shading of edges counts for little and what a reader
// would notice (missing, misplaced or miscoloured content) for much.
const blur = (img) => {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const k = (yy * w + xx) * 4;
      r += data[k]; g += data[k + 1]; b += data[k + 2]; n++;
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return new ImageData(out, w, h);
};
const visible = (a, ref) => score(blur(a), blur(ref)).score;
window.comparePage = async (url, n, scale, refUrl, keep, options = {}) => {
  let bytes = docs.get(url);
  if (!bytes) { bytes = new Uint8Array(await (await fetch(url)).arrayBuffer()); docs.set(url, bytes); }
  const ref = await pixels(refUrl);
  const out = {};
  // Ours.
  try {
    const t = performance.now();
    const doc = new PdfDocument(bytes.slice());
    const page = doc.pages[n - 1];
    const vp = viewport(page, scale);
    const c = new OffscreenCanvas(Math.floor(vp.width), Math.floor(vp.height));
    const errors = new Map();
    await renderPage(page, c.getContext('2d'), { scale, fonts: (f) => fonts.get(f), onError: (e, op) => { const k = op + ': ' + String(e.message ?? e).slice(0, 120); errors.set(k, (errors.get(k) ?? 0) + 1); }, ...options });
    out.skipped = [...errors].map(([k, n]) => n + '× ' + k);
    out.oursMs = performance.now() - t;
    const map = {};
    const mine = await pixels(c);
    out.ours = score(mine, ref, keep ? map : null);
    out.ours.visible = visible(mine, ref);
    if (keep) {
      out.oursPng = await png(c);
      out.diffPng = await png(map.canvas);
    }
  } catch (e) { out.oursError = String(e.stack || e); }
  // pdf.js, as the app uses it.
  try {
    const t = performance.now();
    const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
    const doc = await task.promise;
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale });
    const c = new OffscreenCanvas(Math.floor(vp.width), Math.floor(vp.height));
    const ctx = c.getContext('2d');
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    out.pdfjsMs = performance.now() - t;
    const theirs = await pixels(c);
    out.pdfjs = score(theirs, ref);
    out.pdfjs.visible = visible(theirs, ref);
    if (keep) out.pdfjsPng = await png(c);
    await task.destroy();
  } catch (e) { out.pdfjsError = String(e.stack || e); }
  return out;
};
window.ready = true;
</script>`;
const served = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = null;
  if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(HARNESS);
  if (url.pathname.startsWith('/read/')) file = path.join(pkg, url.pathname);
  else if (url.pathname.startsWith('/fonts/')) file = path.join(pkg, url.pathname);
  else if (url.pathname.startsWith('/pdfjs/')) file = path.join(root, 'node_modules/pdfjs-dist/build', url.pathname.slice(7));
  else if (url.pathname.startsWith('/file/')) file = served.get(url.pathname.slice(6));
  if (!file || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// Chrome, headless, with a profile of its own.
const chrome = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const profile = mkdtempSync(path.join(tmpdir(), 'render-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
process.on('exit', () => {
  browser.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
});
const wsUrl = await new Promise((resolve, reject) => {
  let text = '';
  browser.stderr.on('data', (d) => {
    text += d;
    const m = text.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  browser.on('exit', () => reject(new Error(`Chrome stopped: ${text}`)));
});
const port = new URL(wsUrl).port;
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const my = ++id;
  ws.addEventListener('message', function on(m) {
    const d = JSON.parse(m.data);
    if (d.id !== my) return;
    ws.removeEventListener('message', on);
    if (d.error) reject(new Error(`${method}: ${d.error.message}`));
    else resolve(d.result);
  });
  ws.send(JSON.stringify({ id: my, method, params }));
});
const evaluate = async (expression, timeout = 120000) => {
  const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), timeout))]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await send('Page.navigate', { url: origin });
for (let i = 0; i < 100 && !(await evaluate('window.ready === true').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));

const rows = [];
for (const [fi, file] of files.entries()) {
  const key = `${fi}.pdf`;
  served.set(key, file);
  const prefix = path.join(outDir, `${fi}`);
  let count;
  try {
    count = Number(execFileSync(pdfkit, [file, prefix, String(scale), String(maxPages)], { timeout: 60000 }).toString().trim());
  } catch {
    continue;
  }
  for (let n = 1; n <= count; n++) {
    const refFile = `${prefix}-${n}.png`;
    served.set(`${fi}-${n}.png`, refFile);
    let r;
    try {
      r = await evaluate(`comparePage('/file/${key}', ${n}, ${scale}, '/file/${fi}-${n}.png', ${Boolean(keep)}, ${options})`);
    } catch (e) {
      r = { oursError: e.message };
      // A page that never finished leaves the harness busy: start it again.
      await send('Page.navigate', { url: origin });
      for (let i = 0; i < 100 && !(await evaluate('window.ready === true').catch(() => false)); i++) await new Promise((res) => setTimeout(res, 100));
    }
    for (const which of ['ours', 'pdfjs', 'diff']) {
      if (r[`${which}Png`]) writeFileSync(`${prefix}-${n}.${which}.png`, Buffer.from(r[`${which}Png`].split(',')[1], 'base64'));
    }
    const row = { skipped: r.skipped, file: path.basename(file), index: fi, page: n, ours: r.ours?.visible ?? null, pdfjs: r.pdfjs?.visible ?? null, oursStrict: r.ours?.score ?? null, pdfjsStrict: r.pdfjs?.score ?? null, oursMs: r.oursMs, oursError: r.oursError?.split('\n').slice(0, 3).join(' | ') };
    rows.push(row);
    const f = (v) => (v === null || v === undefined ? '   err ' : `${(v * 100).toFixed(2).padStart(6)}%`);
    console.log(`${f(row.ours)} ${f(row.pdfjs)} ${row.ours !== null && row.pdfjs !== null && row.ours <= row.pdfjs + 0.002 ? 'ok ' : '   '} strict ${f(row.oursStrict)} ${f(row.pdfjsStrict)}  ${row.file} p${n}${row.oursError ? `  ${row.oursError}` : ''}${row.skipped?.length ? `  [skipped: ${row.skipped.join('; ')}]` : ''}`);
  }
}
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 1));
const both = rows.filter((r) => r.ours !== null && r.pdfjs !== null);
const asClose = both.filter((r) => r.ours <= r.pdfjs + 0.002).length;
const mean = (k) => both.reduce((a, r) => a + r[k], 0) / (both.length || 1);
const strictClose = both.filter((r) => r.oursStrict <= r.pdfjsStrict + 0.002).length;
console.log(`\n${rows.length} pages, ${rows.filter((r) => r.oursError).length} errors. Visible: ours at least as close as pdf.js on ${asClose} of ${both.length}, mean ours ${(mean('ours') * 100).toFixed(2)}%, pdf.js ${(mean('pdfjs') * 100).toFixed(2)}%. Strict (every edge pixel): ${strictClose} of ${both.length}, mean ours ${(mean('oursStrict') * 100).toFixed(2)}%, pdf.js ${(mean('pdfjsStrict') * 100).toFixed(2)}%.`);
process.exit(0);
