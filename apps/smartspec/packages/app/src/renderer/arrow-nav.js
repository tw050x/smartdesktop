// Arrow keys between cards, only while one of those cards has focus. Set out in columns: up and down
// to the card above or below in its column, left and right to the nearest card, by height, in the
// column beside it (home's); going into home's schemas, the chosen one is where it lands. On the overview's
// canvas: to the nearest card that way, brought to the middle if it's out of view. Elsewhere, arrows
// do what they always do.

// Each layout: its columns, left to right, and the cards in one.
const LAYOUTS = [
  { columns: '.browser .browser-column', cards: 'button.browser-row' },
];
const CANVAS = { canvas: '.overview.diagram-canvas', cards: 'button.overview-card' };

// The nearest card the arrow points to, from the middle of one to the middle of the other, keeping
// close to the way it points: within 45° of it if any card is, else anywhere on that side.
function nearestThatWay(card, key) {
  const canvas = card.closest(CANVAS.canvas);
  if (!canvas) return null;
  const centre = (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const from = centre(card);
  const [dx, dy] = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
  const ahead = [...canvas.querySelectorAll(CANVAS.cards)].filter((other) => other !== card).map((other) => {
    const to = centre(other);
    return { other, along: (to.x - from.x) * dx + (to.y - from.y) * dy, across: Math.abs((to.x - from.x) * dy - (to.y - from.y) * dx) };
  }).filter(({ along }) => along > 0);
  const within = ahead.filter(({ along, across }) => across <= along);
  const pool = within.length ? within : ahead;
  pool.sort((a, b) => a.along + 2 * a.across - (b.along + 2 * b.across));
  return pool[0]?.other ?? null;
}

const shown = (element) => element.getClientRects().length > 0;
const middleOf = (element) => {
  const box = element.getBoundingClientRect();
  return box.top + box.height / 2;
};

// The cards of a column in the order they're seen, top to bottom.
const cardsIn = (column, selector) => [...column.querySelectorAll(selector)].filter(shown).sort((a, b) => middleOf(a) - middleOf(b));

function target(card, key) {
  for (const { columns, cards } of LAYOUTS) {
    if (!card.matches(cards)) continue;
    const all = [...document.querySelectorAll(columns)].filter(shown).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const at = all.findIndex((column) => column.contains(card));
    if (at < 0) continue;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const list = cardsIn(all[at], cards);
      return list[list.indexOf(card) + (key === 'ArrowDown' ? 1 : -1)] ?? null;
    }
    // The next column along with any cards in it.
    const step = key === 'ArrowRight' ? 1 : -1;
    for (let next = at + step; next >= 0 && next < all.length; next += step) {
      const list = cardsIn(all[next], cards);
      if (!list.length) continue;
      const chosen = list.find((one) => one.getAttribute('aria-pressed') === 'true');
      if (chosen) return chosen;
      const y = middleOf(card);
      return list.reduce((best, one) => (Math.abs(middleOf(one) - y) < Math.abs(middleOf(best) - y) ? one : best));
    }
    return null;
  }
  return null;
}

export function watchArrowKeys() {
  document.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    if (document.querySelector('dialog[open]')) return;
    const card = document.activeElement;
    if (!(card instanceof HTMLElement) || ![...LAYOUTS, CANVAS].some(({ cards }) => card.matches(cards))) return;
    // A card's own arrow keys stay its own: the page doesn't scroll, whether or not there's somewhere to go.
    event.preventDefault();
    if (card.matches(CANVAS.cards)) {
      const next = nearestThatWay(card, event.key);
      if (!next) return;
      // The canvas moves, not its box, so focusing mustn't scroll it.
      next.focus({ preventScroll: true });
      const canvas = next.closest(CANVAS.canvas);
      const box = next.getBoundingClientRect();
      const room = canvas.getBoundingClientRect();
      if (box.left < room.left || box.right > room.right || box.top < room.top || box.bottom > room.bottom) canvas.centreOn?.(next);
      return;
    }
    const next = target(card, event.key);
    if (next) next.focus();
  });
}
