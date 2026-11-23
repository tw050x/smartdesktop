import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { contractJob } from './contract.js';

// Running a schematic's contract checks, with the runner (@smartspec/runner, packages/runner: the
// app carries it in its resources as it does the smartspec command, and runs it with its own Node).
// The app makes the job (the checks, all or a branch's, with the setup above each, the shapes, and
// the implementation) and hears the runner's events as JSON lines, so a runner elsewhere could run
// the same job later.
//
// Results are kept per version of a schematic (a draft's id, or 'proposal'), in memory while the app
// runs, each run of a branch replacing only that branch's results. A proposal's results are from the
// proposal as it was when run: changed since (its contract or implementation), they're `stale`; once
// accepted as it was, they're the new draft's.
//
// What a window is sent (`state`): { version, running, phase, only, startedAt, endedAt, outcome,
// detail, counts, results: { 'clause/check': { outcome, detail, ms, status } }, pending, log, stale }.

const LOG_LINES = 1500;
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

// `runner`: { command, args, env } to start the runner's cli.js; `store` (see store.js);
// `onChange(schemaId, version, state)`, told as a run moves on (at most every SEND_EVERY ms).
export function createTestRuns({ runner, store, onChange = () => {} }) {
  const runs = new Map();

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
      const key = keyOf(schemaId, version);
      if (runs.get(key)?.running) throw new Error('Its checks are already running: stop them first, or wait for them to finish.');
      const record = await recordOf(schemaId, version);
      if (!record) throw new Error('There\'s no proposal waiting to run the checks of.');
      if (!record.implementation) throw new Error(`${record.name} has no implementation, so there's nothing to run its checks against. Ask your AI to add one, telling it where the code is.`);
      const { checks, shapes } = contractJob(record.contract, only);
      if (!checks.length) throw new Error(only ? 'There are no checks there to run.' : `${record.name}'s contract has no checks to run yet.`);

      const before = runs.get(key);
      const keys = checks.map((check) => check.key);
      const results = only && before && !before.stale ? Object.fromEntries(Object.entries(before.results).filter(([one]) => !keys.includes(one))) : {};
      const run = {
        schemaId, version, only, basis: basisOf(record), stale: false,
        running: true, phase: 'starting', startedAt: Date.now(), endedAt: null,
        outcome: null, detail: null, counts: null, results, pending: keys, log: [], buffer: '', checked: false,
      };
      runs.set(key, run);

      const job = {
        version: 1,
        id: `${schemaId}-${Date.now().toString(36)}`,
        schematic: { id: schemaId, name: record.name, draftId: version === 'proposal' ? null : version },
        implementation: record.implementation,
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
      return Object.fromEntries([...runs.values()].filter((run) => run.schemaId === schemaId).map((run) => [run.version, publicState(run)]));
    },

    // A schematic changed: a proposal's results are out of date once what was run changes, and are
    // the new draft's once it's accepted as it was.
    async changed(schemaId) {
      for (const run of [...runs.values()]) {
        if (run.version !== 'proposal' || (schemaId && run.schemaId !== schemaId) || run.running) continue;
        const proposal = await store.getProposal(run.schemaId).catch(() => null);
        if (proposal) {
          const stale = basisOf(proposal) !== run.basis;
          if (stale !== run.stale) {
            run.stale = stale;
            send(run, true);
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
      }
    },

    // As the app quits: each runner told to stop, so it tidies up.
    stopAll() {
      for (const run of runs.values()) run.child?.kill('SIGTERM');
    },
  };
}
