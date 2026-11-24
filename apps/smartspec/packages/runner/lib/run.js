import { runCheck } from './check.js';
import { RunError, defaultCacheDir, startImplementation } from './start.js';

// A job: one schematic's checks (all of its contract, or a branch run again), with what to run them
// against. Made by whatever holds the schematic (the app, later a server), so the runner needs
// nothing else, here or on another machine:
//   { version: 1, id, schematic?: { id, name, draftId }, implementation, ref?, workdir?, secrets?, shapes, checks }
// `checks`, each { key: 'clause/check', clause, title?, setup, request, expect }, setup being the
// steps above it in the tree in order (contract.js's checksUnder); `shapes`, the contract's, by id;
// `workdir`, a folder on this machine to keep a git repository's or Compose file's code in, to be
// worked on there: cloned into it once, then tested as it is (see start.js); `ref`, else, the
// branch, tag or commit of its code to run (default: the source's ref, else the default branch);
// `secrets`, the values of the implementation's secrets, each { name, value, env?, files? } (see
// start.js), never written in what's told: any value turning up in a log line or a check's detail
// is masked (•••).
//
// What happens is told as events (the JSON lines the command line writes):
//   { type: 'job', id, checks }                 started
//   { type: 'phase', phase }                    fetch, start, ready, check, stop
//   { type: 'code', kind, ref, commit, label }   the code being run: a branch and the commit it
//                                               resolved to, the workspace (its branch, commit and
//                                               files not committed), or an image, archive or URL
//   { type: 'log', stream, text }               a line from the runner or what it started
//   { type: 'result', key, outcome, detail?, status?, ms }
//   { type: 'done', outcome, counts, detail? }  passed, failed (some check did), or error (couldn't
//                                               run them all: not started, stopped), with counts of each
// and runJob resolves to the done event.

export const JOB_VERSION = 1;

export function checkJob(job) {
  if (!job || typeof job !== 'object') throw new RunError('A job should be an object.');
  if (job.version !== JOB_VERSION) throw new RunError(`This runner runs jobs of version ${JOB_VERSION}, not ${job.version}: update it, or the app that made the job.`);
  if (!job.implementation?.source?.kind) throw new RunError('The job has no implementation: nothing says where the code is or how to run it.');
  if (!Array.isArray(job.checks)) throw new RunError('The job has no checks.');
  if (job.secrets !== undefined && !(Array.isArray(job.secrets) && job.secrets.every((one) => one && typeof one.name === 'string' && typeof one.value === 'string'))) throw new RunError('The job\'s secrets should each have a name and a value.');
}

// What hides secrets' values in text: each value (and each of its lines, for one over several lines)
// replaced with •••. Values shorter than 4 characters aren't masked: they'd mask ordinary words.
export function masker(secrets = []) {
  const values = [...new Set(secrets.flatMap((one) => [one.value, ...one.value.split(/\r?\n/)]).map((value) => value.trim()).filter((value) => value.length >= 4))].sort((a, b) => b.length - a.length);
  if (!values.length) return (text) => text;
  const pattern = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (text) => (typeof text === 'string' ? text.replace(pattern, '•••') : text);
}

export async function runJob(job, { emit: tell = () => {}, signal, cacheDir = defaultCacheDir() } = {}) {
  const mask = masker(Array.isArray(job?.secrets) ? job.secrets.filter((one) => typeof one?.value === 'string') : []);
  const emit = (event) => tell(event.type === 'log' || event.type === 'result' || event.type === 'done'
    ? { ...event, ...(event.text !== undefined ? { text: mask(event.text) } : {}), ...(event.detail !== undefined ? { detail: mask(event.detail) } : {}) }
    : event);
  const counts = { passed: 0, failed: 0, error: 0 };
  const done = (outcome, detail) => {
    const event = { type: 'done', outcome, counts, ...(detail ? { detail } : {}) };
    emit(event);
    return event;
  };
  try {
    checkJob(job);
  } catch (error) {
    return done('error', error.message);
  }
  emit({ type: 'job', id: job.id, checks: job.checks.length });
  if (!job.checks.length) return done('passed');

  let running;
  try {
    running = await startImplementation(job.implementation, { jobId: job.id, cacheDir, workdir: job.workdir, ref: job.ref, secrets: job.secrets ?? [], emit, signal });
  } catch (error) {
    const stopped = signal?.aborted;
    for (const check of job.checks) {
      counts.error++;
      emit({ type: 'result', key: check.key, outcome: 'error', detail: stopped ? 'Not run: stopped.' : 'Not run: the implementation didn\'t start.', ms: 0 });
    }
    return done('error', stopped ? 'Stopped before the checks ran.' : error.message);
  }

  let stopped = false;
  try {
    emit({ type: 'phase', phase: 'check' });
    for (const check of job.checks) {
      if (signal?.aborted) {
        stopped = true;
        counts.error++;
        emit({ type: 'result', key: check.key, outcome: 'error', detail: 'Not run: stopped.', ms: 0 });
        continue;
      }
      let result;
      try {
        result = await runCheck(check, { base: running.base, shapes: job.shapes ?? {}, signal });
      } catch (error) {
        result = signal?.aborted ? { outcome: 'error', detail: 'Not run: stopped.', ms: 0 } : { outcome: 'error', detail: error.message, ms: 0 };
        if (signal?.aborted) stopped = true;
      }
      counts[result.outcome]++;
      emit({ type: 'result', key: check.key, ...result });
    }
  } finally {
    emit({ type: 'phase', phase: 'stop' });
    await running.stop();
  }
  if (stopped) return done('error', 'Stopped before every check had run.');
  return done(counts.failed ? 'failed' : counts.error ? 'error' : 'passed');
}

export { runCheck } from './check.js';
export { RunError, defaultCacheDir, startImplementation } from './start.js';
export { validate } from './schema.js';
