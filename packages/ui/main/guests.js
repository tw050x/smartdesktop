// An app's pages shown in another app's window (guest tabs): this app serves them, and runs their
// calls, on a small HTTP server on this Mac only (127.0.0.1), every request carrying a random
// token. Node's own http, no dependencies. The window showing a guest (the other app) loads the
// page from here, gives it the same API this app's own pages have (from `api`, the app's
// main/api.js), and passes its calls on and its events back:
//
//   GET  /<token>/api                     the pages' API as data ({ id, calls, events })
//   GET  /<token>/page/<file>             the app's built pages (index.html, its scripts and styles)
//   POST /<token>/tabs                    opens a guest tab: { id }
//   GET  /<token>/tabs/<id>/events        what this app sends the tab, as server-sent events
//                                         ({ channel, value } each); the stream closing closes the tab
//   POST /<token>/tabs/<id>/call          { channel, args } → { ok, value } or { ok: false, error },
//                                         only the channels in `api.calls`
//
// What a tab is sent before its stream is open waits for it. The app makes and removes the guest
// tabs (`open(send)` → its tab, `close(tab)`) and runs their calls (`call(tab, channel, args)`), as
// its own handlers do for its own tabs.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm' };
const MOST_BODY = 8 * 1024 * 1024; // a call's arguments, at most

export function startGuestServer({ files, api, open, close, call, port = 0 }) {
  const token = randomBytes(24).toString('hex');
  const tabs = new Map(); // id → { tab, stream, waiting: [] }
  const root = path.resolve(files);

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

  function openTab() {
    const entry = { tab: null, stream: null, waiting: [] };
    const send = (channel, value) => {
      const event = `data: ${JSON.stringify({ channel, value: value ?? null })}\n\n`;
      if (entry.stream) entry.stream.write(event);
      else entry.waiting.push(event);
    };
    entry.tab = open(send);
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
      if (req.method === 'GET' && kind === 'api' && !id) return json(res, 200, api);
      if (req.method === 'GET' && kind === 'page') {
        const file = path.resolve(root, decodeURIComponent(rest.slice(1).join('/')) || 'index.html');
        if (file !== root && !file.startsWith(root + path.sep)) return json(res, 403, { error: 'Not allowed' });
        const data = await readFile(file).catch(() => null);
        if (!data) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(data);
      }
      if (req.method === 'POST' && kind === 'tabs' && !id) return json(res, 200, { id: openTab() });
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
      if (req.method === 'POST' && what === 'call') {
        const { channel, args = [] } = JSON.parse(await body(req));
        if (!Object.values(api.calls).includes(channel)) return json(res, 200, { ok: false, error: `${channel} isn’t one of this app’s calls` });
        return json(res, 200, await call(entry.tab, channel, Array.isArray(args) ? args : []));
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
