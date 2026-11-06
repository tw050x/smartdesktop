import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stretched } from '../packages/app/src/renderer/resizers.js';

test('a drag within the limits is followed exactly', () => {
  assert.equal(stretched(500, 420, 900), 500);
  assert.equal(stretched(420, 420, 900), 420);
  assert.equal(stretched(900, 420, 900), 900);
});

test('past a limit it gives less and less, and never more than the most', () => {
  const past = [10, 100, 1000, 100000].map((over) => stretched(900 + over, 420, 900) - 900);
  for (let i = 1; i < past.length; i++) assert.ok(past[i] > past[i - 1]);
  assert.ok(past[0] < 10 && past.at(-1) < 48);
  assert.ok(stretched(100, 420, 900) < 420 && stretched(100, 420, 900) > 372);
});
