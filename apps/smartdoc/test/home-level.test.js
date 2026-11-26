import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { levelOf } from '../packages/app/src/renderer/home-level.js';

const doc = (id, day) => ({ id, name: id, importedAt: `2026-10-${day}T10:00:00.000Z` });
const folder = (id, parentId = null) => ({ id, name: id, parentId });
// Most recently opened first.
const documents = [doc('newest', '05'), doc('top', '20'), doc('older', '25'), doc('oldest', '10')];
const state = {
  folders: [folder('zeta'), folder('nested', 'zeta'), folder('alpha'), folder('empty'), folder('shell'), folder('inner', 'shell')],
  placement: { newest: 'nested', older: 'alpha' },
};
const ids = (items) => items.map((i) => i.id);

describe('a level of the documents column', () => {
  test('mixes folders and documents, a folder placed by its most recently opened document at any depth', () => {
    assert.deepEqual(ids(levelOf(state, documents, null)), ['zeta', 'top', 'alpha', 'oldest', 'empty', 'shell']);
  });

  test('moves a folder up when a document deep inside is opened', () => {
    const reopened = [documents[2], documents[0], documents[1], documents[3]];
    assert.deepEqual(ids(levelOf(state, reopened, null)), ['alpha', 'zeta', 'top', 'oldest', 'empty', 'shell']);
  });

  test('shows only what is directly inside a folder', () => {
    assert.deepEqual(levelOf(state, documents, 'zeta').map((i) => [i.kind, i.id]), [['folder', 'nested']]);
    assert.deepEqual(levelOf(state, documents, 'nested').map((i) => [i.kind, i.id]), [['document', 'newest']]);
  });

  test('puts folders with no document anywhere inside last, by name', () => {
    assert.deepEqual(ids(levelOf({ folders: [folder('b'), folder('a')], placement: {} }, [doc('d', '01')], null)), ['d', 'a', 'b']);
  });

  test('gives a folder the newest date added of the documents in it', () => {
    const placement = { newest: 'nested', top: 'nested' };
    const zeta = levelOf({ ...state, placement }, documents, null).find((i) => i.id === 'zeta');
    assert.equal(zeta.importedAt, documents[1].importedAt);
  });

  test('copes with a loop in a damaged file', () => {
    const damaged = { folders: [folder('x', 'y'), folder('y', 'x')], placement: { top: 'x' } };
    assert.deepEqual(levelOf(damaged, documents, null).map((i) => i.id), ['newest', 'older', 'oldest']);
  });
});
