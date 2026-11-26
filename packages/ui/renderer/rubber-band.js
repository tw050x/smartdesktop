// Rubber banding for something that scrolls, as macOS does it: scrolled on past its top or its end,
// what's in it is pulled a little further, more and more stiffly, and comes back, so the user feels
// the end rather than nothing happening. Chromium does this for the page itself, not for an area
// inside it. It moves with `translate`, which leaves `transform` free for anything that animates it,
// on a layer of its own while it moves, so the text isn't repainted at every step.
//
// Two things, kept apart so it's smooth:
// - the pull: how far the scrolling has pulled it, which says where it should be. Scrolling past
//   the end adds to it; as soon as the scrolling stops adding, it lets go, quickly.
// - where it shows: it follows the pull on a spring (critically damped: no wobble, no jumps), so the
//   uneven scrolls a trackpad sends never show as jitter.
// A trackpad keeps sending scrolls for a second or more after a flick (it coasts), each the same size
// as the one before or smaller, so, as macOS does, the scroll that reaches the end makes the bounce,
// and after that only one bigger than the last (fingers pulling) pulls further: coasting can't hold
// it out.

const MAX = 80; // px: how far it can be pulled, at most (it never quite gets there)
const IMPACT = 1.6; // how much of the scroll that first reaches the end goes into the bounce
const FRESH_MS = 120; // a scroll after this long with none is a new one, not the last one going on
const HOLD_MS = 60; // the pull holds this long after the last scroll that added to it
const LET_GO_MS = 55; // then it lets go: the time to come about two thirds of the way home
const SPRING = 40; // how quickly where it shows follows the pull (radians a second)

// How far it shows for how far it's been pulled: less and less, never past MAX.
export const stretched = (pull) => Math.sign(pull) * MAX * (1 - 1 / (1 + Math.abs(pull) / (MAX * 1.5)));

// One step of a critically damped spring towards `target`, `dt` seconds on: exactly, at any dt.
export function follow({ at, speed }, target, dt) {
  const away = at - target;
  const decay = Math.exp(-SPRING * dt);
  const push = speed + SPRING * away;
  return { at: target + (away + push * dt) * decay, speed: (speed - SPRING * push * dt) * decay };
}

export function rubberBand(scroller) {
  let pull = 0; // + pulled down past the top, − pulled up past the end
  let shown = { at: 0, speed: 0 };
  let lastAdded = 0; // when the pull was last added to
  let previous = { size: 0, at: 0, past: false }; // the last scroll: its size, when, and if past the end
  let frame = 0;
  let last = 0;

  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (now - lastAdded > HOLD_MS) {
      pull *= Math.exp(-(dt * 1000) / LET_GO_MS);
      if (Math.abs(pull) < 0.5) pull = 0;
    }
    shown = follow(shown, stretched(pull), dt);
    if (!pull && Math.abs(shown.at) < 0.2 && Math.abs(shown.speed) < 2) {
      shown = { at: 0, speed: 0 };
      scroller.style.translate = '';
      scroller.style.willChange = '';
      frame = 0;
      return;
    }
    scroller.style.willChange = 'translate';
    scroller.style.translate = `0 ${shown.at.toFixed(2)}px`;
    frame = requestAnimationFrame(tick);
  };

  scroller.addEventListener('wheel', (event) => {
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const range = scroller.scrollHeight - scroller.clientHeight;
    const now = performance.now();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const size = Math.abs(delta);
    const pastTop = range > 0 && scroller.scrollTop <= 0 && delta < 0;
    const pastEnd = range > 0 && scroller.scrollTop >= range - 1 && delta > 0;
    const out = pull || shown.at;
    if (!out && !pastTop && !pastEnd) {
      previous = { size, at: now, past: false };
      return;
    }
    event.preventDefault();
    const goingOn = previous.past && now - previous.at < FRESH_MS;
    const easingBack = out && Math.sign(-delta) !== Math.sign(out);
    if (easingBack) {
      // Scrolling back eases it home before anything scrolls, never past home.
      const next = pull - delta;
      pull = Math.sign(next) === Math.sign(pull) ? next : 0;
    } else if (!goingOn) {
      pull -= delta * IMPACT; // reaching the end: the bounce
      lastAdded = now;
    } else if (size > previous.size) {
      pull -= delta; // fingers pulling
      lastAdded = now;
    } // otherwise coasting: it adds nothing
    previous = { size, at: now, past: true };
    if (!frame) {
      last = now;
      frame = requestAnimationFrame(tick);
    }
  }, { passive: false });
}
