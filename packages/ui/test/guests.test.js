import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGuestServer } from '../main/guests.js';

const API = { id: 'smarttest', calls: { listThings: 'list-things', fail: 'fail' }, events: { onThings: 'things' } };

async function server() {
  const files = mkdtempSync(path.join(os.tmpdir(), 'guests-'));
  writeFileSync(path.join(files, 'index.html'), '<!doctype html><p>a page</p>');
  mkdirSync(path.join(files, 'assets'));
  writeFileSync(path.join(files, 'assets', 'main.js'), 'console.log(1)');
  writeFileSync(path.join(path.dirname(files), `${path.basename(files)}-secret.txt`), 'not to be served');
  const opened = [];
  const closed = [];
  const guests = await startGuestServer({
    files,
    api: API,
    open: (send) => {
      const tab = { id: `g-${opened.length + 1}`, send };
      opened.push(tab);
      // Sent before the stream opens: it waits for it.
      send('things', ['first']);
      return tab;
    },
    close: (tab) => closed.push(tab.id),
    call: async (tab, channel, args) => (channel === 'fail' ? { ok: false, error: 'It failed' } : { ok: true, value: { tab: tab.id, args } }),
  });
  return { guests, opened, closed, secret: `${path.basename(files)}-secret.txt` };
}

// The next server-sent event's data on a stream, parsed.
async function nextEvent(reader, buffer) {
  const decoder = new TextDecoder();
  for (;;) {
    const at = buffer.text.indexOf('\n\n');
    if (at >= 0) {
      const block = buffer.text.slice(0, at);
      buffer.text = buffer.text.slice(at + 2);
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
      continue;
    }
    const { value, done } = await reader.read();
    if (done) return null;
    buffer.text += decoder.decode(value, { stream: true });
  }
}

test('nothing without the token, and only the pages from the pages’ folder', async () => {
  const { guests, secret } = await server();
  try {
    const base = `http://127.0.0.1:${guests.port}`;
    assert.equal((await fetch(`${base}/wrong-token/api`)).status, 403);
    assert.deepEqual(await (await fetch(`${guests.url}/api`)).json(), API);
    const page = await fetch(`${guests.url}/page/index.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${guests.url}/page/assets/main.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${guests.url}/page/..%2F${secret}`)).status, 403);
    assert.equal((await fetch(`${guests.url}/page/missing.html`)).status, 404);
  } finally {
    guests.stop();
  }
});

test('a guest tab’s calls are run as the app’s, only its API’s, and what it’s sent reaches it', async () => {
  const { guests, opened, closed } = await server();
  try {
    const { id } = await (await fetch(`${guests.url}/tabs`, { method: 'POST' })).json();
    assert.equal(id, 'g-1');
    const call = (channel, args) => fetch(`${guests.url}/tabs/${id}/call`, { method: 'POST', body: JSON.stringify({ channel, args }) }).then((r) => r.json());
    assert.deepEqual(await call('list-things', [1, 'two']), { ok: true, value: { tab: 'g-1', args: [1, 'two'] } });
    assert.deepEqual(await call('fail', []), { ok: false, error: 'It failed' });
    assert.equal((await call('delete-everything', [])).ok, false);
    assert.equal((await fetch(`${guests.url}/tabs/g-9/call`, { method: 'POST', body: '{}' })).status, 404);

    const controller = new AbortController();
    const stream = await fetch(`${guests.url}/tabs/${id}/events`, { signal: controller.signal });
    const reader = stream.body.getReader();
    const buffer = { text: '' };
    assert.deepEqual(await nextEvent(reader, buffer), { channel: 'things', value: ['first'] });
    opened[0].send('things', ['second']);
    assert.deepEqual(await nextEvent(reader, buffer), { channel: 'things', value: ['second'] });

    // The window showing it lets go: the tab closes.
    controller.abort();
    for (let i = 0; i < 50 && !closed.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(closed, ['g-1']);
  } finally {
    guests.stop();
  }
});

test('another app’s tab dragged over this one is asked about, and shown only by an app that shows guests', async () => {
  const asked = [];
  // In front where y < 300 (used after the dragging app's window, `front`, 100), its top bar where y < 50.
  const over = (point, front) => {
    asked.push([point, front]);
    const inFront = Boolean(point && point.y < 300 && 200 > front);
    return { over: inFront && point.y < 50, front: inFront };
  };
  const showing = await startGuestServer({ open() {}, close() {}, call() {}, host: async () => {}, over });
  const serving = await startGuestServer({ files: os.tmpdir(), api: API, open() {}, close() {}, call() {} });
  try {
    const ask = (server, point, front) => fetch(`${server.url}/over`, { method: 'POST', body: JSON.stringify({ point, front }) }).then((r) => r.json());
    assert.deepEqual(await ask(showing, { x: 10, y: 20 }, 100), { over: true, front: true });
    assert.deepEqual(await ask(showing, { x: 10, y: 200 }, 100), { over: false, front: true });
    assert.deepEqual(await ask(showing, { x: 10, y: 20 }, 300), { over: false, front: false });
    assert.deepEqual(await ask(showing, { x: 10, y: 400 }), { over: false, front: false });
    assert.deepEqual(await ask(showing, null), { over: false, front: false });
    assert.deepEqual(asked.map(([, front]) => front), [100, 100, 300, 0, 0]);
    assert.deepEqual(await ask(serving, { x: 10, y: 20 }, 0), { over: false, front: false });
    assert.equal((await fetch(`${showing.url}/api`)).status, 404);
  } finally {
    showing.stop();
    serving.stop();
  }
});

test('a guest tab says what it shows, hears its window’s answers, and comes back to its app', async () => {
  const back = [];
  const guests = await startGuestServer({
    files: os.tmpdir(),
    api: API,
    open: (send) => ({ id: 'g-1', send }),
    close() {},
    call() {},
    opening: (tab) => ({ thing: tab.id }),
    returned: async (tab, at) => back.push([tab.id, at]),
    answered: (tab, ask, value) => back.push([tab.id, ask, value]),
  });
  try {
    const { id } = await (await fetch(`${guests.url}/tabs`, { method: 'POST' })).json();
    assert.deepEqual(await (await fetch(`${guests.url}/tabs/${id}/open`)).json(), { open: { thing: 'g-1' } });
    const returned = await fetch(`${guests.url}/tabs/${id}/return`, { method: 'POST', body: JSON.stringify({ at: { x: 5, y: 6 } }) });
    assert.deepEqual(await returned.json(), { ok: true });
    assert.deepEqual(back, [['g-1', { x: 5, y: 6 }]]);
    // What its window answered (a menu's choice, say).
    await fetch(`${guests.url}/tabs/${id}/answer`, { method: 'POST', body: JSON.stringify({ ask: 3, value: 'delete' }) });
    assert.deepEqual(back.at(-1), ['g-1', 3, 'delete']);
  } finally {
    guests.stop();
  }
});

test('an app’s media is served in the ranges a player asks for', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'media-'));
  writeFileSync(path.join(folder, 'take.flac'), '0123456789');
  const guests = await startGuestServer({
    files: os.tmpdir(),
    api: API,
    open() {},
    close() {},
    call() {},
    media: ([kind, file]) => (kind === 'take' && file === 'take.flac' ? path.join(folder, file) : null),
  });
  try {
    const whole = await fetch(`${guests.url}/media/take/take.flac`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'audio/flac');
    assert.equal(await whole.text(), '0123456789');
    const part = await fetch(`${guests.url}/media/take/take.flac`, { headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');
    assert.equal(await (await fetch(`${guests.url}/media/take/take.flac`, { headers: { range: 'bytes=-3' } })).text(), '789');
    assert.equal((await fetch(`${guests.url}/media/take/take.flac`, { headers: { range: 'bytes=20-' } })).status, 416);
    assert.equal((await fetch(`${guests.url}/media/take/other.flac`)).status, 404);
  } finally {
    guests.stop();
  }
});

test('bytes cross a guest tab’s connection as bytes, both ways', async () => {
  const { encode, decode } = await import('../main/wire.js');
  const pdf = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const round = decode(JSON.parse(JSON.stringify(encode({ view: { pdf, pages: [1, 2] }, font: pdf.buffer, name: 'x' }))));
  assert.deepEqual([...round.view.pdf], [...pdf]);
  assert.deepEqual([...round.font], [...pdf]);
  assert.deepEqual(round.view.pages, [1, 2]);
  assert.equal(round.name, 'x');

  const guests = await startGuestServer({
    files: os.tmpdir(),
    api: API,
    open: (send) => ({ id: 'g-1', send }),
    close() {},
    call: async (_tab, _channel, args) => ({ ok: true, value: { got: [...args[0]], back: new Uint8Array([9, 8]) } }),
  });
  try {
    const { id } = await (await fetch(`${guests.url}/tabs`, { method: 'POST' })).json();
    const answer = decode(await (await fetch(`${guests.url}/tabs/${id}/call`, { method: 'POST', body: JSON.stringify(encode({ channel: 'list-things', args: [new Uint8Array([1, 2, 3])] })) })).json());
    assert.deepEqual(answer.value.got, [1, 2, 3]);
    assert.deepEqual([...answer.value.back], [9, 8]);
  } finally {
    guests.stop();
  }
});
