import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balance, bringToMiddle, cardnessAtEdge, groupCards, cleanLayout, defaultLayout, fillBox, fills, layoutToSave, placeNew, scaleAtEdge, separate, settleFilling, settleSize, toFront, zoneAt, zoneAtEdge, zoneOf } from '../packages/app/src/renderer/board.js';

const board = { width: 1400, height: 900 };

test('where an item sits says how it shows', () => {
  assert.equal(zoneAt(0.5), 'middle');
  assert.equal(zoneAt(0.3), 'middle');
  assert.equal(zoneAt(0.7), 'middle');
  assert.equal(zoneAt(0.2), 'side');
  assert.equal(zoneAt(0.8), 'side');
  assert.equal(zoneAt(0.05), 'edge');
  assert.equal(zoneAt(0.95), 'edge');
});

test('open, it shrinks steadily as its outer edge nears the side, down to its smallest', () => {
  assert.equal(scaleAtEdge(0.3), 1);
  assert.equal(scaleAtEdge(0.15), 1);
  const out = [0.14, 0.12, 0.1, 0.07, 0.031].map(scaleAtEdge);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] < out[i - 1]);
  assert.ok(Math.abs(scaleAtEdge(0.03) - 0.25) < 1e-9);
  assert.ok(Math.abs(scaleAtEdge(-0.1) - 0.25) < 1e-9);
});

test('at its smallest it is its card, and the swap is at one point', () => {
  assert.equal(cardnessAtEdge(0.2), 0);
  assert.equal(cardnessAtEdge(0.031), 0);
  assert.equal(cardnessAtEdge(0.03), 1);
  assert.equal(cardnessAtEdge(-0.05), 1);
  assert.equal(scaleAtEdge(0.03), 0.25);
  assert.equal(zoneAtEdge(0.2), 'middle');
  assert.equal(zoneAtEdge(0.1), 'side');
  assert.equal(zoneAtEdge(0), 'edge');
});
test('an item has one size for each place, however its size and edge depend on each other', () => {
  // A frame 1000px across at most, its size rising steeply with its edge; the edge falling as it widens.
  const widthAt = (e) => 100 + 900 * Math.min(1, Math.max(0, e / 0.15));
  const edgeAt = (w) => (300 - 0.2 * w) / 1400;
  const one = settleSize(widthAt, edgeAt, 1, 2000);
  assert.ok(Math.abs(widthAt(one.edge) - one.width) < 0.01);
  // Moving the pointer a little moves the answer a little.
  const next = settleSize(widthAt, (w) => (301 - 0.2 * w) / 1400, 1, 2000);
  assert.ok(Math.abs(next.width - one.width) < 10);
});test('a first layout puts one item in the middle and the rest down the edges, from the top', () => {
  const layout = defaultLayout({ centre: 'a', left: ['b'], right: ['c', 'd'] }, { b: 100, c: 100, d: 100 }, board);
  assert.equal(zoneAt(layout.boxes.a.cx), 'middle');
  assert.ok(fills(layout, 'a'));
  assert.ok(layout.boxes.b.cx < 0.12 && layout.boxes.c.cx > 0.88);
  assert.ok(layout.boxes.c.cy < layout.boxes.d.cy);
  assert.equal(Math.round(layout.boxes.b.cy * board.height), 16 + 50);
});

test('cards too many for the edge overlap rather than run off it', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `i${i}`);
  const layout = defaultLayout({ centre: null, left: [], right: ids }, Object.fromEntries(ids.map((id) => [id, 100])), board);
  const last = layout.boxes.i19.cy * board.height + 50;
  assert.ok(last <= board.height - 16 + 0.001);
});

test('a lone item fills the middle until another joins it or the user sizes it', () => {
  let layout = defaultLayout({ centre: 'a', left: [], right: ['b'] }, {}, board);
  assert.ok(fills(layout, 'a'));
  assert.ok(!fills(layout, 'a', 'a'), 'not while it is dragged');
  layout = bringToMiddle(layout, 'b', board);
  assert.ok(!fills(layout, 'a') && !fills(layout, 'b'));
  // What filled the middle kept that box, so it didn't jump.
  assert.deepEqual({ w: layout.boxes.a.w, h: layout.boxes.a.h }, { w: fillBox(board).w, h: fillBox(board).h });
  assert.equal(layout.boxes.b.cx, 0.5);
  assert.ok(layout.boxes.b.z > layout.boxes.a.z);
  const sized = { boxes: { a: { ...layout.boxes.a, sized: true } } };
  assert.ok(!fills(sized, 'a'));
});

test('settling leaves a layout with nothing filling the middle as it is', () => {
  const layout = { boxes: { a: { cx: 0.05, cy: 0.2, w: 0.4, h: 0.6, z: 0, sized: false } } };
  assert.equal(settleFilling(layout, board), layout);
});

test('touching an item brings it to the front', () => {
  const layout = { boxes: { a: { cx: 0.5, cy: 0.5, w: 0.4, h: 0.5, z: 3 }, b: { cx: 0.4, cy: 0.5, w: 0.4, h: 0.5, z: 1 } } };
  assert.equal(toFront(layout, 'a'), layout);
  assert.equal(toFront(layout, 'b').boxes.b.z, 4);
});

test('new items go down the edge with less in it, below what is there', () => {
  const layout = defaultLayout({ centre: 'a', left: [], right: ['b'] }, { b: 100 }, board);
  const next = placeNew(layout, ['a', 'b', 'c', 'd'], { b: 100, c: 100, d: 100 }, board);
  assert.ok(next.boxes.c.cx < 0.12);
  assert.ok(next.boxes.d.cx > 0.88 && next.boxes.d.cy > next.boxes.b.cy);
  assert.equal(placeNew(next, ['a', 'b', 'c', 'd'], {}, board), next);
});

test('the first layout shares the cards between the two sides', () => {
  const ids = ['b', 'c', 'd', 'e', 'f', 'g'];
  const heights = Object.fromEntries(ids.map((id) => [id, 100]));
  const [left, right] = balance(['b'], ['c', 'd', 'e', 'f', 'g'], heights);
  assert.equal(left[0], 'b');
  assert.equal(left.length, 3);
  assert.equal(right.length, 3);
  const layout = defaultLayout({ centre: 'a', left: ['b'], right: ['c', 'd', 'e', 'f', 'g'] }, heights, board);
  assert.equal(ids.filter((id) => layout.boxes[id].cx < 0.5).length, 3);
});

test('things on one side are kept apart', () => {
  const rects = [
    { id: 'a', rank: 0, left: 0, width: 200, top: 100, height: 100 },
    { id: 'b', rank: 1, left: 50, width: 200, top: 150, height: 100 },
    { id: 'c', rank: 2, left: 300, width: 100, top: 150, height: 100 },
  ];
  const { tops, fits } = separate(rects, { top: 8, bottom: 900, gap: 8 });
  assert.equal(tops.a, 100);
  assert.equal(tops.b, 208);
  assert.equal(tops.c, 150); // not across from the others, so it stays
  assert.ok(fits);
  assert.equal(separate(rects, { top: 8, bottom: 250, gap: 8 }).fits, false);
  // Something being dragged stays put, and the rest move out of its way.
  const held = { id: 'h', left: 0, width: 200, top: 90, height: 50 };
  const around = separate(rects, { top: 8, bottom: 900, gap: 8 }, [held]);
  assert.equal(around.tops.a, 148);
  assert.equal('h' in around.tops, false);
});

test('what is kept is fractions, and only what is well formed comes back', () => {
  const layout = { boxes: { a: { cx: 0.123456789, cy: 0.5, w: 0.4, h: 0.6, z: 2, sized: true }, b: { cx: 0.9, cy: 0.1, w: 0.45, h: 0.72, z: 0, sized: false } } };
  const saved = layoutToSave(layout, ['a', 'b']);
  assert.equal(saved.boxes.a.cx, 0.1235);
  assert.equal(saved.boxes.a.sized, true);
  assert.equal('sized' in saved.boxes.b, false);
  const back = cleanLayout(JSON.parse(JSON.stringify({ boxes: { ...saved.boxes, bad: { cx: 'x' }, far: { cx: 4, cy: -1, w: 0.4, h: 0.4 } } })));
  assert.deepEqual(Object.keys(back.boxes).sort(), ['a', 'b', 'far']);
  assert.deepEqual([back.boxes.far.cx, back.boxes.far.cy], [1, 0]);
  assert.deepEqual(cleanLayout(null), { boxes: {} });
});

test('chosen on the overview, an item has the middle to itself', () => {
  const layout = { boxes: {
    a: { cx: 0.5, cy: 0.5, w: 0.45, h: 0.72, z: 1, sized: true },
    b: { cx: 0.6, cy: 0.3, w: 0.3, h: 0.3, z: 2, sized: true },
    c: { cx: 0.25, cy: 0.4, w: 0.3, h: 0.3, z: 0, sized: false },
    d: { cx: 0.06, cy: 0.2, w: 0.45, h: 0.72, z: 0, sized: false },
  } };
  const next = bringToMiddle(layout, 'd', board, { alone: true });
  assert.equal(next.boxes.d.cx, 0.5);
  assert.ok(fills(next, 'd'));
  assert.ok(next.boxes.b.cx > 0.9 && next.boxes.b.cy === 0.3);
  assert.ok(next.boxes.c.cx < 0.1);
  assert.equal(zoneOf(next.boxes.a), 'edge');
  // Without it, nothing else moves.
  assert.equal(bringToMiddle(layout, 'd', board).boxes.b.cx, 0.6);
});

test('a dropped item keeps the size it had where it was let go, until it is brought in', () => {
  const layout = { boxes: { a: { cx: 0.18, cy: 0.5, w: 0.4, h: 0.6, z: 1, sized: false, ex: 0.06 } } };
  assert.equal(zoneOf(layout.boxes.a), 'side');
  const saved = cleanLayout(JSON.parse(JSON.stringify(layoutToSave(layout, ['a']))));
  assert.equal(saved.boxes.a.ex, 0.06);
  const brought = bringToMiddle(saved, 'a');
  assert.equal(zoneOf(brought.boxes.a), 'middle');
});

test('cards stay where they were put, and only ones that would overlap group up', () => {
  const bounds = { top: 8, bottom: 1000, gap: 8 };
  const cards = [
    { id: 'a', top: 50, height: 100 },
    { id: 'b', top: 100, height: 100 }, // over a: they group, moving as little as they can
    { id: 'c', top: 400, height: 100 }, // clear of everything: stays exactly where it was put
    { id: 'd', top: 700, height: 100 },
  ];
  const tops = Object.fromEntries(groupCards(cards, bounds).map(({ id, top }) => [id, top]));
  assert.equal(tops.b - tops.a, 108);
  assert.equal((tops.a + tops.b) / 2, (50 + 100) / 2); // round where they were put
  assert.equal(tops.c, 400);
  assert.equal(tops.d, 700);
});
test('cards make way for open things beside them, with room between', () => {
  const rects = [
    { id: 'card', rank: 0, left: 410, width: 100, top: 100, height: 100 },
    { id: 'open', open: true, rank: 1, left: 0, width: 400, top: 150, height: 300 },
  ];
  const { tops } = separate(rects, { top: 8, bottom: 2000, gap: 8, across: 24 });
  assert.equal(tops.open, 150); // the open one stays
  assert.equal(tops.card, 42); // the card beside it moves clear, up being nearer than down
});

test('a card in the way slides towards the side, or shrinks, when that moves it least', () => {
  const open = { id: 'open', open: true, rank: 0, left: 0, width: 400, top: 0, height: 600 };
  // Room by the side to slide clear: it slides rather than dropping below.
  const slides = separate([open, { id: 'card', rank: 1, out: 1, room: 200, left: 380, width: 100, top: 100, height: 100 }], { top: 0, bottom: 2000, gap: 8, across: 24 });
  assert.equal(slides.tops.card, 100);
  assert.equal(slides.lefts.card, 424);
  // Little room, but enough to fit at a smaller size: it shrinks into it.
  const shrinks = separate([open, { id: 'card', rank: 1, out: 1, room: 20, left: 380, width: 100, top: 100, height: 100 }], { top: 0, bottom: 2000, gap: 8, across: 24 });
  assert.equal(shrinks.tops.card, 100);
  assert.ok(shrinks.scales.card < 1 && shrinks.scales.card >= 0.5);
  // No room at all: it moves down.
  const drops = separate([open, { id: 'card', rank: 1, out: 1, room: 0, left: 300, width: 100, top: 100, height: 100 }], { top: 0, bottom: 2000, gap: 8, across: 24 });
  assert.equal(drops.tops.card, 608);
});

test('a card keeps the way out it took, unless another is clearly better', () => {
  const open = { id: 'open', open: true, rank: 0, left: 0, width: 400, top: 200, height: 400 };
  const bounds = { top: 0, bottom: 2000, gap: 8, across: 24 };
  // Up (cost 108) is a little nearer than down (cost 292)... unless it went down before.
  const card = { id: 'card', rank: 1, left: 300, width: 100, top: 200, height: 100 };
  assert.equal(separate([open, card], bounds).ways.card, 'up');
  assert.equal(separate([open, { ...card, prefer: 'down', lock: true }], bounds).ways.card, 'down');
  // Not locked any more: down at half its cost (146) still loses to up (108).
  assert.equal(separate([open, { ...card, prefer: 'down' }], bounds).ways.card, 'up');
});
