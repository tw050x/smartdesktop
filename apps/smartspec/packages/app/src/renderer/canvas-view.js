// A diagram as a virtual canvas, in its card or full screen: drag to move around, pinch or Cmd
// and scroll to zoom, scroll to move. It starts fitted to the space. Where you've moved to isn't
// stored with the schema, as positions are never data.

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const MARGIN = 24;
const DRAG_FROM = 4; // px: less than this is a click, so links in the diagram still work
const DOTS = 24;
const PIN_GAP = 8;

const limited = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

// The view showing all of a diagram, centred, without enlarging it.
export function fitView(content, space) {
  const scale = limited(Math.min(1, (space.width - 2 * MARGIN) / content.width, (space.height - 2 * MARGIN) / content.height));
  return { x: (space.width - content.width * scale) / 2, y: (space.height - content.height * scale) / 2, scale };
}

// The view zoomed by `factor`, keeping what's at (x, y) in the same place on screen.
export function zoomedAt(view, factor, x, y) {
  const scale = limited(view.scale * factor);
  const kept = scale / view.scale;
  return { scale, x: x - (x - view.x) * kept, y: y - (y - view.y) * kept };
}

// How far to move a sequence diagram's heads down, within the drawing, to keep them on the canvas at
// this view: none until they'd go off the top, and no further than the end of the diagram.
export function pinOffset(view, { top, bottom, height }) {
  const wanted = (PIN_GAP - view.y) / view.scale - top;
  return Math.max(0, Math.min(wanted, height - bottom));
}

// Turns a diagram's holder into a canvas. `saved` is a view to return to, `onChange` hears of each
// one the user moves to, and `onShow` of every change on screen.
export function makeCanvas(holder, { saved = null, onChange = () => {}, onShow = () => {} } = {}) {
  const drawing = holder.querySelector('svg');
  const content = { width: Number(drawing.getAttribute('width')), height: Number(drawing.getAttribute('height')) };
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
  const amount = document.createElement('span');
  amount.className = 'canvas-amount';
  const show = () => {
    drawing.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    dots.style.backgroundSize = `${DOTS * view.scale}px ${DOTS * view.scale}px`;
    dots.style.backgroundPosition = `${view.x}px ${view.y}px`;
    amount.textContent = `${Math.round(view.scale * 100)}%`;
    drawing.onView?.(view);
    onShow();
  };
  const moveTo = (next) => {
    view = next;
    moved = true;
    show();
    onChange(view);
  };
  const fit = () => {
    if (!holder.clientWidth) return;
    view = fitView(content, space());
    show();
  };
  const zoomBy = (factor) => {
    const { x, y } = centre();
    moveTo(zoomedAt(view, factor, x, y));
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

  holder.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
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
    };
    holder.addEventListener('pointermove', onMove);
    holder.addEventListener('pointerup', onEnd);
    holder.addEventListener('pointercancel', onEnd);
  });

  holder.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!event.ctrlKey && !event.metaKey) return moveTo({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
    const box = holder.getBoundingClientRect();
    return moveTo(zoomedAt(view, Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top));
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
