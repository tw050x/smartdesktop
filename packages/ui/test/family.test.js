import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFamily } from '../main/family.js';

test('apps running find each other, and one that has gone counts for nothing', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'family-'));
  const family = createFamily(folder);
  assert.deepEqual(family.others('smartprep'), []);
  family.announce({ app: 'smartplan', name: 'SmartPlan', url: 'http://127.0.0.1:1/t', hosting: true, serving: true });
  // A crashed copy's entry: no such process.
  writeFileSync(path.join(folder, 'apps', 'smartad.json'), JSON.stringify({ app: 'smartad', name: 'SmartAd', url: 'http://127.0.0.1:2/t', pid: 2 ** 22 + 12345 }));
  writeFileSync(path.join(folder, 'apps', 'broken.json'), '{');
  assert.deepEqual(family.others('smartprep').map((e) => e.app), ['smartplan']);
  assert.deepEqual(family.others('smartplan'), []);
  assert.equal(family.get('smartplan').serving, true);
  family.withdraw('smartplan');
  assert.equal(family.get('smartplan'), null);
});
