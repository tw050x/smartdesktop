import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grow, sentenceAt, sentencesOf, wordAt } from '../packages/app/src/renderer/pick-rules.js';

const text = 'Nodes fail and pods crash. A loop that keeps comparing puts things right. It never stops. Done.';
const words = (span) => span && text.slice(...span);

test('a paragraph\'s sentences, words and the sentence at a place', () => {
  assert.deepEqual(sentencesOf(text).map(words), ['Nodes fail and pods crash.', 'A loop that keeps comparing puts things right.', 'It never stops.', 'Done.']);
  assert.equal(words(wordAt(text, 7)), 'fail');
  assert.equal(words(wordAt(text, 10)), 'fail'); // just after its last letter
  assert.equal(wordAt(text, 26), null); // the space after a full stop
  assert.equal(words(sentenceAt(text, 30)), 'A loop that keeps comparing puts things right.');
});

test('each double-click on what\'s picked: word, sentence, the sentences either side, the paragraph', () => {
  let span = wordAt(text, 30); // "loop"
  span = grow(text, span);
  assert.equal(words(span), 'A loop that keeps comparing puts things right.');
  span = grow(text, span);
  assert.equal(words(span), 'Nodes fail and pods crash. A loop that keeps comparing puts things right. It never stops.');
  span = grow(text, span);
  assert.equal(words(span), text);
  assert.equal(grow(text, span), null);
});

test('at the start or end of a paragraph, a sentence grows to one side, and two sentences to the paragraph', () => {
  let span = grow(text, wordAt(text, 0));
  assert.equal(words(span), 'Nodes fail and pods crash.');
  span = grow(text, span);
  assert.equal(words(span), 'Nodes fail and pods crash. A loop that keeps comparing puts things right.');
  assert.equal(words(grow(text, span)), text);
  assert.equal(words(grow(text, grow(text, sentenceAt(text, text.length - 2)))), text);
});

test('words picked across sentences grow to the sentences they touch, and a lone sentence is its paragraph', () => {
  assert.equal(words(grow(text, [20, 30])), 'Nodes fail and pods crash. A loop that keeps comparing puts things right.');
  assert.equal(grow('Just one.', [0, 9]), null);
  assert.equal(grow('   ', [0, 3]), null);
});
