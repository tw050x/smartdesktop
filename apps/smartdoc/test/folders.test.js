import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NO_FOLDERS, canMoveFolder, createFolder, deleteFolder, moveDocument, moveFolder, pathOf, readFolders, removeDocument, renameFolder } from '../packages/app/src/main/folders.js';

// Clients › Acme › Contracts, and Personal.
const tree = () => [
  { id: 'clients', name: 'Clients' },
  { id: 'acme', name: 'Acme', parentId: 'clients' },
  { id: 'contracts', name: 'Contracts', parentId: 'acme' },
  { id: 'personal', name: 'Personal' },
].reduce(createFolder, NO_FOLDERS);

describe('folders', () => {
  test('need a name, and a parent that exists', () => {
    assert.throws(() => createFolder(NO_FOLDERS, { id: 'a', name: '   ' }), /needs a name/);
    assert.throws(() => createFolder(NO_FOLDERS, { id: 'a', name: 'A', parentId: 'nope' }), /no folder/);
    assert.equal(createFolder(NO_FOLDERS, { id: 'a', name: '  A ' }).folders[0].name, 'A');
    assert.throws(() => renameFolder(tree(), 'acme', ''), /needs a name/);
    assert.equal(renameFolder(tree(), 'acme', 'Acme Ltd').folders[1].name, 'Acme Ltd');
  });

  test('can nest to any depth, with the path from the top', () => {
    assert.deepEqual(pathOf(tree(), 'contracts').map((f) => f.name), ['Clients', 'Acme', 'Contracts']);
    assert.deepEqual(pathOf(tree(), null), []);
  });

  test('deleting one moves what was in it up a level', () => {
    let state = moveDocument(tree(), 'd1', 'acme');
    state = moveDocument(state, 'd2', 'clients');
    state = deleteFolder(state, 'acme');
    assert.equal(state.placement.d1, 'clients');
    assert.equal(state.folders.find((f) => f.id === 'contracts').parentId, 'clients');
    state = deleteFolder(state, 'clients');
    assert.deepEqual(state.placement, {}); // now at the top level
    assert.equal(state.folders.find((f) => f.id === 'contracts').parentId, null);
  });

  test('can’t go inside themselves', () => {
    const state = tree();
    assert.equal(canMoveFolder(state, 'clients', 'contracts'), false);
    assert.equal(canMoveFolder(state, 'clients', 'clients'), false);
    assert.equal(canMoveFolder(state, 'contracts', 'personal'), true);
    assert.equal(canMoveFolder(state, 'contracts', null), true);
    assert.throws(() => moveFolder(state, 'acme', 'contracts'), /inside itself/);
    assert.equal(moveFolder(state, 'contracts', 'personal').folders[2].parentId, 'personal');
  });
});

describe('documents in folders', () => {
  test('move to a folder and back to the top level', () => {
    const inFolder = moveDocument(tree(), 'd', 'acme');
    assert.equal(inFolder.placement.d, 'acme');
    assert.deepEqual(moveDocument(inFolder, 'd', null).placement, {});
    assert.throws(() => moveDocument(tree(), 'd', 'nope'), /no folder/);
  });

  test('leave their folder when removed from the list', () => {
    assert.deepEqual(removeDocument(moveDocument(tree(), 'd', 'acme'), 'd').placement, {});
  });
});

describe('a saved file', () => {
  test('that’s missing or damaged leaves everything at the top level', () => {
    assert.deepEqual(readFolders(null), NO_FOLDERS);
    assert.deepEqual(readFolders({ folders: 'x', placement: 3 }), NO_FOLDERS);
    const state = readFolders({ folders: [{ id: 'a', name: 'A', parentId: 'gone' }, { name: 'no id' }], placement: { d1: 'a', d2: 'gone' } });
    assert.deepEqual(state, { folders: [{ id: 'a', name: 'A', parentId: null }], placement: { d1: 'a' } });
  });

  test('with a loop can’t hang the path', () => {
    const state = { folders: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }], placement: {} };
    assert.equal(pathOf(state, 'a').length, 2);
  });
});
