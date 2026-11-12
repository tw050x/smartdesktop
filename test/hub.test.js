import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startHub } from '../packages/app/src/main/hub.js';

async function withHub(options, fn) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'hub-'));
  const hub = await startHub({ userData, port: 0, about: { app: 'SmartDesktop' }, ...options });
  const { token } = JSON.parse(await readFile(path.join(userData, 'connect.json'), 'utf8'));
  const base = `http://127.0.0.1:${hub.port}`;
  const post = (route, body, auth = token) => fetch(`${base}${route}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await fn({ hub, base, token, post, userData });
  } finally {
    hub.close();
    await rm(userData, { recursive: true, force: true });
  }
}

test('writes where to connect, readable by the user alone', async () => {
  await withHub({}, async ({ hub, userData }) => {
    const file = path.join(userData, 'connect.json');
    const { port, token } = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(port, hub.port);
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test('says what it is without a token, and refuses anything else without one', async () => {
  await withHub({}, async ({ base, post }) => {
    assert.deepEqual(await (await fetch(`${base}/whoami`)).json(), { app: 'SmartDesktop' });
    assert.equal((await post('/hello', { app: 'smartdoc', mcp: { url: 'u', token: 't' } }, 'wrong')).status, 401);
  });
});

test('refuses requests from web pages', async () => {
  await withHub({}, async ({ base, token }) => {
    const res = await fetch(`${base}/hello`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://example.com' }, body: '{}' });
    assert.equal(res.status, 403);
  });
});

test('an app says hello with its MCP server, then sends messages', async () => {
  const hellos = [];
  const messages = [];
  await withHub({ onHello: (c) => hellos.push(c), onMessage: (c, m) => (messages.push([c.app, m.type]), { chatOpen: true }) }, async ({ post }) => {
    assert.equal((await post('/hello', { app: 'other', mcp: { url: 'u', token: 't' } })).status, 400);
    const { client } = await (await post('/hello', { app: 'smartdoc', name: 'SmartDoc', mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' } })).json();
    assert.match(client, /^c-/);
    assert.equal(hellos[0].mcp.url, 'http://127.0.0.1:1/mcp');
    assert.deepEqual(await (await post('/message', { client, type: 'focus', windowId: 'w-1' })).json(), { chatOpen: true });
    assert.deepEqual(messages, [['smartdoc', 'focus']]);
    assert.equal((await post('/message', { client: 'c-nobody', type: 'focus' })).status, 404);
  });
});

test('streams events to an app, and forgets it when the stream closes', async () => {
  let gone = null;
  await withHub({ onGone: (c) => (gone = c.app) }, async ({ hub, base, token, post }) => {
    const { client } = await (await post('/hello', { app: 'smartspec', mcp: { url: 'u', token: 't' } })).json();
    const controller = new AbortController();
    const res = await fetch(`${base}/events?client=${client}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    assert.match(text, /connected/);
    assert.equal(hub.send(client, { type: 'action', id: 'confirm' }), true);
    while (!text.includes('data:')) text += decoder.decode((await reader.read()).value);
    assert.match(text, /data: {"type":"action","id":"confirm"}/);
    controller.abort();
    for (let i = 0; i < 50 && !gone; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(gone, 'smartspec');
    assert.equal(hub.clients.size, 0);
  });
});
