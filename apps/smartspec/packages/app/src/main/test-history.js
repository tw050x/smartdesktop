// A schematic's test runs, kept as a history (the user's choice: every run, accepted and draft), and
// what they add up to. Plain data and no Node, as the main process (for the AI) and the window (to
// draw it) both use it.
//
// A run is a contract against some code (the user's model): the contract of an accepted draft (any,
// old ones too, to check compatibility over time) or the proposal (`version`: a draft's id, or
// 'proposal'), and the code (`target`) of the default branch, the workspace as it is (uncommitted
// changes and all: a draft of the code, tested before it's committed), or a branch, tag or commit
// named (`ref:<name>`). `code` says what that resolved to ({ kind, ref, commit, subject, changes,
// label }, from the runner).
//   run: { id, version, target, by: 'user' | 'ai', only, startedAt, endedAt, running, phase, outcome,
//          detail, counts, results: { 'clause/check': { outcome, detail, ms } }, pending, code, log,
//          stale }

export const DEFAULT_TARGET = 'default';
export const WORKSPACE_TARGET = 'workspace';

// The target for some code asked for: { ref } or { workspace: true }, or neither for the default.
export const targetOf = ({ ref = null, workspace = false } = {}) => (workspace ? WORKSPACE_TARGET : ref ? `ref:${ref}` : DEFAULT_TARGET);
export const refOf = (target) => (target?.startsWith('ref:') ? target.slice(4) : null);

// A target in words, with what it last resolved to if known: "main (the default branch)",
// "the workspace", "feature-x".
export function targetLabel(target, code = null) {
  if (target === WORKSPACE_TARGET) return 'the workspace';
  if (target === DEFAULT_TARGET) return code?.ref ? `${code.ref} (the default branch)` : 'the default branch';
  return refOf(target);
}

const newestFirst = (runs) => [...runs].sort((a, b) => b.startedAt - a.startedAt);

// What the runs of one contract against one code add up to: the latest run (how it went, what it's
// doing), and each check's latest result, back to the last full run (a branch run again replaces
// only its own checks' results). Runs gone out of date (a proposal changed since) don't count. Null
// if there are none.
export function viewOf(runs, version, target) {
  const those = newestFirst(runs.filter((run) => run.version === version && run.target === target && !run.stale));
  if (!those.length) return null;
  const [latest] = those;
  const results = {};
  for (const run of those) {
    for (const [key, result] of Object.entries(run.results ?? {})) if (!(key in results) && !(run.running && run.pending?.includes(key))) results[key] = result;
    if (!run.only && !run.running) break;
  }
  return { ...latest, results, pending: latest.running ? latest.pending ?? [] : [] };
}

// The targets a version has been run against, the most recently run first.
export function targetsOf(runs, version) {
  const seen = [];
  for (const run of newestFirst(runs)) if (run.version === version && !seen.includes(run.target)) seen.push(run.target);
  return seen;
}

// A run in a line, for the history and the AI: "main at 1a2b3c4: 3 passed, 1 failed".
export function runLine(run) {
  const code = run.code?.label ?? targetLabel(run.target);
  if (run.running) return `${code}: running`;
  if (run.outcome === 'error' && !Object.keys(run.results ?? {}).length) return `${code}: didn’t run${run.detail ? ` (${run.detail})` : ''}`;
  const { passed = 0, failed = 0, error = 0 } = run.counts ?? {};
  return `${code}: ${[`${passed} passed`, failed && `${failed} failed`, error && `${error} couldn’t be run`].filter(Boolean).join(', ')}`;
}
