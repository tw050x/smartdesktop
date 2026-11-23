import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createTestRuns } from '../packages/app/src/main/test-runs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = { command: process.execPath, args: [path.join(here, '../packages/runner/cli.js')], env: {} };

// A service already running (so nothing has to be fetched or started): /a answers, /b is broken.
let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(req.url === '/b' ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url !== '/b' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const check = (id, pathname) => ({ id, kind: 'http', request: { method: 'GET', path: pathname }, expect: { status: 200 } });
const contract = () => ({
  children: [
    { id: 'a', name: '/a', path: '/a', clauses: [{ id: 'a-works', title: 'A works', checks: [check('ok', '/a')] }] },
    { id: 'b', name: '/b', path: '/b', clauses: [{ id: 'b-works', title: 'B works', checks: [check('ok', '/b')] }] },
  ],
});

// A store with one schematic: draft d1, and maybe a proposal.
function fakeStore() {
  const state = {
    drafts: { d1: { name: 'Thing', contract: contract(), implementation: { source: { kind: 'running', url } } } },
    line: ['d1'],
    proposal: null,
  };
  return {
    state,
    getSchema: async (_id, { draftId } = {}) => ({ draftId: draftId ?? state.line.at(-1), ...state.drafts[draftId ?? state.line.at(-1)] }),
    getProposal: async () => state.proposal,
  };
}

// Resolves with a version's state once its run has ended.
function runs(store) {
  const ended = new Map();
  const heard = [];
  const testRuns = createTestRuns({
    runner,
    store,
    onChange: (schemaId, version, state) => {
      heard.push({ version, state });
      if (state && !state.running) ended.get(version)?.(state);
    },
  });
  const finished = (version) => new Promise((resolve) => ended.set(version, resolve));
  return { testRuns, finished, heard };
}

describe('running a schematic\'s checks', () => {
  test('runs them all with the runner, then a branch again, keeping the rest', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns, finished, heard } = runs(store);
    const done = finished('d1');
    const started = await testRuns.start('s1', 'd1');
    assert.equal(started.running, true);
    assert.deepEqual(started.pending, ['a-works/ok', 'b-works/ok']);
    await assert.rejects(testRuns.start('s1', 'd1'), /already running/);
    const state = await done;
    assert.equal(state.outcome, 'failed');
    assert.deepEqual(state.counts, { passed: 1, failed: 1, error: 0 });
    assert.equal(state.results['b-works/ok'].detail, 'Expected status 200, got 500: {"ok":false}.');
    assert.ok(heard.some((one) => one.state?.running), 'progress is sent while it runs');

    const again = finished('d1');
    await testRuns.start('s1', 'd1', 'a');
    const branch = await again;
    assert.equal(branch.only, 'a');
    assert.equal(branch.outcome, 'passed');
    assert.equal(branch.results['b-works/ok'].outcome, 'failed', 'the rest of the results are kept');
    assert.deepEqual(Object.keys(testRuns.stateOf('s1')), ['d1']);
  });

  test('that couldn\'t start the code marks no check, saying why once', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns, finished } = runs(store);
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const nowhere = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((resolve) => closed.close(resolve));
    store.state.drafts.d1.implementation = { source: { kind: 'running', url: nowhere }, ready: { path: '/health', timeout: 1 } };
    const done = finished('d1');
    await testRuns.start('s1', 'd1');
    const state = await done;
    assert.equal(state.outcome, 'error');
    assert.match(state.detail, /wasn't ready after 1 s/);
    assert.deepEqual(state.results, {});
  });

  test('says what\'s missing before running', async () => {
    const store = fakeStore();
    const { testRuns } = runs(store);
    store.state.drafts.d1.implementation = null;
    await assert.rejects(testRuns.start('s1', 'd1'), /has no implementation/);
    store.state.drafts.d1 = { ...store.state.drafts.d1, implementation: { source: { kind: 'running', url } }, contract: 'Just writing.' };
    await assert.rejects(testRuns.start('s1', 'd1'), /no checks to run yet/);
    await assert.rejects(testRuns.start('s1', 'proposal'), /no proposal/);
  });

  test('a proposal\'s results go out of date as it changes, and are the new draft\'s once accepted', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns, finished } = runs(store);
    store.state.proposal = { name: 'Thing', contract: contract(), implementation: { source: { kind: 'running', url } } };
    const done = finished('proposal');
    await testRuns.start('s1', 'proposal');
    await done;

    store.state.proposal = { ...store.state.proposal, contract: { children: [contract().children[0]] } };
    await testRuns.changed('s1');
    assert.equal(testRuns.stateOf('s1').proposal.stale, true);
    store.state.proposal = { ...store.state.proposal, contract: contract() };
    await testRuns.changed('s1');
    assert.equal(testRuns.stateOf('s1').proposal.stale, false);

    // Accepted as it was run: the new draft's.
    store.state.drafts.d2 = { name: 'Thing', contract: contract(), implementation: { source: { kind: 'running', url } } };
    store.state.line.push('d2');
    store.state.proposal = null;
    await testRuns.changed('s1');
    const states = testRuns.stateOf('s1');
    assert.equal(states.proposal, undefined);
    assert.equal(states.d2.version, 'd2');
    assert.equal(states.d2.counts.passed, 1);
  });
});
