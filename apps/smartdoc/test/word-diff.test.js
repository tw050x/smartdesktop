import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diffPages } from '../packages/app/src/renderer/word-diff.js';

const slice = (pages, ranges) => ranges.map((r) => pages[r.page - 1].slice(r.start, r.end));

describe('comparing drafts', () => {
  test('identical text has no changes', () => {
    assert.deepEqual(diffPages(['one two'], ['one two']), []);
    assert.deepEqual(diffPages([''], ['']), []);
  });

  test('a change is the words that differ', () => {
    const before = ['Led a team of six.'];
    const after = ['Led a team of nine.'];
    const [change, ...rest] = diffPages(before, after);
    assert.deepEqual(rest, []);
    assert.deepEqual(slice(before, change.removed), ['six']);
    assert.deepEqual(slice(after, change.added), ['nine']);
  });

  test('removed and added text only appear on their own side', () => {
    const before = ['keep this and remove these words end'];
    const after = ['keep this end'];
    const [change] = diffPages(before, after);
    assert.deepEqual(slice(before, change.removed), ['and remove these words']);
    assert.deepEqual(change.added, []);
    const [back] = diffPages(after, before);
    assert.deepEqual(back.removed, []);
    assert.deepEqual(slice(before, back.added), ['and remove these words']);
  });

  test('wrapping and page breaks are not changes', () => {
    assert.deepEqual(diffPages(['one two\nthree four'], ['one\ntwo three', 'four']), []);
    assert.deepEqual(diffPages(['directly line-\nmanaging ten'], ['directly line-managing\nten']), []);
    assert.deepEqual(diffPages(['Vue/\nNuxt'], ['Vue/Nuxt']), []);
  });

  test('edits close together are one change, far apart are separate', () => {
    const near = diffPages(['built 2 iOS apps today'], ['built an iOS app today']);
    assert.equal(near.length, 1);
    assert.deepEqual(slice(['built 2 iOS apps today'], near[0].removed), ['2', 'apps']);
    assert.equal(diffPages(['a b c d e f g h'], ['x b c d e f g y']).length, 2);
  });

  test('a removed line is marked whole, its closing bracket included', () => {
    const before = ['one (first)\ntwo (second)\nthree'];
    const after = ['one (first)\nthree'];
    const [change] = diffPages(before, after);
    assert.deepEqual(slice(before, change.removed), ['two (second)']);
  });

  test('a change that crosses pages has a range on each', () => {
    const before = ['keep gone', 'also keep'];
    const after = ['keep'];
    const [change] = diffPages(before, after);
    assert.deepEqual(change.removed, [{ page: 1, start: 5, end: 9 }, { page: 2, start: 0, end: 9 }]);
  });

  test('applying the changes to random text gives the other text, in the fewest edits', () => {
    let seed = 7;
    const random = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const words = (length) => Array.from({ length }, () => 'abcd'[random(4)]);
    const shortest = (a, b) => {
      const row = Array.from({ length: b.length + 1 }, (_, j) => j);
      for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
          const held = row[j];
          row[j] = a[i - 1] === b[j - 1] ? diagonal : Math.min(row[j], row[j - 1]) + 1;
          diagonal = held;
        }
      }
      return row[b.length];
    };
    for (let round = 0; round < 500; round++) {
      const a = words(random(30));
      const b = words(random(30));
      const before = [a.join(' ')];
      const after = [b.join(' ')];
      const changes = diffPages(before, after);
      const count = (ranges) => ranges.reduce((n, r) => n + before[0].slice(r.start, r.end).split(' ').length, 0);
      const countB = (ranges) => ranges.reduce((n, r) => n + after[0].slice(r.start, r.end).split(' ').length, 0);
      const removed = changes.flatMap((c) => c.removed);
      const added = changes.flatMap((c) => c.added);
      assert.equal(count(removed) + countB(added), shortest(a, b), `${before} → ${after}`);
      // What's left of each side once its changes are taken out is the same.
      const left = (text, ranges) => {
        let out = '';
        let from = 0;
        for (const r of ranges) {
          out += text.slice(from, r.start);
          from = r.end;
        }
        return (out + text.slice(from)).split(/\s+/).filter(Boolean).join(' ');
      };
      assert.equal(left(before[0], removed), left(after[0], added), `${before} → ${after}`);
    }
  });

  test('documents with nothing in common are one change', () => {
    const before = [Array.from({ length: 5000 }, (_, i) => `a${i}`).join(' ')];
    const after = [Array.from({ length: 5000 }, (_, i) => `b${i}`).join(' ')];
    const changes = diffPages(before, after);
    assert.equal(changes.length, 1);
    assert.deepEqual(slice(before, changes[0].removed), before);
  });
});
