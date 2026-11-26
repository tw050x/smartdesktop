import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore, levelsFields, nameFrom, stretch, takeFields } from '../packages/app/src/main/store.js';

async function withStore(run) {
  const folder = await mkdtemp(path.join(tmpdir(), 'smartstudio-store-'));
  try {
    await run(createStore(folder), folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('a project is made, listed and kept in its own folder', async () => withStore(async (store, folder) => {
  const made = await store.create({ name: 'Summer single', description: 'A song for June' });
  const [listed] = await store.list();
  assert.equal(listed.name, 'Summer single');
  assert.equal(listed.takes, 0);
  const kept = JSON.parse(await readFile(path.join(folder, 'projects', made.project, 'project.json'), 'utf8'));
  assert.equal(kept.description, 'A song for June');
  await assert.rejects(store.get('../etc'), /No project/);
}));

test('a take is queued with what was asked, and an untitled project is named after it', async () => withStore(async (store) => {
  const { project } = await store.create({});
  const take = await store.addTake(project, { kind: 'music', prompt: 'warm neo-soul, live drums, Rhodes', lyrics: '[Verse]\nla la', seconds: 30, seed: 7 });
  assert.match(take.id, /^t-\w{6}$/);
  assert.equal(take.status, 'queued');
  assert.equal(take.seed, 7);
  const got = await store.get(project);
  assert.equal(got.name, 'Warm neo-soul, live drums, Rhodes');
  assert.equal(got.running, 1);
  assert.deepEqual(got.kinds, ['music']);
  // A video take has no lyrics.
  const clip = await store.addTake(project, { kind: 'video', prompt: 'rain on a window', lyrics: 'ignored' });
  assert.equal(clip.lyrics, '');
  assert.equal(clip.seconds, 5);
  assert.equal((await store.get(project)).name, 'Warm neo-soul, live drums, Rhodes');
}));

test('what\'s asked for is checked, each mistake said plainly', () => {
  assert.throws(() => takeFields({ kind: 'speech', prompt: 'hi' }), /kind is one of music or video/);
  assert.throws(() => takeFields({ kind: 'music', prompt: '  ' }), /prompt is empty/);
  assert.throws(() => takeFields({ kind: 'video', prompt: 'x', seconds: 60 }), /video take is 2 to 20 seconds/);
  assert.throws(() => takeFields({ kind: 'music', prompt: 'x', seed: -1 }), /seed is a whole number/);
  assert.equal(takeFields({ kind: 'music', prompt: 'x' }).seconds, 60);
  assert.equal(nameFrom(''), 'Untitled project');
  assert.equal(nameFrom('a slow dolly through a rainy neon street at night'), 'A slow dolly through a rainy');
});

test('a take goes from queued to done with its file, and the AI\'s is new until seen', async () => withStore(async (store) => {
  const { project } = await store.create({ name: 'Clips' });
  const take = await store.addTake(project, { kind: 'video', prompt: 'waves', by: 'ai' });
  await store.updateTake(project, take.id, { status: 'running', job: { server: 'http://gx10:8188', promptId: 'p-1' } });
  assert.deepEqual(await store.unfinished(), [{ projectId: project, take: (await store.get(project)).takes[0] }]);
  await store.updateTake(project, take.id, { status: 'done', file: `${take.id}.mp4` });
  let got = (await store.get(project)).takes[0];
  assert.equal(got.status, 'done');
  assert.equal(got.unread, 'new');
  assert.ok(got.startedAt && got.finishedAt);
  assert.deepEqual(await store.unfinished(), []);
  await store.markSeen(project, take.id);
  got = (await store.get(project)).takes[0];
  assert.equal(got.unread, null);
  await assert.rejects(store.updateTake(project, take.id, { file: '../../secret.mp4' }), /Not a take's file/);
  assert.throws(() => store.mediaPath(project, '../project.json'), /Not a take's file/);
  assert.match(store.mediaPath(project, `${take.id}.mp4`), /media\/t-\w+\.mp4$/);
}));

test('a project is renamed and deleted with its takes', async () => withStore(async (store) => {
  const { project } = await store.create({ name: 'Old' });
  await store.addTake(project, { kind: 'music', prompt: 'x' });
  await store.rename(project, { name: 'New', description: 'For the launch' });
  assert.equal((await store.get(project)).name, 'New');
  await store.delete(project);
  assert.deepEqual(await store.list(), []);
}));

// A finished song in a new project, to note and remake parts of.
async function finishedSong(store) {
  const { project } = await store.create({ name: 'Single' });
  const take = await store.addTake(project, { kind: 'music', prompt: 'synth-pop', lyrics: '[Chorus]\nlight it up', seconds: 30, seed: 7 });
  await store.updateTake(project, take.id, { status: 'done', file: `${take.id}.flac` });
  return { project, take };
}

test('a note is kept on a stretch of a take, in order, and can be taken off', async () => withStore(async (store) => {
  const { project, take } = await finishedSong(store);
  const late = await store.addNote(project, take.id, { start: 20, end: 24.04, text: 'the hi-hat doubles' });
  const early = await store.addNote(project, take.id, { start: 3, end: 5, text: 'love this intro', by: 'ai' });
  assert.match(late.id, /^n-\w{6}$/);
  assert.equal(late.end, 24);
  const { notes } = (await store.get(project)).takes[0];
  assert.deepEqual(notes.map((note) => [note.start, note.text, note.by]), [[3, 'love this intro', 'ai'], [20, 'the hi-hat doubles', 'user']]);
  await assert.rejects(store.addNote(project, take.id, { start: 25, end: 40, text: 'past the end' }), /within the take: 0 to 30/);
  await assert.rejects(store.addNote(project, take.id, { start: 5, end: 4, text: 'backwards' }), /ends after it starts/);
  await assert.rejects(store.addNote(project, take.id, { start: 1, end: 2, text: '  ' }), /empty/);
  await store.removeNote(project, take.id, early.id);
  assert.equal((await store.get(project)).takes[0].notes.length, 1);
  await assert.rejects(store.removeNote(project, take.id, early.id), /No note/);
}));

test('a take remaking part of a song keeps which song and stretch, and the song\'s plan', async () => withStore(async (store) => {
  const { project, take } = await finishedSong(store);
  const again = await store.addTake(project, { kind: 'music', prompt: 'synth-pop', seconds: 30, seed: 99, planSeed: take.planSeed, from: { take: take.id, start: 12, end: 20 } });
  assert.deepEqual(again.from, { take: take.id, start: 12, end: 20 });
  assert.equal(again.planSeed, 7);
  assert.equal(again.seed, 99);
  // A take made from nothing is planned with its own seed.
  assert.equal(take.planSeed, 7);
  await assert.rejects(store.addTake(project, { kind: 'music', prompt: 'x', seconds: 30, from: { take: take.id, start: 12, end: 12.5 } }), /at least 1 second/);
  await assert.rejects(store.addTake(project, { kind: 'video', prompt: 'x', seconds: 5, from: { take: take.id, start: 1, end: 3 } }), /Only music/);
  await assert.rejects(store.addTake(project, { kind: 'music', prompt: 'x', seconds: 30, from: { take: again.id, start: 1, end: 3 } }), /isn't a finished music take/);
  await assert.rejects(store.addTake(project, { kind: 'music', prompt: 'x', seconds: 30, from: { take: 't-nope00', start: 1, end: 3 } }), /No take/);
}));

test('a take\'s levels are kept beside its file, checked', async () => withStore(async (store) => {
  const { project, take } = await finishedSong(store);
  assert.equal(await store.levels(project, take.id), null);
  await store.setLevels(project, take.id, { rate: 20, peak: [0.5, 1.4, -1], rms: [0.1, 0.2, 0.3] });
  assert.deepEqual(await store.levels(project, take.id), { rate: 20, peak: [0.5, 1, 0], rms: [0.1, 0.2, 0.3] });
  assert.throws(() => levelsFields({ rate: 20, peak: [1], rms: [] }), /as many peaks/);
  await assert.rejects(store.setLevels(project, '../x', { rate: 20, peak: [], rms: [] }), /No take/);
  assert.deepEqual(stretch(1.04, 2.96, 30), { start: 1, end: 3 });
}));
