import { pairKey } from '../main/items.js';
import { hideHoverCard, showHoverCard } from './hover-card.js';
import { route } from './item-views.js';
import { layoutCards } from './layout.js';

// A schema's overview: every item in it as a card, laid out on a canvas that can be moved around and
// zoomed (see canvas-view.js), with a line for each pair of items that link to each other in any way,
// however many links that is. Nothing is placed by hand: the layout is worked out each time, in a grid
// shaped to fill the window (see layoutCards). Pointing
// at a card picks out its lines and the cards they reach. Pointing at a line picks out the two cards it
// joins, with a card saying what the links between them are.

const SVG = 'http://www.w3.org/2000/svg';
export const CARD_WIDTH = 280;
const MOST_ON_CARD = 8; // the line card can't be scrolled, as it moves with the pointer

const svg = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};

// The overview's drawing, in a holder that makeCanvas turns into a canvas. `cards` are the item
// cards, each with data-item (or data-removed, or data-comment), and `pairs` are from connectedPairs.
// Cards are measured where they'll show, so the layout leaves each the room it needs. `room` is the
// size of the space it's shown in.
export function drawOverview(cards, pairs, room) {
  // Inside the same markup as the canvas, as its styles change a card's height.
  const measuring = Object.assign(document.createElement('div'), { className: 'diagram overview overview-measuring' });
  const sheet = svg('svg', { class: 'diagram-svg overview-svg', width: CARD_WIDTH, height: 10000 });
  for (const card of cards) {
    const place = svg('foreignObject', { width: CARD_WIDTH, height: 10000 });
    place.append(card);
    sheet.append(place);
  }
  measuring.append(sheet);
  document.body.append(measuring);
  const sized = cards.map((card) => ({ card, id: card.dataset.item ?? card.dataset.removed ?? `comment-${card.dataset.comment}`, width: CARD_WIDTH, height: Math.ceil(card.getBoundingClientRect().height) }));
  measuring.remove();
  const ids = new Set(sized.map(({ id }) => id));
  const joined = pairs.filter(([a, b]) => ids.has(a) && ids.has(b));
  const layout = layoutCards(sized, joined, room);

  const drawing = svg('svg', { class: 'diagram-svg overview-svg', width: Math.ceil(layout.width), height: Math.ceil(layout.height), viewBox: `0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}` });
  const lines = svg('g', { class: 'overview-lines' });
  for (const { pair: [a, b], points } of layout.lines) {
    const line = svg('path', { d: route(points), 'data-pair': pairKey(a, b) });
    // A line is too thin to point at, so there's a wider one with nothing to see.
    const hit = svg('path', { d: route(points), class: 'hit', 'data-hit': pairKey(a, b) });
    lines.append(line, hit);
  }
  drawing.append(lines);
  for (const { card, id } of sized) {
    const { x, y, width, height } = layout.cards.find((one) => one.id === id);
    const place = svg('foreignObject', { x: x - width / 2, y: y - height / 2, width, height });
    place.append(card);
    drawing.append(place);
  }
  const holder = Object.assign(document.createElement('div'), { className: 'diagram overview' });
  holder.append(drawing);
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
  for (const card of holder.querySelectorAll('.overview-card[data-item]')) card.classList.toggle('lit', reached.has(card.dataset.item));
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
    const card = event.target.closest?.('.overview-card[data-item]')?.dataset.item;
    return card ? pairs.filter((pair) => pair.includes(card)) : [];
  };
  holder.addEventListener('mouseover', (event) => light(holder, pairs, pairsAt(event)));
  holder.addEventListener('mouseleave', () => light(holder, pairs, []));
  holder.addEventListener('focusin', (event) => {
    light(holder, pairs, pairsAt(event));
    // Tabbing to a card out of view moves the canvas to it.
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
