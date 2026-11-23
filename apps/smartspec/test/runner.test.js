import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { contractJob, checkContract } from '../packages/app/src/main/contract.js';
import { runCheck, runJob, validate } from '../packages/runner/lib/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-runner-'));
after(() => rmSync(temp, { recursive: true, force: true }));

// A small orders API, as an implementation would be: POST /orders makes one, GET /orders/:id reads
// it. `broken` makes it answer totals wrong, as a regression would.
const ORDERS = `
const http = require('node:http');
const orders = new Map();
let next = 1;
const broken = process.env.BROKEN === '1';
http.createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (req.url === '/health') return send(200, { ok: true });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/orders') {
      const { items } = JSON.parse(raw || '{}');
      if (!Array.isArray(items) || !items.length) return send(400, { error: 'An order needs items.' });
      const id = String(next++);
      const order = { id, items, total: items.reduce((sum, one) => sum + one.price * one.qty, 0) + (broken ? 1 : 0) };
      orders.set(id, order);
      return send(201, order, { location: '/orders/' + id });
    }
    const match = req.url.match(/^\\/orders\\/([^/?]+)$/);
    if (req.method === 'GET' && match) return orders.has(match[1]) ? send(200, orders.get(match[1])) : send(404, { error: 'No such order.' });
    send(404, { error: 'Not found.' });
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

const contract = () => ({
  markdown: 'Takes and keeps orders.',
  shapes: [{ id: 'Order', schema: { type: 'object', required: ['id', 'items', 'total'], properties: { id: { type: 'string' }, items: { type: 'array', minItems: 1, items: { $ref: 'LineItem' } }, total: { type: 'number', minimum: 0 } } } },
    { id: 'LineItem', schema: { type: 'object', required: ['sku', 'qty', 'price'], properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 }, price: { type: 'number' } } } }],
  children: [{
    id: 'orders', name: '/orders', path: '/orders',
    clauses: [
      { id: 'create', title: 'Makes an order from its items', checks: [
        { id: 'made', kind: 'http', request: { method: 'POST', path: '/orders', body: { items: [{ sku: 'apple', qty: 2, price: 3 }] } }, expect: { status: 201, shape: 'Order', body: { total: 6 } } },
        { id: 'empty', kind: 'http', title: 'An order with no items is refused', request: { method: 'POST', path: '/orders', body: { items: [] } }, expect: { status: 400 } },
      ] },
    ],
    children: [{
      id: 'order', name: '/orders/:id', path: '/orders/:id',
      setup: [{ id: 'make', kind: 'http', title: 'Make an order', request: { method: 'POST', path: '/orders', body: { items: [{ sku: 'pear', qty: 1, price: 4 }] } }, expect: { status: 201 }, keep: { id: 'body.id' } }],
      clauses: [{ id: 'read', title: 'Gives an order back as it was made', checks: [
        { id: 'same', kind: 'http', request: { method: 'GET', path: '/orders/{id}' }, expect: { status: 200, shape: 'Order', body: { id: '{id}', total: 4 } } },
        { id: 'missing', kind: 'http', request: { method: 'GET', path: '/orders/nope' }, expect: { status: 404 } },
      ] }],
    }],
  }],
});

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

const workdir = path.join(temp, 'orders');
async function ordersDir() {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(path.join(workdir, 'server.js'), ORDERS);
  return workdir;
}

const implementationAt = (port, extra = {}) => ({
  source: { kind: 'git', url: 'https://github.com/larder/orders.git' },
  start: { port, env: { PORT: String(port), ...extra.env }, commands: ['node -e "1"', 'node server.js'] },
  ready: { path: '/health', timeout: 20 },
});

describe('a contract made into a job', () => {
  test('has every check, or a branch\'s, with the setup above it and the shapes', () => {
    assert.doesNotThrow(() => checkContract(contract()));
    const all = contractJob(contract());
    assert.deepEqual(all.checks.map((one) => one.key), ['create/made', 'create/empty', 'read/same', 'read/missing']);
    assert.deepEqual(Object.keys(all.shapes), ['Order', 'LineItem']);
    assert.equal(all.checks[2].setup[0].keep.id, 'body.id');
    assert.deepEqual(contractJob(contract(), 'order').checks.map((one) => one.key), ['read/same', 'read/missing']);
    assert.deepEqual(contractJob('Just writing.').checks, []);
  });
});

describe('a shape', () => {
  const shapes = contractJob(contract()).shapes;
  test('fits, or says where and why it doesn\'t', () => {
    assert.equal(validate({ id: '1', items: [{ sku: 'a', qty: 1, price: 2 }], total: 2 }, shapes.Order, { shapes }), null);
    assert.deepEqual(validate({ id: '1', items: [{ sku: 'a', qty: 1.5, price: 2 }], total: 2 }, shapes.Order, { shapes }), { path: ['items', 0, 'qty'], message: 'should be an integer, not a number (1.5)' });
    assert.deepEqual(validate({ id: 1, items: [], total: 2 }, shapes.Order, { shapes }).path, ['id']);
    assert.equal(validate({ items: [] }, shapes.Order, { shapes }).message, 'is missing');
    assert.match(validate('x', { enum: ['a', 'b'] }).message, /one of "a", "b"/);
    assert.match(validate({ a: 1, b: 2 }, { properties: { a: {} }, additionalProperties: false }).message, /isn't expected/);
    assert.equal(validate({ next: { next: null } }, { $defs: { link: { type: ['object', 'null'], properties: { next: { $ref: '#/$defs/link' } } } }, $ref: '#/$defs/link' }), null);
  });
});

describe('a check', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(req.url === '/teapot' ? 418 : 200, { 'content-type': 'application/json', 'x-kind': 'tea' });
      res.end(JSON.stringify({ kind: 'tea', cups: [1, 2] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('passes, fails saying how, or says why it couldn\'t be checked', async () => {
    const check = (expect, request = { method: 'GET', path: '/' }) => runCheck({ key: 'c/k', setup: [], request, expect }, { base });
    assert.equal((await check({ status: 200, headers: { 'X-Kind': 'tea' }, body: { cups: [1, 2] } })).outcome, 'passed');
    assert.deepEqual(await check({ status: 200 }, { method: 'GET', path: '/teapot' }).then(({ outcome, detail }) => ({ outcome, detail })), { outcome: 'failed', detail: 'Expected status 200, got 418: {"kind":"tea","cups":[1,2]}.' });
    assert.equal((await check({ body: { cups: [1] } })).detail, 'Body.cups should have 1 item, not 2.');
    assert.equal((await check({ body: { kind: 'coffee' } })).detail, 'Body.kind should be "coffee", not "tea".');
    const nowhere = await runCheck({ key: 'c/k', setup: [], request: { method: 'GET', path: '/' }, expect: { status: 200 } }, { base: `http://127.0.0.1:${await freePort()}` });
    assert.equal(nowhere.outcome, 'error');
    assert.match(nowhere.detail, /nothing is listening there/);
  });
});

describe('a job', () => {
  test('starts its implementation from a folder, runs every check, and stops it', { timeout: 60_000 }, async () => {
    const port = await freePort();
    const events = [];
    const done = await runJob({ version: 1, id: 'orders-1', implementation: implementationAt(port), workdir: await ordersDir(), ...contractJob(contract()) }, { emit: (event) => events.push(event), cacheDir: path.join(temp, 'cache') });
    assert.equal(done.outcome, 'passed', JSON.stringify(events.filter((one) => one.type !== 'log'), null, 1));
    assert.deepEqual(done.counts, { passed: 4, failed: 0, error: 0 });
    assert.deepEqual(events.filter((one) => one.type === 'phase').map((one) => one.phase), ['fetch', 'start', 'ready', 'check', 'stop']);
    assert.ok(events.some((one) => one.type === 'log' && one.text === '$ node server.js'));
    assert.equal(await portOpen(port), false);
  });

  test('says which promise is broken, and a branch can be run again', { timeout: 60_000 }, async () => {
    const port = await freePort();
    const results = [];
    const done = await runJob({ version: 1, id: 'orders-2', implementation: implementationAt(port, { env: { BROKEN: '1' } }), workdir: await ordersDir(), ...contractJob(contract(), 'order') }, { emit: (event) => event.type === 'result' && results.push(event), cacheDir: path.join(temp, 'cache') });
    assert.equal(done.outcome, 'failed');
    assert.deepEqual(results.map((one) => [one.key, one.outcome]), [['read/same', 'failed'], ['read/missing', 'passed']]);
    assert.equal(results[0].detail, 'Body.total should be 4, not 5.');
  });

  test('that can\'t start says why, and every check is not run', { timeout: 60_000 }, async () => {
    const port = await freePort();
    const implementation = { ...implementationAt(port), start: { port, commands: ['node -e "process.exit(3)"'] } };
    const results = [];
    const done = await runJob({ version: 1, id: 'orders-3', implementation, workdir: await ordersDir(), ...contractJob(contract(), 'create') }, { emit: (event) => event.type === 'result' && results.push(event), cacheDir: path.join(temp, 'cache') });
    assert.equal(done.outcome, 'error');
    assert.match(done.detail, /stopped before it was ready \(exit 3\)/);
    assert.deepEqual(results.map((one) => one.outcome), ['error', 'error']);
    assert.equal((await runJob({ version: 2 })).detail.includes('version 1'), true);
  });

  test('runs from the command line, as JSON lines', { timeout: 60_000 }, async () => {
    const server = http.createServer((req, res) => { res.writeHead(204); res.end(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const job = { version: 1, id: 'cli', implementation: { source: { kind: 'running', url: `http://127.0.0.1:${server.address().port}` } }, shapes: {}, checks: [{ key: 'ping/ok', setup: [], request: { method: 'GET', path: '/' }, expect: { status: 204 } }] };
    const child = spawn(process.execPath, [path.join(here, '../packages/runner/cli.js'), 'run', '-'], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.end(JSON.stringify(job));
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));
    server.close();
    const events = out.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(code, 0);
    assert.deepEqual(events.map((one) => one.type), ['job', 'phase', 'log', 'phase', 'result', 'phase', 'done']);
    assert.equal(events.at(-1).outcome, 'passed');
  });
});
