// The card that shows while pointing at something, saying more about it: one for the window, outside
// whatever it's about, like the diagrams' tooltip and for the same reason. What it's about can be
// taken away, or scrolled from under the pointer, with no event to say the pointer has left, so while
// it shows, every frame asks whether that's still there and still pointed at (or focused).

let card = null;
let owner = null;
let frame = 0;
let place = () => {};

const check = () => {
  if (owner?.isConnected && owner.matches(':hover, :focus-visible')) frame = requestAnimationFrame(check);
  else hideHoverCard();
};

export function hideHoverCard() {
  cancelAnimationFrame(frame);
  owner = null;
  if (card) card.hidden = true;
}

// Shows the card for `target`, filled by `fill(card)` when it's new to it, which can be async. `at` is
// where it goes: { x, y }, a point to sit beside, or a rect, such as a link's, to sit beneath (or above,
// with no room beneath).
export function showHoverCard(target, fill, at, className = '') {
  card ??= document.body.appendChild(Object.assign(document.createElement('div'), { hidden: true }));
  place = () => {
    const gap = at.width === undefined ? 14 : 6;
    const { width, height } = card.getBoundingClientRect();
    let x;
    let y;
    if (at.width === undefined) {
      x = at.x + gap + width > innerWidth - 4 ? at.x - gap - width : at.x + gap;
      y = Math.min(at.y + gap, innerHeight - height - 4);
    } else {
      x = Math.min(at.left, innerWidth - width - 4);
      y = at.bottom + gap + height > innerHeight - 4 ? at.top - gap - height : at.bottom + gap;
    }
    Object.assign(card.style, { left: `${Math.max(4, x)}px`, top: `${Math.max(4, y)}px` });
  };
  if (owner !== target) {
    card.className = `hover-card ${className}`;
    card.replaceChildren();
    owner = target;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(check);
    const filled = fill(card);
    if (filled?.then) filled.then(() => owner === target && place());
  }
  card.hidden = false;
  place();
}
