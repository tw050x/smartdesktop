import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { baseUrlOf, checkImplementation, readyTimeout, sourceLine } from '../packages/app/src/main/implementation.js';
import { createStore } from '../packages/app/src/main/store.js';

const image = () => ({ source: { kind: 'image', image: 'ghcr.io/larder/orders:1.4' }, start: { port: 3000, env: { LOG: 'quiet' } }, ready: { path: '/health' } });
const git = () => ({ source: { kind: 'git', url: 'https://github.com/larder/orders.git', ref: 'v2', dir: 'services/orders' }, start: { port: 8080, commands: ['npm ci', 'npm start'] }, stop: { commands: ['rm -rf tmp'] }, credentials: ['github'] });

describe('an implementation', () => {
  test('says where the code comes from and how to run it', () => {
    assert.doesNotThrow(() => checkImplementation(image()));
    assert.doesNotThrow(() => checkImplementation(git()));
    assert.doesNotThrow(() => checkImplementation({ source: { kind: 'compose', url: 'https://github.com/larder/stack.git', service: 'orders' }, start: { port: 3000 } }));
    assert.doesNotThrow(() => checkImplementation({ source: { kind: 'archive', url: 'https://example.com/orders.tar.gz', sha256: 'a'.repeat(64) }, start: { port: 3000, commands: ['./run'] } }));
    assert.doesNotThrow(() => checkImplementation({ source: { kind: 'running', url: 'https://orders.staging.example.com' }, ready: { path: '/health' } }));
    assert.doesNotThrow(() => checkImplementation({ source: { kind: 'git', url: 'file:///Users/me/code/orders' }, start: { port: 3000, commands: ['npm start'] } }));
    assert.throws(() => checkImplementation({ source: { kind: 'archive', url: 'file:///Users/me/orders.tar' }, start: { port: 3000, commands: ['./run'] } }), /should start https:\/\/ or http:\/\//);
    assert.doesNotThrow(() => checkImplementation(null));
  });

  test('a Compose file can start other services beside it, after commands run to their end', () => {
    const stack = { source: { kind: 'compose', url: 'https://github.com/larder/stack.git', service: 'orders', with: ['mongo'] }, start: { port: 3000, commands: ['yarn install', './setup.sh'] } };
    assert.doesNotThrow(() => checkImplementation(stack));
    assert.equal(sourceLine(stack.source), 'orders (with mongo) in github.com/larder/stack');
    assert.throws(() => checkImplementation({ ...stack, source: { ...stack.source, with: ['orders'] } }), /other services/);
    assert.throws(() => checkImplementation({ ...stack, source: { ...stack.source, with: [] } }), /other services/);
    assert.throws(() => checkImplementation({ ...stack, start: { port: 3000, commands: [] } }), /before Compose starts it/);
  });

  test('refuses what can\'t be run, saying why', () => {
    const broken = (change) => {
      const one = git();
      change(one);
      return () => checkImplementation(one);
    };
    assert.throws(broken((one) => { one.source.kind = 'svn'; }), /unknown kind, "svn"/);
    assert.throws(broken((one) => { one.source.url = 'github.com/larder'; }), /needs a URL/);
    assert.throws(broken((one) => { delete one.start.commands; }), /needs start\.commands/);
    assert.throws(broken((one) => { delete one.start.port; }), /needs start\.port/);
    assert.throws(broken((one) => { one.source.dir = '../elsewhere'; }), /a folder inside the repository/);
    assert.throws(broken((one) => { one.credentials = ['my token']; }), /labels for logins/);
    assert.throws(() => checkImplementation({ ...image(), start: { port: 3000, commands: ['npm start'] } }), /runs as it is/);
    assert.throws(() => checkImplementation({ source: { kind: 'running', url: 'https://x.example.com' }, start: { port: 1 } }), /already running, so it has no start or stop/);
    assert.throws(() => checkImplementation({ ...image(), ready: { path: 'health' } }), /such as \/health/);
  });

  test('where the checks reach it, and in a line', () => {
    assert.equal(baseUrlOf(image()), 'http://127.0.0.1:3000');
    assert.equal(baseUrlOf({ source: { kind: 'running', url: 'https://orders.example.com/' } }), 'https://orders.example.com');
    assert.equal(readyTimeout(image()), 60);
    assert.equal(sourceLine(git().source), 'github.com/larder/orders at v2, in services/orders');
    assert.equal(sourceLine(image().source), 'ghcr.io/larder/orders:1.4');
  });
});

const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-implementation-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const newStore = () => createStore(path.join(temp, `store-${n++}`));
const proposal = (extra = {}) => ({ name: 'Orders', summary: 'Takes orders.', note: 'First version', ...extra });

describe('an implementation in the store', () => {
  test('is kept with the drafts, changed as a proposal, and private to the schematic', async () => {
    const store = newStore();
    const { schema } = await store.propose(proposal({ implementation: image() }));
    await store.accept(schema);
    assert.deepEqual((await store.getSchema(schema)).implementation, image());

    // Left out, it carries over; changed, it's a change to approve; null takes it away.
    await store.propose({ schemaId: schema, summary: 'Takes and keeps orders.', note: 'n' });
    assert.equal((await store.getProposal(schema)).changes.implementation, false);
    await store.propose({ schemaId: schema, implementation: git(), note: 'n' });
    const waiting = await store.getProposal(schema);
    assert.equal(waiting.changes.implementation, true);
    await store.approveChange(schema, '@implementation', true);
    assert.deepEqual((await store.getProposal(schema)).approved, ['@implementation']);
    await store.propose({ schemaId: schema, implementation: null, note: 'n' });
    assert.equal((await store.getProposal(schema)).implementation, null);
    await assert.rejects(store.propose({ schemaId: schema, implementation: { source: { kind: 'image' } }, note: 'n' }), /needs the image/);

    // What embeds it sees whether it has one, not what it is; a use can name its own.
    const checkout = await store.propose(proposal({ name: 'Checkout', uses: [{ id: 'orders', schemaId: schema }, { id: 'local-orders', schemaId: schema, implementation: git() }] }));
    await store.accept(checkout.schema);
    const [use, own] = (await store.getSchema(checkout.schema)).uses;
    assert.equal(use.implemented, true);
    assert.equal(use.implementation, null);
    assert.equal(own.implementation.source.kind, 'git');
    await assert.rejects(store.propose(proposal({ uses: [{ id: 'orders', schemaId: schema, implementation: { source: { kind: 'git', url: 'x' } } }] })), /Use orders's implementation's source needs a URL/);
  });
});
