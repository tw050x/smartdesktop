import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clausesOf, contractJob } from './contract.js';
import { WORKSPACE_KINDS } from './implementation.js';

// Running a schematic's contract checks, with the runner (@smartspec/runner, packages/runner: the
// app carries it in its resources as it does the smartspec command, and runs it with its own Node).
// The app makes the job (the checks, all or a branch's, with the setup above each, the shapes, and
// the implementation) and hears the runner's events as JSON lines, so a runner elsewhere could run
// the same job later.
//
// Results are kept per version of a schematic (a draft's id, or 'proposal'), each run of a branch
// replacing only that branch's results, and saved on this Mac (`dir`, test-results/<id>.json, never
// in the schematic) once a run ends, so they're there after a restart and the AI can read them
// (get_test_results). A git repository's or Compose file's code is kept in the schematic's
// workspace (`workspaces`, see workspaces.js), cloned there by the first run and tested as it is
// after that; the run names it (`workdir`). A proposal's results are from the
// proposal as it was when run: changed since (its contract or implementation), they're `stale`; once
// accepted as it was, they're the new draft's.
//
// What a window is sent (`state`): { version, running, phase, only, startedAt, endedAt, outcome,
// detail, counts, results: { 'clause/check': { outcome, detail, ms, status } }, pending, log, stale,
// workdir }.

const LOG_LINES = 1500;
const SAVED_LOG_LINES = 300;
const SEND_EVERY = 120;

const basisOf = (record) => createHash('sha256').update(JSON.stringify([record.contract ?? '', record.implementation ?? null])).digest('hex');
const keyOf = (schemaId, version) => `${schemaId}\n${version}`;

// The user's own PATH, from their login shell: an app opened from the Finder has only the system's,
// so neither docker nor npm (Homebrew's, nvm's) would be found.
let shellPath;
function userPath() {
  shellPath ??= new Promise((resolve) => {
    const fallback = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
    if (process.platform === 'win32') return resolve(process.env.PATH);
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\\n__PATH__%s\\n" "$PATH"'], { timeout: 4000, encoding: 'utf8' }, (error, stdout) => {
      const found = stdout?.match(/__PATH__(.*)/)?.[1];
      resolve(found ? [found, fallback].join(':') : fallback);
    });
  });
  return shellPath;
}

// `runner`: { command, args, env } to start the runner's cli.js; `store` (see store.js); `dir`, where
// results are saved (none: kept in memory only); `workspaces`, where code is kept to work on;
// `onChange(schemaId, version, state)`, told as a run moves on (at most every SEND_EVERY ms).
export function createTestRuns({ runner, store, dir = null, workspaces = null, onChange = () => {} }) {
  const runs = new Map();
  // Those waiting for a run to end (runAndWait), by version.
  const waiting = new Map();

  // Saved results, read once per schematic as it's first asked about.
  const loaded = new Set();
  const fileOf = (schemaId) => path.join(dir, `${schemaId.replace(/[^\w-]/g, '_')}.json`);
  function load(schemaId) {
    if (!dir || loaded.has(schemaId)) return;
    loaded.add(schemaId);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(fileOf(schemaId), 'utf8')); } catch { return; }
    for (const [version, state] of Object.entries(saved)) {
      if (!runs.has(keyOf(schemaId, version))) runs.set(keyOf(schemaId, version), { ...state, schemaId, version, running: false, pending: [], phase: null });
    }
  }
  // Every finished run of a schematic; one running keeps what was saved for it before.
  function save(schemaId) {
    if (!dir) return;
    let before = {};
    try { before = JSON.parse(fs.readFileSync(fileOf(schemaId), 'utf8')); } catch {}
    const all = {};
    for (const run of runs.values()) {
      if (run.schemaId !== schemaId) continue;
      if (run.running) {
        if (before[run.version]) all[run.version] = before[run.version];
        continue;
      }
      const { child, timer, schemaId: _id, buffer, checked, running, pending, phase, log, ...kept } = run;
      all[run.version] = { ...kept, log: log.slice(-SAVED_LOG_LINES) };
    }
    fs.mkdirSync(dir, { recursive: true });
    if (Object.keys(all).length) fs.writeFileSync(fileOf(schemaId), JSON.stringify(all));
    else fs.rmSync(fileOf(schemaId), { force: true });
  }

  const publicState = (run) => {
    const { child, timer, basis, schemaId, buffer, checked, ...state } = run;
    return state;
  };
  const send = (run, now = false) => {
    const flush = () => {
      run.timer = null;
      onChange(run.schemaId, run.version, publicState(run));
    };
    if (now) {
      clearTimeout(run.timer);
      flush();
    } else run.timer ??= setTimeout(flush, SEND_EVERY);
  };

  const recordOf = async (schemaId, version) => (version === 'proposal' ? store.getProposal(schemaId) : store.getSchema(schemaId, { draftId: version }));

  function apply(run, event) {
    switch (event.type) {
      case 'phase':
        run.phase = event.phase;
        if (event.phase === 'check') run.checked = true;
        break;
      case 'log':
        run.log.push({ stream: event.stream, text: event.text });
        if (run.log.length > LOG_LINES) run.log.splice(0, run.log.length - LOG_LINES);
        break;
      case 'result': {
        const { type, key, ...result } = event;
        // Before any check ran (the code didn't start), a check's own result says nothing: the run's
        // line says why, once, and the checks stay as they were (Not run), not each marked.
        if (run.checked) run.results[key] = result;
        run.pending = run.pending.filter((one) => one !== key);
        break;
      }
      case 'done':
        run.outcome = event.outcome;
        run.detail = event.detail ?? null;
        run.counts = event.counts;
        break;
      default:
    }
    send(run, event.type === 'done');
  }

  return {
    // Runs the checks of a schematic's draft or proposal (`version`), all of them or a branch's or
    // clause's (`only`, its id). Resolves once it has started.
    async start(schemaId, version, only = null) {
      load(schemaId);
      const key = keyOf(schemaId, version);
      if (runs.get(key)?.running) throw new Error('Its checks are already running: stop them first, or wait for them to finish.');
      const record = await recordOf(schemaId, version);
      if (!record) throw new Error('There\'s no proposal waiting to run the checks of.');
      if (!record.implementation) throw new Error(`${record.name} has no implementation, so there's nothing to run its checks against. Ask your AI to add one, telling it where the code is.`);
      const { checks, shapes } = contractJob(record.contract, only);
      if (!checks.length) throw new Error(only ? 'There are no checks there to run.' : `${record.name}'s contract has no checks to run yet.`);

      const workdir = workspaces && WORKSPACE_KINDS.includes(record.implementation.source.kind) ? workspaces.pathFor(schemaId, record.name) : null;

      const before = runs.get(key);
      const keys = checks.map((check) => check.key);
      const results = only && before && !before.stale ? Object.fromEntries(Object.entries(before.results).filter(([one]) => !keys.includes(one))) : {};
      const run = {
        schemaId, version, only, basis: basisOf(record), stale: false,
        running: true, phase: 'starting', startedAt: Date.now(), endedAt: null,
        outcome: null, detail: null, counts: null, results, pending: keys, log: [], buffer: '', checked: false,
        workdir,
      };
      runs.set(key, run);

      const job = {
        version: 1,
        id: `${schemaId}-${Date.now().toString(36)}`,
        schematic: { id: schemaId, name: record.name, draftId: version === 'proposal' ? null : version },
        implementation: record.implementation,
        ...(workdir ? { workdir } : {}),
        shapes,
        checks,
      };
      const child = spawn(runner.command, [...runner.args, 'run', '-'], { env: { ...process.env, ...runner.env, PATH: await userPath() }, stdio: ['pipe', 'pipe', 'pipe'] });
      run.child = child;
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(job));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const lines = (run.buffer + chunk).split('\n');
        run.buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { apply(run, JSON.parse(line)); } catch { run.log.push({ stream: 'runner', text: line }); }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { for (const text of chunk.split('\n').filter(Boolean)) run.log.push({ stream: 'stderr', text }); });
      const finish = (detail) => {
        if (!run.running) return;
        run.running = false;
        run.endedAt = Date.now();
        run.child = null;
        if (!run.outcome) {
          run.outcome = 'error';
          run.detail = detail;
          if (run.checked) for (const one of run.pending) run.results[one] = { outcome: 'error', detail: 'Not run: the runner stopped.', ms: 0 };
        }
        run.pending = [];
        run.phase = null;
        send(run, true);
        try { save(schemaId); } catch { /* kept in memory */ }
        for (const resolve of waiting.get(key) ?? []) resolve(publicState(run));
        waiting.delete(key);
      };
      child.on('error', (error) => finish(`The runner couldn't be started: ${error.message}.`));
      child.on('close', (code, by) => finish(`The runner stopped unexpectedly (${by ? `stopped by ${by}` : `exit ${code}`}).`));
      send(run, true);
      return publicState(run);
    },

    // Stops a run: the runner tidies up what it started (stops the code, removes its container).
    stop(schemaId, version) {
      const run = runs.get(keyOf(schemaId, version));
      if (run?.child) {
        run.phase = 'stopping';
        run.child.kill('SIGTERM');
        send(run, true);
      }
    },

    // Each version's results for a schematic, by version.
    stateOf(schemaId) {
      load(schemaId);
      return Object.fromEntries([...runs.values()].filter((run) => run.schemaId === schemaId).map((run) => [run.version, publicState(run)]));
    },

    // A schematic changed: a proposal's results are out of date once what was run changes, and are
    // the new draft's once it's accepted as it was.
    async changed(schemaId) {
      if (schemaId) load(schemaId);
      const touched = new Set();
      for (const run of [...runs.values()]) {
        if (run.version !== 'proposal' || (schemaId && run.schemaId !== schemaId) || run.running) continue;
        const proposal = await store.getProposal(run.schemaId).catch(() => null);
        if (proposal) {
          const stale = basisOf(proposal) !== run.basis;
          if (stale !== run.stale) {
            run.stale = stale;
            send(run, true);
            touched.add(run.schemaId);
          }
          continue;
        }
        runs.delete(keyOf(run.schemaId, 'proposal'));
        const latest = await store.getSchema(run.schemaId).catch(() => null);
        if (latest && basisOf(latest) === run.basis && !runs.has(keyOf(run.schemaId, latest.draftId))) {
          run.version = latest.draftId;
          runs.set(keyOf(run.schemaId, latest.draftId), run);
          send(run, true);
        }
        onChange(run.schemaId, 'proposal', null);
        touched.add(run.schemaId);
      }
      for (const one of touched) {
        try { save(one); } catch { /* kept in memory */ }
      }
    },

    // For the AI (run_checks): runs a draft's checks (the latest unless named) or the proposal's,
    // all or a branch's or clause's, as the user would from Test mode (their window shows it as it
    // goes), or joins the run already going; then waits up to `wait` seconds for it to end and gives
    // its results (resultsFor), still running if it hasn't. A run executes the implementation's
    // commands on the user's Mac, so the AI may run only an implementation the user has accepted: a
    // proposal's only while it's the same as the latest draft's.
    // `onEnd(state, record)` is told once it ends, waited for or not.
    async runAndWait(schemaId, { draftId, proposal = false, only = null, wait = 60, onEnd = null } = {}) {
      load(schemaId);
      const record = proposal ? await store.getProposal(schemaId) : await store.getSchema(schemaId, { draftId });
      if (!record) throw new Error('There\'s no proposal waiting on that schematic.');
      if (proposal && record.implementation) {
        const latest = record.line?.length ? await store.getSchema(schemaId).catch(() => null) : null;
        if (JSON.stringify(latest?.implementation ?? null) !== JSON.stringify(record.implementation)) {
          throw new Error('The proposal\'s implementation isn\'t one the user has accepted yet, and running the checks runs its commands on their Mac, so you can\'t run them: ask the user to accept the proposal first, or to run them themselves from Test mode.');
        }
      }
      const version = proposal ? 'proposal' : record.draftId;
      const key = keyOf(schemaId, version);
      if (!runs.get(key)?.running) await this.start(schemaId, version, only);
      const ended = new Promise((resolve) => waiting.set(key, [...(waiting.get(key) ?? []), (state) => {
        resolve(true);
        try { onEnd?.(state, record); } catch { /* only a line for the chat */ }
      }]));
      const seconds = Math.min(Math.max(Number(wait) || 60, 5), 300);
      let timer;
      await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, seconds * 1000); })]);
      clearTimeout(timer);
      const results = await this.resultsFor(schemaId, { draftId: proposal ? undefined : version, proposal });
      return results.running
        ? { ...results, message: `Still running after ${seconds} s (fetching, building or starting it can take a while): call get_test_results in a little while for the results.` }
        : results;
    },

    // The latest results of a draft (the latest unless named) or the proposal, for the AI
    // (get_test_results): how the run went, each check that failed or couldn't be run in full (its
    // promise, request, what it expects and what went wrong), and those passing or not run by key.
    async resultsFor(schemaId, { draftId, proposal = false } = {}) {
      load(schemaId);
      const record = proposal ? await store.getProposal(schemaId) : await store.getSchema(schemaId, { draftId });
      if (!record) throw new Error('There\'s no proposal waiting on that schematic.');
      const version = proposal ? 'proposal' : record.draftId;
      const where = proposal ? 'the proposal' : `draft ${record.number} of ${record.total}`;
      const run = runs.get(keyOf(schemaId, version));
      if (!run) {
        return {
          schematic_id: schemaId, version: where, ran: false,
          message: record.implementation
            ? `Its checks haven't been run on ${where}. The user runs them from SmartSpec's Test mode.`
            : `It has no implementation, so its checks can't be run: propose one (where the code is and how to start it) first, asking the user where the code is.`,
        };
      }
      const titles = new Map(clausesOf(record.contract).map(({ clause, node }) => [clause.id, { clause: clause.title, part: node.name ?? null }]));
      const { checks } = contractJob(record.contract);
      const line = (request) => `${request.method} ${request.path}${request.body !== undefined ? ` ${JSON.stringify(request.body)}` : ''}`;
      const problems = [];
      const passed = [];
      const notRun = [];
      for (const check of checks) {
        const result = run.results[check.key];
        if (!result) notRun.push(check.key);
        else if (result.outcome === 'passed') passed.push(check.key);
        else {
          problems.push({
            key: check.key, outcome: result.outcome === 'error' ? 'couldn\'t be run' : 'failed',
            promise: titles.get(check.clause)?.clause, part: titles.get(check.clause)?.part ?? undefined,
            ...(check.title ? { check: check.title } : {}),
            request: line(check.request), expect: check.expect,
            ...(check.setup.length ? { setup: check.setup.map((step) => step.title ?? line(step.request)) } : {}),
            detail: result.detail,
          });
        }
      }
      return {
        schematic_id: schemaId, version: where, ran: true, running: run.running,
        ran_at: new Date(run.startedAt).toISOString(), outcome: run.running ? 'running' : run.outcome,
        ...(run.detail ? { detail: run.detail } : {}),
        ...(run.only ? { last_run_was_only: run.only } : {}),
        ...(run.stale ? { stale: 'The proposal has changed since these were run.' } : {}),
        ...(run.workdir ? { code_from: `the schematic's workspace on the user's Mac, ${run.workdir}, as it was (uncommitted changes included)` } : {}),
        counts: { passed: passed.length, failed: problems.filter((one) => one.outcome === 'failed').length, couldnt_be_run: problems.filter((one) => one.outcome !== 'failed').length, not_run: notRun.length },
        problems, passed, not_run: notRun,
        ...(run.outcome === 'error' && !run.running ? { log: run.log.slice(-40).map((one) => one.text) } : {}),
      };
    },

    // As the app quits: each runner told to stop, so it tidies up.
    stopAll() {
      for (const run of runs.values()) run.child?.kill('SIGTERM');
    },
  };
}
