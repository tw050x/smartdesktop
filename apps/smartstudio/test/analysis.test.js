import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeStretch } from '../packages/app/src/main/analysis.js';

// Levels for a take: 20 measures a second, each second as loud as `shape(second)` (an amplitude).
const levelsOf = (seconds, shape) => {
  const rms = Array.from({ length: seconds * 20 }, (_, i) => shape(Math.floor(i / 20)));
  return { rate: 20, rms, peak: rms.map((value) => Math.min(1, value * 2)) };
};

test('a stretch\'s loudness is told against the rest of the take, with where it drops and comes back', () => {
  // A song at about -14 dB that drops to silence from 13 to 16s.
  const levels = levelsOf(30, (second) => (second >= 13 && second < 16 ? 0.001 : 0.2));
  const sound = analyzeStretch(levels, { start: 12, end: 20, seconds: 30 });
  assert.ok(sound.loudness < sound.rest.loudness);
  assert.equal(sound.rest.loudness, -14);
  assert.equal(sound.rest.difference, -2);
  assert.deepEqual(sound.silences, [{ start: 13, end: 16 }]);
  assert.deepEqual(sound.jumps.map((jump) => [jump.at, Math.sign(jump.change)]), [[13, -1], [16, 1]]);
  // Its timeline runs from two seconds before to two after, in half seconds.
  assert.equal(sound.timeline.from, 10);
  assert.equal(sound.timeline.step, 0.5);
  assert.equal(sound.timeline.loudness.length, 24);
  assert.equal(sound.timeline.loudness[0], -14);
  assert.equal(sound.timeline.loudness[(15 - 10) / 0.5], -60);
  assert.equal(sound.fullScale.moments, 0);
});

test('full scale is found, a run counting once, and the whole take has no rest to be against', () => {
  const levels = levelsOf(10, (second) => (second === 4 ? 0.6 : 0.1));
  const sound = analyzeStretch(levels, { start: 0, end: 10, seconds: 10 });
  assert.deepEqual(sound.fullScale, { moments: 1, seconds: 1, at: [4] });
  assert.equal(sound.peak, 0);
  assert.equal(sound.rest, null);
  assert.equal(analyzeStretch(null, { start: 0, end: 1, seconds: 10 }), null);
});

test('a long stretch\'s timeline is coarser, so it stays short', () => {
  const sound = analyzeStretch(levelsOf(240, () => 0.2), { start: 0, end: 240, seconds: 240 });
  assert.ok(sound.timeline.loudness.length <= 80);
});
