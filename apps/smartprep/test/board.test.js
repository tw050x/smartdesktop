import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balance, bringToMiddle, cardnessAtEdge, groupCards, cleanLayout, defaultLayout, fillBox, filling, fillMiddle, fills, forgetSnap, layoutToSave, leastScale, LEAST_SCALE, placeNew, scaleAtEdge, separate, SMALLEST_SCALE, settleFilling, settleSize, stagger, STAGGER, toFront, zoneAt, zoneAtEdge, zoneOf } from '../packages/app/src/renderer/board.js';

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
  const out = [0.14, 0.12, 0.1, 0.07, 0.031].map((e) => scaleAtEdge(e));
  for (let i = 1; i < out.length; i++) assert.ok(out[i] < out[i - 1]);
  assert.ok(Math.abs(scaleAtEdge(0.03) - SMALLEST_SCALE) < 1e-9);
  assert.ok(Math.abs(scaleAtEdge(-0.1) - SMALLEST_SCALE) < 1e-9);
});

test('at its smallest it is its card, and the swap is at one point', () => {
  assert.equal(cardnessAtEdge(0.2), 0);
  assert.equal(cardnessAtEdge(0.031), 0);
  assert.equal(cardnessAtEdge(0.03), 1);
  assert.equal(cardnessAtEdge(-0.05), 1);
  assert.ok(Math.abs(scaleAtEdge(0.03) - SMALLEST_SCALE) < 1e-9);
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

test('an open item can be made to fill the middle, in front, whatever else is there', () => {
  let layout = defaultLayout({ centre: 'a', left: [], right: ['b'] }, {}, board);
  layout = bringToMiddle(layout, 'b', board);
  assert.ok(!filling(layout, 'b', board));
  const filled = fillMiddle(layout, 'b', board);
  const fill = fillBox(board);
  assert.deepEqual(['cx', 'cy', 'w', 'h'].map((key) => filled.boxes.b[key]), ['cx', 'cy', 'w', 'h'].map((key) => fill[key]));
  assert.ok(filled.boxes.b.sized, 'it keeps that size with something else in the middle');
  assert.ok(filled.boxes.b.z > filled.boxes.a.z);
  assert.ok(filling(filled, 'b', board));
  assert.deepEqual({ cx: filled.boxes.a.cx, w: filled.boxes.a.w }, { cx: layout.boxes.a.cx, w: layout.boxes.a.w }, 'nothing else moves');
  // An item scaled down at a side loses its kept edge, so it's at full size in the middle.
  const aside = { boxes: { ...layout.boxes, b: { ...layout.boxes.b, cx: 0.85, ex: 0.08 } } };
  assert.equal(fillMiddle(aside, 'b', board).boxes.b.ex, undefined);
  // A lone item that hasn't been sized already fills it.
  assert.ok(filling(defaultLayout({ centre: 'a', left: [], right: ['b'] }, {}, board), 'a', board));
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

test('open items in the middle that hide one another are drawn as a cascade', () => {
  const board = { width: 1000, height: 800 };
  const full = { cx: 0.5, cy: 0.5, w: 0.6, h: 0.9, sized: true };
  const layout = { boxes: { a: { ...full, z: 1 }, b: { ...full, z: 2 }, side: { cx: 0.04, cy: 0.5, w: 0.3, h: 0.3, ex: 0, z: 0 } } };
  const drawn = stagger(layout, board);
  assert.deepEqual(Object.keys(drawn).sort(), ['a', 'b']);
  const px = (box) => ({ left: (box.cx - box.w / 2) * 1000, top: (box.cy - box.h / 2) * 800, width: box.w * 1000, height: box.h * 800 });
  const [back, front] = [px(drawn.a), px(drawn.b)];
  // The one behind keeps the top left; the one in front starts a step lower and to the right.
  assert.ok(Math.abs(back.left - 200) < 1e-6 && Math.abs(back.top - 40) < 1e-6);
  assert.ok(Math.abs(front.left - back.left - STAGGER) < 1e-6 && Math.abs(front.top - back.top - STAGGER) < 1e-6);
  // Both a step smaller, so together they take the space the two took.
  assert.ok(Math.abs(back.width - (600 - STAGGER)) < 1e-6 && Math.abs(front.height - (720 - STAGGER)) < 1e-6);
  // The layout itself is left as it was.
  assert.deepEqual(layout.boxes.a, { ...full, z: 1 });
});

test('items that show enough of each other, or a small one in front of a big one, stay as they are', () => {
  const board = { width: 1000, height: 800 };
  const apart = { boxes: { a: { cx: 0.4, cy: 0.5, w: 0.3, h: 0.5, z: 1 }, b: { cx: 0.6, cy: 0.5, w: 0.3, h: 0.5, z: 2 } } };
  assert.deepEqual(stagger(apart, board), {});
  const smallInFront = { boxes: { big: { cx: 0.5, cy: 0.5, w: 0.6, h: 0.9, z: 1 }, small: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.2, z: 2 } } };
  assert.deepEqual(stagger(smallInFront, board), {});
  // What's being dragged is left out, so the one it was over gets its own size back.
  const over = { boxes: { a: { cx: 0.5, cy: 0.5, w: 0.6, h: 0.9, z: 1 }, b: { cx: 0.5, cy: 0.5, w: 0.6, h: 0.9, z: 2 } } };
  assert.deepEqual(stagger(over, board, ['b']), {});
});

test('three that hide one another cascade in order, back to front', () => {
  const board = { width: 1000, height: 800 };
  const box = { cx: 0.5, cy: 0.5, w: 0.45, h: 0.72 };
  const drawn = stagger({ boxes: { c: { ...box, z: 3 }, a: { ...box, z: 1 }, b: { ...box, z: 2 } } }, board);
  const left = (id) => (drawn[id].cx - drawn[id].w / 2) * 1000;
  assert.ok(left('a') < left('b') && left('b') < left('c'));
  assert.ok(Math.abs(left('c') - left('a') - 2 * STAGGER) < 1e-6);
});

test('an item dragged to the top forgets what it pushed aside once anything else comes into the middle', () => {
  const restore = { self: { cx: 0.4, cy: 0.5, w: 0.3, h: 0.4, z: 1 }, others: { b: { cx: 0.6, cy: 0.5, w: 0.3, h: 0.4, z: 2 } } };
  const layout = { boxes: { a: { cx: 0.5, cy: 0.5, w: 0.5, h: 0.6, z: 3, restore }, b: { cx: 0.05, cy: 0.5, w: 0.3, h: 0.4, z: 2, ex: 0 }, c: { cx: 0.95, cy: 0.5, w: 0.3, h: 0.4, z: 0, ex: 0 } } };
  // Brought in from the side, or another made to fill the middle: no longer the snapped item's own.
  assert.equal(bringToMiddle(layout, 'c').boxes.a.restore, undefined);
  assert.equal(fillMiddle(layout, 'a', { width: 1200, height: 800 }).boxes.a.restore, undefined);
  assert.equal(forgetSnap(layout).boxes.a.restore, undefined);
  assert.deepEqual(forgetSnap(layout).boxes.b, layout.boxes.b);
  // Nothing to forget: the same layout.
  const plain = forgetSnap(layout);
  assert.equal(forgetSnap(plain), plain);
});

test('a card with less to show gets smaller at the side, always within the limits', () => {
  const full = { width: 576, height: 560 };
  const measure = (text, px) => text.length * px * 0.55; // about the width of a sans-serif title
  const short = leastScale({ title: 'Contract', icon: false, full, measure });
  const tagged = leastScale({ title: 'Pages', rows: 1, full, measure });
  const long = leastScale({ title: "Restoring an account's backup", rows: 1, full, measure });
  assert.ok(short < tagged && tagged < long, `${short} < ${tagged} < ${long}`);
  for (const scale of [short, tagged, long]) assert.ok(scale >= LEAST_SCALE[0] && scale <= LEAST_SCALE[1]);
  // A title that can't fit even at the largest keeps the largest.
  assert.equal(leastScale({ title: 'Averyveryveryverylongwordthatnevercanfit', full, measure }), LEAST_SCALE[1]);
});
