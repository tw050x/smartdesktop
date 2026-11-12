import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as grid from '../packages/app/src/main/chat-layout.js';

const two = () => ({ columns: [{ chats: ['a', 'b'], active: 'a' }, { chats: ['c'], active: 'c' }], widths: [0.5, 0.5] });

test('a new chat goes into a column, showing; with none, it makes the first', () => {
  assert.deepEqual(grid.place(grid.empty(), 'a'), { columns: [{ chats: ['a'], active: 'a' }], widths: [1] });
  const next = grid.place(two(), 'd', 1);
  assert.deepEqual(next.columns[1], { chats: ['c', 'd'], active: 'd' });
});

test('a tab dragged along its row moves to where it was dropped', () => {
  const next = grid.place(two(), 'b', 0, 0);
  assert.deepEqual(next.columns[0].chats, ['b', 'a']);
});

test('a tab moved to another column leaves its own, which goes once empty', () => {
  const next = grid.place(two(), 'c', 0, 1);
  assert.deepEqual(next.columns, [{ chats: ['a', 'c', 'b'], active: 'c' }]);
  assert.deepEqual(next.widths, [1]);
});

test('a tab dropped on a column edge splits it off into a new column on that side, halving it', () => {
  const right = grid.split(two(), 'b', 0, 'right');
  assert.deepEqual(right.columns.map((c) => c.chats), [['a'], ['b'], ['c']]);
  assert.deepEqual(right.widths, [0.25, 0.25, 0.5]);
  const left = grid.split(two(), 'a', 1, 'left');
  assert.deepEqual(left.columns.map((c) => c.chats), [['b'], ['a'], ['c']]);
  // A column holding only the tab dragged doesn't split from itself.
  assert.deepEqual(grid.split(two(), 'c', 1, 'left'), two());
});

test('splitting a column after the one emptied by the move lands beside the right one', () => {
  const layout = { columns: [{ chats: ['a'], active: 'a' }, { chats: ['b', 'c'], active: 'b' }], widths: [0.5, 0.5] };
  const next = grid.split(layout, 'a', 1, 'right');
  assert.deepEqual(next.columns.map((c) => c.chats), [['b', 'c'], ['a']]);
});

test('closing a tab shows its neighbour, and a column left empty goes, its width shared', () => {
  const next = grid.close(two(), 'a');
  assert.deepEqual(next.columns[0], { chats: ['b'], active: 'b' });
  const gone = grid.close(two(), 'c');
  assert.deepEqual(gone, { columns: [{ chats: ['a', 'b'], active: 'a' }], widths: [1] });
});

test('a kept layout is tidied: no empty columns, no chat twice, widths that add up', () => {
  const kept = { columns: [{ chats: [], active: null }, { chats: ['a', 'a', 'b'], active: 'x' }, { chats: ['b', 'c'], active: 'c' }], widths: [1, 2, 2] };
  assert.deepEqual(grid.normalize(kept), { columns: [{ chats: ['a', 'b'], active: 'a' }, { chats: ['c'], active: 'c' }], widths: [0.5, 0.5] });
  assert.deepEqual(grid.normalize(null), grid.empty());
  assert.deepEqual(grid.resize(two(), [300, 100]).widths, [0.75, 0.25]);
  assert.deepEqual(grid.even(grid.resize(two(), [300, 100])).widths, [0.5, 0.5]);
});
