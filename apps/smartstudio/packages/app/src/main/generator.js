import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { failure, outputFile } from './comfy.js';
import { graphFor } from './workflows.js';

// Makes takes: each one asked for (by the user in a project's tab, or the AI) is added to its
// project, queued (store.js), sent to the generation server (comfy.js) and followed until it's
// done, its file then fetched into the project's media folder, or failed, with why. The server
// runs one job at a time, so takes wait their turn there; this only follows them.
//
// How far along a take is (`progress(takeId)`: { value, max }, from the server's steps, kept here
// only) is said with `onProgress({ projectId, takeId, value, max })` as it changes. As the app
// starts, takes it was following are picked up again (`resume`): one the server still knows is
// followed on, one it doesn't (restarted meanwhile) fails, and one never sent is sent now.

const POLL_MS = 1500;
const GIVE_UP_MS = 30 * 60 * 1000; // a take with no answer for this long is given up on

export function createGenerator({ store, comfy, onProgress = () => {}, poll = POLL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const following = new Map(); // take id → { projectId, promptId, progress }
  const byPrompt = new Map(); // the server's job id → take id
  const stopped = new Set(); // takes the user stopped, which following leaves as they are

  // The server says how far along a job is; the take it's for hears.
  function progressed({ promptId, value, max }) {
    const takeId = byPrompt.get(promptId);
    const take = takeId && following.get(takeId);
    if (!take || !(max > 0)) return;
    take.progress = { value, max };
    onProgress({ projectId: take.projectId, takeId, value, max });
  }

  const fail = (projectId, takeId, error) => store.updateTake(projectId, takeId, { status: 'failed', error: error?.message ?? String(error) }).catch(() => {});

  // Follows a job on the server until it's finished, then keeps its file (or says why it failed).
  async function follow(projectId, take, promptId) {
    // (Sent from here, it's followed already: progress that's come meanwhile is kept.)
    if (!following.has(take.id)) following.set(take.id, { projectId, promptId, progress: null });
    byPrompt.set(promptId, take.id);
    const started = Date.now();
    let misses = 0;
    try {
      for (;;) {
        // Stopped by the user: the server's told too (stopping it may not have known the job yet).
        if (stopped.has(take.id)) return await comfy.cancel(promptId).catch(() => {});
        let entry = null;
        try {
          entry = await comfy.history(promptId);
          misses = 0;
        } catch (error) {
          // The server may be restarting: keep asking for a while.
          if (++misses > 40) throw error;
        }
        if (entry) {
          if (entry.status?.status_str !== 'success') throw new Error(failure(entry));
          const file = outputFile(entry);
          if (!file) throw new Error('The generation server finished, but saved nothing.');
          const ext = path.extname(file.filename).toLowerCase().replace(/^\./, '') || (take.kind === 'video' ? 'mp4' : 'flac');
          const name = `${take.id}.${ext}`;
          const bytes = await comfy.download(file);
          const to = store.mediaPath(projectId, name);
          await mkdir(path.dirname(to), { recursive: true });
          await writeFile(to, bytes);
          await store.updateTake(projectId, take.id, { status: 'done', file: name, error: null });
          return;
        }
        // Not finished: still on the server's queue, or gone (it restarted, say).
        if (misses === 0 && Date.now() - started > 10_000 && !(await comfy.queued(promptId).catch(() => true))) {
          // It may have finished between the two questions.
          if (!(await comfy.history(promptId).catch(() => null))) throw new Error('The generation server lost this take (it may have restarted). Try it again.');
          continue;
        }
        if (Date.now() - started > GIVE_UP_MS) throw new Error('The generation server took too long, so this take was given up on.');
        await sleep(poll);
      }
    } catch (error) {
      if (!stopped.has(take.id)) await fail(projectId, take.id, error);
    } finally {
      stopped.delete(take.id);
      following.delete(take.id);
      byPrompt.delete(promptId);
    }
  }

  // What a take remaking part of another reads: that take's file, put on the server first (named
  // for the project and take, so the same song isn't sent twice under different names).
  async function sourceFor(projectId, take) {
    if (!take.from) return {};
    const project = await store.get(projectId);
    const source = project.takes.find((one) => one.id === take.from.take);
    if (!source?.file) throw new Error(`Take ${take.from.take} has no file to make part of again.`);
    const bytes = await readFile(store.mediaPath(projectId, source.file));
    const audio = await comfy.upload(`smartstudio-${projectId}-${source.file}`, bytes, 'audio/flac');
    return { audio };
  }

  // Sends a take to the server, then follows it.
  async function send(projectId, take) {
    let promptId;
    try {
      promptId = await comfy.submit(graphFor(take, await sourceFor(projectId, take)));
      // Stopped while it was being sent: it stays stopped, and the server lets it go.
      if (stopped.has(take.id)) throw new Error('Stopped.');
      // Followed from before it's marked running, so progress the server sends at once isn't missed.
      following.set(take.id, { projectId, promptId, progress: null });
      byPrompt.set(promptId, take.id);
      await store.updateTake(projectId, take.id, { status: 'running', job: { server: comfy.base(), promptId } });
    } catch (error) {
      following.delete(take.id);
      if (promptId) byPrompt.delete(promptId);
      if (promptId) await comfy.cancel(promptId);
      if (stopped.delete(take.id)) return;
      return fail(projectId, take.id, error);
    }
    await follow(projectId, take, promptId);
  }

  return {
    progressed,

    // A new take for a project: added, queued and sent. Gives the take as added (queued); what
    // becomes of it is saved on the project as it happens.
    async generate(projectId, fields) {
      const take = await store.addTake(projectId, fields);
      send(projectId, take);
      return take;
    },

    // Stops a take that hasn't finished.
    async cancel(projectId, takeId) {
      const project = await store.get(projectId);
      const take = project.takes.find((one) => one.id === takeId);
      if (!take) throw new Error(`No take ${takeId} in this project.`);
      if (take.status !== 'queued' && take.status !== 'running') return { take: takeId, status: take.status };
      // Followed, or still being sent: either way, it stops (see send and follow).
      stopped.add(takeId);
      if (take.job?.promptId) await comfy.cancel(take.job.promptId);
      await store.updateTake(projectId, takeId, { status: 'failed', error: 'Stopped.' });
      return { take: takeId, status: 'failed' };
    },

    progress: (takeId) => following.get(takeId)?.progress ?? null,

    // Picks up the takes not finished when the app last quit.
    async resume() {
      for (const { projectId, take } of await store.unfinished()) {
        if (following.has(take.id)) continue;
        if (take.status === 'running' && take.job?.promptId) follow(projectId, take, take.job.promptId);
        else send(projectId, take);
      }
    },
  };
}
