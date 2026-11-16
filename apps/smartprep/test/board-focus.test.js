import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bringToMiddle, choiceBoxes, choicesOf, cleanLayout, dismissChoices, fillBox, fills, focusLimits, focusOf, FOCUS_LIMITS, FOCUS_WIDTH, forgetSnap, FULL_FROM, halfBox, inMiddle, isCard, layoutToSave, leaveHalf, MARGIN, offerChoices, offeredFor, pickChoice, settleFilling, snapTarget, snapToHalf, zoneOf } from '../packages/app/src/renderer/board.js';

const board = { width: 1400, height: 900 };
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the focus area is as wide as the user makes it, within its limits', () => {
  assert.equal(focusOf(board), FOCUS_WIDTH);
  assert.equal(fillBox(board).w, FOCUS_WIDTH);
  assert.equal(fillBox({ ...board, focus: 0.5 }).w, 0.5);
  assert.equal(focusOf({ ...board, focus: 0.1 }), FOCUS_LIMITS[0]);
  assert.equal(focusOf({ ...board, focus: 0.95 }), FOCUS_LIMITS[1]);
  // Never so narrow it's no use: on a smaller board the least is wider.
  const [low] = focusLimits(1000);
  assert.ok(near(low, 0.42));
  assert.equal(focusOf({ width: 1000, height: 700, focus: 0.3 }), low);
  // Nor so wide that what fills it reaches where items shrink.
  assert.ok((1 - FOCUS_LIMITS[1]) / 2 >= FULL_FROM);
});

test('a lone item fills the focus area at its width', () => {
  const layout = { boxes: { a: { cx: 0.5, cy: 0.5, w: 0.45, h: 0.72, z: 1, sized: false }, b: { cx: 0.06, cy: 0.2, w: 0.45, h: 0.72, z: 0, ex: 0 } } };
  assert.ok(fills(layout, 'a'));
  const wide = { ...board, focus: 0.66 };
  const settled = bringToMiddle(layout, 'b', wide);
  assert.ok(near(settled.boxes.a.w, 0.66), 'it kept the focus area\'s width as it was');
});

test('the top\'s thirds pick the left half, all of it, or the right half', () => {
  const { cx, w } = fillBox(board);
  const left = (cx - w / 2) * board.width;
  const third = (w * board.width) / 3;
  assert.equal(snapTarget(10, board), 'left');
  assert.equal(snapTarget(left + third - 1, board), 'left');
  assert.equal(snapTarget(left + third + 1, board), 'whole');
  assert.equal(snapTarget(board.width / 2, board), 'whole');
  assert.equal(snapTarget(left + 2 * third + 1, board), 'right');
  assert.equal(snapTarget(board.width - 5, board), 'right');
});

test('the two halves share the focus area, with room between, and follow its width', () => {
  for (const focus of [0.4, 0.6, 0.68]) {
    const size = { ...board, focus };
    const whole = fillBox(size);
    const [left, right] = [halfBox(size, 'left'), halfBox(size, 'right')];
    assert.ok(near(left.cx - left.w / 2, whole.cx - whole.w / 2), 'from the focus area\'s left edge');
    assert.ok(near(right.cx + right.w / 2, whole.cx + whole.w / 2), 'to its right edge');
    assert.ok(near(((right.cx - right.w / 2) - (left.cx + left.w / 2)) * board.width, MARGIN));
    assert.equal(left.h, whole.h);
    // Open at full size, in the middle.
    assert.equal(zoneOf(left), 'middle');
    assert.equal(zoneOf(right), 'middle');
  }
});

const open = () => ({ boxes: {
  a: { cx: 0.5, cy: 0.5, w: 0.45, h: 0.72, z: 2, sized: true },
  b: { cx: 0.45, cy: 0.4, w: 0.3, h: 0.4, z: 1, sized: false },
  c: { cx: 0.22, cy: 0.5, w: 0.3, h: 0.4, z: 0, ex: 0.08 },
  d: { cx: 0.06, cy: 0.3, w: 0.45, h: 0.72, z: 0, ex: 0 },
  e: { cx: 0.94, cy: 0.6, w: 0.45, h: 0.72, z: 0, ex: 0 },
} });

test('only what was open in the focus area is offered for the other half', () => {
  const layout = open();
  assert.deepEqual(offeredFor(layout, 'd'), ['a', 'b']);
  assert.deepEqual(offeredFor(layout, 'a'), ['b']);
  assert.deepEqual(offeredFor({ boxes: { d: layout.boxes.d } }, 'd'), []);
});

test('a pair already side by side is offered when another takes one half, and goes back as it was', () => {
  let layout = snapToHalf(open(), 'd', 'left', board, { cx: 0.06, cy: 0.3, w: 0.45, h: 0.72, z: 0, ex: 0 });
  layout = pickChoice(offerChoices(layout, ['a', 'b'], 'right', board), 'd', 'b', board);
  const pair = layout;
  assert.deepEqual(offeredFor(layout, 'e').sort(), ['b', 'd']);
  layout = snapToHalf(layout, 'e', 'right', board);
  layout = offerChoices(layout, ['b', 'd'], 'left', board);
  assert.deepEqual(dismissChoices(layout).boxes.d, pair.boxes.d, 'not picked, it fills its half again');
  // Picked, it keeps its own size from before it first filled a half.
  const picked = pickChoice(layout, 'e', 'd', board);
  assert.equal(picked.boxes.d.half, 'left');
  assert.deepEqual(picked.boxes.d.restore.self, { cx: 0.06, cy: 0.3, w: 0.45, h: 0.72, z: 0 });
  assert.equal(picked.boxes.b.half, undefined);
  assert.ok(isCard(picked.boxes.b));
});

test('let go on one side, an item fills that half, and keeps its own size to take back', () => {
  const from = { cx: 0.06, cy: 0.3, w: 0.45, h: 0.72, z: 0, ex: 0 };
  const layout = snapToHalf(open(), 'd', 'left', board, from);
  const d = layout.boxes.d;
  assert.equal(d.half, 'left');
  assert.ok(near(d.cx, halfBox(board, 'left').cx));
  assert.ok(d.z > 2);
  assert.equal(d.ex, undefined);
  assert.deepEqual(d.restore.self, { cx: 0.06, cy: 0.3, w: 0.45, h: 0.72, z: 0 });
  assert.ok(!fills(layout, 'd'), 'a half isn\'t the whole');
  // Nothing else moves.
  assert.deepEqual(layout.boxes.a, open().boxes.a);
  // As the focus area changes, the half's box follows.
  assert.ok(near(settleFilling(layout, { ...board, focus: 0.5 }).boxes.d.w, halfBox({ ...board, focus: 0.5 }, 'left').w));
  // Something else coming into the middle doesn't make it forget its own size.
  assert.deepEqual(forgetSnap(layout).boxes.d, d);
});

test('the items offered sit in the other half, then go back where they were if none is picked', () => {
  let layout = snapToHalf(open(), 'd', 'left', board);
  layout = offerChoices(layout, ['a', 'b'], 'right', board);
  assert.deepEqual(choicesOf(layout), ['a', 'b']);
  const right = halfBox(board, 'right');
  for (const id of ['a', 'b']) {
    const box = layout.boxes[id];
    assert.ok(box.cx - box.w / 2 >= right.cx - right.w / 2 - 1e-9 && box.cx + box.w / 2 <= right.cx + right.w / 2 + 1e-9, `${id} is in the right half`);
  }
  assert.deepEqual(inMiddle(layout), ['d'], 'what\'s offered isn\'t worked on');
  assert.ok(!fills(layout, 'a') && !fills(layout, 'b'), 'nor does it fill the focus area');
  // Kept where they were, if the board is saved meanwhile.
  assert.equal(layoutToSave(layout, ['a']).boxes.a.cx, 0.5);
  const back = dismissChoices(layout);
  assert.deepEqual(back.boxes.a, open().boxes.a);
  assert.deepEqual(back.boxes.b, open().boxes.b);
  assert.equal(back.boxes.d.half, 'left', 'the snapped item keeps its half');
});

test('the item picked fills the other half, and the rest go to the nearer side', () => {
  let layout = snapToHalf(open(), 'd', 'left', board);
  layout = offerChoices(layout, ['a', 'b'], 'right', board);
  layout = pickChoice(layout, 'd', 'b', board);
  assert.deepEqual(choicesOf(layout), []);
  assert.equal(layout.boxes.b.half, 'right');
  assert.ok(near(layout.boxes.b.cx, halfBox(board, 'right').cx));
  assert.ok(layout.boxes.b.z > layout.boxes.d.z, 'in front');
  assert.deepEqual(layout.boxes.b.restore.self, open().boxes.b);
  assert.ok(isCard(layout.boxes.a));
  assert.equal(layout.boxes.a.cy, 0.5, 'at the height it was');
  // From the middle exactly, to the side with fewer cards (the left: the right has e).
  assert.ok(layout.boxes.a.cx < 0.5);
  assert.deepEqual(inMiddle(layout).sort(), ['b', 'd']);
});

test('the choices fit the half they\'re offered in, a card\'s shape at most', () => {
  for (const count of [1, 2, 3, 5, 7]) {
    const ids = Array.from({ length: count }, (_, i) => `i${i}`);
    const cells = choiceBoxes(board, 'right', ids);
    const half = halfBox(board, 'right');
    for (const cell of Object.values(cells)) {
      assert.ok(cell.cx - cell.w / 2 >= half.cx - half.w / 2 - 1e-9 && cell.cx + cell.w / 2 <= half.cx + half.w / 2 + 1e-9);
      assert.ok(cell.cy - cell.h / 2 >= half.cy - half.h / 2 - 1e-9 && cell.cy + cell.h / 2 <= half.cy + half.h / 2 + 1e-9);
      assert.ok(cell.h * board.height <= cell.w * board.width * 0.75 + 1e-6);
    }
  }
});

test('dragged away, an item leaves its half with the size it had; its partner stays', () => {
  let layout = snapToHalf(open(), 'd', 'left', board, { cx: 0.06, cy: 0.3, w: 0.45, h: 0.72, z: 0, ex: 0 });
  layout = pickChoice(offerChoices(layout, ['a', 'b'], 'right', board), 'd', 'b', board);
  const away = leaveHalf(layout, 'd', { self: true });
  assert.equal(away.boxes.d.half, undefined);
  assert.equal(away.boxes.d.restore, undefined);
  assert.deepEqual([away.boxes.d.w, away.boxes.d.h], [0.45, 0.72]);
  assert.equal(away.boxes.d.cx, layout.boxes.d.cx, 'where it is now');
  assert.equal(away.boxes.b.half, 'right');
  // Resized instead, it keeps the size it shows at.
  const resized = leaveHalf(layout, 'd');
  assert.equal(resized.boxes.d.w, layout.boxes.d.w);
  // Brought alone into the middle, something else sends both halves to the sides as they were.
  const alone = bringToMiddle(layout, 'e', board, { alone: true });
  assert.equal(alone.boxes.d.half, undefined);
  assert.equal(alone.boxes.b.half, undefined);
  assert.ok(isCard(alone.boxes.b));
});

test('which half an item fills is kept with the board', () => {
  const layout = snapToHalf(open(), 'd', 'right', board);
  const back = cleanLayout(JSON.parse(JSON.stringify(layoutToSave(layout, ['d', 'a']))));
  assert.equal(back.boxes.d.half, 'right');
  assert.equal(back.boxes.a.half, undefined);
});
