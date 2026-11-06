import { pairKey } from '../main/items.js';
import { hideHoverCard, showHoverCard } from './hover-card.js';

// The list's connections: a line beside the rows for each pair of items that link to each other in
// any way, however many links that is. Lines go down both sides of the rows, whichever keeps them from
// crossing. Pointing at a row picks out its lines and the rows they reach. Pointing at a line picks out
// the two rows it joins, with a card saying what the links between them are.

const SVG = 'http://www.w3.org/2000/svg';
const NEAREST = 18; // how far the line between neighbouring rows curves out
const EACH_ROW = 26; // and how much further for each row it passes
const SAME_SPAN = 8; // and for lines passing the same number of rows, so they don't lie on each other
const MARGIN = 8; // kept clear at the window's edge
const MOST_ON_CARD = 8; // the card can't be scrolled, as it moves with the pointer

// Which side each line goes on, given the rows it joins as [first, last]. Two lines on one side cross
// when one starts inside the other and ends beyond it. Shortest first, as those are the most tucked in,
// each takes the side where it crosses fewest, then the side with fewer lines. Returns 'left' or 'right'
// for each, in the order given.
export function chooseSides(spans) {
  const placed = { left: [], right: [] };
  const crosses = ([a, b], [c, d]) => (a < c && c < b && b < d) || (c < a && a < d && d < b);
  const count = (side, span) => placed[side].filter((other) => crosses(span, other)).length;
  const sides = [];
  const order = spans.map((_, index) => index).sort((one, other) => spans[one][1] - spans[one][0] - (spans[other][1] - spans[other][0]) || one - other);
  for (const index of order) {
    const span = spans[index];
    const difference = count('right', span) - count('left', span) || placed.right.length - placed.left.length;
    const side = difference > 0 ? 'left' : 'right';
    placed[side].push(span);
    sides[index] = side;
  }
  return sides;
}

function draw(page, layer, pairs) {
  layer.replaceChildren();
  const box = page.getBoundingClientRect();
  const rows = [...page.querySelectorAll('.list-row[data-item]')];
  const order = new Map(rows.map((row, index) => [row.dataset.item, index]));
  const shown = pairs.filter(([a, b]) => order.has(a) && order.has(b));
  const spans = shown.map(([a, b]) => [order.get(a), order.get(b)].sort((one, other) => one - other));
  const sides = chooseSides(spans);
  const first = rows[0]?.getBoundingClientRect();
  const area = page.closest('.content')?.getBoundingClientRect();
  const window = page.closest('.content');
  const room = {
    left: area && first ? first.left - area.left - MARGIN : Infinity,
    right: area && first ? area.left + window.clientWidth - first.right - MARGIN : Infinity,
  };
  for (const [name, direction] of [['left', -1], ['right', 1]]) {
    // Longer lines curve further out, around the shorter ones, as far as there's room: a curve reaches
    // 3/4 of the way to its control points.
    const here = shown.map((pair, index) => ({ pair, span: spans[index][1] - spans[index][0] })).filter((_, index) => sides[index] === name);
    const taken = new Map();
    for (const line of [...here].sort((one, other) => one.span - other.span)) {
      const before = taken.get(line.span) ?? 0;
      taken.set(line.span, before + 1);
      line.wanted = NEAREST + (line.span - 1) * EACH_ROW + before * SAME_SPAN;
    }
    const scale = Math.min(1, room[name] / 0.75 / Math.max(1, ...here.map((line) => line.wanted)));
    const place = (id) => {
      const rect = rows[order.get(id)].getBoundingClientRect();
      return { x: (direction > 0 ? rect.right : rect.left) - box.left, y: rect.top + rect.height / 2 - box.top };
    };
    const hits = [];
    for (const { pair: [a, b], wanted, span } of here) {
      const from = place(a);
      const to = place(b);
      const out = direction * wanted * scale;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', `M${from.x} ${from.y}C${from.x + out} ${from.y} ${to.x + out} ${to.y} ${to.x} ${to.y}`);
      path.dataset.pair = pairKey(a, b);
      path.dataset.side = name;
      layer.append(path);
      // A line is too thin to point at, so there's a wider one with nothing to see.
      const hit = path.cloneNode();
      delete hit.dataset.pair;
      hit.classList.add('hit');
      hit.dataset.hit = pairKey(a, b);
      hits.push({ hit, span });
    }
    // The shorter lines on top: they're in among the longer ones, and harder to reach.
    layer.append(...hits.sort((one, other) => other.span - one.span).map(({ hit }) => hit));
    for (const id of new Set(here.flatMap(({ pair }) => pair))) {
      const { x, y } = place(id);
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.setAttribute('r', 3);
      dot.dataset.end = id;
      dot.dataset.side = name;
      layer.append(dot);
    }
  }
}

// Picks out these pairs' lines, and the rows they join.
function light(page, layer, pairs, picked) {
  const reached = new Set();
  const sidesLit = new Set();
  const dots = [...layer.querySelectorAll('circle')];
  const lines = [...layer.querySelectorAll('path[data-pair]')];
  for (const [a, b] of pairs) {
    const lit = picked.some((pair) => pairKey(...pair) === pairKey(a, b));
    const line = lines.find((path) => path.dataset.pair === pairKey(a, b));
    if (!line) continue;
    line.classList.toggle('lit', lit);
    // In front of the rest, with the dots in front of that.
    if (lit) {
      layer.append(line);
      reached.add(a).add(b);
      sidesLit.add(`${line.dataset.side} ${a}`).add(`${line.dataset.side} ${b}`);
    }
  }
  layer.append(...dots);
  layer.classList.toggle('picking', reached.size > 0);
  for (const dot of dots) dot.classList.toggle('lit', sidesLit.has(`${dot.dataset.side} ${dot.dataset.end}`));
  for (const row of page.querySelectorAll('.list-row[data-item]')) row.classList.toggle('lit', reached.has(row.dataset.item));
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
// `pairs` are from connectedPairs, and `connections` from connectionDetails. Keeps the lines right for
// as long as the list is on the page.
export function watchList(page, pairs, connections) {
  const layer = document.createElementNS(SVG, 'svg');
  layer.classList.add('list-lines');
  layer.setAttribute('aria-hidden', 'true');
  page.append(layer);
  const redraw = () => draw(page, layer, pairs);
  redraw();
  const resized = new ResizeObserver(() => {
    if (!page.isConnected) return resized.disconnect();
    redraw();
  });
  resized.observe(page);
  const pairsAt = (event) => {
    const line = event.target.closest?.('[data-hit]')?.dataset.hit;
    if (line) return pairs.filter(([a, b]) => pairKey(a, b) === line);
    const row = event.target.closest?.('.list-row[data-item]')?.dataset.item;
    return row ? pairs.filter((pair) => pair.includes(row)) : [];
  };
  page.addEventListener('mouseover', (event) => light(page, layer, pairs, pairsAt(event)));
  page.addEventListener('mouseleave', () => light(page, layer, pairs, []));
  page.addEventListener('focusin', (event) => light(page, layer, pairs, pairsAt(event)));
  page.addEventListener('focusout', () => light(page, layer, pairs, []));
  page.addEventListener('mousemove', (event) => {
    const line = event.target.closest?.('[data-hit]');
    const details = line && connections[line.dataset.hit];
    if (details) showHoverCard(line, (card) => fillCard(card, details), { x: event.clientX, y: event.clientY }, 'link-card');
    else hideHoverCard();
  });
}
