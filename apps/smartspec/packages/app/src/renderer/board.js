// The focus view's layout, as numbers only (board-view.js draws it). Every item in a schematic has a
// box on the board: its centre and its full size, as fractions of the board's width and height, so a
// layout survives the window changing size, and which is in front. How big an item shows depends on
// how close its outer edge is to the window's side: at full size in the middle, smaller the closer
// it gets, and at its smallest a compact card by the time its edge reaches the side. The user places
// things by dragging them. A layout is kept on this computer for each schematic, never with it.

// Distances of an item's outer edge (the one nearer the window's side) from that side, as fractions
// of the board's width.
export const FULL_FROM = 0.15; // this far in or more, an item is open at full size
export const SMALLEST_BY = 0.03; // by here it's at its smallest, and from here out it's its card
export const SMALLEST_SCALE = 0.25; // its smallest
export const MIDDLE = [0.3, 0.7]; // without a known edge, centres in here count as the middle
export const EDGE = 0.07; // and centres nearer than this to a side as cards
export const FILL = [0.2, 0.8]; // what a lone item in the middle fills, across
export const DEFAULT_SIZE = { w: 0.45, h: 0.72 }; // an item's full size until the user sizes it
export const MARGIN = 16; // px around the board's edges, and between stacked cards

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const fromSide = (cx) => Math.min(cx, 1 - cx);

// The scale an open item shows at, its outer edge `e` from the side: 1 from FULL_FROM in, falling
// steadily to SMALLEST_SCALE by SMALLEST_BY.
export function scaleAtEdge(e) {
  return 1 - (1 - SMALLEST_SCALE) * clamp((FULL_FROM - e) / (FULL_FROM - SMALLEST_BY), 0, 1);
}

// Whether it's its card (1) rather than its open view (0). An item is always the same shape, its full
// size scaled; once it's at its smallest its content becomes its card's (kind, title and comments),
// which can still be read at that size, and as soon as it starts growing again it's open. The swap
// is at one point, not spread out.
export function cardnessAtEdge(e) {
  return e <= SMALLEST_BY ? 1 : 0;
}

// 'middle' (open, full size), 'side' (open, smaller, as usable as in the middle) or 'edge' (its card).
export function zoneAtEdge(e) {
  return e >= FULL_FROM ? 'middle' : e <= SMALLEST_BY ? 'edge' : 'side';
}

// Without a known edge, by its centre alone (for the layout's own decisions, before anything is
// measured): the same three.
export function zoneAt(cx) {
  const out = fromSide(cx);
  return out >= MIDDLE[0] ? 'middle' : out >= EDGE ? 'side' : 'edge';
}

// An item's zone: by its outer edge (`ex`, known once it's been shown or dragged), else its centre.
export const zoneOf = (box) => (box.ex != null ? zoneAtEdge(box.ex) : zoneAt(box.cx));
export const isCard = (box) => zoneOf(box) === 'edge';

// An item's width depends on how near its outer edge is to the side, and where its edge is depends on
// its width. `widthAt(e)` (px, rising with e) and `edgeAt(w)` (the edge a frame `w` px wide would
// have, falling with w) meet once, so there's one answer for each place, found by halving: no item
// ever flips between two sizes. Returns { width, edge }.
export function settleSize(widthAt, edgeAt, low, high) {
  let [a, b] = [low, high];
  for (let i = 0; i < 40; i++) {
    const w = (a + b) / 2;
    if (widthAt(edgeAt(w)) > w) a = w;
    else b = w;
  }
  const width = (a + b) / 2;
  return { width, edge: edgeAt(width) };
}

const LEFT_CARDS = 0.06; // where cards sit down each side
const RIGHT_CARDS = 1 - LEFT_CARDS;

export const emptyLayout = () => ({ boxes: {} });

// A layout read back from storage, keeping only what's well formed.
export function cleanLayout(saved) {
  const boxes = {};
  const number = (value) => typeof value === 'number' && Number.isFinite(value);
  for (const [id, box] of Object.entries(saved?.boxes ?? {})) {
    if (!box || ![box.cx, box.cy, box.w, box.h].every(number)) continue;
    boxes[id] = { cx: clamp(box.cx, 0, 1), cy: clamp(box.cy, 0, 1), w: clamp(box.w, 0.05, 1), h: clamp(box.h, 0.05, 1), z: number(box.z) ? box.z : 0, sized: Boolean(box.sized), ...(number(box.ex) && { ex: box.ex }) };
  }
  return { boxes };
}

const topZ = (layout) => Math.max(0, ...Object.values(layout.boxes).map((box) => box.z));

// The items whose centres are in the middle.
export const inMiddle = (layout) => Object.keys(layout.boxes).filter((id) => zoneOf(layout.boxes[id]) === 'middle');

// Whether an item fills the middle: it's there alone, and the user hasn't sized it. One being dragged
// never does, so it doesn't jump under the pointer; it fills once let go.
export function fills(layout, id, dragging = null) {
  const box = layout.boxes[id];
  if (!box || box.sized || id === dragging || zoneOf(box) !== 'middle') return false;
  return inMiddle(layout).length === 1;
}

// The box a lone item fills, as fractions, for a board this size in px.
export function fillBox({ width, height }) {
  const margin = Math.min(0.2, MARGIN / Math.max(1, height));
  return { cx: (FILL[0] + FILL[1]) / 2, cy: 0.5, w: FILL[1] - FILL[0], h: 1 - 2 * margin };
}

// Whatever fills the middle keeps that as its own box, before anything else comes into the middle,
// so it doesn't jump when it stops filling. `board` is the board's size in px.
export function settleFilling(layout, board) {
  const filling = Object.keys(layout.boxes).filter((id) => fills(layout, id));
  if (!filling.length) return layout;
  const boxes = { ...layout.boxes };
  for (const id of filling) boxes[id] = { ...boxes[id], ...fillBox(board) };
  return { boxes };
}

// An item brought to the middle: centred, in front, at its full size. Nothing else moves, and
// whatever filled the middle stays as it was (`board` is the board's size in px, if known). With
// `alone` (chosen on the overview), it's the only thing there: everything else in or near the middle
// goes to the nearer side, at the same height, and it fills the middle.
export function bringToMiddle(layout, id, board = null, { alone = false } = {}) {
  const settled = board && !alone ? settleFilling(layout, board) : layout;
  const was = settled.boxes[id];
  const boxes = { ...settled.boxes };
  if (alone) {
    const count = (left) => Object.entries(boxes).filter(([other, box]) => other !== id && isCard(box) && (box.cx < 0.5) === left).length;
    for (const [other, box] of Object.entries(boxes)) {
      if (other === id || isCard(box)) continue;
      const left = box.cx === 0.5 ? count(true) <= count(false) : box.cx < 0.5;
      boxes[other] = { ...box, cx: left ? LEFT_CARDS : RIGHT_CARDS, ex: 0 };
    }
  }
  const { ex, ...kept } = was ?? {};
  boxes[id] = { w: DEFAULT_SIZE.w, h: DEFAULT_SIZE.h, sized: false, ...kept, ...(alone && { sized: false }), cx: 0.5, cy: 0.5, z: topZ(settled) + 1 };
  return { boxes };
}

// In front of everything else.
export function toFront(layout, id) {
  const box = layout.boxes[id];
  if (!box || box.z === topZ(layout)) return layout;
  return { boxes: { ...layout.boxes, [id]: { ...box, z: topZ(layout) + 1 } } };
}

// Cards stacked down one edge from the top, `heights` in px. If they don't all fit, they overlap
// evenly, so each still shows its top. Returns each one's centre height, as a fraction.
function stack(ids, heights, height) {
  const sizes = ids.map((id) => heights[id] ?? 80);
  const total = sizes.reduce((sum, one) => sum + one, 0) + MARGIN * (ids.length - 1);
  const room = height - 2 * MARGIN;
  const step = (index) => (total <= room || ids.length < 2 ? sizes.slice(0, index).reduce((sum, one) => sum + one + MARGIN, 0) : index * ((room - sizes.at(-1)) / (ids.length - 1)));
  return ids.map((id, index) => (MARGIN + step(index) + sizes[index] / 2) / height);
}


// The two sides share the cards: what links to the centre starts on the left and the rest on the
// right, then cards move from the taller side's end to the other until neither is taller by more
// than a card. Returns [left, right].
export function balance(left, right, heights) {
  const sides = [[...left], [...right]];
  const tall = (side) => side.reduce((sum, id) => sum + (heights[id] ?? 80) + MARGIN, 0);
  for (;;) {
    const [short, long] = tall(sides[0]) <= tall(sides[1]) ? [sides[0], sides[1]] : [sides[1], sides[0]];
    const moving = long.at(-1);
    if (moving === undefined || tall(long) - tall(short) <= (heights[moving] ?? 80) + MARGIN) return sides;
    short.push(long.pop());
  }
}

// The first layout for a schematic: `centre` filling the middle, and the rest as cards down both
// edges from the top, shared between them (see balance). `heights` are the cards' in px.
export function defaultLayout({ centre, left: linking, right: rest }, heights, board) {
  const [left, right] = balance(linking, rest, heights);
  const boxes = {};
  if (centre) boxes[centre] = { ...DEFAULT_SIZE, cx: 0.5, cy: 0.5, z: 1, sized: false };
  stack(left, heights, board.height).forEach((cy, index) => { boxes[left[index]] = { ...DEFAULT_SIZE, cx: LEFT_CARDS, cy, z: 0, sized: false, ex: 0 }; });
  stack(right, heights, board.height).forEach((cy, index) => { boxes[right[index]] = { ...DEFAULT_SIZE, cx: RIGHT_CARDS, cy, z: 0, sized: false, ex: 0 }; });
  return { boxes };
}

// Items with no place yet, such as one a new draft adds, go down whichever edge has less in it, below
// what's there (the sides keep them apart if there isn't room: see separate).
export function placeNew(layout, ids, heights, board) {
  const missing = ids.filter((id) => !layout.boxes[id]);
  if (!missing.length) return layout;
  const lowest = (right) => Object.entries(layout.boxes).filter(([, box]) => isCard(box) && (box.cx > 0.5) === right)
    .reduce((low, [id, box]) => Math.max(low, box.cy * board.height + (heights[id] ?? 80) / 2), 0);
  const tops = { left: Math.max(MARGIN, lowest(false) + MARGIN), right: Math.max(MARGIN, lowest(true) + MARGIN) };
  const boxes = { ...layout.boxes };
  for (const id of missing) {
    const side = tops.left < tops.right ? 'left' : 'right';
    const height = heights[id] ?? 80;
    const cy = Math.min(tops[side] + height / 2, board.height - MARGIN - height / 2) / board.height;
    boxes[id] = { ...DEFAULT_SIZE, cx: side === 'left' ? LEFT_CARDS : RIGHT_CARDS, cy: clamp(cy, 0, 1), z: 0, sized: false, ex: 0 };
    tops[side] += height + MARGIN;
  }
  return { boxes };
}

// Which side of the middle an item is on: 'left', 'right', or null in the middle.
export const sideOf = (box) => (zoneOf(box) === 'middle' ? null : box.cx < 0.5 ? 'left' : 'right');

// Cards on one side, each wanting to stay where it was put (`top`, px, with its `height`). Cards that
// would overlap, or touch, join into a group, stacked one under another with `gap` between, as near
// as it can be to where its cards were put (its cards, on average, moved as little as they can),
// inside `top`..`bottom`. Groups that come to touch join up; cards apart stay where they are.
// Returns each card's top, in the order given.
export function groupCards(cards, { top: first, bottom, gap }) {
  if (!cards.length) return [];
  const sorted = [...cards].sort((a, b) => a.top - b.top);
  const place = (group) => {
    const tall = group.cards.reduce((sum, card) => sum + card.height + gap, -gap);
    let offset = 0;
    const wanted = group.cards.map((card) => {
      const at = card.top - offset;
      offset += card.height + gap;
      return at;
    });
    group.tall = tall;
    group.top = Math.min(Math.max(first, wanted.reduce((sum, one) => sum + one, 0) / wanted.length), Math.max(first, bottom - tall));
  };
  const groups = [];
  for (const card of sorted) {
    const group = { cards: [card] };
    place(group);
    groups.push(group);
    // Join the group above while they overlap or touch.
    while (groups.length > 1) {
      const [above, below] = groups.slice(-2);
      if (below.top >= above.top + above.tall + gap) break;
      groups.splice(-2, 2, { cards: [...above.cards, ...below.cards] });
      place(groups.at(-1));
    }
  }
  const tops = new Map();
  for (const group of groups) {
    let at = group.top;
    for (const card of group.cards) {
      tops.set(card, at);
      at += card.height + gap;
    }
  }
  return cards.map((card) => ({ id: card.id, top: tops.get(card) }));
}

// Keeping the things on one side apart. `rects` are where they'd show, in px ({ id, left, top,
// width, height, rank }, rank being the order down the side; `open` for something open, which is
// placed first and never moved aside; `out` for a card, the way to the window's side, -1 or 1, with
// `room`, how far that side is). Each is placed in turn. A card in the way of something gets the
// cheapest of four ways out: sliding towards the side, shrinking into the room by the side (to half
// its size at most), or moving up or down clear of what's in its way. Things side by side need `aside` room
// between them. `fixed` stay exactly where they are, such as what's being dragged. Returns each
// one's top, left and scale, and whether they all end above `bottom`.
export const SMALLEST_FIT = 0.5;
export function separate(rects, { top: first, bottom, gap = MARGIN, across: aside = gap }, fixed = []) {
  const placed = [...fixed];
  const hits = (r) => placed.filter((other) => r.left < other.left + other.width + aside && other.left < r.left + r.width + aside
    && r.top < other.top + other.height + gap && other.top < r.top + r.height + gap);
  const order = [...rects].sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)) || a.top - b.top || a.rank - b.rank || a.left - b.left);
  for (const rect of order) {
    const start = { ...rect, top: Math.max(first, rect.top), scale: 1, way: 'stay' };
    let best = start;
    if (hits(start).length) {
      // Down, below whatever is in the way.
      const down = { ...start, way: 'down' };
      for (let blocking = hits(down); blocking.length; blocking = hits(down)) down.top = Math.max(...blocking.map((other) => other.top + other.height + gap));
      const ways = [{ at: down, cost: down.top - start.top }];
      // Up, above whatever is in the way, if that's nearer.
      const up = { ...start, way: 'up' };
      for (let blocking = hits(up), tries = 0; blocking.length && tries < 20; blocking = hits(up), tries++) up.top = Math.min(...blocking.map((other) => other.top - gap - rect.height));
      if (up.top >= first && !hits(up).length) ways.push({ at: up, cost: start.top - up.top });
      if (rect.out) {
        const inWay = hits(start);
        // Towards the side, just clear of what's in the way.
        const clear = rect.out > 0 ? Math.max(...inWay.map((other) => other.left + other.width + aside)) : Math.min(...inWay.map((other) => other.left - aside));
        const slid = { ...start, way: 'slide', left: rect.out > 0 ? clear : clear - rect.width };
        const shift = Math.abs(slid.left - start.left);
        if (shift <= rect.room && !hits(slid).length) ways.push({ at: slid, cost: shift });
        // Smaller, into the room by the side, its outer edge against the side.
        const outer = rect.out > 0 ? start.left + start.width + rect.room : start.left - rect.room;
        const width = rect.out > 0 ? outer - clear : clear - outer;
        const scale = Math.min(1, width / rect.width);
        if (scale >= SMALLEST_FIT && scale < 1) {
          const small = { ...start, way: 'shrink', scale, width: rect.width * scale, height: rect.height * scale, left: rect.out > 0 ? outer - rect.width * scale : outer };
          if (!hits(small).length) ways.push({ at: small, cost: (1 - scale) * rect.height * 1.5 });
        }
      }
      // Once a card has taken a way out it sticks with it: held to it outright for a while
      // (`lock`), and after that it changes only for a way that's clearly better, so it doesn't
      // flip between two as things move.
      const kept = ways.find((one) => one.at.way === rect.prefer);
      if (kept && rect.lock) best = kept.at;
      else {
        if (kept) kept.cost *= 0.5;
        best = ways.sort((a, b) => a.cost - b.cost)[0].at;
      }
    }
    placed.push(best);
  }
  const moved = placed.slice(fixed.length);
  return {
    tops: Object.fromEntries(moved.map((r) => [r.id, r.top])),
    lefts: Object.fromEntries(moved.map((r) => [r.id, r.left])),
    scales: Object.fromEntries(moved.map((r) => [r.id, r.scale ?? 1])),
    ways: Object.fromEntries(moved.map((r) => [r.id, r.way ?? 'stay'])),
    fits: moved.every((r) => r.top + r.height <= bottom),
  };
}

// What's kept: only the boxes of items still in the schematic, rounded.
export function layoutToSave(layout, ids) {
  const round = (value) => Math.round(value * 10000) / 10000;
  const boxes = {};
  for (const id of ids) {
    const box = layout.boxes[id];
    if (box) boxes[id] = { cx: round(box.cx), cy: round(box.cy), w: round(box.w), h: round(box.h), z: box.z, ...(box.sized && { sized: true }), ...(box.ex != null && { ex: round(box.ex) }) };
  }
  return { boxes };
}
