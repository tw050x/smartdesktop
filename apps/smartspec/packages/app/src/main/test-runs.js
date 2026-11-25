import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clausesOf, contractJob, expectationsJob, isUseKey, useKey } from './contract.js';
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

// What a use relies on, as run: a run's results for it count only while it's the same.
export const useBasis = (use) => createHash('sha256').update(JSON.stringify([use.expects ?? null, use.with ?? {}])).digest('hex');
// A run started by itself is for a change made in the last few minutes only, never one found
// waiting after a restart.
const AUTO_WITHIN_MS = 10 * 60_000;
const basisOf = (record) => createHash('sha256').update(JSON.stringify([record.contract ?? '', record.implementation ?? null])).digest('hex');

// A repository's branches and tags, and its default branch (what its HEAD names), read from it
// without cloning (`git ls-remote`): { defaultBranch, branches, tags }, defaultBranch null when it
// doesn't say. Never asks for a login.
export async function refsOf(url, env = process.env) {
  const out = await new Promise((resolve, reject) => {
    execFile('git', ['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*', 'refs/tags/*'], { env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' }, timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim().split('\n').at(-1))) : resolve(stdout)));
  });
  const defaultBranch = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? null;
  const names = (prefix) => [...new Set([...out.matchAll(new RegExp(`\\s${prefix}(\\S+?)(\\^\\{\\})?$`, 'gm'))].map((match) => match[1]))];
  const branches = names('refs/heads/');
  return { defaultBranch, branches: defaultBranch ? [defaultBranch, ...branches.filter((one) => one !== defaultBranch)] : branches, tags: names('refs/tags/').sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) };
}

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
// `secrets`, the values of its secrets on this Mac (see secrets.js), given to the runner in its job;
// `onChange(schemaId, run)`, told as a run moves on (at most every SEND_EVERY ms).
// How long a branch's head, read from its repository, is trusted before it's read again.
const HEAD_FRESH_MS = 5 * 60_000;

// A branch's head commit, read from its repository without cloning; null if it can't be read.
async function headCommit(url, branch, env) {
  return new Promise((resolve) => {
    execFile('git', ['ls-remote', url, `refs/heads/${branch}`], { env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' }, timeout: 20_000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout.split(/\s/)[0] || null));
  });
}

export function createTestRuns({ runner, store, dir = null, workspaces = null, secrets = null, onChange = () => {}, onStatus = () => {}, readHead = null }) {
  // Branches' heads (`url branch` → { commit, at, reading }), for whether a passing run is still of
  // the code there (see statusOf).
  const heads = new Map();
  const readHeadOf = readHead ?? (async (url, branch) => headCommit(url, branch, { ...process.env, PATH: await userPath() }));
  const history = new Map(); // schemaId → Map(runId → run)
  const autoTried = new Set(); // the changes runs have been started for by themselves (see auto)
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
  function summary(schemaId, record, version, run, results, uses = null) {
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
    const moved = run.target === DEFAULT_TARGET && !run.running && movedOn(schemaId, record, run);
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
      ...(moved ? { out_of_date: `Its default branch has moved on since this ran (${code.ref} isn't at ${code.commit.slice(0, 7)} any more): run the checks again to check the code as it is now.` } : {}),
      counts: { passed: passed.length, failed: problems.filter((one) => one.outcome === 'failed').length, couldnt_be_run: problems.filter((one) => one.outcome !== 'failed').length, not_run: notRun.length },
      problems, passed, not_run: notRun,
      ...(dependents(run, results, { moved, uses }).length ? { dependents: dependents(run, results, { moved, uses }) } : {}),
      ...(run.outcome === 'error' && !run.running ? { log: run.log.slice(-40).map((one) => one.text) } : {}),
    };
  }

  // How what each schematic depending on it relies on went in a run (`results`, the run's or what
  // its runs add up to), for the AI: [{ schematic_id, schematic, use, counts, problems }].
  // Each is out of date (`out_of_date`, why) once the code has moved on (`moved`), or what it relies
  // on has changed since (`uses`, the dependents' uses now, by `owner/use`, when known).
  function dependents(run, results, { moved = false, uses = null } = {}) {
    const line = (request) => `${request.method} ${request.path}${request.body !== undefined ? ` ${JSON.stringify(request.body)}` : ''}`;
    return (run.consumers ?? []).map((one) => {
      const prefix = useKey(one.schemaId, one.use);
      const titles = new Map(clausesOf(one.expects).map(({ clause }) => [`${prefix}${clause.id}`, clause.title]));
      const { checks } = expectationsJob(one.expects, { ownerId: one.schemaId, useId: one.use });
      const problems = [];
      let passed = 0;
      let notRun = 0;
      for (const check of checks) {
        const result = results[check.key];
        if (!result) notRun++;
        else if (result.outcome === 'passed') passed++;
        else problems.push({ key: check.key.slice(prefix.length), outcome: result.outcome === 'error' ? 'couldn\'t be run' : 'failed', relies_on: titles.get(check.clause), ...(check.title ? { check: check.title } : {}), request: line(check.request), expect: check.expect, detail: result.detail });
      }
      const now = uses?.get(`${one.schemaId}/${one.use}`) ?? [];
      const changed = uses && !now.some((use) => useBasis(use) === one.basis);
      const outOfDate = changed ? (now.length ? 'What it relies on has changed since this ran: run the checks again.' : 'It no longer relies on this schematic as it did when this ran.')
        : moved ? 'The default branch has moved on since this ran.' : null;
      return { schematic_id: one.schemaId, schematic: one.name, use: one.use, ...(one.version === 'proposal' ? { from_its_proposal: true } : {}), ...(outOfDate ? { out_of_date: outOfDate } : {}), counts: { passed, failed: problems.filter((p) => p.outcome === 'failed').length, couldnt_be_run: problems.filter((p) => p.outcome !== 'failed').length, not_run: notRun }, problems };
    });
  }

  // How a set of keys stands in what some runs add up to: { status, total, failed, unchecked, notRun }.
  function standingOf(view, keys) {
    const outcomes = keys.map((key) => view?.results[key]?.outcome);
    const failed = outcomes.filter((one) => one === 'failed').length;
    const unchecked = outcomes.filter((one) => one === 'error').length;
    const notRun = outcomes.filter((one) => !one).length;
    const status = failed ? 'failing' : unchecked ? 'cant-run' : notRun ? (view && !view.running && view.outcome === 'error' && notRun === keys.length ? 'cant-run' : 'implemented') : 'passing';
    return { status, total: keys.length, failed, unchecked, notRun, running: Boolean(view?.running), ...(view ? { code: view.code?.label ?? targetLabel(view.target), at: view.startedAt } : {}) };
  }

  // Whether the branch a view's code came from has moved on since it ran: its head, read from the
  // repository at most every HEAD_FRESH_MS (`onStatus(schemaId)` says when that changes it).
  function movedOn(schemaId, record, view) {
    const source = record?.implementation?.source;
    const code = view?.code;
    if (!WORKSPACE_KINDS.includes(source?.kind) || !code?.commit || !code.ref) return false;
    const key = `${source.url} ${code.ref}`;
    const head = heads.get(key);
    if ((!head || Date.now() - head.at > HEAD_FRESH_MS) && !head?.reading) {
      heads.set(key, { ...head, at: head?.at ?? 0, reading: true });
      readHeadOf(source.url, code.ref).then((commit) => {
        heads.set(key, { commit: commit ?? head?.commit ?? null, at: Date.now(), reading: false });
        if (commit && commit !== head?.commit) onStatus(schemaId);
      }, () => heads.set(key, { ...head, at: Date.now(), reading: false }));
    }
    const known = heads.get(key)?.commit;
    return Boolean(known && !known.startsWith(code.commit) && !code.commit.startsWith(known));
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
    // `ownerVersion`, for a use's own run: the owner's draft or proposal whose expects to run.
    async start(schemaId, version, { only = null, target = DEFAULT_TARGET, by = 'user', ownerVersion = null } = {}) {
      const runs = runsOf(schemaId);
      if (runningOn(schemaId, version, target)) throw new Error(`Its checks against ${targetLabel(target)} are already running: stop them first, or wait for them to finish.`);
      const record = await recordOf(schemaId, version);
      if (!record) throw new Error('There\'s no proposal waiting to run the checks of.');
      if (!record.implementation) throw new Error(`${record.name} has no implementation, so there's nothing to run its checks against. Ask your AI to add one, telling it where the code is.`);
      // Its own checks (all, or a branch's or clause's), and what those depending on it rely on (see
      // expectationsJob in contract.js), run against the same code: a run of a branch runs none of
      // theirs, and one of a use's (`only`, use:<owner>/<use>) none of its own.
      const ofUse = only && isUseKey(only);
      const own = contractJob(record.contract, ofUse ? null : only);
      const checks = ofUse ? [] : own.checks;
      const shapes = { ...own.shapes };
      const consumers = [];
      if (!only || ofUse) {
        const latestId = record.line?.at(-1) ?? null;
        const follows = (use) => (use.pin ? use.pin === version : version === 'proposal' || version === latestId);
        const chosen = new Map();
        const dependents = store.dependentsOf ? await store.dependentsOf(schemaId).catch(() => []) : [];
        for (const one of dependents) {
          const prefix = useKey(one.ownerId, one.use.id);
          if (ofUse ? !prefix.startsWith(`${only.replace(/\/$/, '')}/`) : !follows(one.use)) continue;
          // An owner's accepted draft, unless its proposal is the one asked for.
          const kept = chosen.get(prefix);
          const wanted = ofUse && ownerVersion ? one.version === ownerVersion : one.version !== 'proposal';
          if (!kept || (wanted && !kept.wanted)) chosen.set(prefix, { ...one, wanted });
        }
        for (const one of chosen.values()) {
          const job = expectationsJob(one.use.expects, { ownerId: one.ownerId, useId: one.use.id, values: one.use.with ?? {} });
          if (!job.checks.length) continue;
          Object.assign(shapes, job.shapes, own.shapes);
          checks.push(...job.checks);
          consumers.push({ schemaId: one.ownerId, name: one.ownerName, version: one.version, use: one.use.id, basis: useBasis(one.use), expects: one.use.expects });
        }
      }
      if (!checks.length) throw new Error(ofUse ? 'There\'s nothing relied on there to run.' : only ? 'There are no checks there to run.' : `${record.name}'s contract has no checks to run yet.`);
      const kind = record.implementation.source.kind;
      if (target !== DEFAULT_TARGET && !WORKSPACE_KINDS.includes(kind)) throw new Error(`Its code is ${kind === 'running' ? 'something already running' : kind === 'image' ? 'a Docker image' : 'an archive'}, so there's no branch, commit or workspace to choose: run it as the schematic says.`);
      const workdir = target === WORKSPACE_TARGET ? workspaces?.pathFor(schemaId, record.name) : null;
      if (target === WORKSPACE_TARGET && !workdir) throw new Error('There\'s no workspace here to run.');
      // Its secrets' values, or no run: one missing would only crash it halfway, confusingly.
      const given = secrets ? secrets.valuesFor(schemaId, record.implementation) : { values: [], missing: (record.implementation.secrets ?? []).map((one) => one.name) };
      if (given.missing.length) {
        const error = new Error(`${record.name} needs ${given.missing.length === 1 ? 'a secret' : 'secrets'} not set on this Mac yet: ${given.missing.join(', ')}. Set ${given.missing.length === 1 ? 'it' : 'them'} in Test mode, under Implementation › Secrets.`);
        error.missingSecrets = given.missing;
        throw error;
      }

      const startedAt = Date.now();
      const run = {
        id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, schemaId, version, target, by, only,
        basis: basisOf(record), stale: false, consumers,
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
        ...(given.values.length ? { secrets: given.values } : {}),
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

    // A schematic's status (the brief's states: what the user sees on home and on what embeds it),
    // for one of its versions (a draft's id, or 'proposal') and its record: the contract against
    // the code it's meant for, the default branch.
    // - 'design-only': no implementation, or no checks;
    // - 'implemented': never run against the default branch, or not every check yet;
    // - 'failing': a check failed;
    // - 'cant-run': none failed, but the code didn't start, or a check couldn't be run;
    // - 'out-of-date': it passed, but the branch has moved on since (its head, read from the
    //   repository now and then: when that changes, `onStatus(schemaId)` says so), or an earlier
    //   draft was run and this one hasn't been (its contract or code changed since);
    // - 'passing': every check passed, on the branch's head as last read.
    statusOf(schemaId, version, record) {
      if (!record?.implementation) return 'design-only';
      let checks = [];
      try { checks = contractJob(record.contract).checks; } catch { /* no checks */ }
      if (!checks.length) return 'design-only';
      const runs = [...runsOf(schemaId).values()];
      const view = viewOf(runs, version, DEFAULT_TARGET);
      if (!view) {
        const earlier = version !== 'proposal' && runs.some((run) => run.target === DEFAULT_TARGET && run.version !== version && run.version !== 'proposal');
        return earlier ? 'out-of-date' : 'implemented';
      }
      const outcomes = checks.map((check) => view.results[check.key]?.outcome);
      if (outcomes.includes('failed')) return 'failing';
      if (outcomes.includes('error')) return 'cant-run';
      if (outcomes.every((one) => !one)) return !view.running && view.outcome === 'error' ? 'cant-run' : 'implemented';
      if (outcomes.some((one) => !one)) return 'implemented';
      if (movedOn(schemaId, record, view)) return 'out-of-date';
      return 'passing';
    },

    // How what a schematic (`ownerId`) relies on from one it embeds (`use`, its `expects`) stands
    // against the embedded one's code, for the draft of it the use shows (`version`, its record
    // `record`): its runs against the default branch that ran this use's expects as they are now.
    // { status, total, failed, unchecked, notRun, running, code, at }, or null with nothing to run;
    // status 'design-only' while it has no code.
    expectationsOf(schemaId, version, record, ownerId, use) {
      let keys = [];
      try { keys = expectationsJob(use.expects, { ownerId, useId: use.id }).checks.map((check) => check.key); } catch { /* none */ }
      if (!keys.length) return null;
      if (!record?.implementation) return { status: 'design-only', total: keys.length, failed: 0, unchecked: 0, notRun: keys.length, running: false };
      const basis = useBasis(use);
      const ofUse = [...runsOf(schemaId).values()].filter((run) => run.target === DEFAULT_TARGET && run.consumers?.some((one) => one.schemaId === ownerId && one.use === use.id));
      const runs = ofUse.filter((run) => run.consumers.some((one) => one.schemaId === ownerId && one.use === use.id && one.basis === basis));
      const view = viewOf(runs, version, DEFAULT_TARGET);
      // Its results by the keys its own tree has (`clause/check`), and what's running, for drawing it.
      const prefix = useKey(ownerId, use.id);
      const results = Object.fromEntries(Object.entries(view?.results ?? {}).filter(([key]) => key.startsWith(prefix)).map(([key, result]) => [key.slice(prefix.length), result]));
      const pending = (view?.running ? view.pending ?? [] : []).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
      const standing = standingOf(view, keys);
      // Out of date, as its own checks go: it passed, but the code has moved on since (`stale:
      // 'code'`), or it never ran on this draft of the embedded one, or on what it relies on as it
      // is now, though it ran before (`stale: 'draft'`, `'expects'`).
      const stale = view
        ? (standing.status === 'passing' && movedOn(schemaId, record, view) ? 'code' : null)
        : ofUse.some((run) => run.version !== version && run.version !== 'proposal' && run.consumers.some((one) => one.schemaId === ownerId && one.use === use.id && one.basis === basis)) ? 'draft'
          : ofUse.some((run) => run.version === version) ? 'expects' : null;
      return { ...standing, ...(stale && { status: 'out-of-date', stale }), results, pending };
    },

    // Every run of a schematic, newest first, for its windows.
    stateOf(schemaId) {
      return [...runsOf(schemaId).values()].sort((a, b) => b.startedAt - a.startedAt).map(publicRun);
    },

    // A schematic changed: a proposal's runs are out of date once what was run changes, and are the
    // new draft's once it's accepted as it was (else they stay, out of date, in the history).
    async changed(schemaId) {
      if (schemaId) this.auto(schemaId).catch(() => {});
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
      const run = runningOn(schemaId, version, target) ?? await this.start(schemaId, version, { only, target, by: 'ai' }).catch((error) => {
        if (!error.missingSecrets) throw error;
        const random = (record.implementation.secrets ?? []).filter((one) => error.missingSecrets.includes(one.name) && one.random).map((one) => one.name);
        const entered = error.missingSecrets.filter((name) => !random.includes(name));
        throw new Error(`The checks weren't run: ${record.name} needs secrets not set on the user's Mac: ${error.missingSecrets.join(', ')}. ${random.length ? `${random.join(', ')} can be made at random: generate_secrets makes ${random.length === 1 ? 'it' : 'them'} (you never see the values). ` : ''}${entered.length ? `Only the user can enter ${entered.join(', ')}: ask them to, in Test mode under Implementation › Secrets.` : 'Then run the checks again.'}`);
      });
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
      // What depends on it now, by `owner/use` (a draft's and a proposal's), to tell what's changed.
      const uses = store.dependentsOf ? new Map() : null;
      for (const one of store.dependentsOf ? await store.dependentsOf(schemaId).catch(() => []) : []) {
        const key = `${one.ownerId}/${one.use.id}`;
        uses.set(key, [...(uses.get(key) ?? []), one.use]);
      }
      if (runId) {
        const run = runs.get(runId);
        if (!run) throw new Error(`There's no run ${runId} of that schematic: list_test_runs gives them.`);
        const record = await recordOf(schemaId, run.version).catch(() => null);
        if (!record) throw new Error(`Run ${runId} was of a proposal that's gone: its contract can't be read any more.`);
        return summary(schemaId, record, run.version, run, run.results, uses);
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
      return summary(schemaId, record, version, view, view.results, uses);
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

    // How a proposal's checks stand, for the accept confirmation (the user's choice: it warns,
    // never blocks, as a contract can be written ahead of its code): its latest run's code, and what
    // its runs against that code add up to. { state: 'none' | 'not-run' | 'running' | 'didnt-run' |
    // 'failing' | 'passing', total, failed, unchecked, code, detail }.
    // `dependents`, how what each schematic depending on it relies on stands in those runs:
    // [{ name, use, failed, unchecked, notRun, total, broken: [what it relies on that fails now, and
    // didn't on the latest draft], already: [what failed there too] }].
    async proposalStanding(schemaId) {
      const proposal = await store.getProposal(schemaId).catch(() => null);
      if (!proposal?.implementation) return { state: 'none' };
      const total = contractJob(proposal.contract).checks.length;
      const runs = [...runsOf(schemaId).values()].filter((run) => run.version === 'proposal' && !run.stale).sort((a, b) => b.startedAt - a.startedAt);
      const view = runs.length ? viewOf(runs, 'proposal', runs[0].target) : null;
      // What already failed on the latest draft, against its default branch, isn't this change's doing.
      const latestId = proposal.line?.at(-1) ?? null;
      const failedBefore = (one, key) => {
        const before = [...runsOf(schemaId).values()].filter((run) => run.consumers?.some((other) => other.schemaId === one.schemaId && other.use === one.use && other.basis === one.basis));
        const result = latestId ? viewOf(before, latestId, DEFAULT_TARGET)?.results[key] : null;
        return Boolean(result) && result.outcome !== 'passed';
      };
      const deps = (view?.consumers ?? []).map((one) => {
        const prefix = useKey(one.schemaId, one.use);
        const titles = new Map(clausesOf(one.expects).map(({ clause }) => [`${prefix}${clause.id}`, clause.title]));
        const checks = expectationsJob(one.expects, { ownerId: one.schemaId, useId: one.use }).checks;
        const standing = standingOf(view, checks.map((check) => check.key));
        const failing = checks.filter((check) => view.results[check.key] && view.results[check.key].outcome !== 'passed');
        const broken = [...new Set(failing.filter((check) => !failedBefore(one, check.key)).map((check) => titles.get(check.clause)))];
        const already = [...new Set(failing.filter((check) => failedBefore(one, check.key)).map((check) => titles.get(check.clause)))].filter((title) => !broken.includes(title));
        return { name: one.name, use: one.use, ...standing, broken, already };
      });
      const also = deps.length ? { dependents: deps } : {};
      if (!total) return { state: 'none', ...also };
      if (!runs.length) return { state: 'not-run', total, ...also };
      const code = view.code?.label ?? targetLabel(view.target);
      if (view.running) return { state: 'running', total, code, ...also };
      const outcomes = contractJob(proposal.contract).checks.map((check) => view.results[check.key]?.outcome);
      const failed = outcomes.filter((one) => one === 'failed').length;
      const unchecked = outcomes.filter((one) => one === 'error').length;
      const missing = outcomes.filter((one) => !one).length;
      if (!failed && !unchecked && missing === total) return { state: 'didnt-run', total, code, detail: view.detail, ...also };
      if (failed || unchecked || missing) return { state: 'failing', total, failed, unchecked, missing, code, ...also };
      return { state: 'passing', total, code, ...also };
    },

    // Runs started by themselves, as a schematic changes (the user's choice, 2026-11-25: a change to
    // a contract should show what it breaks for the schematics depending on it, with nothing to
    // start). Each is tried once, for a change made in the last few minutes, and never asks: one that
    // can't start (a secret not set, no code) is left for the user to run.
    // - A proposal that changes the contract, its code the accepted (the AI may run only that, so
    //   it does by itself only that): its checks and its dependents', against the workspace where
    //   there's one, else the default branch.
    // - A new draft whose contract changed: the same, against the default branch, unless the
    //   proposal's run became its own on accepting.
    // - A new draft of a schematic that changed what it relies on from one it embeds: those checks,
    //   against that one's code.
    async auto(schemaId) {
      const fresh = (at) => at && Date.now() - new Date(at).getTime() < AUTO_WITHIN_MS;
      const once = (key) => (autoTried.has(key) ? false : (autoTried.add(key), true));
      const go = (id, version, options) => this.start(id, version, { ...options, by: 'auto' }).catch(() => null);
      const latest = await store.getSchema(schemaId).catch(() => null);
      const proposal = await store.getProposal(schemaId).catch(() => null);
      const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      if (proposal?.implementation && latest && fresh(proposal.createdAt ?? latest.proposal?.createdAt) && same(latest.implementation, proposal.implementation) && !same(latest.contract || null, proposal.contract || null) && once(`${schemaId} proposal ${basisOf(proposal)}`)) {
        const kind = proposal.implementation.source?.kind;
        const cloned = workspaces && WORKSPACE_KINDS.includes(kind) ? (await workspaces.info(schemaId, proposal.name).catch(() => null))?.cloned : false;
        const target = cloned ? WORKSPACE_TARGET : DEFAULT_TARGET;
        if (!runningOn(schemaId, 'proposal', target)) await go(schemaId, 'proposal', { target });
      }
      if (!latest || !fresh(latest.createdAt)) return;
      const before = latest.line.length > 1 ? await store.getSchema(schemaId, { draftId: latest.line.at(-2) }).catch(() => null) : null;
      const ran = [...runsOf(schemaId).values()].some((run) => run.version === latest.draftId);
      if (latest.implementation && !ran && !same(before?.contract || null, latest.contract || null) && once(`${schemaId} draft ${latest.draftId}`)) await go(schemaId, latest.draftId, {});
      for (const use of latest.uses ?? []) {
        if (!use.expects || use.missing) continue;
        const was = before?.uses?.find((one) => one.id === use.id);
        if (was && same(was.expects, use.expects) && same(was.with, use.with) && was.schemaId === use.schemaId) continue;
        if (once(`${schemaId} use ${use.id} ${useBasis(use)}`)) await go(use.schemaId, use.draftId, { only: useKey(schemaId, use.id).slice(0, -1) });
      }
    },

    // The branches and tags a draft's or the proposal's code can be run at, for the window's Branch
    // menu: its repository's (see refsOf), its default the one the schematic names (its ref), else
    // the repository's own; null default when neither says, and the user picks one.
    async branchesOf(schemaId, version) {
      const record = await recordOf(schemaId, version);
      const source = record?.implementation?.source;
      if (!source || !WORKSPACE_KINDS.includes(source.kind)) return null;
      const refs = await refsOf(source.url, { ...process.env, PATH: await userPath() });
      return { ...refs, defaultBranch: source.ref ?? refs.defaultBranch, named: Boolean(source.ref) };
    },

    // As the app quits: each runner told to stop, so it tidies up.
    stopAll() {
      for (const runs of history.values()) for (const run of runs.values()) run.child?.kill('SIGTERM');
    },
  };
}
