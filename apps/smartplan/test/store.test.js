import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore } from '../packages/app/src/main/store.js';

async function withStore(run) {
  const folder = await mkdtemp(path.join(tmpdir(), 'smartplan-store-'));
  try {
    await run(createStore(folder), folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('a board with no lists starts with To do, Doing and Done', async () => withStore(async (store, folder) => {
  const made = await store.create({ name: 'Website relaunch', description: 'New site by March' });
  assert.deepEqual(made.lists.map((list) => list.name), ['To do', 'Doing', 'Done']);
  const board = await store.get(made.board);
  assert.equal(board.description, 'New site by March');
  const [listed] = await store.list();
  assert.deepEqual(listed.lists.map(({ name, cards }) => ({ name, cards })), [{ name: 'To do', cards: 0 }, { name: 'Doing', cards: 0 }, { name: 'Done', cards: 0 }]);
  const kept = JSON.parse(await readFile(path.join(folder, 'boards', made.board, 'board.json'), 'utf8'));
  assert.equal(kept.name, 'Website relaunch');
}));

test('cards are added in order, new until read, and checked with where a mistake is', async () => withStore(async (store) => {
  const { board, lists: [todo] } = await store.create({ name: 'Move house', lists: [{ name: 'To do', cards: [{ title: 'Book the van' }] }, { name: 'Done' }] });
  const added = await store.addCards(board, todo.id, [
    { title: 'Pack the kitchen', labels: [{ name: 'Packing', color: 'blue' }], due: '2026-12-01', checklist: [{ text: 'Plates' }, { text: 'Pans', done: true }] },
  ], { position: 0 });
  let got = await store.get(board);
  assert.deepEqual(got.lists[0].cards.map((card) => card.title), ['Pack the kitchen', 'Book the van']);
  assert.equal(got.unread, 2);
  assert.deepEqual(got.lists[0].cards[0].checklist, [{ text: 'Plates', done: false }, { text: 'Pans', done: true }]);
  await store.markRead(board, added.cards[0]);
  got = await store.get(board);
  assert.equal(got.lists[0].cards[0].unread, null);
  await assert.rejects(store.addCards(board, todo.id, [{ title: 'Ok' }, { title: '' }]), /cards\[1\]\.title is missing/);
  await assert.rejects(store.addCards(board, todo.id, [{ title: 'Ok', labels: [{ name: 'X', color: 'pink' }] }]), /cards\[0\]\.labels\[0\]\.color is one of/);
  await assert.rejects(store.addCards(board, todo.id, [{ title: 'Ok', due: 'soon' }]), /cards\[0\]\.due is a date/);
  await assert.rejects(store.addCards(board, 'l-nope', [{ title: 'Ok' }]), /No list l-nope on this board\. Its lists: l-\w+ \(To do\)/);
}));

test('a change touches only the fields sent, and shows as updated until read', async () => withStore(async (store) => {
  const { board, lists: [todo] } = await store.create({ name: 'Launch', lists: [{ name: 'To do', cards: [{ title: 'Write the post', description: 'A draft' }] }] });
  const [cardId] = todo.cards;
  await store.markRead(board, cardId);
  await store.updateCard(board, cardId, { due: '2026-12-24' });
  const card = (await store.get(board)).lists[0].cards[0];
  assert.equal(card.description, 'A draft');
  assert.equal(card.due, '2026-12-24');
  assert.equal(card.unread, 'updated');
  await assert.rejects(store.updateCard(board, cardId, {}), /Give at least one/);
}));

test('cards move between lists at a place among those that stay, and the user\'s moves mark nothing', async () => withStore(async (store) => {
  const { board, lists: [todo, doing] } = await store.create({ name: 'Sprint', lists: [{ name: 'To do', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] }, { name: 'Doing', cards: [{ title: 'D' }] }] });
  const [a, b, c] = todo.cards;
  await store.moveCards(board, [c, a], doing.id, { position: 0 });
  let got = await store.get(board);
  assert.deepEqual(got.lists.map((list) => list.cards.map((card) => card.title)), [['B'], ['C', 'A', 'D']]);
  // Within one list: B to the end of To do is where it is.
  await store.moveCards(board, [b], todo.id);
  for (const id of [a, b, c]) await store.markRead(board, id);
  await store.moveCards(board, [a], todo.id, { position: 0, by: 'user' });
  got = await store.get(board);
  assert.deepEqual(got.lists.map((list) => list.cards.map((card) => card.title)), [['A', 'B'], ['C', 'D']]);
  assert.equal(got.lists[0].cards[0].unread, null);
}));

test('lists are added, renamed, moved and removed with their cards', async () => withStore(async (store) => {
  const { board, lists: [todo, , done] } = await store.create({ name: 'Plan' });
  const { lists: [review] } = await store.addLists(board, [{ name: 'Review', cards: [{ title: 'Check it' }] }], { position: 2 });
  assert.deepEqual((await store.get(board)).lists.map((list) => list.name), ['To do', 'Doing', 'Review', 'Done']);
  await store.updateList(board, done.id, { name: 'Shipped', position: 0 });
  assert.deepEqual((await store.get(board)).lists.map((list) => list.name), ['Shipped', 'To do', 'Doing', 'Review']);
  assert.deepEqual(await store.removeList(board, review.id), { removed: review.id, cards: 1 });
  await store.addCards(board, todo.id, [{ title: 'X' }]);
  const { removed } = await store.removeCards(board, (await store.get(board)).lists[1].cards.map((card) => card.id));
  assert.equal(removed.length, 1);
  await store.delete(board);
  assert.deepEqual(await store.list(), []);
}));
