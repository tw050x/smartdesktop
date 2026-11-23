import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clausesOf, contractJob } from './contract.js';
import { WORKSPACE_KINDS } from './implementation.js';
import { DEFAULT_TARGET, WORKSPACE_TARGET, refOf, runLine, targetLabel, targetOf, viewOf } from './test-history.js';

// Running a schematic's contract checks, with the runner (@smartspec/runner, packages/runner: the
// app carries it in its resources as it does the smartspec command, and runs it with its own Node).
// The app makes the job (the checks, all or a branch's, with the setup above each, the shapes, the
// implementation, and the code to run: a ref, or the workspace) and hears the runner's events as
// JSON lines, so a runner elsewhere could run the same job later.
//
// Every run is kept (see test-history.js for what a run is and what runs add up to), each saved on
// this Mac once it ends (`dir`/<schematic>/<run>.json, never in the schematic), so the history is
// there after a restart and the AI can read it. A proposal's runs are of the proposal as it was:
// changed since (its contract or implementation), they're `stale`; accepted as it was, they're the
// new draft's. Windows are sent each run as it changes (`onChange(schemaId, run)`).

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
// runs are saved (none: kept in memory only); `workspaces`, where code is kept to work on;
// `onChange(schemaId, run)`, told as a run moves on (at most every SEND_EVERY ms).
export function createTestRuns({ runner, store, dir = null, workspaces = null, onChange = () => {} }) {
  const history = new Map(); // schemaId → Map(runId → run)
  const waiting = new Map(); // runId → [told when it ends]
  const safe = (text) => text.replace(/[^\w-]/g, '_');

  // A schematic's runs, read from disk the first time it's asked about.
  function runsOf(schemaId) {
    if (history.has(schemaId)) return history.get(schemaId);
    const runs = new Map();
    history.set(schemaId, runs);
    if (!dir) return runs;
    let files = [];
    try { files = fs.readdirSync(path.join(dir, safe(schemaId))).filter((name) => name.endsWith('.json')); } catch { return runs; }
    for (const name of files) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(dir, safe(schemaId), name), 'utf8'));
        runs.set(run.id, { ...run, schemaId, running: false, pending: [], phase: null });
      } catch { /* a damaged run is left out */ }
    }
    return runs;
  }
  function save(run) {
    if (!dir || run.running) return;
    const { child, timer, schemaId, buffer, checked, running, pending, phase, log, ...kept } = run;
    const folder = path.join(dir, safe(schemaId));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${safe(run.id)}.json`), JSON.stringify({ ...kept, log: log.slice(-SAVED_LOG_LINES) }));
  }

  const publicRun = (run) => {
    const { child, timer, basis, schemaId, buffer, checked, ...state } = run;
    return state;
  };
  const send = (run, now = false) => {
    const flush = () => {
      run.timer = null;
      onChange(run.schemaId, publicRun(run));
    };
    if (now) {
      clearTimeout(run.timer);
      flush();
    } else run.timer ??= setTimeout(flush, SEND_EVERY);
  };

  const recordOf = async (schemaId, version) => (version === 'proposal' ? store.getProposal(schemaId) : store.getSchema(schemaId, { draftId: version }));
  const runningOn = (schemaId, version, target) => [...runsOf(schemaId).values()].find((run) => run.running && run.version === version && run.target === target);

  function apply(run, event) {
    switch (event.type) {
      case 'phase':
        run.phase = event.phase;
        if (event.phase === 'check') run.checked = true;
        break;
      case 'code': {
        const { type, ...code } = event;
        run.code = code;
        break;
      }
      case 'log':
        run.log.push({ stream: event.stream, text: event.text });
        if (run.log.length > LOG_LINES) run.log.splice(0, run.log.length - LOG_LINES);
        break;
      case 'result': {
        const { type, key, ...result } = event;
        // Before any check ran (the code didn't start), a check's own result says nothing: the run's
        // line says why, once, and the checks stay as they were, not each marked.
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
    send(run, event.type === 'done' || event.type === 'code');
  }

  // What the AI is given for a run of a contract (`record`), or what some runs add up to: how it
  // went, the code it ran against (named, so the AI can correct it), each check that failed or
  // couldn't be run in full, and those passing or not run by key.
  function summary(schemaId, record, version, run, results) {
    const where = version === 'proposal' ? 'the proposal' : `draft ${record.number ?? '?'} of ${record.total ?? '?'}`;
    const titles = new Map(clausesOf(record.contract).map(({ clause, node }) => [clause.id, { clause: clause.title, part: node.name ?? null }]));
    const { checks } = contractJob(record.contract);
    const line = (request) => `${request.method} ${request.path}${request.body !== undefined ? ` ${JSON.stringify(request.body)}` : ''}`;
    const problems = [];
    const passed = [];
    const notRun = [];
    for (const check of checks) {
      const result = results[check.key];
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
    const code = run.code ?? null;
    return {
      schematic_id: schemaId, contract: where, ran: true, run_id: run.id, running: run.running,
      code: code ? code.label : targetLabel(run.target),
      ...(code?.kind === 'git' || code?.kind === 'workspace' ? { code_detail: {
        ...(code.kind === 'workspace' ? { workspace: true } : {}),
        ...(code.ref ? { branch_or_ref: code.ref } : {}),
        ...(code.defaultBranch ? { default_branch: true } : {}),
        ...(code.commit ? { commit: code.commit } : {}),
        ...(code.subject ? { commit_message: code.subject } : {}),
        ...(code.kind === 'workspace' ? { files_not_committed: code.changes ?? 0 } : {}),
      } } : {}),
      ran_at: new Date(run.startedAt).toISOString(), by: run.by, outcome: run.running ? 'running' : run.outcome,
      ...(run.detail ? { detail: run.detail } : {}),
      ...(run.only ? { last_run_was_only: run.only } : {}),
      ...(run.stale ? { stale: 'The proposal has changed since this was run.' } : {}),
      counts: { passed: passed.length, failed: problems.filter((one) => one.outcome === 'failed').length, couldnt_be_run: problems.filter((one) => one.outcome !== 'failed').length, not_run: notRun.length },
      problems, passed, not_run: notRun,
      ...(run.outcome === 'error' && !run.running ? { log: run.log.slice(-40).map((one) => one.text) } : {}),
    };
  }

  // A draft's (the latest unless named) or the proposal's record and version.
  async function contractOf(schemaId, { draftId, proposal = false }) {
    const record = proposal ? await store.getProposal(schemaId) : await store.getSchema(schemaId, { draftId });
    if (!record) throw new Error('There\'s no proposal waiting on that schematic.');
    return { record, version: proposal ? 'proposal' : record.draftId };
  }

  return {
    // Runs the checks of a schematic's draft or proposal (`version`), all of them or a branch's or
    // clause's (`only`, its id), against some code (`target`, see test-history.js); `by` who asked.
    // Resolves with the run once it has started.
    async start(schemaId, version, { only = null, target = DEFAULT_TARGET, by = 'user' } = {}) {
      const runs = runsOf(schemaId);
      if (runningOn(schemaId, version, target)) throw new Error(`Its checks against ${targetLabel(target)} are already running: stop them first, or wait for them to finish.`);
      const record = await recordOf(schemaId, version);
      if (!record) throw new Error('There\'s no proposal waiting to run the checks of.');
      if (!record.implementation) throw new Error(`${record.name} has no implementation, so there's nothing to run its checks against. Ask your AI to add one, telling it where the code is.`);
      const { checks, shapes } = contractJob(record.contract, only);
      if (!checks.length) throw new Error(only ? 'There are no checks there to run.' : `${record.name}'s contract has no checks to run yet.`);
      const kind = record.implementation.source.kind;
      if (target !== DEFAULT_TARGET && !WORKSPACE_KINDS.includes(kind)) throw new Error(`Its code is ${kind === 'running' ? 'something already running' : kind === 'image' ? 'a Docker image' : 'an archive'}, so there's no branch, commit or workspace to choose: run it as the schematic says.`);
      const workdir = target === WORKSPACE_TARGET ? workspaces?.pathFor(schemaId, record.name) : null;
      if (target === WORKSPACE_TARGET && !workdir) throw new Error('There\'s no workspace here to run.');

      const startedAt = Date.now();
      const run = {
        id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, schemaId, version, target, by, only,
        basis: basisOf(record), stale: false,
        running: true, phase: 'starting', startedAt, endedAt: null,
        outcome: null, detail: null, counts: null, results: {}, pending: checks.map((check) => check.key), log: [], buffer: '', checked: false,
        code: null,
      };
      runs.set(run.id, run);

      const job = {
        version: 1,
        id: `${schemaId}-${run.id}`,
        schematic: { id: schemaId, name: record.name, draftId: version === 'proposal' ? null : version },
        implementation: record.implementation,
        ...(workdir ? { workdir } : {}),
        ...(refOf(target) ? { ref: refOf(target) } : {}),
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
        try { save(run); } catch { /* kept in memory */ }
        for (const told of waiting.get(run.id) ?? []) told(publicRun(run));
        waiting.delete(run.id);
      };
      child.on('error', (error) => finish(`The runner couldn't be started: ${error.message}.`));
      child.on('close', (code, by_) => finish(`The runner stopped unexpectedly (${by_ ? `stopped by ${by_}` : `exit ${code}`}).`));
      send(run, true);
      return publicRun(run);
    },

    // Stops a run: the runner tidies up what it started (stops the code, removes its container).
    stop(schemaId, runId) {
      const run = runsOf(schemaId).get(runId);
      if (run?.child) {
        run.phase = 'stopping';
        run.child.kill('SIGTERM');
        send(run, true);
      }
    },

    // Every run of a schematic, newest first, for its windows.
    stateOf(schemaId) {
      return [...runsOf(schemaId).values()].sort((a, b) => b.startedAt - a.startedAt).map(publicRun);
    },

    // A schematic changed: a proposal's runs are out of date once what was run changes, and are the
    // new draft's once it's accepted as it was (else they stay, out of date, in the history).
    async changed(schemaId) {
      const ids = schemaId ? [schemaId] : [...history.keys()];
      for (const id of ids) {
        const proposalRuns = [...runsOf(id).values()].filter((run) => run.version === 'proposal' && !run.running);
        if (!proposalRuns.length) continue;
        const proposal = await store.getProposal(id).catch(() => null);
        const latest = proposal ? null : await store.getSchema(id).catch(() => null);
        for (const run of proposalRuns) {
          let changed = false;
          if (proposal) {
            const stale = basisOf(proposal) !== run.basis;
            if (stale !== run.stale) { run.stale = stale; changed = true; }
          } else if (latest && basisOf(latest) === run.basis && !run.stale) {
            run.version = latest.draftId;
            changed = true;
          } else if (!run.stale) {
            run.stale = true;
            changed = true;
          }
          if (changed) {
            send(run, true);
            try { save(run); } catch { /* kept in memory */ }
          }
        }
      }
    },

    // For the AI (run_checks): runs a draft's checks (the latest unless named) or the proposal's,
    // all or a branch's or clause's, against the code it names (`ref`, a branch, tag or commit; or
    // `workspace`; else the default branch), as the user would from Test mode (their window shows it
    // as it goes), or joins that run if it's already going; then waits up to `wait` seconds and gives
    // its results, still running if it hasn't ended. A run executes the implementation's commands on
    // the user's Mac, so the AI may run only an implementation the user has accepted: a proposal's
    // only while it's the same as the latest draft's. `onEnd(run, record)` is told once it ends.
    async runAndWait(schemaId, { draftId, proposal = false, only = null, ref = null, workspace = false, wait = 60, onEnd = null } = {}) {
      const { record, version } = await contractOf(schemaId, { draftId, proposal });
      if (proposal && record.implementation) {
        const latest = record.line?.length ? await store.getSchema(schemaId).catch(() => null) : null;
        if (JSON.stringify(latest?.implementation ?? null) !== JSON.stringify(record.implementation)) {
          throw new Error('The proposal\'s implementation isn\'t one the user has accepted yet, and running the checks runs its commands on their Mac, so you can\'t run them: ask the user to accept the proposal first, or to run them themselves from Test mode.');
        }
      }
      const target = targetOf({ ref, workspace });
      const run = runningOn(schemaId, version, target) ?? await this.start(schemaId, version, { only, target, by: 'ai' });
      const ended = new Promise((resolve) => waiting.set(run.id, [...(waiting.get(run.id) ?? []), (state) => {
        resolve(true);
        try { onEnd?.(state, record); } catch { /* only a line for the chat */ }
      }]));
      const seconds = Math.min(Math.max(Number(wait) || 60, 5), 300);
      let timer;
      await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, seconds * 1000); })]);
      clearTimeout(timer);
      const now = runsOf(schemaId).get(run.id);
      const given = summary(schemaId, record, version, now, now.results);
      return now.running
        ? { ...given, message: `Still running after ${seconds} s (fetching, building or starting it can take a while): call get_test_results with run_id ${now.id} in a little while for the results.` }
        : { ...given, message: `Ran against ${given.code}. If that isn't the code you meant, run them again naming the branch, tag or commit (ref), or the workspace.` };
    },

    // For the AI (get_test_results): a run (`runId`), or the latest results of a draft's contract
    // (the latest unless named) or the proposal's against some code (`ref`, `workspace`, else the
    // code it was last run against), as they add up across its runs.
    async resultsFor(schemaId, { draftId, proposal = false, ref = null, workspace = false, runId = null } = {}) {
      const runs = runsOf(schemaId);
      if (runId) {
        const run = runs.get(runId);
        if (!run) throw new Error(`There's no run ${runId} of that schematic: list_test_runs gives them.`);
        const record = await recordOf(schemaId, run.version).catch(() => null);
        if (!record) throw new Error(`Run ${runId} was of a proposal that's gone: its contract can't be read any more.`);
        return summary(schemaId, record, run.version, run, run.results);
      }
      const { record, version } = await contractOf(schemaId, { draftId, proposal });
      const asked = ref || workspace ? targetOf({ ref, workspace }) : null;
      const target = asked ?? [...runs.values()].filter((run) => run.version === version && !run.stale).sort((a, b) => b.startedAt - a.startedAt)[0]?.target;
      const view = target ? viewOf([...runs.values()], version, target) : null;
      if (!view) {
        const where = version === 'proposal' ? 'the proposal' : `draft ${record.number} of ${record.total}`;
        return {
          schematic_id: schemaId, contract: where, ran: false,
          message: record.implementation
            ? `Its checks haven't been run on ${where}${asked ? ` against ${targetLabel(asked)}` : ''}. Run them with run_checks, or the user runs them from SmartSpec's Test mode.`
            : `It has no implementation, so its checks can't be run: propose one (where the code is and how to start it) first, asking the user where the code is.`,
        };
      }
      return summary(schemaId, record, version, view, view.results);
    },

    // For the AI (list_test_runs): the runs of a schematic, newest first, each in a line.
    async listFor(schemaId, { limit = 20 } = {}) {
      const latest = await store.getSchema(schemaId).catch(() => null);
      const number = (draftId) => (latest?.line?.includes(draftId) ? `draft ${latest.line.indexOf(draftId) + 1}` : `draft ${draftId}`);
      return [...runsOf(schemaId).values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((run) => ({
        run_id: run.id, ran_at: new Date(run.startedAt).toISOString(), by: run.by,
        contract: run.version === 'proposal' ? 'the proposal' : number(run.version), ...(run.version !== 'proposal' ? { draft_id: run.version } : {}),
        code: run.code?.label ?? targetLabel(run.target),
        ...(run.code?.commit ? { commit: run.code.commit } : {}),
        ...(run.only ? { only: run.only } : {}),
        outcome: run.running ? 'running' : run.outcome,
        ...(run.stale ? { stale: true } : {}),
        line: runLine(run),
      }));
    },

    // As the app quits: each runner told to stop, so it tidies up.
    stopAll() {
      for (const runs of history.values()) for (const run of runs.values()) run.child?.kill('SIGTERM');
    },
  };
}
