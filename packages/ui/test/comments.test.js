import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentSettings, keyOf, setupComments } from '../renderer/comments.js';

// Comments on the same thing gather under one key, whatever the app calls the whole thing.
test('SmartSpec’s comments gather by what they’re on, its title (card: true) apart', () => {
  assert.equal(commentSettings.whole, 'schematic');
  assert.equal(keyOf({ schematic: true }), 'schematic');
  assert.equal(keyOf({ item: 'cart', card: true }), 'cart|card');
  assert.equal(keyOf({ item: 'cart', quote: 'two weeks' }), 'cart|quote|two weeks');
  assert.equal(keyOf({ item: 'cart', part: 'pay' }), 'cart|part|pay');
  assert.equal(keyOf({ item: 'cart', part: 'pay', partMissing: true }), 'cart|item');
  assert.equal(keyOf({ item: 'cart', point: { x: 0.25, y: 0.5 } }), 'cart|point|0.250|0.500');
  assert.equal(keyOf({ item: 'cart' }), 'cart|item');
});

test('SmartPrep’s questions are about a topic, and a card named in `card` is no title', () => {
  const before = { ...commentSettings };
  try {
    setupComments({ noun: 'question', whole: 'topic', titles: false });
    assert.equal(keyOf({ topic: true }), 'topic');
    // SmartPrep's store names the card a question is on `card`: a name, not SmartSpec's flag.
    assert.equal(keyOf({ item: 'c-1', card: 'c-1' }), 'c-1|item');
    assert.equal(keyOf({ item: 'c-1', quote: 'heat pump' }), 'c-1|quote|heat pump');
  } finally {
    setupComments(before);
  }
});
