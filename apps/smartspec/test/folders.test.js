import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as folders from '../packages/app/src/main/folders.js';
import { levelOf } from '../packages/app/src/renderer/home-level.js';

// Two folders, one inside the other, and three domains: one at the top, one in each folder.
const state = () => {
  let next = folders.createFolder(folders.NO_FOLDERS, { id: 'platform', name: 'Platform' });
  next = folders.createFolder(next, { id: 'identity', name: 'Identity team', parentId: 'platform' });
  next = folders.moveDomain(next, 'billing', 'platform');
  return folders.moveDomain(next, 'auth', 'identity');
};
const groups = [
  { id: 'auth', name: 'Auth', schemas: 3, createdAt: '2026-11-03' },
  { id: 'billing', name: 'Billing', schemas: 1, createdAt: '2026-11-01' },
  { id: 'web', name: 'Web', schemas: 2, createdAt: '2026-11-02' },
];

describe('folders for domains', () => {
  test('a level holds its folders and domains, a folder counting everything inside it', () => {
    assert.deepEqual(levelOf(state(), groups, null), [
      { kind: 'folder', id: 'platform', name: 'Platform', schemas: 4, domains: 2, createdAt: '2026-11-03' },
      { kind: 'domain', id: 'web', name: 'Web', schemas: 2, createdAt: '2026-11-02' },
    ]);
    assert.deepEqual(levelOf(state(), groups, 'platform').map(({ kind, id }) => `${kind}:${id}`), ['folder:identity', 'domain:billing']);
    assert.deepEqual(levelOf(state(), [], 'identity'), []);
  });

  test("deleting a folder moves what's in it up a level, and a folder can't go inside itself", () => {
    const next = folders.deleteFolder(state(), 'platform');
    assert.deepEqual(next.folders, [{ id: 'identity', name: 'Identity team', parentId: null }]);
    assert.deepEqual(next.placement, { auth: 'identity' });
    assert.throws(() => folders.moveFolder(state(), 'platform', 'identity'), /inside itself/);
    assert.deepEqual(folders.pathOf(state(), 'identity').map((f) => f.name), ['Platform', 'Identity team']);
    assert.deepEqual(folders.removeDomain(state(), 'auth').placement, { billing: 'platform' });
  });

  test('a damaged file keeps what can be used', () => {
    const read = folders.readFolders({ folders: [{ id: 'a', name: 'A', parentId: 'gone' }, { id: 7 }], placement: { auth: 'a', web: 'gone' } });
    assert.deepEqual(read, { folders: [{ id: 'a', name: 'A', parentId: null }], placement: { auth: 'a' } });
  });
});
