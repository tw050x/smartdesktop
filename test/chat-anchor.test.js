import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorOf, firstPlace, placeFrom } from '../packages/app/src/main/chat-anchor.js';

const parent = { x: 100, y: 50, width: 1200, height: 800 };
const size = { width: 400, height: 600 };

test('a chat beside the right edge stays beside it as the window is resized', () => {
  const chat = { x: 1320, y: 120, ...size }; // 20px outside the right edge
  const anchor = anchorOf(parent, chat);
  assert.deepEqual(anchor, { side: 'right', dx: 20, edge: 'top', dy: 70 });
  assert.deepEqual(placeFrom({ ...parent, width: 1000 }, anchor, size), { x: 1120, y: 120, ...size });
});

test('a chat by the left and bottom follows those edges', () => {
  const chat = { x: 80, y: 400, width: 300, height: 500 };
  const anchor = anchorOf(parent, chat);
  assert.equal(anchor.side, 'left');
  assert.equal(anchor.edge, 'bottom');
  // Resized from the left and the bottom: it moves with those edges.
  assert.deepEqual(placeFrom({ x: 300, y: 50, width: 1000, height: 600 }, anchor, chat), { x: 280, y: 200, width: 300, height: 500 });
});

test('it first opens inside the right edge, below the top bar', () => {
  assert.deepEqual(firstPlace(parent), { x: 876, y: 114, width: 400, height: 680 });
  assert.equal(firstPlace({ ...parent, height: 300 }).height, 320);
});
