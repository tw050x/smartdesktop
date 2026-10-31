import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_READ_CHARS, estimateTokens, findText, parsePages, textStats } from '../packages/app/src/main/text-stats.js';

describe('pages', () => {
  test('single pages, ranges and lists, sorted without repeats', () => {
    assert.deepEqual(parsePages('3', 10), [3]);
    assert.deepEqual(parsePages('5-7', 10), [5, 6, 7]);
    assert.deepEqual(parsePages('9, 1-3, 2', 10), [1, 2, 3, 9]);
    assert.deepEqual(parsePages('4 – 5', 10), [4, 5]);
  });

  test('pages outside the document or that make no sense are refused', () => {
    assert.throws(() => parsePages('11', 10), /has 10 pages/);
    assert.throws(() => parsePages('0', 10), /aren't in the document/);
    assert.throws(() => parsePages('5-3', 10), /aren't in the document/);
    assert.throws(() => parsePages('first', 10), /isn't a page/);
    assert.throws(() => parsePages(' , ', 10), /Name the pages/);
  });
});

describe('counts', () => {
  test('words, characters and lines', () => {
    const stats = textStats('One two three.\nFour five\n\n');
    assert.equal(stats.words, 5);
    assert.equal(stats.characters, 26);
    assert.equal(stats.lines, 2);
  });

  test('paragraphs end at short closing lines, headings and before list items', () => {
    const text = [
      'Terms and conditions', // heading: short
      'This agreement sets out the terms on which the Supplier provides the',
      'services to the Customer and how they are paid for.', // closes a paragraph
      'Payment is due within thirty days of the date on which the invoice',
      'is issued, and late payments incur interest.', // closes a paragraph
      '1. The first item in a list of things that follow', // a list item
      '2. The second item',
    ].join('\n');
    assert.equal(textStats(text).paragraphs, 5);
  });

  test('an empty page has nothing', () => {
    assert.deepEqual(textStats(''), { words: 0, characters: 0, lines: 0, paragraphs: 0 });
  });

  test('tokens are estimated from characters, and the read limit stays under AI apps\' caps', () => {
    assert.equal(estimateTokens(4000), 1000);
    assert.ok(estimateTokens(MAX_READ_CHARS) < 25000);
  });
});

describe('finding text', () => {
  const texts = ['Payment is due within 30 days.\nLate payment incurs interest.', 'No payment\nterms here.'];

  test('matches ignore case and spacing, and give the exact text with its page', () => {
    const found = findText(texts, 'PAYMENT  terms', 50);
    assert.equal(found.total, 1);
    assert.deepEqual(found.matches[0], { page: 2, match: 'payment\nterms', snippet: 'No payment terms here.' });
  });

  test('every match is counted, but only up to the limit are returned', () => {
    const found = findText(texts, 'payment', 2);
    assert.equal(found.total, 3);
    assert.equal(found.matches.length, 2);
    assert.match(found.more, /1 more/);
  });

  test('characters with meaning in patterns are found as written', () => {
    assert.equal(findText(['Costs (in GBP) are 24.000'], '(in GBP)', 50).total, 1);
    assert.equal(findText(['Costs are 24,000'], '24.000', 50).total, 0);
  });

  test('a long page gives a snippet around the match', () => {
    const long = `${'a '.repeat(100)}needle${' b'.repeat(100)}`;
    const { snippet } = findText([long], 'needle', 50).matches[0];
    assert.ok(snippet.startsWith('…') && snippet.endsWith('…') && snippet.includes('needle'));
    assert.ok(snippet.length < 200);
  });

  test('an empty search is refused', () => {
    assert.throws(() => findText(texts, '   ', 50), /word or phrase/);
  });
});
