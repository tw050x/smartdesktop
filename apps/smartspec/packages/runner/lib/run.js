import { runCheck } from './check.js';
import { RunError, defaultCacheDir, startImplementation } from './start.js';

// A job: one schematic's checks (all of its contract, or a branch run again), with what to run them
// against. Made by whatever holds the schematic (the app, later a server), so the runner needs
// nothing else, here or on another machine:
//   { version: 1, id, schematic?: { id, name, draftId }, implementation, workdir?, shapes, checks }
// `checks`, each { key: 'clause/check', clause, title?, setup, request, expect }, setup being the
// steps above it in the tree in order (contract.js's checksUnder); `shapes`, the contract's, by id;
// `workdir`, a folder on this machine standing in for the implementation's repository or archive.
//
// What happens is told as events (the JSON lines the command line writes):
//   { type: 'job', id, checks }                 started
//   { type: 'phase', phase }                    fetch, start, ready, check, stop
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
}

export async function runJob(job, { emit = () => {}, signal, cacheDir = defaultCacheDir() } = {}) {
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
    running = await startImplementation(job.implementation, { jobId: job.id, cacheDir, workdir: job.workdir, emit, signal });
  } catch (error) {
    for (const check of job.checks) {
      counts.error++;
      emit({ type: 'result', key: check.key, outcome: 'error', detail: 'Not run: the implementation didn\'t start.', ms: 0 });
    }
    return done('error', error.message);
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
