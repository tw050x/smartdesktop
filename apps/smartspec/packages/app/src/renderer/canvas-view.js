// A diagram as a virtual canvas, in its card or full screen: drag to move around, pinch or Cmd
// and scroll to zoom, scroll to move. It starts fitted to the space. Where you've moved to isn't
// stored with the schema, as positions are never data.

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const MARGIN = 24;
const DRAG_FROM = 4; // px: less than this is a click, so links in the diagram still work
const DOTS = 24;
const PIN_GAP = 8;

const STRETCH = 200; // px: how far past its limit a canvas that rubber-bands can be pulled, at most
const SPRING_AFTER = 160; // ms after the last scroll before a rubber-banding canvas springs back

const limited = (scale, min = MIN_SCALE) => Math.min(MAX_SCALE, Math.max(min, scale));

// Zoomed out past as far as it goes, it gives a little, more and more stiffly, to at most GIVE
// smaller, and springs back when let go, so the user sees the limit rather than nothing happening.
const GIVE = 0.12;
const BOUNCE = 0.06; // how far a zoom-out button pressed at the limit dips before springing back
export const SPRING_MS = 260;
export function pastLeast(wanted, least) {
  if (wanted >= least) return wanted;
  const excess = 1 - wanted / least;
  return least * (1 - GIVE * (1 - 1 / (1 + excess / GIVE)));
}

// Moves a number from `from` to `to` over SPRING_MS, easing out, calling `step` with each value.
export function glide(from, to, step, done = () => {}, ms = SPRING_MS) {
  const start = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - start) / ms);
    step(from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(frame);
    else done();
  };
  requestAnimationFrame(frame);
}

// A press of zoom out at the limit: a little dip and back, from `at`, by `step`.
export function bounce(at, step, done) {
  glide(at, at * (1 - BOUNCE), step, () => glide(at * (1 - BOUNCE), at, step, done, SPRING_MS / 2), SPRING_MS / 2);
}

// The view showing all of a diagram, centred, without enlarging it.
export function fitView(content, space, min = MIN_SCALE) {
  const scale = limited(Math.min(1, (space.width - 2 * MARGIN) / content.width, (space.height - 2 * MARGIN) / content.height), min);
  return { x: (space.width - content.width * scale) / 2, y: (space.height - content.height * scale) / 2, scale };
}

// The view zoomed by `factor`, keeping what's at (x, y) in the same place on screen.
export function zoomedAt(view, factor, x, y, min = MIN_SCALE) {
  const scale = limited(view.scale * factor, min);
  const kept = scale / view.scale;
  return { scale, x: x - (x - view.x) * kept, y: y - (y - view.y) * kept };
}

// How far to move a sequence diagram's heads down, within the drawing, to keep them on the canvas at
// this view: none until they'd go off the top, and no further than the end of the diagram.
export function pinOffset(view, { top, bottom, height }) {
  const wanted = (PIN_GAP - view.y) / view.scale - top;
  return Math.max(0, Math.min(wanted, height - bottom));
}

// Past `limit`, `value` gives less and less the further it's pulled, to at most STRETCH more.
function band(value, low, high) {
  if (value < low) return low - STRETCH * (1 - 1 / (1 + (low - value) / STRETCH));
  if (value > high) return high + STRETCH * (1 - 1 / (1 + (value - high) / STRETCH));
  return value;
}

// Turns a diagram's holder into a canvas. `saved` is a view to return to, `onChange` hears of each
// one the user moves to, and `onShow` of every change on screen. `drawing` is what moves (the
// holder's svg unless given), with its `size`. `minScale` is how far out it zooms. `panFrom(event)`
// says whether a drag starting there moves the canvas. With `fitted`, it zooms out no further than it
// takes to show all of it: there's nothing to see in making it smaller. With `rubber`, it can be moved anywhere, but
// once its content no longer crosses the middle of the space it gives less and less, and springs
// back when let go.
export function makeCanvas(holder, { saved = null, onChange = () => {}, onShow = () => {}, drawing = holder.querySelector('svg'), size = null, minScale = MIN_SCALE, panFrom = () => true, rubber = false, fitted = false } = {}) {
  const content = size ?? { width: Number(drawing.getAttribute('width')), height: Number(drawing.getAttribute('height')) };
  holder.classList.add('diagram-canvas');
  const dots = document.createElement('div');
  dots.className = 'canvas-dots';
  holder.prepend(dots);
  let view = saved;
  let moved = Boolean(saved);

  const button = (label, name, run) => {
    const element = document.createElement('button');
    Object.assign(element, { type: 'button', textContent: label, title: name, onclick: run });
    element.setAttribute('aria-label', name);
    return element;
  };
  const space = () => ({ width: holder.clientWidth, height: holder.clientHeight });
  const centre = () => ({ x: holder.clientWidth / 2, y: holder.clientHeight / 2 });
  // How far out it zooms: all of it in view, if `fitted`.
  const least = () => (fitted && holder.clientWidth ? Math.max(minScale, fitView(content, space(), minScale).scale) : minScale);
  const amount = document.createElement('span');
  amount.className = 'canvas-amount';
  // Where the content may go freely: as long as it crosses the middle of the space, both ways.
  const range = (scale) => {
    const middle = centre();
    return { x: [middle.x - content.width * scale, middle.x], y: [middle.y - content.height * scale, middle.y] };
  };
  const shownView = () => {
    if (!rubber) return view;
    const { x, y } = range(view.scale);
    return { ...view, x: band(view.x, ...x), y: band(view.y, ...y) };
  };
  const show = () => {
    const at = shownView();
    drawing.style.transform = `translate(${at.x}px, ${at.y}px) scale(${at.scale})`;
    dots.style.backgroundSize = `${DOTS * at.scale}px ${DOTS * at.scale}px`;
    dots.style.backgroundPosition = `${at.x}px ${at.y}px`;
    amount.textContent = `${Math.round(at.scale * 100)}%`;
    drawing.onView?.(at);
    onShow();
  };
  // Pulled past where it can go, it springs back there.
  let springing = 0;
  const springBack = () => {
    if (!rubber || !view) return;
    const { x, y } = range(view.scale);
    const kept = { ...view, x: Math.min(x[1], Math.max(x[0], view.x)), y: Math.min(y[1], Math.max(y[0], view.y)) };
    if (kept.x === view.x && kept.y === view.y) return;
    holder.classList.add('springing');
    clearTimeout(springing);
    springing = setTimeout(() => holder.classList.remove('springing'), 320);
    view = kept;
    show();
    onChange(view);
  };
  let settle = 0;
  const moveTo = (next) => {
    holder.classList.remove('springing');
    view = next;
    moved = true;
    show();
    onChange(view);
  };
  const fit = () => {
    if (!holder.clientWidth) return;
    view = fitView(content, space(), minScale);
    show();
  };
  // Zoomed to `scale` about (x, y), past the limit or not.
  const scaleTo = (x, y) => (scale) => {
    view = zoomedAt(view, scale / view.scale, x, y, 0);
    moved = true;
    show();
  };
  const zoomBy = (factor) => {
    if (!view) fit();
    if (!view) return;
    const { x, y } = centre();
    const floor = least();
    if (factor < 1 && view.scale <= floor * 1.001) return bounce(view.scale, scaleTo(x, y), () => onChange(view));
    moveTo(zoomedAt(view, factor, x, y, floor));
    springBack();
  };
  // Pinched out past the limit: the scale asked for, and about where, until it springs back.
  let pulled = null;
  const settleZoom = () => {
    if (!pulled) return;
    const { x, y } = pulled;
    pulled = null;
    glide(view.scale, least(), scaleTo(x, y), () => onChange(view));
  };

  const controls = document.createElement('div');
  controls.className = 'canvas-controls';
  controls.append(
    button('−', 'Zoom out', () => zoomBy(1 / 1.25)),
    amount,
    button('+', 'Zoom in', () => zoomBy(1.25)),
    button('Fit', 'Fit it to the space', () => {
      moved = false;
      fit();
      onChange(null);
    }),
  );
  controls.addEventListener('pointerdown', (event) => event.stopPropagation());
  holder.append(controls);

  // Before it has shown anywhere, there's no view to move from: it's fitted first.
  const ready = () => {
    if (!view) fit();
    return Boolean(view);
  };
  holder.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !panFrom(event) || !ready()) return;
    const start = { x: event.clientX, y: event.clientY, view };
    let dragging = false;
    const onMove = (move) => {
      const dx = move.clientX - start.x;
      const dy = move.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < DRAG_FROM) return;
      if (!dragging) {
        // Only now, so that a click still reaches what's under it.
        dragging = true;
        holder.setPointerCapture(event.pointerId);
        holder.classList.add('panning');
      }
      moveTo({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
    };
    const onEnd = () => {
      holder.removeEventListener('pointermove', onMove);
      holder.removeEventListener('pointerup', onEnd);
      holder.removeEventListener('pointercancel', onEnd);
      holder.classList.remove('panning');
      springBack();
    };
    holder.addEventListener('pointermove', onMove);
    holder.addEventListener('pointerup', onEnd);
    holder.addEventListener('pointercancel', onEnd);
  });

  holder.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!ready()) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      settleZoom();
      springBack();
    }, SPRING_AFTER);
    if (!event.ctrlKey && !event.metaKey) return moveTo({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
    const box = holder.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const floor = least();
    const wanted = (pulled?.wanted ?? view.scale) * Math.exp(-event.deltaY * 0.01);
    if (wanted < floor) {
      pulled = { wanted, x, y };
      return scaleTo(x, y)(pastLeast(wanted, floor));
    }
    pulled = null;
    return moveTo(zoomedAt(view, wanted / view.scale, x, y, floor));
  }, { passive: false });

  // Stays fitted as the window changes, until the user has moved it themselves.
  new ResizeObserver(() => {
    if (!view || !moved) fit();
  }).observe(holder);
  if (saved) show();

  // Fits it now, for whatever needs to know where it will end up before the next frame.
  holder.ready = () => {
    if (!view) fit();
  };

  // Brings a part of the diagram to the middle, keeping the zoom.
  holder.centreOn = (part) => {
    if (!view) fit();
    if (!view) return;
    const from = drawing.getBoundingClientRect();
    const box = part.getBoundingClientRect();
    const x = (box.left + box.width / 2 - from.left) / view.scale;
    const y = (box.top + box.height / 2 - from.top) / view.scale;
    const middle = centre();
    moveTo({ ...view, x: middle.x - x * view.scale, y: middle.y - y * view.scale });
  };
  return holder;
}
