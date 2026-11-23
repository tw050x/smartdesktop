import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createTestRuns } from '../packages/app/src/main/test-runs.js';
import { targetOf, viewOf } from '../packages/app/src/main/test-history.js';
import { createWorkspaces } from '../packages/app/src/main/workspaces.js';
import { describeStep } from '../packages/app/src/main/describe-step.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = { command: process.execPath, args: [path.join(here, '../packages/runner/cli.js')], env: {} };
const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-test-runs-'));
after(() => rmSync(temp, { recursive: true, force: true }));

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
    getSchema: async (_id, { draftId } = {}) => {
      const id = draftId ?? state.line.at(-1);
      return { draftId: id, number: state.line.indexOf(id) + 1, total: state.line.length, line: state.line, ...state.drafts[id] };
    },
    getProposal: async () => state.proposal && { line: state.line, ...state.proposal },
  };
}

// The runs, and a promise of the next to end.
function runsWith(store, options = {}) {
  const heard = [];
  let ended = null;
  const testRuns = createTestRuns({
    runner,
    store,
    ...options,
    onChange: (_schemaId, run) => {
      heard.push(run);
      if (!run.running) ended?.(run);
    },
  });
  const next = () => new Promise((resolve) => { ended = resolve; });
  return { testRuns, next, heard };
}

function closedPort() {
  return new Promise((resolve) => {
    const one = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = one.address();
      one.close(() => resolve(port));
    });
  });
}

describe('running a schematic\'s checks', () => {
  test('runs them all, then a branch again, its view keeping the rest, every run kept', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns, next, heard } = runsWith(store);
    let done = next();
    const started = await testRuns.start('s1', 'd1');
    assert.equal(started.running, true);
    assert.equal(started.by, 'user');
    assert.deepEqual(started.pending, ['a-works/ok', 'b-works/ok']);
    await assert.rejects(testRuns.start('s1', 'd1'), /already running/);
    const first = await done;
    assert.equal(first.outcome, 'failed');
    assert.deepEqual(first.counts, { passed: 1, failed: 1, error: 0 });
    assert.equal(first.results['b-works/ok'].detail, 'Expected status 200, got 500: {"ok":false}.');
    assert.equal(first.code.label, url);
    assert.ok(heard.some((one) => one.running), 'progress is sent while it runs');

    done = next();
    await testRuns.start('s1', 'd1', { only: 'a' });
    const branch = await done;
    assert.equal(branch.only, 'a');
    assert.deepEqual(Object.keys(branch.results), ['a-works/ok']);
    const view = viewOf(testRuns.stateOf('s1'), 'd1', 'default');
    assert.equal(view.id, branch.id);
    assert.equal(view.results['b-works/ok'].outcome, 'failed', 'the rest of the results are kept');
    assert.equal(testRuns.stateOf('s1').length, 2);
  });

  test('that couldn\'t start the code marks no check, saying why once', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns, next } = runsWith(store);
    store.state.drafts.d1.implementation = { source: { kind: 'running', url: `http://127.0.0.1:${await closedPort()}` }, ready: { path: '/health', timeout: 1 } };
    const done = next();
    await testRuns.start('s1', 'd1');
    const run = await done;
    assert.equal(run.outcome, 'error');
    assert.match(run.detail, /wasn't ready after 1 s/);
    assert.deepEqual(run.results, {});
  });

  test('says what\'s missing before running', async () => {
    const store = fakeStore();
    const { testRuns } = runsWith(store);
    store.state.drafts.d1.implementation = null;
    await assert.rejects(testRuns.start('s1', 'd1'), /has no implementation/);
    store.state.drafts.d1 = { ...store.state.drafts.d1, implementation: { source: { kind: 'running', url } }, contract: 'Just writing.' };
    await assert.rejects(testRuns.start('s1', 'd1'), /no checks to run yet/);
    await assert.rejects(testRuns.start('s1', 'proposal'), /no proposal/);
    store.state.drafts.d1.contract = contract();
    await assert.rejects(testRuns.start('s1', 'd1', { target: targetOf({ ref: 'main' }) }), /no branch, commit or workspace to choose/);
  });

  test('a proposal\'s runs go out of date as it changes, and are the new draft\'s once accepted', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns, next } = runsWith(store);
    store.state.proposal = { name: 'Thing', contract: contract(), implementation: { source: { kind: 'running', url } } };
    const done = next();
    await testRuns.start('s1', 'proposal');
    const run = await done;

    store.state.proposal = { ...store.state.proposal, contract: { children: [contract().children[0]] } };
    await testRuns.changed('s1');
    assert.equal(testRuns.stateOf('s1')[0].stale, true);
    assert.equal(viewOf(testRuns.stateOf('s1'), 'proposal', 'default'), null, 'out of date, it shows no results');
    store.state.proposal = { ...store.state.proposal, contract: contract() };
    await testRuns.changed('s1');
    assert.equal(testRuns.stateOf('s1')[0].stale, false);

    // Accepted as it was run: the new draft's.
    store.state.drafts.d2 = { name: 'Thing', contract: contract(), implementation: { source: { kind: 'running', url } } };
    store.state.line.push('d2');
    store.state.proposal = null;
    await testRuns.changed('s1');
    const [moved] = testRuns.stateOf('s1');
    assert.equal(moved.id, run.id);
    assert.equal(moved.version, 'd2');
  });
});

describe('the code a run is against', () => {
  // A repository holding the service in services/thing, as the schematic's dir says: /b is broken
  // on main, fixed on the branch fix.
  const repo = path.join(temp, 'repo');
  const server = (broken) => `require('node:http').createServer((req, res) => { res.writeHead(req.url === '/b' && ${broken} ? 500 : 200); res.end('{}'); }).listen(Number(process.env.PORT), '127.0.0.1');`;
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  mkdirSync(path.join(repo, 'services', 'thing'), { recursive: true });
  writeFileSync(path.join(repo, 'services', 'thing', 'server.js'), server(true));
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  git('commit', '--quiet', '-m', 'First');
  const mainCommit = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '-b', 'fix');
  writeFileSync(path.join(repo, 'services', 'thing', 'server.js'), server(false));
  git('commit', '--quiet', '-am', 'Fix b');
  git('checkout', '--quiet', 'main');

  let n = 0;
  const gitStore = async () => {
    const store = fakeStore();
    const port = await closedPort();
    store.state.drafts.d1.implementation = { source: { kind: 'git', url: `file://${repo}`, dir: 'services/thing' }, start: { port, env: { PORT: String(port) }, commands: ['node server.js'] }, ready: { path: '/a', timeout: 20 } };
    const where = path.join(temp, `case-${n++}`);
    const workspaces = createWorkspaces(path.join(where, 'data'), { home: path.join(where, 'home') });
    return { store, workspaces, where };
  };

  test('is the default branch, named, unless a branch, tag or commit is', { timeout: 60_000 }, async () => {
    const { store, workspaces, where } = await gitStore();
    const { testRuns, next } = runsWith(store, { workspaces, dir: path.join(where, 'results'), runner: { ...runner, env: { SMARTSPEC_RUNNER_CACHE: path.join(where, 'cache') } } });
    let done = next();
    await testRuns.start('s1', 'd1');
    const onMain = await done;
    assert.deepEqual({ kind: onMain.code.kind, ref: onMain.code.ref, commit: onMain.code.commit, defaultBranch: onMain.code.defaultBranch }, { kind: 'git', ref: 'main', commit: mainCommit, defaultBranch: true }, JSON.stringify(onMain.log));
    assert.equal(onMain.code.label, `main at ${mainCommit.slice(0, 7)}`);
    assert.equal(onMain.outcome, 'failed');

    done = next();
    await testRuns.start('s1', 'd1', { target: targetOf({ ref: 'fix' }) });
    const onFix = await done;
    assert.equal(onFix.target, 'ref:fix');
    assert.equal(onFix.code.ref, 'fix');
    assert.equal(onFix.outcome, 'passed', JSON.stringify(onFix.log));
    assert.equal(viewOf(testRuns.stateOf('s1'), 'd1', 'default').outcome, 'failed', 'each code has its own view');

    done = next();
    await testRuns.start('s1', 'd1', { target: targetOf({ ref: 'no-such-branch' }) });
    const nowhere = await done;
    assert.match(nowhere.detail, /no branch, tag or commit called no-such-branch/);
  });

  test('is the workspace as it is: cloned by its first run, then changes and all', { timeout: 60_000 }, async () => {
    const { store, workspaces } = await gitStore();
    const { testRuns, next } = runsWith(store, { workspaces });
    const space = await workspaces.info('s1', 'Thing');
    assert.equal(space.cloned, false);

    let done = next();
    await testRuns.start('s1', 'd1', { target: 'workspace' });
    let run = await done;
    assert.deepEqual(run.counts, { passed: 1, failed: 1, error: 0 }, JSON.stringify(run.log));
    assert.equal(run.code.kind, 'workspace');
    assert.equal(run.code.label, `the workspace on main at ${mainCommit.slice(0, 7)}`);
    const cloned = await workspaces.info('s1', 'Renamed');
    assert.equal(cloned.dir, space.dir, 'its place stays as the schematic is renamed');
    assert.equal(cloned.cloned, true);

    // Fixed in the workspace, not committed: a draft of the code, tested before it's committed.
    writeFileSync(path.join(cloned.dir, 'services', 'thing', 'server.js'), server(false));
    done = next();
    await testRuns.start('s1', 'd1', { target: 'workspace' });
    run = await done;
    assert.deepEqual(run.counts, { passed: 2, failed: 0, error: 0 }, JSON.stringify(run.log));
    assert.equal(run.code.changes, 1);
    assert.match(run.code.label, /, 1 file not committed$/);
  });

  test('is kept with every run, read again after a restart, and given to the AI', { timeout: 60_000 }, async () => {
    const { store, workspaces, where } = await gitStore();
    const results = path.join(where, 'results');
    const { testRuns, next } = runsWith(store, { workspaces, dir: results });
    let done = next();
    await testRuns.start('s1', 'd1', { target: 'workspace' });
    const first = await done;
    done = next();
    await testRuns.start('s1', 'd1', { target: 'workspace', only: 'a' });
    await done;

    const again = createTestRuns({ runner, store, dir: results, workspaces });
    assert.equal(again.stateOf('s1').length, 2);
    const given = await again.resultsFor('s1', { workspace: true });
    assert.equal(given.ran, true);
    assert.equal(given.contract, 'draft 1 of 1');
    assert.match(given.code, /^the workspace on main at/);
    assert.equal(given.code_detail.workspace, true);
    assert.equal(given.code_detail.branch_or_ref, 'main');
    assert.deepEqual(given.counts, { passed: 1, failed: 1, couldnt_be_run: 0, not_run: 0 });
    assert.equal(given.problems[0].promise, 'B works');
    assert.equal(given.problems[0].part, '/b');
    assert.equal(given.problems[0].request, 'GET /b');

    const one = await again.resultsFor('s1', { runId: first.id });
    assert.equal(one.run_id, first.id);
    const list = await again.listFor('s1');
    assert.equal(list.length, 2);
    assert.equal(list[0].only, 'a');
    assert.equal(list[1].contract, 'draft 1');
    assert.match(list[1].line, /: 1 passed, 1 failed$/);
    assert.equal((await again.resultsFor('s1', { ref: 'fix' })).ran, false);
  });
});

describe('the AI running the checks', () => {
  test('runs them, waits, and names the code it ran against; or joins a run already going', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns } = runsWith(store);
    let told = null;
    const given = await testRuns.runAndWait('s1', { onEnd: (run, record) => { told = { run, record }; } });
    assert.equal(given.outcome, 'failed');
    assert.equal(given.by, 'ai');
    assert.equal(given.code, url);
    assert.match(given.message, /^Ran against http/);
    assert.deepEqual(given.passed, ['a-works/ok']);
    assert.equal(told.run.counts.failed, 1);
    assert.equal(told.record.name, 'Thing');

    const branch = await testRuns.runAndWait('s1', { only: 'a' });
    assert.equal(branch.outcome, 'passed');
    assert.equal(branch.last_run_was_only, 'a');

    // The user's run going: the AI's waits for it, starting none of its own.
    const users = await testRuns.start('s1', 'd1');
    const joined = await testRuns.runAndWait('s1');
    assert.equal(joined.run_id, users.id);
    assert.equal(joined.by, 'user');
  });

  test('says when it\'s still running, to read the results later', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    store.state.drafts.d1.implementation = { source: { kind: 'running', url: `http://127.0.0.1:${await closedPort()}` }, ready: { path: '/health', timeout: 8 } };
    const { testRuns } = runsWith(store);
    const given = await testRuns.runAndWait('s1', { wait: 5 });
    assert.equal(given.running, true);
    assert.match(given.message, /Still running after 5 s/);
    assert.match(given.message, new RegExp(given.run_id));
    testRuns.stopAll();
  });

  test('runs a proposal\'s only while its implementation is one the user accepted', { timeout: 30_000 }, async () => {
    const store = fakeStore();
    const { testRuns } = runsWith(store);
    store.state.proposal = { name: 'Thing', contract: contract(), implementation: { source: { kind: 'running', url } } };
    assert.equal((await testRuns.runAndWait('s1', { proposal: true })).contract, 'the proposal');
    store.state.proposal = { ...store.state.proposal, implementation: { source: { kind: 'running', url: `${url}/v2` } } };
    await assert.rejects(testRuns.runAndWait('s1', { proposal: true }), /isn't one the user has accepted/);
  });

  test('is told in the chat\'s step what it runs', () => {
    assert.equal(describeStep('run_checks', {}), 'Running the checks');
    assert.equal(describeStep('run_checks', { only: 'order-by-id', workspace: true }), 'Running the checks of “order-by-id” on the workspace');
    assert.equal(describeStep('run_checks', { proposal: true, ref: 'feature-x' }), 'Running the proposal’s checks on “feature-x”');
    assert.equal(describeStep('list_test_runs', {}), 'Looking through the test runs');
  });
});
