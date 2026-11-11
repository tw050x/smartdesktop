// Makes the stills the website shows on phones and upright tablets (site/shots/<scene>-dark.webp and
// -light.webp): each scene the pages' story plays, played in the demo in a headless Chrome most of
// the way through its moment, and the part of the window it's about (its focus, with the chat's
// window where it shows) saved as an image on a clear background, once in dark mode and once in
// light. Run after `npm run demo` (`npm run shots`); the site's workflow does, before publishing.
// Chrome is found at CHROME, or where macOS or Linux keeps it.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../site');
const out = path.join(root, 'shots');
mkdirSync(out, { recursive: true });

// The scenes the pages' steps play, and their second and other windows'.
const scenes = new Set();
const heroes = new Set();
for (const page of ['index.html', 'features.html']) {
  const html = readFileSync(path.join(root, page), 'utf8');
  for (const m of html.matchAll(/<(?:article|div) class="(?:step|camera[^"]*)"[^>]*?data-scene="([^"]+)"/g)) scenes.add(m[1]);
  // A hero (a step with no caption, or its caption below), and the hero's other window, show the
  // whole window.
  for (const m of html.matchAll(/<article class="step" data-scene="([^"]+)" data-side="(?:below|none)"/g)) heroes.add(m[1]);
  for (const m of html.matchAll(/<div class="camera alt" data-scene="([^"]+)"/g)) heroes.add(m[1]);
}
scenes.delete('settle');
// (ONLY=<scene> makes just that one's.)
if (process.env.ONLY) for (const scene of [...scenes]) if (scene !== process.env.ONLY) scenes.delete(scene);

// Where the window and the chat's go on the capture page, with room round them for the chat to sit
// on either side.
const AT = { x: 520, y: 80 };
const CAPTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  .win { position: absolute; overflow: hidden; border-radius: 12px; border: 1px solid rgba(128, 128, 128, 0.35); }
  .win iframe { display: block; border: 0; }
  #chat { visibility: hidden; border-radius: 10px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12), 0 18px 48px rgba(0, 0, 0, 0.22); }
</style></head><body>
  <div class="win" id="app" style="left: ${AT.x}px; top: ${AT.y}px"><iframe src="demo/demo.html" style="width: 1280px; height: 800px"></iframe></div>
  <div class="win" id="chat"><iframe src="demo/demo-chat.html" style="width: 400px; height: 660px"></iframe></div>
</body></html>`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (url === '/__shots.html') return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(CAPTURE);
  const file = path.join(root, url);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const chrome = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => existsSync(p));
if (!chrome) throw new Error('Chrome not found: set CHROME to it.');
// A profile of its own, thrown away after; and Chrome stopped however this ends.
const profile = mkdtempSync(path.join(tmpdir(), 'shots-chrome-'));
// (A CI runner's Linux may not let Chrome sandbox itself; it runs only the site's own pages there.)
const sandbox = process.env.CI ? ['--no-sandbox'] : [];
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', ...sandbox, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const stop = () => {
  browser.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on('exit', stop);
process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exit(1);
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
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));
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
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
// What the demo says went wrong, if it does.
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(d.params.type)) console.warn('demo:', d.params.args.map((a) => a.value ?? a.description).join(' '));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
for (const scheme of ['dark', 'light']) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  for (const scene of scenes) {
    // A fresh demo for each scene, so nothing's left from the one before.
    await send('Page.navigate', { url: `${origin}/__shots.html` });
    await run(`(async () => {
      const app = document.querySelector('#app iframe');
      const chat = document.querySelector('#chat iframe');
      while (!app.contentWindow?.demo || !chat.contentWindow?.startChat) await new Promise((r) => setTimeout(r, 50));
      const d = app.contentWindow.demo;
      await d.attachChat(chat.contentWindow, d.chatPlace);
      d.setShots?.(false);
      window.chatShown = false;
      d.onChatShown((on) => { window.chatShown = on; });
      window.d = d;
    })()`);
    // The scene, most of the way through its moment.
    let focus = null;
    for (let tries = 0; !focus && tries < 3; tries++) {
      focus = await run(`(async () => { const f = await window.d.show(${JSON.stringify(scene)}); if (f) window.d.seek(0.85); return f; })()`);
    }
    if (!focus) throw new Error(`The demo couldn't show ${scene}.`);
    await sleep(1500);
    // The chat's window where the scene has it, while it shows; and what to keep: the focus, with a
    // little room round it, inside the windows (and their shadows).
    const box = await run(`(() => {
      const f = ${JSON.stringify(heroes.has(scene) ? { ...focus, x: 0, y: 0, width: 1280, height: 800 } : focus)};
      const chat = document.getElementById('chat');
      const at = f.chatAt ?? window.d.chatPlace;
      chat.style.left = (${AT.x} + at.x) + 'px';
      chat.style.top = (${AT.y} + at.y) + 'px';
      chat.style.visibility = window.chatShown ? 'visible' : 'hidden';
      const parts = [{ x: 0, y: 0, width: 1280, height: 800 }];
      if (window.chatShown) parts.push({ x: at.x, y: at.y, width: 400, height: 660 });
      const all = { left: Math.min(...parts.map((p) => p.x)), top: Math.min(...parts.map((p) => p.y)), right: Math.max(...parts.map((p) => p.x + p.width)), bottom: Math.max(...parts.map((p) => p.y + p.height)) };
      const pad = 24;
      const left = Math.max(all.left - 12, f.x - pad);
      const top = Math.max(all.top - 12, f.y - pad);
      const right = Math.min(all.right + 12, f.x + f.width + pad);
      const bottom = Math.min(all.bottom + 12, f.y + f.height + pad);
      return { x: ${AT.x} + left, y: ${AT.y} + top, width: right - left, height: bottom - top };
    })()`);
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 82, clip: { ...box, scale: 2 }, captureBeyondViewport: true });
    writeFileSync(path.join(out, `${scene}-${scheme}.webp`), Buffer.from(shot.data, 'base64'));
    console.log(`${scene}-${scheme}.webp ${Math.round(box.width)}×${Math.round(box.height)}`);
  }
}
ws.close();
server.close();
process.exit(0);
