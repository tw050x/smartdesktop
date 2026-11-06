// Arrow keys between cards set out in columns, only while one of those cards has focus: up and down
// to the card above or below in its column, left and right to the nearest card, by height, in the
// column beside it. Going into home's schemas, the chosen one is where it lands. Elsewhere, arrows do
// what they always do.

// Each layout: its columns, left to right, and the cards in one.
const LAYOUTS = [
  { columns: '.browser .browser-column', cards: 'button.browser-row' },
  { columns: '.focus-stage > .focus-side', cards: 'button.focus-neighbour' },
  { columns: '.list-page', cards: 'button.list-row' }, // one column, however many lists
];

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
    if (!(card instanceof HTMLElement) || !LAYOUTS.some(({ cards }) => card.matches(cards))) return;
    // A card's own arrow keys stay its own: the page doesn't scroll, whether or not there's somewhere to go.
    event.preventDefault();
    const next = target(card, event.key);
    if (next) next.focus();
  });
}
