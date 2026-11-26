import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLayouts } from '../packages/app/src/main/layouts.js';

test('a schematic\'s layout is kept on this computer and read back', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'smartspec-layouts-'));
  try {
    const layouts = createLayouts(path.join(folder, 'layouts'));
    assert.equal(await layouts.get('mw5t6udm-048252a8'), null);
    await layouts.save('mw5t6udm-048252a8', { boxes: { contract: { cx: 0.5, cy: 0.5, w: 0.6, h: 0.9, z: 1 } } });
    assert.deepEqual(await layouts.get('mw5t6udm-048252a8'), { boxes: { contract: { cx: 0.5, cy: 0.5, w: 0.6, h: 0.9, z: 1 } } });
    await assert.rejects(layouts.save('../elsewhere', {}), /Not a schematic id/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
