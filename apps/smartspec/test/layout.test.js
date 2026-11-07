import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutCards } from '../packages/app/src/renderer/layout.js';

const cards = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, width: 280, height: 80 + (i % 3) * 30 }));
const hub = (n) => Array.from({ length: n - 1 }, (_, i) => ['c0', `c${i + 1}`]);
const inside = (point, card) => point.x > card.x - card.width / 2 + 0.5 && point.x < card.x + card.width / 2 - 0.5 && point.y > card.y - card.height / 2 + 0.5 && point.y < card.y + card.height / 2 - 0.5;

test('the overview grid takes the shape of the room it is shown in', () => {
  const wide = layoutCards(cards(14), hub(14), { width: 1600, height: 800 });
  const tall = layoutCards(cards(14), hub(14), { width: 600, height: 1200 });
  assert.ok(wide.columns > tall.columns);
  assert.ok(wide.width / wide.height > 1 && tall.width / tall.height < 1);
});

test('overview cards never overlap, and the most linked is in among the rest', () => {
  const layout = layoutCards(cards(14), hub(14), { width: 1600, height: 800 });
  for (const a of layout.cards) {
    for (const b of layout.cards) {
      if (a === b) continue;
      assert.ok(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2, `${a.id} overlaps ${b.id}`);
    }
  }
  const centre = layout.cards.find((card) => card.id === 'c0');
  assert.ok(layout.cards.some((card) => card.x < centre.x) && layout.cards.some((card) => card.x > centre.x));
});

test('overview lines run between cards, never across one, as straight runs', () => {
  const pairs = [...hub(9), ['c1', 'c8'], ['c2', 'c7'], ['c3', 'c5']];
  const layout = layoutCards(cards(9), pairs, { width: 1400, height: 800 });
  assert.equal(layout.lines.length, pairs.length);
  for (const { points } of layout.lines) {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      assert.ok(a.x === b.x || a.y === b.y, 'each run is level or upright');
      for (let t = 0.02; t < 1; t += 0.02) {
        const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        assert.ok(!layout.cards.some((card) => inside(point, card)), `a line crosses a card at ${point.x},${point.y}`);
      }
    }
  }
});
