// An app's pages shown in another app's window (guest tabs): this app serves them, and runs their
// calls, on a small HTTP server on this Mac only (127.0.0.1), every request carrying a random
// token. Node's own http, no dependencies. The window showing a guest (the other app) loads the
// page from here, gives it the same API this app's own pages have (from `api`, the app's
// main/api.js), and passes its calls on and its events back:
//
//   GET  /<token>/api                     the pages' API as data ({ id, calls, events })
//   GET  /<token>/page/<file>             the app's built pages (index.html, its scripts and styles)
//   GET  /<token>/media/<…>               a file of the app's own that its pages play or read (with
//                                         `media`: SmartStudio's takes), in byte ranges as asked, so
//                                         audio and video can seek
//   POST /<token>/tabs                    opens a guest tab ({ open }: what it's to show, the app's
//                                         own request, as its own tabs are sent it): { id }
//   GET  /<token>/tabs/<id>/events        what this app sends the tab, as server-sent events
//                                         ({ channel, value } each); the stream closing closes the tab
//   POST /<token>/tabs/<id>/call          { channel, args } → { ok, value } or { ok: false, error },
//                                         only the channels in `api.calls`
//   GET  /<token>/tabs/<id>/open          what the tab shows, as this app's own request for opening it
//                                         ({ open }, null if it can't be moved), for moving it on
//   POST /<token>/tabs/<id>/answer        the window showing the tab answers what this app asked it
//                                         to show ({ ask, value }: a menu's choice, a message box's
//                                         response; asked as `guest-ui` events)
//   POST /<token>/tabs/<id>/return        the tab comes back to this app, as a tab of its own
//                                         ({ at }: where on the screen it was dropped, or null)
//   POST /<token>/host                    asks this app to show another's tab in its window
//                                         ({ app, url, open }: that app, its server, and what to
//                                         show; `at`, where on the screen it was dropped, if it
//                                         was) → { ok } or { ok: false, error }
//   POST /<token>/over                    another app's tab is dragged over `point` (on the screen,
//                                         or null once it's gone; `front`, when that app's own window
//                                         there last had the focus): { front, over } (whether a
//                                         window of this app's is in front there, and whether the tab
//                                         would drop in its top bar), showing where it would go
//
// What a tab is sent before its stream is open waits for it. The app makes and removes the guest
// tabs (`open(send, { open })` → its tab, `close(tab)`) and runs their calls (`call(tab, channel,
// args)`), as its own handlers do for its own tabs, says what one shows (`opening(tab)`) and takes one
// back (`returned(tab, at)`), hearing what its window answered (`answered(tab, ask, value)`); and
// shows others' (`host(request)`, `over(point)`). `media(parts)` gives the file for a media path's
// parts, or null. Without
// `api` it serves no pages (it only shows others'); without `host` it shows none.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { decode, encode } from './wire.js';

const TYPES = { '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.pdf': 'application/pdf', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm' };
const MOST_BODY = 8 * 1024 * 1024; // a call's arguments, at most

export function startGuestServer({ files = null, api = null, open, close, call, media = null, opening = () => null, returned = null, answered = () => {}, host = null, over = null, port = 0 }) {
  const token = randomBytes(24).toString('hex');
  const tabs = new Map(); // id → { tab, stream, waiting: [] }
  const root = files && path.resolve(files);

  const tokenOk = (given) => given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const body = (req) => new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (part) => {
      size += part.length;
      if (size > MOST_BODY) {
        reject(new Error('Too large'));
        req.destroy();
      } else parts.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });

  function openTab(options) {
    const entry = { tab: null, stream: null, waiting: [] };
    const send = (channel, value) => {
      const event = `data: ${JSON.stringify({ channel, value: encode(value ?? null) })}\n\n`;
      if (entry.stream) entry.stream.write(event);
      else entry.waiting.push(event);
    };
    entry.tab = open(send, options);
    tabs.set(entry.tab.id, entry);
    return entry.tab.id;
  }
  function closeTab(id) {
    const entry = tabs.get(id);
    if (!entry) return;
    tabs.delete(id);
    entry.stream?.end();
    close(entry.tab);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const [given = '', ...rest] = url.pathname.split('/').filter(Boolean);
      if (!tokenOk(given)) return json(res, 403, { error: 'Not allowed' });
      const [kind, id, what] = rest;
      if (req.method === 'POST' && kind === 'host' && !id) {
        if (!host) return json(res, 200, { ok: false, error: 'This app doesn’t show other apps’ tabs' });
        const request = JSON.parse(await body(req));
        await host(request);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && kind === 'over' && !id) {
        const { point = null, front = 0 } = JSON.parse((await body(req)) || '{}');
        const answer = host && over ? over(point, Number(front) || 0) : null;
        return json(res, 200, { over: Boolean(answer?.over), front: Boolean(answer?.front) });
      }
      if (!api) return json(res, 404, { error: 'This app serves no pages' });
      if (req.method === 'GET' && kind === 'api' && !id) return json(res, 200, api);
      if (req.method === 'GET' && kind === 'media' && media) {
        const file = media(rest.slice(1).map((part) => decodeURIComponent(part)));
        const info = file && await stat(file).catch(() => null);
        if (!info?.isFile()) return json(res, 404, { error: 'Not found' });
        const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        // A range asked for (a player seeking): that part, else all of it.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        let start = 0;
        let end = info.size - 1;
        if (range && (range[1] || range[2])) {
          if (range[1]) {
            start = Number(range[1]);
            if (range[2]) end = Math.min(Number(range[2]), end);
          } else start = Math.max(0, info.size - Number(range[2]));
          if (start > end) {
            res.writeHead(416, { 'content-range': `bytes */${info.size}` });
            return res.end();
          }
          res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${info.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
        } else res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(file, { start, end }).pipe(res);
      }
      if (req.method === 'GET' && kind === 'page') {
        const file = path.resolve(root, decodeURIComponent(rest.slice(1).join('/')) || 'index.html');
        if (file !== root && !file.startsWith(root + path.sep)) return json(res, 403, { error: 'Not allowed' });
        const data = await readFile(file).catch(() => null);
        if (!data) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(data);
      }
      if (req.method === 'POST' && kind === 'tabs' && !id) {
        const text = await body(req);
        const { open: what = null } = text ? JSON.parse(text) : {};
        return json(res, 200, { id: openTab({ open: what }) });
      }
      const entry = id && tabs.get(id);
      if (kind === 'tabs' && !entry) return json(res, 404, { error: 'No such tab' });
      if (req.method === 'GET' && what === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': open\n\n');
        entry.stream?.end();
        entry.stream = res;
        for (const event of entry.waiting.splice(0)) res.write(event);
        // The window showing it has gone (or let it go): the tab goes too.
        req.on('close', () => {
          if (entry.stream === res) closeTab(id);
        });
        return;
      }
      if (req.method === 'GET' && what === 'open') return json(res, 200, { open: opening(entry.tab) ?? null });
      if (req.method === 'POST' && what === 'answer') {
        const { ask, value = null } = JSON.parse((await body(req)) || '{}');
        answered(entry.tab, ask, value);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && what === 'return') {
        if (!returned) return json(res, 200, { ok: false, error: 'This app doesn’t take tabs back' });
        const { at = null } = JSON.parse((await body(req)) || '{}');
        await returned(entry.tab, at);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && what === 'call') {
        // (Bytes come and go as base64: see wire.js.)
        const { channel, args = [] } = decode(JSON.parse(await body(req)));
        if (!Object.values(api.calls).includes(channel)) return json(res, 200, { ok: false, error: `${channel} isn’t one of this app’s calls` });
        return json(res, 200, encode(await call(entry.tab, channel, Array.isArray(args) ? args : [])));
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: listening } = server.address();
      resolve({
        url: `http://127.0.0.1:${listening}/${token}`,
        port: listening,
        token,
        // Every guest tab closes (the app is quitting).
        stop() {
          for (const id of [...tabs.keys()]) closeTab(id);
          server.close();
        },
      });
    });
  });
}
