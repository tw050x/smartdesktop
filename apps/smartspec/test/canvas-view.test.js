import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitView, pinOffset, zoomedAt } from '../packages/app/src/renderer/canvas-view.js';

test('a diagram too big for the space is shrunk to fit, centred', () => {
  const view = fitView({ width: 1000, height: 2000 }, { width: 1200, height: 1048 });
  assert.equal(view.scale, 0.5);
  assert.equal(view.x, 350);
  assert.equal(view.y, 24);
});

test('a small diagram is centred, not enlarged', () => {
  assert.deepEqual(fitView({ width: 100, height: 100 }, { width: 500, height: 300 }), { scale: 1, x: 200, y: 100 });
});

test('zooming keeps what is under the pointer where it is', () => {
  const before = { x: 10, y: 20, scale: 1 };
  const after = zoomedAt(before, 2, 110, 120);
  const pointAt = (view) => [(110 - view.x) / view.scale, (120 - view.y) / view.scale];
  assert.deepEqual(pointAt(after), pointAt(before));
  assert.equal(after.scale, 2);
});

test('zoom stops at its limits', () => {
  assert.equal(zoomedAt({ x: 0, y: 0, scale: 3 }, 100, 0, 0).scale, 4);
  assert.equal(zoomedAt({ x: 0, y: 0, scale: 0.3 }, 0.01, 0, 0).scale, 0.2);
});

test('a sequence diagram\'s heads stay put until they would leave the top, then stay at the top', () => {
  const heads = { top: 10, bottom: 50, height: 800 };
  assert.equal(pinOffset({ y: 100, scale: 1 }, heads), 0);
  assert.equal(pinOffset({ y: -2, scale: 1 }, heads), 0);
  assert.equal(pinOffset({ y: -102, scale: 1 }, heads), 100);
  assert.equal(pinOffset({ y: -102, scale: 2 }, heads), 45);
});

test('and leave along with the diagram once it has gone past', () => {
  assert.equal(pinOffset({ y: -5000, scale: 1 }, { top: 10, bottom: 50, height: 800 }), 750);
});
