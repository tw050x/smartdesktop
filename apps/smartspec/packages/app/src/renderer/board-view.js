// The focus view: a board the size of the window where every item in a schematic has a place the user
// drags it to (see board.js for the layout's numbers). The middle is for working on things: there an
// item shows at full size, filling the middle if it's there alone and hasn't been sized, and it can
// be resized from its edges and corners; several can sit there, overlapping. Moved out to a side, it's
// the same view, smaller the further out it goes; at the edge, a compact card. It isn't a canvas:
// nothing pans or zooms but what's inside a diagram. There are no lines between linked items: the
// user took them out, as they didn't help once things were placed by hand.
//
// Each item is an element `.board-item[data-item]` holding its full view (`.board-full`, built when
// first needed by `build(id)`) and its card (`.board-card`). The board calls `onChange(layout)` when
// the user has moved or sized something, and `onBring(id)` when a card is clicked.

import { bringToMiddle, cardnessAtEdge, groupCards, fillBox, fills, MARGIN, scaleAtEdge, separate, settleFilling as settle, settleSize, toFront, zoneAt, zoneAtEdge } from './board.js';
import { watchPage } from './page-view.js';
import { longPressed } from './long-press.js';

const RADIUS = 12; // px, an item's corners at full size (--card-radius in styles.css)
const COMMENT_WIDTH = 260; // px, a card for a comment on the whole schematic
const SMALL_TOP = 20; // px along the top of a small open item that pick it up
const SMALL_OPEN = 0.6; // an open item scaled below this is moved by its top edge, not resized
const MIN_RADIUS = 4; // px, and at its smallest, as a card
const FRAME = 2; // px, the item's border, both sides together (styles.css)
const DRAG_FROM = 4; // px: less than this is a click
const SMALLEST = { width: 260, height: 160 }; // px, an item's full size at its smallest
// Rubber banding: `value` held between `low` and `high`, giving way past them less and less, up to
// STRETCH px at most.
const STRETCH = 48;
function band(value, low, high) {
  if (high < low) high = low;
  const give = (over) => STRETCH * (1 - 1 / (over / STRETCH + 1));
  if (value < low) return low - give(low - value);
  if (value > high) return high + give(value - high);
  return value;
}
const narrow = () => matchMedia('(max-width: 900px)').matches;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const GRIPS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function watchBoard(board, { layout: first, build, onChange = () => {}, onBring = () => {} }) {
  let layout = first;
  let dragging = null; // the item being moved
  let placed = null; // the item last dropped, which stays exactly where it was put
  const items = () => [...board.querySelectorAll(':scope > .board-item')];
  const itemOf = (id) => board.querySelector(`:scope > .board-item[data-item="${CSS.escape(id)}"]`);
  const size = () => ({ width: board.clientWidth, height: board.clientHeight });

  // The box an item shows in, as fractions: the middle's, if it fills it.
  const shownBox = (id) => (fills(layout, id, dragging) ? { ...layout.boxes[id], ...fillBox(size()) } : layout.boxes[id]);

  // An item's full view, built the first time it's shown.
  const fullOf = (element) => {
    let full = element.querySelector(':scope > .board-full');
    if (full || element.building) return full;
    element.building = true;
    Promise.resolve(build(element.dataset.item)).then((built) => {
      element.building = false;
      if (!built || !element.isConnected) return;
      built.classList.add('board-full');
      element.prepend(built);
      for (const page of built.querySelectorAll('.sheet-body')) watchPage(page);
      placeAll();
    });
    return null;
  };

  // Where each item on a side shows after the side is kept apart (see keepApart), as fractions, so a
  // drag starts from where the item is seen. The layout keeps where the user put it.
  let shownAt = {};

  // How big an item is with its outer edge `e` from the window's side (a fraction of the board's
  // width): always its full size's shape, scaled down the nearer the edge is to the side, to its
  // smallest, where its content becomes its card's. A side too full shrinks it further (shrink).
  function sizeAt(one, e) {
    // A comment on the whole schematic is a card of its own size wherever it is.
    if (one.fixed) return { width: one.fixed.width * one.shrink, height: one.fixed.height * one.shrink, scale: one.shrink, cardness: 1 };
    const scale = scaleAtEdge(e) * one.shrink;
    return { width: one.full.width * scale, height: one.full.height * scale, scale, cardness: cardnessAtEdge(e) };
  }

  // Where an item's outer edge is when only its centre is known: the one place where its size and
  // its edge agree (see settleSize).
  function edgeFromCentre(one) {
    const { width } = size();
    const centre = one.cx / width;
    const out = Math.min(centre, 1 - centre);
    return settleSize((e) => sizeAt(one, e).width, (w) => out - w / 2 / width, 1, one.full.width + 100).edge;
  }

  // How an item shows, before its side is kept apart. It's open (its full view, as usable as in the
  // middle) everywhere but the very edges, smaller the nearer its outer edge is to the window's
  // side; at its smallest, as its edge reaches the side, it turns into its card.
  function look(element) {
    const id = element.dataset.item;
    const box = shownBox(id);
    if (!box) return null;
    const { width, height } = size();
    const filling = fills(layout, id, dragging);
    const one = {
      id, element, cx: box.cx * width, cy: box.cy * height,
      full: { width: box.w * width, height: box.h * height },
      fixed: element.classList.contains('board-comment') ? commentSize(element) : null,
      shrink: id === dragging || id === placed ? element.keepShrink ?? 1 : 1,
    };
    // An item with no edge kept, whose centre is where cards go, is a card.
    one.e = box.ex != null && !filling ? box.ex : zoneAt(box.cx) === 'edge' ? 0 : edgeFromCentre(one);
    const zone = zoneAtEdge(one.e);
    one.side = zone === 'middle' ? null : box.cx < 0.5 ? 'left' : 'right';
    one.cardness = one.fixed ? 1 : cardnessAtEdge(one.e);
    // The open view is built the first time it's needed; until it's there, the card shows.
    one.built = one.cardness < 1 ? Boolean(fullOf(element)) : Boolean(element.querySelector(':scope > .board-full'));
    element.classList.toggle('in-middle', zone === 'middle');
    element.classList.toggle('filling', filling);
    element.style.zIndex = String((id === dragging ? 10000 : 1) + (box.z ?? 0));
    if (narrow()) {
      element.classList.toggle('as-full', one.cardness < 1 && one.built);
      for (const name of ['left', 'top', 'width', 'height', 'border-radius']) element.style.removeProperty(name);
      for (const child of element.children) for (const name of ['width', 'height', 'transform', 'opacity']) child.style.removeProperty(name);
      element.style.order = String(zone === 'middle' ? Math.round(box.cy * 100) : 1000 + Math.round(box.cy * 100));
      return null;
    }
    element.classList.remove('as-full');
    element.style.removeProperty('order');
    return one;
  }

  const seenSize = (one) => sizeAt(one, one.e);

  // A comment card's size: its own width, and as tall as what's in it. Measured once, on a hidden
  // copy: measuring the card itself, on every move, stopped everything gliding mid-way and made
  // cards jump to their new places.
  function commentSize(element) {
    if (element.commentSize) return element.commentSize;
    const card = element.querySelector(':scope > .board-card');
    const copy = card.cloneNode(true);
    Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '-10000px', top: '0', width: `${COMMENT_WIDTH}px`, height: 'auto', transform: 'none', transition: 'none' });
    board.append(copy);
    const height = copy.offsetHeight || 120;
    copy.remove();
    const measured = { width: COMMENT_WIDTH + FRAME, height: height + FRAME };
    if (height) element.commentSize = measured;
    return measured;
  }

  // Where an item's frame goes, `top` being where its side put it (or where it is, if left out).
  // It keeps inside the board, out from the middle, except while it's being dragged: then it goes
  // where the pointer takes it, or it would sit still against the edge as it grows.
  function frameOf(one, top, left) {
    const { width, height } = size();
    const seen = seenSize(one);
    // Everything is kept inside the window, so its title bar can always be reached, except what's
    // being dragged, which gives a little at the edges and springs back (see band).
    const outside = one.id !== dragging;
    let cx = outside ? clamp(one.cx, MARGIN / 2 + seen.width / 2, Math.max(MARGIN / 2 + seen.width / 2, width - MARGIN / 2 - seen.width / 2)) : one.cx;
    if (left != null) cx = left + seen.width / 2;
    let y = top ?? one.cy - seen.height / 2;
    if (outside) y = clamp(y, MARGIN / 2, Math.max(MARGIN / 2, height - MARGIN / 2 - seen.height));
    return { id: one.id, left: cx - seen.width / 2, top: y, width: seen.width, height: seen.height };
  }

  // An item put on the page: a frame of its own shape, holding either its open view, scaled to fit
  // and fully usable, or, at its smallest, its card's content laid out to fill it. They swap at one
  // point, with a quick fade.
  function show(one, top, left) {
    const { width, height } = size();
    const frame = frameOf(one, top, left);
    const { element } = one;
    const { scale, cardness } = sizeAt(one, one.e);
    const asCard = cardness === 1 || !one.built;
    element.classList.toggle('card-only', asCard);
    element.classList.toggle('full-only', !asCard);
    element.classList.toggle('is-card', asCard);
    // Small, its title bar is thin: the top edge is for dragging it, not resizing.
    element.classList.toggle('small-open', !asCard && scale < SMALL_OPEN);
    // Its corners shrink with it.
    const radius = Math.max(MIN_RADIUS, RADIUS * scale);
    Object.assign(element.style, { left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px`, borderRadius: `${radius}px` });
    const full = element.querySelector(':scope > .board-full');
    if (full) {
      Object.assign(full.style, { width: `${one.full.width}px`, height: `${one.full.height}px`, transform: scale === 1 ? '' : `scale(${scale})`, opacity: asCard ? '0' : '1' });
    }
    element.shrunk = one.shrink;
    // The card's content is laid out at the size it can be read at and scaled to the frame, so a
    // side too full makes it smaller rather than cutting it off.
    const card = element.querySelector(':scope > .board-card');
    if (card) {
      const k = Math.min(1, one.shrink);
      Object.assign(card.style, { width: `${(frame.width - FRAME) / k}px`, height: `${(frame.height - FRAME) / k}px`, transform: k === 1 ? '' : `scale(${k})`, opacity: asCard ? '1' : '0' });
    }
    shownAt[one.id] = { cx: (frame.left + frame.width / 2) / width, cy: (frame.top + frame.height / 2) / height, ex: one.e };
  }

  // The things on one side never cover each other. First where the user put them, moved down where
  // they'd overlap; if that runs off the bottom, packed from the top in the same order; then all of
  // them smaller and smaller. What's being dragged (`held`) is sized with its side from the start,
  // so it doesn't change size when let go, but stays under the pointer while the rest move round it.
  // What each card and each side last decided, and when, so decisions stick (see separate).
  const HOLD_MS = 600;
  const ways = new Map();
  const sides = new Map();
  const SHRINK = 0.88;
  const SMALLEST_SHRINK = 0.05; // cards never overlap: they get as small as it takes
  function keepApart(side, looks, held = null, middle = []) {
    const { width, height } = size();
    // Things side by side need room between them, or the one further out moves out of the way.
    const bounds = { top: MARGIN / 2, bottom: height - MARGIN / 2, gap: MARGIN / 2, across: MARGIN * 1.5 };
    const rank = new Map([...looks].sort((a, b) => a.cy - b.cy).map((one, index) => [one, index]));
    // Anything open stays exactly where it was put, at its own size: only cards make way.
    const opened = looks.filter((one) => one.cardness !== 1);
    for (const one of opened) one.shrink = 1;
    const cards = looks.filter((one) => one.cardness === 1);
    const obstacles = [...opened.map((one) => frameOf(one)), ...middle.map((one) => frameOf(one))];
    // The card last put down stays where it was put, and the other cards move round it. Only
    // something open moves it, the least it can (open things come first).
    let heldAt = null;
    if (held) {
      held.shrink = held.element.keepShrink ?? 1;
      heldAt = { frame: frameOf(held) };
      // A card is kept off anything open while it's dragged too, so where it's let go is where it
      // stays: it never jumps away after the drop. It sticks with the way round it took (see
      // separate), so it doesn't flicker as the pointer moves.
      if (held.cardness === 1) {
        const frame = heldAt.frame;
        const out = held.side === 'right' ? 1 : -1;
        const room = Math.max(0, out > 0 ? width - MARGIN / 2 - (frame.left + frame.width) : frame.left - MARGIN / 2);
        const memory = ways.get(held.id);
        const alone = separate([{ ...frame, id: held.id, out, room, rank: 0, prefer: memory?.way, lock: Boolean(memory) && performance.now() - memory.at < HOLD_MS }], { top: MARGIN / 2, bottom: height - MARGIN / 2, gap: MARGIN / 2, across: MARGIN * 1.5 }, obstacles);
        const way = alone.ways[held.id];
        if (way && memory?.way !== way) ways.set(held.id, { way, at: performance.now() });
        heldAt = { top: alone.tops[held.id], left: alone.lefts[held.id], scale: alone.scales[held.id] };
        held.shrink *= heldAt.scale;
        heldAt.frame = frameOf(held, heldAt.top, heldAt.left);
      }
    }
    const attempt = ({ shrink = 1, packed = false }) => {
      for (const one of cards) one.shrink = shrink;
      const frames = new Map(cards.map((one) => [one, frameOf(one)]));
      // Cards prefer to keep together: those near one another on a side join up into a group,
      // stacked one under another round where they were put, so none sits off on its own just
      // because there's room, but cards far apart stay apart (see groupCards). Something open in
      // the way still moves them: down, towards the side, or smaller, whichever moves them least.
      const grouped = groupCards(cards.map((one) => ({ id: one, top: packed ? bounds.top : frames.get(one).top, height: frames.get(one).height })), bounds);
      const stacked = new Map(grouped.map(({ id, top }) => [id, top]));
      return separate(cards.map((one) => {
        const frame = frames.get(one);
        const out = one.side === 'right' ? 1 : -1;
        const room = Math.max(0, out > 0 ? width - MARGIN / 2 - (frame.left + frame.width) : frame.left - MARGIN / 2);
        const memory = ways.get(one.id);
        return { ...frame, id: one.id, out, room, rank: rank.get(one), top: stacked.get(one), prefer: memory?.way, lock: Boolean(memory) && performance.now() - memory.at < HOLD_MS };
      }), bounds, [...obstacles, ...(heldAt ? [heldAt.frame] : [])]);
    };
    // How hard a side has to work to fit its cards: where they were put (0), packed from the top
    // (1), then smaller and smaller. It takes the first that fits, but having gone further it stays
    // there a while before easing back, so it doesn't flip between two as things move.
    const level = (k) => (k === 0 ? {} : k === 1 ? { packed: true } : { packed: true, shrink: SHRINK ** (k - 1) });
    const most = 2 + Math.ceil(Math.log(SMALLEST_SHRINK) / Math.log(SHRINK));
    let k = 0;
    let result = attempt(level(0));
    while (!result.fits && k < most) result = attempt(level(++k));
    const now = performance.now();
    const before = sides.get(side);
    if (before && k < before.level && now - before.at < HOLD_MS) {
      const held = attempt(level(before.level));
      if (held.fits) {
        result = held;
        k = before.level;
      } else result = attempt(level(k));
    }
    if (!before || before.level !== k) sides.set(side, { level: k, at: now });
    for (const one of opened) show(one);
    for (const one of cards) {
      const way = result.ways[one.id];
      if (way && ways.get(one.id)?.way !== way) ways.set(one.id, { way, at: now });
      // A card made smaller to fit by something open stays that much smaller.
      one.shrink *= result.scales[one.id] ?? 1;
      show(one, result.tops[one.id], result.lefts[one.id]);
    }
    if (held) show(held, heldAt?.top, heldAt?.left);
  }

  const placeAll = () => {
    board.classList.toggle('stacked', narrow());
    shownAt = {};
    const looks = items().map(look).filter(Boolean);
    // What's being dragged stays under the pointer, and the things on its side move out of its way
    // as it goes, gliding there.
    const held = looks.find((one) => one.id === dragging) ?? looks.find((one) => one.id === placed);
    // What's open in the middle is in the way of cards too.
    const middle = looks.filter((one) => !one.side && one !== held);
    for (const side of ['left', 'right']) keepApart(side, looks.filter((one) => one.side === side && one !== held), held?.side === side ? held : null, held && !held.side ? [...middle, held] : middle);
    if (held && !held.side) show(held);
    for (const one of looks.filter((one) => !one.side && one !== held)) show(one);
    for (const element of items()) element.classList.toggle('held', element.dataset.item === dragging);
  };

  const changed = () => onChange(layout);

  // A card clicked comes to the middle, centred and in front. Nothing else moves.
  function bring(id) {
    layout = bringToMiddle(layout, id, size());
    placeAll();
    changed();
    onBring(id);
  }

  // Whatever fills the middle keeps that as its own box before anything else moves (see board.js).
  const settleFilling = () => {
    layout = settle(layout, size());
  };

  // Touching an item brings it to the front.
  board.addEventListener('pointerdown', (event) => {
    const element = event.target.closest?.('.board-item');
    if (!element || narrow()) return;
    const next = toFront(layout, element.dataset.item);
    if (next !== layout) {
      layout = next;
      for (const one of items()) one.style.zIndex = String(1 + (layout.boxes[one.dataset.item]?.z ?? 0));
      changed();
    }
  }, true);

  // Moving: by an item's title bar, or anywhere on its card. A card that isn't dragged was clicked.
  board.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || narrow()) return;
    const grip = event.target.closest?.('.board-grip');
    if (grip) return resize(event, grip);
    // Its title bar, at the top edge, wherever it is; what's inside stays usable (scrolling and all).
    // A small open item is picked up anywhere along its top, as its title bar is thin.
    const small = event.target.closest?.('.board-item.small-open');
    const atTop = small && event.clientY - small.getBoundingClientRect().top < SMALL_TOP;
    const handle = atTop ? small : event.target.closest?.('.board-full > .pane-head, .board-card');
    if (!handle || (!atTop && event.target.closest('.pane-actions, .title-card, h2[tabindex]:focus-visible, .board-comment button, .comment-marker'))) return;
    const element = handle.closest('.board-item');
    const id = element.dataset.item;
    const start = { x: event.clientX, y: event.clientY };
    // Where in the item it was picked up, as a fraction of its frame: it stays under the pointer
    // there however the item changes size on the way.
    const picked = element.getBoundingClientRect();
    const hold = { x: (start.x - picked.left) / (picked.width || 1), y: (start.y - picked.top) / (picked.height || 1) };
    let from = null;
    let frameNow = null; // its size under the pointer, for springing back inside the window
    const onMove = (move) => {
      const dx = move.clientX - start.x;
      const dy = move.clientY - start.y;
      if (!from) {
        // A long press is a comment starting, not a drag (see long-press.js).
        if (longPressed()) return onEnd();
        if (Math.hypot(dx, dy) < DRAG_FROM) return;
        settleFilling();
        from = { ...layout.boxes[id] };
        element.keepShrink = element.shrunk ?? 1; // its size when picked up stays its size
        dragging = id;
        try { board.setPointerCapture(event.pointerId); } catch {}
        board.classList.add('dragging');
      }
      const { width, height } = size();
      const origin = board.getBoundingClientRect();
      const pointer = { x: move.clientX - origin.left, y: move.clientY - origin.top };
      // Its size follows how near its outer edge is to the window's side, and its edge follows its
      // size, as the point it was picked up by stays under the pointer: they agree in one place
      // only (settleSize), so it grows and shrinks steadily and never flips between two.
      const one = look(element);
      if (one) {
        const across = (w) => Math.min(pointer.x - hold.x * w, width - (pointer.x + (1 - hold.x) * w)) / width;
        const { width: w, edge } = settleSize((e) => sizeAt(one, e).width, across, 1, one.full.width + 100);
        const h = sizeAt(one, edge).height;
        // It stays on the window: pulled past an edge it gives a little, more and more stiffly, and
        // springs back when let go (see onEnd).
        const left = band(pointer.x - hold.x * w, MARGIN / 2, width - MARGIN / 2 - w);
        const top = band(pointer.y - hold.y * h, MARGIN / 2, height - MARGIN / 2 - h);
        layout = { boxes: { ...layout.boxes, [id]: { ...from, ex: edge, cx: (left + w / 2) / width, cy: (top + h / 2) / height } } };
        frameNow = { w, h };
      }
      placeAll();
    };
    const onEnd = () => {
      board.removeEventListener('pointermove', onMove);
      board.removeEventListener('pointerup', onEnd);
      board.removeEventListener('pointercancel', onEnd);
      board.classList.remove('dragging');
      // A click only brings it to the front: a double click or a drag brings it in.
      if (!from) return;
      // It stays where it was dropped, and what moved out of its way stays where it went: the layout
      // becomes what was showing.
      // Pulled past an edge, it springs back inside the window.
      if (frameNow) {
        const { width, height } = size();
        const box = layout.boxes[id];
        const left = clamp(box.cx * width - frameNow.w / 2, MARGIN / 2, Math.max(MARGIN / 2, width - MARGIN / 2 - frameNow.w));
        const top = clamp(box.cy * height - frameNow.h / 2, MARGIN / 2, Math.max(MARGIN / 2, height - MARGIN / 2 - frameNow.h));
        layout = { boxes: { ...layout.boxes, [id]: { ...box, cx: (left + frameNow.w / 2) / width, cy: (top + frameNow.h / 2) / height } } };
      }
      dragging = null;
      // What was dropped stays where it was put: the other cards move round it. A card dropped
      // over something open moves out of its way, the least it can: what's open comes first.
      placed = id;
      placeAll();
      const boxes = { ...layout.boxes };
      for (const [other, at] of Object.entries(shownAt)) {
        if (boxes[other] && zoneAtEdge(at.ex) !== 'middle' && (other !== id || cardnessAtEdge(at.ex) === 1)) boxes[other] = { ...boxes[other], ex: at.ex, cx: at.cx, cy: at.cy };
      }
      layout = { boxes };
      changed();
    };
    board.addEventListener('pointermove', onMove);
    board.addEventListener('pointerup', onEnd);
    board.addEventListener('pointercancel', onEnd);
  });
  // The drag is the click: a card dragged isn't also followed.
  board.addEventListener('click', (event) => {
    if (event.target.closest?.('.board-card')) event.preventDefault();
  }, true);

  // Resizing, in the middle, from an edge or a corner: the other edges stay put. Double-clicking a
  // grip lets go of the size, so a lone item fills the middle again.
  function resize(event, grip) {
    event.preventDefault();
    event.stopPropagation();
    const element = grip.closest('.board-item');
    const id = element.dataset.item;
    settleFilling();
    const { width, height } = size();
    const box = layout.boxes[id];
    // Anything open can be resized, in the middle or scaled down at the side. It keeps its scale
    // while it's resized (its edge, ex, is held), and its edges follow the pointer where it shows.
    const origin = board.getBoundingClientRect();
    const shown = element.getBoundingClientRect();
    const scale = shown.width / (box.w * width) || 1;
    const ex = shownAt[id]?.ex ?? box.ex;
    const from = { left: shown.left - origin.left, right: shown.right - origin.left, top: shown.top - origin.top, bottom: shown.bottom - origin.top };
    const least = { width: SMALLEST.width * scale, height: SMALLEST.height * scale };
    const start = { x: event.clientX, y: event.clientY };
    const edge = grip.dataset.edge;
    try { board.setPointerCapture(event.pointerId); } catch {}
    board.classList.add('resizing');
    const onMove = (move) => {
      const dx = move.clientX - start.x;
      const dy = move.clientY - start.y;
      const next = { ...from };
      if (edge.includes('w')) next.left = clamp(from.left + dx, MARGIN / 2, from.right - least.width);
      if (edge.includes('e')) next.right = clamp(from.right + dx, from.left + least.width, width - MARGIN / 2);
      if (edge.includes('n')) next.top = clamp(from.top + dy, MARGIN / 2, from.bottom - least.height);
      if (edge.includes('s')) next.bottom = clamp(from.bottom + dy, from.top + least.height, height - MARGIN / 2);
      layout = { boxes: { ...layout.boxes, [id]: { ...box, ex, cx: (next.left + next.right) / 2 / width, cy: (next.top + next.bottom) / 2 / height, w: (next.right - next.left) / scale / width, h: (next.bottom - next.top) / scale / height, sized: true } } };
      placeAll();
    };
    const onEnd = () => {
      board.removeEventListener('pointermove', onMove);
      board.removeEventListener('pointerup', onEnd);
      board.removeEventListener('pointercancel', onEnd);
      board.classList.remove('resizing');
      changed();
    };
    board.addEventListener('pointermove', onMove);
    board.addEventListener('pointerup', onEnd);
    board.addEventListener('pointercancel', onEnd);
  }
  // Double-clicking a card, or an item's title bar, brings it to the middle.
  board.addEventListener('dblclick', (event) => {
    const handle = event.target.closest?.('.board-card, .board-full > .pane-head');
    if (!handle || handle.closest('.board-comment') || event.target.closest('.pane-actions') || narrow()) return;
    event.preventDefault();
    bring(handle.closest('.board-item').dataset.item);
  });
  board.addEventListener('dblclick', (event) => {
    const grip = event.target.closest?.('.board-grip');
    if (!grip) return;
    const id = grip.closest('.board-item').dataset.item;
    layout = { boxes: { ...layout.boxes, [id]: { ...layout.boxes[id], sized: false } } };
    placeAll();
    changed();
  });

  for (const element of items()) {
    for (const edge of GRIPS) {
      const grip = document.createElement('div');
      grip.className = `board-grip ${edge}`;
      grip.dataset.edge = edge;
      grip.setAttribute('aria-hidden', 'true');
      element.append(grip);
    }
  }

  // A card can be brought to the middle from the keyboard too.
  for (const card of board.querySelectorAll(':scope > .board-item > .board-card')) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
  }
  board.addEventListener('keydown', (event) => {
    const card = event.target.closest?.('.board-card');
    if (!card || (event.key !== 'Enter' && event.key !== ' ') || event.target !== card) return;
    event.preventDefault();
    bring(card.closest('.board-item').dataset.item);
  });

  for (const page of board.querySelectorAll('.board-full .sheet-body')) watchPage(page);
  // Things are put in place at once when the board opens, and glide from then on.
  board.classList.add('settling');
  placeAll();
  requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('settling')));
  // The window changing size moves everything with it, at once: gliding after it, things lagged
  // behind (going full screen, they only grew once the window had finished).
  let unsettle = 0;
  const resized = new ResizeObserver(() => {
    if (!board.isConnected) return resized.disconnect();
    if (dragging) return;
    board.classList.add('settling');
    placeAll();
    cancelAnimationFrame(unsettle);
    unsettle = requestAnimationFrame(() => {
      unsettle = requestAnimationFrame(() => board.classList.remove('settling'));
    });
  });
  resized.observe(board);

  return { layout: () => layout, bring };
}
