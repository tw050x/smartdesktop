import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { historyVerdict, matchesInPages, snippetOf } from '../packages/app/src/renderer/text-search.js';

const found = (text, query) => matchesInPages([text], query).map((m) => text.slice(m.start, m.end));

describe('finding text', () => {
  test('case is ignored and every match is found, page by page', () => {
    assert.deepEqual(matchesInPages(['Led a team', 'the TEAM grew, team'], 'team'), [
      { page: 1, start: 6, end: 10 },
      { page: 2, start: 4, end: 8 },
      { page: 2, start: 15, end: 19 },
    ]);
  });

  test('a phrase can run across a line break', () => {
    assert.deepEqual(found('led a\nsmall   team', 'a small team'), ['a\nsmall   team']);
  });

  test('straight and curly quotes are the same', () => {
    assert.deepEqual(found('don’t and don\'t', "don't"), ['don’t', "don't"]);
    assert.deepEqual(found('don\'t', 'don’t'), ["don't"]);
    assert.deepEqual(found('the “best” team', '"best"'), ['“best”']);
  });

  test('what is typed is taken literally', () => {
    assert.deepEqual(found('costs (approx.) $5', '(approx.)'), ['(approx.)']);
    assert.deepEqual(found('abc', 'a.c'), []);
  });

  test('nothing to find finds nothing', () => {
    assert.deepEqual(matchesInPages(['text'], '   '), []);
  });

  test('a snippet has the text around the match, on one line', () => {
    const text = `${'x'.repeat(50)} the\nteam ${'y'.repeat(50)}`;
    const [match] = matchesInPages([text], 'the team');
    const snippet = snippetOf(text, match);
    assert.equal(snippet.match, 'the team');
    assert.ok(snippet.before.startsWith('…'));
    assert.ok(snippet.after.endsWith('…'));
    assert.deepEqual(snippetOf('the team', { start: 4, end: 8 }), { before: 'the ', match: 'team', after: '' });
  });
});

describe('the verdict on the history', () => {
  const line = (...counts) => counts.map((count, i) => ({ id: String(i), label: i ? `Draft ${i}` : 'Original', count }));

  test('text the newest draft no longer has was removed after the last draft with it', () => {
    assert.equal(historyVerdict(line(2, 1, 0), '2'), 'Removed after Draft 1');
    assert.equal(historyVerdict(line(2, 0, 0), '2'), 'Removed after Original');
    assert.equal(historyVerdict(line(2, 1, 0), '0'), 'Removed after Draft 1');
  });

  test('text taken out and put back is not removed', () => {
    assert.equal(historyVerdict(line(1, 0, 3), '2'), 'In 1 other draft');
  });

  test('text in the newest draft and others counts the others', () => {
    assert.equal(historyVerdict(line(1, 1, 1), '2'), 'In 2 other drafts');
  });

  test('text only in the draft showing, or nowhere', () => {
    assert.equal(historyVerdict(line(0, 0, 4), '2'), 'Not in any other draft');
    assert.equal(historyVerdict(line(0, 0, 0), '2'), 'Not in any draft');
  });
});
