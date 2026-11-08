import { pairKey } from '../main/items.js';
import { hideHoverCard, showHoverCard } from './hover-card.js';
import { route } from './item-views.js';
import { layoutCards } from './layout.js';

// A schema's overview: every item in it at full size, each as large as its content, laid out on a
// canvas that can be moved around and zoomed (see canvas-view.js), with a line for each pair of items that link to each other in any way,
// however many links that is. Nothing is placed by hand: the layout is worked out each time, in a grid
// shaped to fill the window (see layoutCards). Pointing
// at a card picks out its lines and the cards they reach. Pointing at a line picks out the two cards it
// joins, with a card saying what the links between them are.

const SVG = 'http://www.w3.org/2000/svg';
const MOST_ON_CARD = 8; // the line card can't be scrolled, as it moves with the pointer

const svg = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};

// The overview's drawing, in a holder that makeCanvas turns into a canvas. `items` are what's shown,
// each with data-item (or data-removed, or data-comment): items at full size, each as large as its
// content, and cards. They're measured where they'll show, so the layout leaves each the room it
// needs. `pairs` are from connectedPairs, and `room` is the size of the space it's shown in.
// `pinned` ({ card, at }) are comment cards the user put somewhere, at `at` (fractions of the
// drawing), over whatever's there. The drawing is HTML, with the lines in an svg beneath, so what's
// in an item works as it does anywhere else.
export function drawOverview(items, pairs, room, pinned = []) {
  const world = Object.assign(document.createElement('div'), { className: 'overview-world' });
  // Measured in the same markup as the canvas, as its styles set their sizes.
  const measuring = Object.assign(document.createElement('div'), { className: 'diagram overview overview-measuring' });
  const sheet = Object.assign(document.createElement('div'), { className: 'overview-world' });
  sheet.append(...items, ...pinned.map((one) => one.card));
  measuring.append(sheet);
  document.body.append(measuring);
  const size = (element) => ({ width: Math.ceil(element.offsetWidth), height: Math.ceil(element.offsetHeight) });
  const sized = items.map((element) => ({ element, id: element.dataset.item ?? element.dataset.removed ?? `comment-${element.dataset.comment}`, ...size(element) }));
  const pinnedSized = pinned.map(({ card, at }) => ({ card, at, ...size(card) }));
  measuring.remove();
  const ids = new Set(sized.map(({ id }) => id));
  const joined = pairs.filter(([a, b]) => ids.has(a) && ids.has(b));
  const layout = layoutCards(sized, joined, room);
  const width = Math.ceil(layout.width);
  const height = Math.ceil(layout.height);

  Object.assign(world.style, { width: `${width}px`, height: `${height}px` });
  const drawing = svg('svg', { class: 'overview-svg', width, height, viewBox: `0 0 ${width} ${height}` });
  const lines = svg('g', { class: 'overview-lines' });
  for (const { pair: [a, b], points } of layout.lines) {
    const line = svg('path', { d: route(points), 'data-pair': pairKey(a, b) });
    // A line is too thin to point at, so there's a wider one with nothing to see.
    const hit = svg('path', { d: route(points), class: 'hit', 'data-hit': pairKey(a, b) });
    lines.append(line, hit);
  }
  drawing.append(lines);
  world.append(drawing);
  for (const { element, id } of sized) {
    const { x, y, width: w, height: h } = layout.cards.find((one) => one.id === id);
    Object.assign(element.style, { left: `${x - w / 2}px`, top: `${y - h / 2}px`, width: `${w}px`, height: `${h}px` });
    world.append(element);
  }
  for (const { card, at, width: w, height: h } of pinnedSized) {
    const x = Math.min(Math.max(0, at.x * width - w / 2), Math.max(0, width - w));
    const y = Math.min(Math.max(0, at.y * height - 16), Math.max(0, height - h));
    Object.assign(card.style, { left: `${x}px`, top: `${y}px`, width: `${w}px` });
    card.classList.add('overview-pinned');
    world.append(card);
  }
  const holder = Object.assign(document.createElement('div'), { className: 'diagram overview' });
  holder.append(world);
  holder.world = world;
  holder.size = { width, height };
  holder.columns = layout.columns;
  return holder;
}

// Picks out these pairs' lines, and the cards they join.
function light(holder, pairs, picked) {
  const reached = new Set();
  for (const line of holder.querySelectorAll('.overview-lines path[data-pair]')) {
    const lit = picked.some((pair) => pairKey(...pair) === line.dataset.pair);
    line.classList.toggle('lit', lit);
    if (lit) line.parentElement.append(line); // in front of the rest
  }
  for (const [a, b] of picked) reached.add(a).add(b);
  holder.classList.toggle('picking', reached.size > 0);
  for (const card of holder.querySelectorAll('.overview-world > [data-item]')) card.classList.toggle('lit', reached.has(card.dataset.item));
}

const text = (tag, className, content) => Object.assign(document.createElement(tag), { className, textContent: content });

function linkLine({ from, to, label }) {
  const line = document.createElement('li');
  // A document's links come from no part of it, so what they say is the best sign of where they are.
  const source = from ?? (label && `“${label}”`);
  if (!source && !to) line.append(text('span', 'link-card-whole', 'The item as a whole'));
  else line.append(text('span', source ? '' : 'link-card-whole', source || 'The whole item'), text('span', 'link-card-arrow', ' → '), text('span', to ? '' : 'link-card-whole', to ?? 'The whole item'));
  if (label && from) line.append(text('span', 'link-card-label', label));
  return line;
}

function fillCard(card, { count, ways }) {
  let left = MOST_ON_CARD;
  const sections = ways.map(({ from, to, links }) => {
    const section = document.createElement('section');
    const head = document.createElement('div');
    head.className = 'link-card-head';
    head.append(text('strong', '', from), text('span', 'link-card-arrow', ' → '), text('strong', '', to));
    const list = document.createElement('ul');
    const shown = links.slice(0, left);
    left -= shown.length;
    list.append(...shown.map(linkLine));
    section.append(head, list);
    return section;
  });
  const footer = count > MOST_ON_CARD ? [text('div', 'link-card-more', `And ${count - MOST_ON_CARD} more`)] : [];
  card.replaceChildren(text('div', 'link-card-count', count === 1 ? '1 link' : `${count} links`), ...sections, ...footer);
}

// `pairs` are from connectedPairs, and `connections` from connectionDetails.
export function watchOverview(holder, pairs, connections) {
  const pairsAt = (event) => {
    const line = event.target.closest?.('[data-hit]')?.dataset.hit;
    if (line) return pairs.filter(([a, b]) => pairKey(a, b) === line);
    const card = event.target.closest?.('.overview-world > [data-item]')?.dataset.item;
    return card ? pairs.filter((pair) => pair.includes(card)) : [];
  };
  holder.addEventListener('mouseover', (event) => light(holder, pairs, pairsAt(event)));
  holder.addEventListener('mouseleave', () => light(holder, pairs, []));
  holder.addEventListener('focusin', (event) => {
    light(holder, pairs, pairsAt(event));
    // Tabbing to an item or card out of view moves the canvas to it (not to something inside one).
    if (!event.target.matches?.('.overview-world > *')) return;
    const box = event.target.getBoundingClientRect?.();
    const room = holder.getBoundingClientRect();
    if (box && (box.left < room.left || box.right > room.right || box.top < room.top || box.bottom > room.bottom)) holder.centreOn?.(event.target);
  });
  // The canvas moves, not its box: whatever scrolls the box to show something is undone.
  holder.addEventListener('scroll', () => {
    holder.scrollTop = 0;
    holder.scrollLeft = 0;
  });
  holder.addEventListener('focusout', () => light(holder, pairs, []));
  holder.addEventListener('mousemove', (event) => {
    const line = event.target.closest?.('[data-hit]');
    const details = line && connections[line.dataset.hit];
    if (details && !holder.classList.contains('panning')) showHoverCard(line, (card) => fillCard(card, details), { x: event.clientX, y: event.clientY }, 'link-card');
    else hideHoverCard();
  });
}
