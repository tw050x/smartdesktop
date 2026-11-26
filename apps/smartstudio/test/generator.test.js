import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGenerator } from '../packages/app/src/main/generator.js';
import { createStore } from '../packages/app/src/main/store.js';

// A stand-in for ComfyUI: jobs it's sent finish (or fail) after `steps` questions about them.
// With `held`, none finishes until `release()`.
function standIn({ fails = false, steps = 2, held = false } = {}) {
  const jobs = new Map();
  let next = 0;
  return {
    jobs,
    release() {
      held = false;
    },
    base: () => 'http://stand-in:8188',
    async submit(graph) {
      const id = `p-${++next}`;
      jobs.set(id, { graph, asked: 0, cancelled: false });
      return id;
    },
    async history(id) {
      const job = jobs.get(id);
      if (!job || held || ++job.asked < steps) return null;
      if (fails || job.cancelled) return { status: { status_str: 'error', messages: [['execution_error', { node_type: 'KSampler', exception_message: 'out of memory' }]] } };
      const kind = job.graph.save.class_type === 'SaveVideo' ? { images: [{ filename: 'v_00001.mp4', subfolder: 'smartstudio/video', type: 'output' }] } : { audio: [{ filename: 'a_00001.flac', subfolder: 'smartstudio/music', type: 'output' }] };
      return { status: { status_str: 'success' }, outputs: { save: kind } };
    },
    queued: async (id) => jobs.has(id),
    async cancel(id) {
      if (jobs.has(id)) jobs.get(id).cancelled = true;
    },
    download: async ({ filename }) => Buffer.from(`bytes of ${filename}`),
    uploads: [],
    async upload(name, bytes) {
      this.uploads.push({ name, bytes: String(bytes) });
      return name;
    },
  };
}

async function withGenerator(comfy, run) {
  const folder = await mkdtemp(path.join(tmpdir(), 'smartstudio-generator-'));
  const store = createStore(folder);
  const progress = [];
  const generator = createGenerator({ store, comfy, poll: 1, sleep: () => new Promise((resolve) => setImmediate(resolve)), onProgress: (p) => progress.push(p) });
  try {
    await run({ store, generator, progress });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const settled = async (store, projectId, takeId) => {
  for (let i = 0; i < 200; i++) {
    const take = (await store.get(projectId)).takes.find((one) => one.id === takeId);
    if (take.status === 'done' || take.status === 'failed') return take;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('never finished');
};

test('a take is sent, followed, and its file kept in the project', async () => {
  const comfy = standIn({ held: true });
  await withGenerator(comfy, async ({ store, generator, progress }) => {
    const { project } = await store.create({});
    const take = await generator.generate(project, { kind: 'music', prompt: 'lo-fi beats', seconds: 10, seed: 5 });
    assert.equal(take.status, 'queued');
    // The server says how far along it is, while it's running there.
    while ((await store.get(project)).takes[0].status !== 'running') await new Promise((resolve) => setTimeout(resolve, 1));
    generator.progressed({ promptId: 'p-1', value: 3, max: 8 });
    comfy.release();
    const done = await settled(store, project, take.id);
    assert.equal(done.status, 'done');
    assert.equal(done.file, `${take.id}.flac`);
    assert.deepEqual(done.job, { server: 'http://stand-in:8188', promptId: 'p-1' });
    assert.equal(await readFile(store.mediaPath(project, done.file), 'utf8'), 'bytes of a_00001.flac');
    assert.equal(comfy.jobs.get('p-1').graph.text.inputs.seed, 5);
    assert.deepEqual(progress.map(({ value, max }) => [value, max]), [[3, 8]]);
  });
});

test('a take the server can\'t make fails with why', async () => {
  await withGenerator(standIn({ fails: true }), async ({ store, generator }) => {
    const { project } = await store.create({});
    const take = await generator.generate(project, { kind: 'video', prompt: 'waves', seconds: 2 });
    const failed = await settled(store, project, take.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'KSampler failed: out of memory');
  });
});

test('a take the user stops says so, and a server that refuses a take says why', async () => {
  // Held: it never finishes by itself (polls are only a setImmediate apart, so a number of steps
  // could all pass before it's stopped on a fast machine).
  const comfy = standIn({ held: true });
  await withGenerator(comfy, async ({ store, generator }) => {
    const { project } = await store.create({});
    const take = await generator.generate(project, { kind: 'music', prompt: 'x', seconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await generator.cancel(project, take.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = (await store.get(project)).takes[0];
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.error, 'Stopped.');
    assert.equal(comfy.jobs.get('p-1').cancelled, true);
    comfy.submit = async () => { throw new Error('The generation server doesn\'t have the model files for this: ltx.safetensors.'); };
    const refused = await generator.generate(project, { kind: 'video', prompt: 'y' });
    assert.match((await settled(store, project, refused.id)).error, /model files/);
  });
});

test('takes not finished when the app quit are picked up again', async () => {
  const comfy = standIn();
  await withGenerator(comfy, async ({ store, generator }) => {
    const { project } = await store.create({});
    const waiting = await store.addTake(project, { kind: 'music', prompt: 'never sent', seconds: 5 });
    const running = await store.addTake(project, { kind: 'music', prompt: 'sent before', seconds: 5 });
    const promptId = await comfy.submit({ save: { class_type: 'SaveAudio' } });
    await store.updateTake(project, running.id, { status: 'running', job: { server: comfy.base(), promptId } });
    await generator.resume();
    assert.equal((await settled(store, project, waiting.id)).status, 'done');
    assert.equal((await settled(store, project, running.id)).status, 'done');
  });
});

test('a part of a song made again sends the song first, then a graph reading it', async () => {
  const comfy = standIn();
  await withGenerator(comfy, async ({ store, generator }) => {
    const { project } = await store.create({});
    const song = await generator.generate(project, { kind: 'music', prompt: 'synth-pop', seconds: 30, seed: 4 });
    await settled(store, project, song.id);
    const again = await generator.generate(project, { kind: 'music', prompt: 'synth-pop', seconds: 30, seed: 8, planSeed: 4, from: { take: song.id, start: 12, end: 20 } });
    const done = await settled(store, project, again.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(comfy.uploads, [{ name: `smartstudio-${project}-${song.id}.flac`, bytes: 'bytes of a_00001.flac' }]);
    const graph = [...comfy.jobs.values()].at(-1).graph;
    assert.equal(graph.load.inputs.audio, `smartstudio-${project}-${song.id}.flac`);
    assert.deepEqual([graph.part.inputs.start, graph.part.inputs.end], [12, 20]);
  });
});
