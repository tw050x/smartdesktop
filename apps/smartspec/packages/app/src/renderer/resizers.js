// A handle at each edge of something centred, which it resizes from both sides at once. Dragged past
// its limits it follows with growing resistance, and springs back when let go. Double-clicking goes
// back to its usual size. The middle card and a full screen page both work this way.

const STRETCH = 48; // the most it goes past a limit, however far it's pulled
const SPRING_BACK = 260; // ms

// The width to show for a drag wanting `wanted`: itself within the limits, and past them, a little
// further the harder it's pulled, approaching STRETCH.
export function stretched(wanted, smallest, biggest) {
  const limit = Math.min(biggest, Math.max(smallest, wanted));
  const over = Math.abs(wanted - limit);
  return limit + Math.sign(wanted - limit) * STRETCH * (1 - 1 / ((over * 0.55) / STRETCH + 1));
}

// Eases from one width to another, then says so. Stopped by calling what it returns.
function springBack(parent, from, to, show, done) {
  if (from === to || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    show(to);
    done();
    return () => {};
  }
  const start = performance.now();
  let frame = requestAnimationFrame(function step(now) {
    if (!parent.isConnected) return done();
    const progress = Math.min(1, (now - start) / SPRING_BACK);
    show(from + (to - from) * (1 - (1 - progress) ** 3));
    if (progress < 1) frame = requestAnimationFrame(step);
    else done();
  });
  return () => cancelAnimationFrame(frame);
}

// Puts each handle's grip at the middle of the part of `parent` in view: the middle of a short card,
// and of the window for a card taller than it. `view` is the box it scrolls within.
const GRIP = 108; // px, as in styles.css
// `surface` is what's seen of it, when that's only part of its box, as a table on a card with no
// background.
export function centreGrips(parent, view, surface = parent) {
  const box = parent.getBoundingClientRect();
  const shown = surface.getBoundingClientRect();
  const seen = view.getBoundingClientRect();
  const top = Math.max(shown.top, seen.top);
  const bottom = Math.min(shown.bottom, seen.bottom);
  const at = Math.min(Math.max(0, (top + bottom) / 2 - box.top - GRIP / 2), Math.max(0, box.height - GRIP));
  for (const handle of parent.querySelectorAll(':scope > .focus-resizer')) {
    handle.style.setProperty('--grip-top', `${at}px`);
    handle.classList.add('placed');
  }
}

// Adds the two handles to `parent`. `width()` is the size now, `limits()` gives [smallest, largest],
// `show(width)` draws a size, `keep(width)` remembers where a drag settled and `reset()` goes back to
// the usual size. `name` says what's being resized. Returns the handles.
export function addResizers(parent, { name, width: widthNow, limits, show, keep, reset, className = '' }) {
  let stopSpring = () => {};
  return [['left', -1], ['right', 1]].map(([side, direction]) => {
    const handle = document.createElement('div');
    handle.className = `focus-resizer ${side} ${className}`.trim();
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize the ${name}`);
    handle.title = `Drag to resize the ${name}. Double-click to reset.`;
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      stopSpring();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = widthNow();
      document.body.classList.add('focus-resizing');
      let width = startWidth;
      const onMove = (move) => {
        // Twice the pointer's travel: the far edge moves as much as the near one.
        const [smallest, largest] = limits();
        width = stretched(startWidth + 2 * direction * (move.clientX - startX), smallest, largest);
        show(width);
      };
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('lostpointercapture', onEnd);
        // Only a click: nothing changed.
        if (width === startWidth) return document.body.classList.remove('focus-resizing');
        const [smallest, largest] = limits();
        const settled = Math.min(largest, Math.max(smallest, width));
        keep(settled);
        stopSpring = springBack(parent, width, settled, show, () => document.body.classList.remove('focus-resizing'));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('lostpointercapture', onEnd);
    });
    handle.addEventListener('dblclick', reset);
    parent.append(handle);
    return handle;
  });
}
