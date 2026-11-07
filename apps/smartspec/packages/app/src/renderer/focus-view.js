// The focused item's stage: it sits in the middle, what links to it on the left, what it links to on
// the right, each sitting level with the thing in it the link is about where it can (a node, row,
// heading or text link), joined by a line to the middle card's edge. Hovering either end lights up that thing. Everything's position
// follows from the links, so none is stored. Lines are drawn behind the cards from where things are
// on screen, and again whenever those move. The window scrolls the middle, title and all, while the
// side columns stay in view beside it.

import { isInternalLink, parseLink } from '../main/items.js';
import { fitPage, PAGE_HEIGHT, pageZoom } from './page-view.js';
import { addResizers, centreGrips } from './resizers.js';
import { commentEnds } from './comments.js';

const SVG = 'http://www.w3.org/2000/svg';
const narrow = () => matchMedia('(max-width: 900px)').matches;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// What in the middle card a line to this card ends on: the text links to it, and the parts its links
// are about (a table row holding such a link gives way to the link itself). With none of those, the
// links are about the item as a whole.
function endsFor(card, middle, focus) {
  const id = card.dataset.item;
  const anchors = [...middle.querySelectorAll('a[href]')].filter((anchor) => {
    const href = anchor.getAttribute('href');
    return isInternalLink(href) && parseLink(href, focus).target === id;
  });
  const parts = new Map([...middle.querySelectorAll('[data-part]')].map((element) => [element.dataset.part, element]));
  const named = JSON.parse(card.dataset.parts).map((part) => part && parts.get(part)).filter(Boolean);
  return [...anchors, ...named.filter((element) => !anchors.some((anchor) => element.contains(anchor)))];
}

// The height a line meets the card's edge at, for what it links to. A diagram's participant is its
// box, not the lifeline beneath it, and a link wrapped over lines is its nearest line.
function heightOf(element, left) {
  const box = element.querySelector?.('.diagram-box') ?? element;
  const rects = box.getClientRects();
  const rect = rects.length ? rects[left ? 0 : rects.length - 1] : box.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

// Each side card tries to sit level with what it links to, so its line runs straight across. Those
// that would collide are pushed apart just enough, down and then, at the bottom, back up. A card
// linked to the item as a whole has nothing to line up with, so it aims for the middle of the content.
// If they can't all fit, the column goes back to a plain stack that scrolls.
const CARD_GAP = 10;
function placeCards(stage, middle, body) {
  // `body` is the part of the middle's content in view.
  for (const column of stage.querySelectorAll('.focus-side')) {
    const left = column.classList.contains('left');
    const box = column.getBoundingClientRect();
    const rows = [...column.children].map((element, order) => {
      // A comment's card sits level with what it's on, as a link card does (see comments.js).
      const ends = element.dataset?.item ? endsFor(element, middle, stage.dataset.focus) : element.dataset?.comment ? commentEnds(element, middle) : [];
      const heights = ends.map((end) => clamp(heightOf(end, left), body.top, body.bottom) - box.top);
      const wanted = !element.dataset?.item && !element.dataset?.comment ? Infinity : heights.length ? heights.reduce((sum, one) => sum + one, 0) / heights.length : (body.top + body.bottom) / 2 - box.top;
      return { element, order, wanted, height: element.offsetHeight };
    }).sort((a, b) => a.wanted - b.wanted || a.order - b.order);
    const total = rows.reduce((sum, row) => sum + row.height + CARD_GAP, -CARD_GAP);
    // A column runs from the window's top to its bottom, but cards placed in it stay level with the
    // stage, between its padding.
    const style = getComputedStyle(column);
    const start = parseFloat(style.paddingTop);
    const room = box.height - parseFloat(style.paddingBottom);
    const fits = total <= room - start && !narrow();
    column.classList.toggle('placed', fits);
    if (!fits) {
      for (const { element } of rows) element.style.top = '';
      continue;
    }
    let edge = start;
    for (const row of rows) {
      row.top = Math.max(edge, (row.wanted === Infinity ? room : row.wanted) - row.height / 2);
      edge = row.top + row.height + CARD_GAP;
    }
    edge = room;
    for (const row of [...rows].reverse()) {
      row.top = Math.min(row.top, edge - row.height);
      edge = row.top - CARD_GAP;
    }
    for (const { element, top } of rows) element.style.top = `${top}px`;
  }
}

export function drawLines(stage) {
  const layer = stage.querySelector('.focus-lines');
  const middle = stage.querySelector('.focus-card');
  if (!layer || !middle) return;
  layer.replaceChildren();
  // The middle can be far taller than the window: only what's in view counts.
  const area = stage.closest('.content').getBoundingClientRect();
  const inView = ({ top, bottom }) => ({ top: Math.max(top, area.top), bottom: Math.min(bottom, area.bottom) });
  const body = inView(middle.querySelector('.focus-body').getBoundingClientRect());
  placeCards(stage, middle, body);
  if (narrow()) return;
  // Measured from the layer, which holds still beside the side cards as the window scrolls, so a
  // line stays on its card whether or not it has been drawn again yet.
  const box = layer.getBoundingClientRect();
  layer.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const whole = middle.getBoundingClientRect();
  const edges = { left: whole.left, right: whole.right, ...inView(whole) };

  for (const card of stage.querySelectorAll('.focus-side [data-item]')) {
    const left = card.closest('.focus-side').classList.contains('left');
    const place = card.getBoundingClientRect();
    const column = card.closest('.focus-side').getBoundingClientRect();
    const endY = place.top + place.height / 2;
    if (endY < column.top || endY > column.bottom) continue; // scrolled out of its column
    const x2 = (left ? place.right : place.left) - box.left;
    const y2 = endY - box.top;
    const edgeX = (left ? edges.left : edges.right) - box.left;
    const ends = endsFor(card, middle, stage.dataset.focus);
    for (const element of ends.length ? ends : [null]) {
      // Something scrolled out of view: the line stays at the top or bottom of the card's content.
      const x1 = edgeX;
      const y1 = (element ? clamp(heightOf(element, left), body.top + 6, body.bottom - 6) : clamp(endY, body.top + 10, body.bottom - 10)) - box.top;
      const bend = (x2 - x1) / 2;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`);
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', x1);
      dot.setAttribute('cy', y1);
      dot.setAttribute('r', 3);
      for (const line of [path, dot]) {
        line.dataset.card = card.dataset.item;
        if (element?.dataset?.part) line.dataset.part = element.dataset.part;
        line.end = element;
      }
      layer.append(path, dot);
    }
  }
}

// Hovering either end of a link lights up both, and the line between them.
function light(stage, { card = null, end = null }) {
  for (const element of stage.querySelectorAll('.lit')) element.classList.remove('lit');
  if (!card && !end) return;
  const lines = [...stage.querySelectorAll('.focus-lines [data-card]')].filter((line) => (card ? line.dataset.card === card : line.end === end));
  for (const line of lines) {
    line.classList.add('lit');
    stage.querySelector(`.focus-side [data-item="${line.dataset.card}"]`)?.classList.add('lit');
    line.end?.classList.add('lit');
  }
}

// --- Resizing the middle card ---------------------------------------------------------------------
// A handle at each edge. Dragging either resizes the card from both sides at once, so it stays
// centred, between a smallest size that's still readable and a largest that leaves the side cards
// their minimum width. Double-clicking goes back to the usual size. The size is kept for every schema
// on this computer, as a convenience. The handles are in resizers.js.

const MIN_MIDDLE = 420;
const MIN_SIDE = 180;
const GAP = 56; // between the columns, for the lines (see .focus-stage)
const STORED_WIDTH = 'focus-width';

function storedWidth() {
  try {
    return Number(localStorage.getItem(STORED_WIDTH)) || null;
  } catch {
    return null;
  }
}
function rememberWidth(width) {
  try {
    if (width) localStorage.setItem(STORED_WIDTH, String(Math.round(width)));
    else localStorage.removeItem(STORED_WIDTH);
  } catch {}
}

const largest = (stage) => Math.max(MIN_MIDDLE, stage.clientWidth - 2 * (MIN_SIDE + GAP));
const fitted = (stage, width) => Math.min(largest(stage), Math.max(MIN_MIDDLE, width));

// A page in the middle scales with the card, before the lines measure where things now are.
function fitContents(stage) {
  const page = stage.querySelector('.focus-card .sheet-body');
  if (page) fitPage(page);
  drawLines(stage);
}

function showWidth(stage, width) {
  stage.style.setProperty('--focus-width', `${width}px`);
  fitContents(stage);
}

function setWidth(stage, width) {
  stage.classList.toggle('sized', Boolean(width));
  if (width) stage.style.setProperty('--focus-width', `${fitted(stage, width)}px`);
  else stage.style.removeProperty('--focus-width');
  fitContents(stage);
}

function addHandles(stage) {
  const middle = stage.querySelector('.focus-card');
  if (!middle) return;
  addResizers(middle, {
    name: 'card',
    width: () => middle.getBoundingClientRect().width,
    limits: () => [MIN_MIDDLE, largest(stage)],
    show: (width) => {
      stage.classList.add('sized');
      showWidth(stage, width);
    },
    keep: rememberWidth,
    reset: () => {
      rememberWidth(null);
      setWidth(stage, null);
    },
  });
}

// The side columns hold still while the window scrolls, so they're given the height in view, from
// where the stage starts at the top down to the page's own margin at the bottom. Cards that don't all
// fit scroll, and run on above and below that rather than being cut off short of the window's edges.
const SMALLEST_ROOM = 420;
function fitColumns(stage) {
  const window = stage.closest('.content');
  const top = stage.getBoundingClientRect().top - window.getBoundingClientRect().top + window.scrollTop;
  const margin = parseFloat(getComputedStyle(stage.closest('.schema-page')).paddingBottom) || 0;
  stage.style.setProperty('--side-top', `${top}px`);
  stage.style.setProperty('--side-room', `${Math.max(SMALLEST_ROOM, window.clientHeight - top - margin)}px`);
  stage.style.setProperty('--side-margin', `${margin}px`);
}

// Keeps a stage's size and lines right once it's on the page.
export function watchStage(stage) {
  addHandles(stage);
  // Refitted as the window changes: the size kept is a wish, within what fits now.
  const scroller = stage.closest('.content');
  const grips = () => {
    const middle = stage.querySelector(':scope > .focus-card:not(.focus-ghost)');
    if (middle) centreGrips(middle, scroller, (middle.classList.contains('embeds') && middle.querySelector(':scope > .focus-body')) || middle);
  };
  const redraw = () => {
    fitColumns(stage);
    setWidth(stage, storedWidth());
    grips();
  };
  redraw();
  const resized = new ResizeObserver(() => {
    if (!stage.isConnected) return resized.disconnect();
    if (!document.body.classList.contains('focus-resizing')) redraw();
    else grips();
  });
  resized.observe(stage);
  resized.observe(scroller);
  const scrolled = () => {
    if (stage.isConnected) {
      drawLines(stage);
      grips();
    } else scroller.removeEventListener('scroll', scrolled);
  };
  scroller.addEventListener('scroll', scrolled, { passive: true });
  for (const side of stage.querySelectorAll('.focus-side')) side.addEventListener('scroll', () => drawLines(stage), { passive: true });
  for (const image of stage.querySelectorAll('img')) image.addEventListener('load', () => drawLines(stage));
  stage.addEventListener('mouseover', (event) => {
    const card = event.target.closest?.('.focus-side [data-item]');
    const part = event.target.closest?.('.focus-card a[href], .focus-card [data-part]');
    light(stage, { card: card?.dataset.item ?? null, end: part });
  });
  stage.addEventListener('mouseleave', () => light(stage, {}));
}

// --- Moving the focus to a card -------------------------------------------------------------------
// Everything leaves away from the chosen card. Clicking a card on the right: the left side's cards
// slide out left one after another, then the middle card follows them, the other right-side cards
// slide out right, and the chosen card grows into the middle's place. A card on the left is the
// mirror of that. Sliding out always fades out too.

const EXIT_MS = 200;
const STAGGER_MS = 50;
const SLIDE_PX = 140;
const GROW_MS = 320;
const WORDS_GO_MS = 90;
const EASE_OUT = 'cubic-bezier(0.4, 0, 1, 1)';
const SETTLE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const SAFETY_MS = 3000; // an animation can stall in a hidden window; the focus still has to move

const slideOut = (element, direction, delay, duration = EXIT_MS, distance = SLIDE_PX) => element.animate(
  [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${direction * distance}px)`, opacity: 0 }],
  { duration, delay, easing: EASE_OUT, fill: 'forwards' },
);

// Whether the move can be animated at all.
export const canChoreograph = () => document.visibilityState === 'visible' && !narrow() && !matchMedia('(prefers-reduced-motion: reduce)').matches;

// Where the new content's surface will sit, in the part of the window it will first show in, which
// is where the side columns are: a page or canvas has its heading above it, floating, and anything
// else fills the card. The new item starts at its top, however far down this one was.
function surfaceFor(middle, next, column) {
  const { left, width } = middle.getBoundingClientRect();
  // The column in view, less the room above and below it runs on through (see fitColumns).
  const style = getComputedStyle(column);
  const rect = column.getBoundingClientRect();
  const [above, below] = [parseFloat(style.paddingTop), parseFloat(style.paddingBottom)];
  const box = { left, top: rect.top + above, width, height: rect.height - above - below };
  if (!next?.classList.contains('embeds')) return box;
  const probe = next.querySelector('.pane-head').cloneNode(true);
  probe.style.visibility = 'hidden';
  middle.append(probe);
  const head = probe.offsetHeight;
  probe.remove();
  const edge = parseFloat(getComputedStyle(middle).borderTopWidth) || 0;
  const surface = { left: box.left + edge, top: box.top + edge + head, width: box.width - 2 * edge, height: box.height - 2 * edge - head };
  // A page is as tall as its width says, and the window cuts it off, not the column.
  if (next.querySelector('.document-sheet')) surface.height = Math.max(surface.height, PAGE_HEIGHT * pageZoom(surface.width, surface.width));
  // A table or image is only as tall as it is.
  const sized = next.querySelector('.table-body, .image-body');
  if (sized) {
    const copy = sized.cloneNode(true);
    const image = sized.querySelector('img');
    // A copy of an image hasn't loaded yet, so it's told the size the image has.
    if (image?.naturalWidth) Object.assign(copy.querySelector('img').style, { width: `${image.naturalWidth}px`, aspectRatio: `${image.naturalWidth} / ${image.naturalHeight}` });
    Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', width: `${surface.width}px` });
    middle.append(copy);
    surface.height = Math.min(surface.height, copy.offsetHeight);
    copy.remove();
  }
  return surface;
}

// Resolves once the old stage has left and the card has become the middle's surface: its words go
// early, while it's still near where it was, and what's left is a sheet growing into place. `next`
// is the card about to take the middle. `side` says which way things came from, for what arrives next.
export async function leaveFor(stage, card, next) {
  await next?.querySelector('img.item-image')?.decode().catch(() => {}); // its size is needed
  const right = Boolean(card.closest('.focus-side.right'));
  const away = right ? -1 : 1; // the direction the far side and the middle go
  const middle = stage.querySelector('.focus-card');
  const far = [...stage.querySelectorAll(`.focus-side.${right ? 'left' : 'right'} > *`)];
  const near = [...stage.querySelectorAll(`.focus-side.${right ? 'right' : 'left'} > *`)].filter((one) => one !== card);
  stage.classList.add('focus-animating');
  stage.closest('.content')?.classList.add('focus-animating-page');

  const running = [];
  const layer = stage.querySelector('.focus-lines');
  running.push(layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }));
  far.forEach((one, index) => running.push(slideOut(one, away, index * STAGGER_MS)));
  near.forEach((one, index) => running.push(slideOut(one, -away, index * STAGGER_MS)));

  // The middle goes once the far side's last card is on its way, and the card grows as it does.
  const middleAt = far.length ? (far.length - 1) * STAGGER_MS + EXIT_MS / 2 : 0;
  running.push(slideOut(middle, away, middleAt, 240, 180));

  const box = stage.getBoundingClientRect();
  const from = card.getBoundingClientRect();
  const to = surfaceFor(middle, next, card.closest('.focus-side'));
  const ghost = document.createElement('div');
  ghost.className = 'focus-card focus-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  const place = (rect) => ({ left: `${rect.left - box.left}px`, top: `${rect.top - box.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const look = (element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, borderColor: style.borderTopColor, borderRadius: style.borderTopLeftRadius, boxShadow: style.boxShadow };
  };
  // The card's own words, at its own width so that they don't rewrap as it grows.
  const words = card.cloneNode(true);
  // Not where it sat in its column, nor anything that would find it as the real card.
  for (const name of ['data-item', 'data-use', 'data-parts', 'id', 'style']) words.removeAttribute(name);
  words.classList.add('focus-ghost-words');
  words.style.width = `${from.width}px`;
  words.style.height = `${from.height}px`;
  ghost.append(words);
  Object.assign(ghost.style, place(from));
  stage.append(ghost);
  const started = look(card);
  const ended = next?.classList.contains('embeds') ? { ...look(ghost), borderColor: 'transparent' } : look(ghost);
  card.style.visibility = 'hidden';
  running.push(ghost.animate([{ ...place(from), ...started }, { ...place(to), ...ended }], { duration: GROW_MS, delay: middleAt, easing: SETTLE, fill: 'both' }));
  running.push(words.animate([{ opacity: 1 }, { opacity: 0 }], { duration: WORDS_GO_MS, delay: middleAt, fill: 'forwards' }));

  await Promise.race([
    Promise.allSettled(running.map((animation) => animation.finished)),
    new Promise((resolve) => setTimeout(resolve, SAFETY_MS)),
  ]);
  document.querySelector('.content')?.classList.remove('focus-animating-page');
  return right ? 'right' : 'left';
}

// The new stage arriving: its side cards slide in, a little and faded, then its lines.
export function arrive(stage) {
  for (const [side, direction] of [['left', -1], ['right', 1]]) {
    [...stage.querySelectorAll(`.focus-side.${side} > *`)].forEach((one, index) => one.animate(
      [{ transform: `translateX(${direction * 28}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
      { duration: 220, delay: index * 40, easing: SETTLE, fill: 'backwards' },
    ));
  }
  // Only what's on the new surface fades in: the surface itself is already there, as the card became it.
  const body = stage.querySelector('.focus-body');
  const sheet = body?.querySelector('.document-sheet');
  const canvas = body?.querySelector('.diagram-canvas');
  const content = sheet ? [...sheet.children] : canvas ? [...canvas.children] : [...(body?.children ?? [])];
  for (const one of [...content, stage.querySelector('.pane-head')]) one?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
  stage.querySelector('.focus-lines')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 160, fill: 'backwards' });
}
