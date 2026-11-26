import assert from 'node:assert/strict';
import { test } from 'node:test';
import { follow, stretched } from '../packages/app/src/renderer/rubber-band.js';

test('pulled further, it gives less and less, never past its stretch, both ways', () => {
  const seen = [10, 50, 200, 1000, 100000].map(stretched);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1]);
  assert.ok(seen.at(-1) < 80);
  assert.equal(stretched(-200), -stretched(200));
  assert.equal(stretched(0), 0);
});

test('where it shows follows the pull smoothly: no jumps, no overshoot', () => {
  let shown = { at: 0, speed: 0 };
  let before = 0;
  for (let f = 0; f < 60; f++) {
    shown = follow(shown, 40, 1 / 60);
    assert.ok(shown.at - before < 10); // never a jump: at most a quarter of the way in a frame
    assert.ok(shown.at <= 40.001); // never past where it's going (no wobble)
    before = shown.at;
  }
  assert.ok(Math.abs(shown.at - 40) < 0.5); // there within a second
  // A long frame (the window busy) is still exact, not thrown out.
  const late = follow({ at: 0, speed: 0 }, 40, 0.05);
  assert.ok(late.at > 0 && late.at < 40);
});
