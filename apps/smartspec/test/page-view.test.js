import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leastPageZoom, PAGE_HEIGHT, PAGE_WIDTH, pageZoom, zoomPage } from '../packages/app/src/renderer/page-view.js';

test('left alone, a page shrinks to fit a smaller space and is never enlarged', () => {
  assert.equal(pageZoom(PAGE_WIDTH), 1);
  assert.equal(pageZoom(2000), 1);
  assert.equal(pageZoom(PAGE_WIDTH / 2), 0.5);
  assert.ok(pageZoom(0) > 0);
});

test('a page dragged to a size keeps it, past its own size if there is space', () => {
  assert.equal(pageZoom(2000, PAGE_WIDTH * 1.5), 1.5);
  assert.equal(pageZoom(2000, PAGE_WIDTH / 2), 0.5);
});

test('a page dragged to a size is still kept within the space', () => {
  assert.equal(pageZoom(PAGE_WIDTH, PAGE_WIDTH * 2), 1);
  assert.equal(pageZoom(PAGE_WIDTH / 2, PAGE_WIDTH), 0.5);
});

test('a page in a card zooms by steps, within its limits', () => {
  assert.equal(zoomPage(1, 1.25), 1.25);
  assert.equal(zoomPage(0.3, 0.5), 0.25);
  assert.equal(zoomPage(3.5, 2), 4);
});

test('a page in a card zooms out no further than one whole page in view', () => {
  assert.equal(leastPageZoom(PAGE_WIDTH, PAGE_HEIGHT / 2), 0.5);
  assert.equal(leastPageZoom(PAGE_WIDTH / 2, PAGE_HEIGHT), 0.5);
  assert.equal(zoomPage(0.6, 0.5, 0.5), 0.5);
  assert.equal(zoomPage(0.6, 2, 0.5), 1.2);
});
