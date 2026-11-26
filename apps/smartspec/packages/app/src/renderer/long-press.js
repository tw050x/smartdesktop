// A long press: the pointer held still for a moment. It's how the user starts a comment (see
// comments.js). Moving first is a drag, or picking text, so a press that moves is let go. While it's
// held, a ring grows round the pointer, so the user can see something's about to happen.

const HOLD_MS = 500;
const STILL = 4; // px the pointer may wander and still be held
const SHOW_AFTER = 120; // ms before the ring shows, so a click doesn't flash it

let pressed = false; // a long press has just happened: what follows (a click, a drag) is ignored

// Whether a long press has happened since the pointer went down. The board's drag checks this, so a
// long press that then moves doesn't drag.
export const longPressed = () => pressed;

// Watches `root` for long presses. `accept(event)` says whether a press there could be one;
// `fire(event)` is called with the pointerdown event once it's been held long enough.
export function watchLongPress(root, { accept, fire }) {
  root.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || !down.isPrimary || !accept(down)) return;
    pressed = false;
    const ring = document.createElement('div');
    ring.className = 'long-press-ring';
    Object.assign(ring.style, { left: `${down.clientX}px`, top: `${down.clientY}px` });
    const showing = setTimeout(() => document.body.append(ring), SHOW_AFTER);
    const done = () => {
      clearTimeout(showing);
      clearTimeout(timer);
      ring.remove();
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', done, true);
      removeEventListener('wheel', done, true);
    };
    const timer = setTimeout(() => {
      done();
      pressed = true;
      fire(down);
    }, HOLD_MS);
    const move = (event) => {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > STILL) done();
    };
    const up = () => done();
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', done, true);
    addEventListener('wheel', done, true);
  });
}

// After a long press, the click that ends it, and any menu, mean nothing; once the pointer is up,
// presses are ordinary again.
addEventListener('click', (event) => {
  if (!pressed) return;
  event.preventDefault();
  event.stopPropagation();
}, true);
addEventListener('contextmenu', (event) => {
  if (pressed) event.preventDefault();
}, true);
addEventListener('pointerup', () => {
  if (pressed) setTimeout(() => { pressed = false; });
}, true);
