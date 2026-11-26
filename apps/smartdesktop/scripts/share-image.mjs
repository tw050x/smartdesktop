// Makes the picture other apps show when a link to the website is shared (LinkedIn, Slack,
// Messages…: the pages' og:image, site/share.png, 1200×630): the app's icon and name, the hero's
// headline in its colours and the site's address, beside a still of the app's window, in the
// site's light look. The icon and headline are read from site/index.html, so the picture says what
// the page does. Made on a Mac, so it's drawn in the system's font as the site is, and committed:
// run `npm run share-image` after the headline or the hero's look changes (after `npm run demo`
// and `npm run shots`, for a fresh still). The same in SmartDoc, SmartSpec and SmartDesktop
// apart from these settings. Chrome is found at CHROME, or where macOS or Linux keeps it.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = {
  address: 'smartdesktop.tw050x.net',
  still: 'shots/chat-light.webp', // the chat's window, as the page shows it
};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../site');
const index = readFileSync(path.join(root, 'index.html'), 'utf8');
const brand = index.match(/<a class="brand"[^>]*>([\s\S]*?)<\/a>/)?.[1];
const icon = brand?.match(/<svg[\s\S]*?<\/svg>/)?.[0];
const name = brand?.replace(/<svg[\s\S]*?<\/svg>/, '').trim();
const headline = index.match(/<h1>([\s\S]*?)<\/h1>/)?.[1].trim();
if (!icon || !name || !headline) throw new Error('The brand or the headline isn’t in site/index.html.');
const still = path.join(root, SITE.still);
if (!existsSync(still)) throw new Error(`No ${SITE.still}: run npm run demo and npm run shots first.`);
const palette = readFileSync(path.join(root, 'site.css'), 'utf8').match(/:root \{[\s\S]*?\}/)[0];

const CARD = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${palette}
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body { position: relative; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .words { position: absolute; left: 72px; top: 64px; bottom: 60px; width: 470px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 32px; font-weight: 600; letter-spacing: -0.02em; }
  .brand svg { width: 52px; height: 52px; }
  .brand .bubble { fill: var(--card); stroke: var(--line); } /* (SmartDesktop's icon) */
  h1 { margin: auto 0; font-size: 58px; line-height: 1.06; letter-spacing: -0.035em; }
  h1 .blue { color: var(--blue); }
  h1 .brown { color: var(--brown); }
  .address { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 22px; }
  .beta { padding: 2px 10px; border-radius: 99px; background: var(--blue-soft); color: var(--blue); font-size: 14px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
  .still { position: absolute; left: 592px; top: 72px; width: 900px; filter: drop-shadow(0 18px 40px rgba(0, 0, 0, 0.16)); }
</style></head><body>
  <div class="words">
    <div class="brand">${icon}${name}</div>
    <h1>${headline}</h1>
    <div class="address"><span class="beta">Beta</span>${SITE.address}</div>
  </div>
  <img class="still" src="data:image/webp;base64,${readFileSync(still).toString('base64')}">
</body></html>`;

const chrome = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => existsSync(p));
if (!chrome) throw new Error('Chrome not found: set CHROME to it.');
const profile = mkdtempSync(path.join(tmpdir(), 'share-chrome-'));
const card = path.join(profile, 'card.html');
writeFileSync(card, CARD);
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
const loaded = new Promise((resolve) => ws.addEventListener('message', function on(m) {
  if (JSON.parse(m.data).method !== 'Page.loadEventFired') return;
  ws.removeEventListener('message', on);
  resolve();
}));
await send('Page.navigate', { url: `file://${card}` });
await loaded;
await new Promise((resolve) => setTimeout(resolve, 300));
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } });
writeFileSync(path.join(root, 'share.png'), Buffer.from(shot.data, 'base64'));
console.log('site/share.png 1200×630');
process.exit(0);
