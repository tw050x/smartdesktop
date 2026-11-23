import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createTestRuns } from '../packages/app/src/main/test-runs.js';
import { createWorkspaces } from '../packages/app/src/main/workspaces.js';

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

describe('a schematic\'s workspace', () => {
  // A repository holding the service in services/thing, as the schematic's dir says: /b is broken.
  const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-workspace-'));
  after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  const server = (broken) => `require('node:http').createServer((req, res) => { res.writeHead(req.url === '/b' && ${broken} ? 500 : 200); res.end('{}'); }).listen(Number(process.env.PORT), '127.0.0.1');`;
  mkdirSync(path.join(repo, 'services', 'thing'), { recursive: true });
  writeFileSync(path.join(repo, 'services', 'thing', 'server.js'), server(true));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  git('commit', '--quiet', '-m', 'First');

  const gitStore = async () => {
    const store = fakeStore();
    const port = await new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
    store.state.drafts.d1.implementation = { source: { kind: 'git', url: `file://${repo}`, ref: 'main', dir: 'services/thing' }, start: { port, env: { PORT: String(port) }, commands: ['node server.js'] }, ready: { path: '/a', timeout: 20 } };
    store.getSchema = async (_id, { draftId } = {}) => ({ draftId: draftId ?? 'd1', number: 1, total: 1, ...store.state.drafts.d1 });
    return store;
  };
  const workspaces = createWorkspaces(path.join(temp, 'data'), { home: path.join(temp, 'home') });
  const withWorkspace = (store, results) => {
    let done;
    const testRuns = createTestRuns({ runner, store, dir: results, workspaces, onChange: (_s, _v, state) => state && !state.running && done?.(state) });
    return { testRuns, finished: () => new Promise((resolve) => { done = resolve; }) };
  };

  test('is cloned by the first run, then tested as it is, changes and all', { timeout: 30_000 }, async () => {
    const store = await gitStore();
    const before = await workspaces.info('s1', 'Thing');
    assert.equal(before.cloned, false);
    assert.equal(before.dir, path.join(temp, 'home', 'workspaces', 'thing-s1'));

    const { testRuns, finished } = withWorkspace(store);
    let done = finished();
    const started = await testRuns.start('s1', 'd1');
    assert.equal(started.workdir, before.dir);
    let state = await done;
    assert.deepEqual(state.counts, { passed: 1, failed: 1, error: 0 }, JSON.stringify(state.log));
    const cloned = await workspaces.info('s1', 'Renamed');
    assert.equal(cloned.dir, before.dir, 'its place stays as the schematic is renamed');
    assert.equal(cloned.cloned, true);
    assert.equal(cloned.branch, 'main');
    assert.equal(cloned.changes, 0);

    // Fixed in the workspace, not committed: the next run tests the fix, nothing reset.
    writeFileSync(path.join(cloned.dir, 'services', 'thing', 'server.js'), server(false));
    assert.equal((await workspaces.info('s1')).changes, 1);
    done = finished();
    await testRuns.start('s1', 'd1');
    state = await done;
    assert.deepEqual(state.counts, { passed: 2, failed: 0, error: 0 }, JSON.stringify(state.log));
    assert.ok(state.log.some((line) => line.text === `Using the code in ${cloned.dir} as it is`));
  });

  test('results are saved, read again after a restart, and given to the AI', { timeout: 30_000 }, async () => {
    const results = mkdtempSync(path.join(os.tmpdir(), 'smartspec-results-'));
    after(() => rmSync(results, { recursive: true, force: true }));
    const store = await gitStore();
    const first = createWorkspaces(path.join(temp, 'data2'), { home: path.join(temp, 'home2') });
    let done;
    const testRuns = createTestRuns({ runner, store, dir: results, workspaces: first, onChange: (_s, _v, state) => state && !state.running && done?.(state) });
    const finished = new Promise((resolve) => { done = resolve; });
    await testRuns.start('s1', 'd1');
    await finished;

    const again = createTestRuns({ runner, store, dir: results, workspaces: first });
    const saved = again.stateOf('s1').d1;
    assert.equal(saved.running, false);
    assert.equal(saved.results['b-works/ok'].outcome, 'failed');

    const given = await again.resultsFor('s1');
    assert.equal(given.ran, true);
    assert.equal(given.version, 'draft 1 of 1');
    assert.deepEqual(given.counts, { passed: 1, failed: 1, couldnt_be_run: 0, not_run: 0 });
    assert.deepEqual(given.passed, ['a-works/ok']);
    assert.equal(given.problems[0].promise, 'B works');
    assert.equal(given.problems[0].part, '/b');
    assert.equal(given.problems[0].request, 'GET /b');
    assert.match(given.problems[0].detail, /Expected status 200, got 500/);
    assert.match(given.code_from, /workspace/);
    assert.equal((await createTestRuns({ runner, store }).resultsFor('s1')).ran, false);
  });

  test('a clone that fails leaves nothing behind, saying why', { timeout: 30_000 }, async () => {
    const store = await gitStore();
    store.state.drafts.d1.implementation.source.url = `file://${path.join(temp, 'nowhere')}`;
    const spaces = createWorkspaces(path.join(temp, 'data3'), { home: path.join(temp, 'home3') });
    let done;
    const testRuns = createTestRuns({ runner, store, workspaces: spaces, onChange: (_s, _v, state) => state && !state.running && done?.(state) });
    const finished = new Promise((resolve) => { done = resolve; });
    await testRuns.start('s1', 'd1');
    const state = await finished;
    assert.equal(state.outcome, 'error');
    assert.match(state.detail, /couldn't be cloned/);
    assert.equal(existsSync(spaces.pathFor('s1', 'Thing')), false);
  });
});
