// Opening a card full screen, or closing it again: everything around the content goes, the content
// itself grows or shrinks into place, and the rest comes back. It's the real diagram or page that
// moves, in both views the same thing at a different size, so nothing inside it shifts.

const LEAVE_MS = 140;
const MORPH_MS = 380;
const RETURN_MS = 180;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const AROUND = '.sheet-head, .focus-side, .focus-lines, .focus-resizer, .pane-head, .full-actions, .canvas-controls, .canvas-dots';

const boxOf = ({ left, top, width, height }) => ({ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

function partsOf(root) {
  const full = Boolean(root.querySelector('.focus-full'));
  const card = root.querySelector('.focus-card');
  const body = card.querySelector('.focus-body');
  const sheet = body.querySelector('.document-sheet');
  return { card, body, sheet, surface: full || !sheet ? body : card, moving: body.querySelector('svg.diagram-svg, img.item-image') ?? sheet ?? body.querySelector('.item-table-holder') };
}
// Beside other cards the window scrolls the content. Full screen, the content scrolls itself.
const scrollerOf = (body) => (body.closest('.focus-stage') ? body.closest('.content') : body);
// An element's box, only as far as it's in view: it can be far taller than the window.
function inView(element, scroller) {
  const { left, width, top, bottom } = element.getBoundingClientRect();
  const area = scroller.getBoundingClientRect();
  const seenTop = Math.max(top, area.top);
  return { left, width, top: seenTop, right: left + width, bottom: Math.min(bottom, area.bottom), height: Math.min(bottom, area.bottom) - seenTop };
}
const blocksIn = (sheet) => (sheet ? [...sheet.querySelectorAll('.markdown > *')] : []);

function surfaceLook(element, scroller) {
  const style = getComputedStyle(element);
  return {
    ...boxOf(inView(element, scroller)),
    backgroundColor: style.backgroundColor,
    borderColor: parseFloat(style.borderTopWidth) ? style.borderTopColor : 'transparent',
    borderRadius: style.borderTopLeftRadius,
    boxShadow: style.boxShadow,
  };
}

// Notes how things are, before anything moves.
export function captureMorph(root) {
  const { body, sheet, surface, moving } = partsOf(root);
  const scroller = scrollerOf(body);
  const space = inView(body, scroller);
  // Where you're reading: the first block in view, and where it sits, kept in the new view. At the
  // top there's no place to keep: the new view starts at its top too.
  const blocks = blocksIn(sheet);
  const index = scroller.scrollTop > 0 ? blocks.findIndex((block) => block.getBoundingClientRect().bottom > space.top) : -1;
  return {
    surface: surfaceLook(surface, scroller),
    space,
    moving: moving?.getBoundingClientRect(),
    reading: index >= 0 ? { index, y: blocks[index].getBoundingClientRect().top - space.top } : null,
    scroll: scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight),
  };
}

// Everything around the content goes. Nothing moves, so the content stays exactly where it is.
export function leaveAround(root) {
  const running = [...root.querySelectorAll(AROUND)].map((one) => one.animate([{ opacity: getComputedStyle(one).opacity }, { opacity: 0 }], { duration: LEAVE_MS, fill: 'forwards' }));
  return Promise.allSettled(running.map((one) => one.finished));
}

// The new view is on the page: turns what was captured into it.
export function morphInto(root, from) {
  const { body, sheet, surface, moving } = partsOf(root);
  root.querySelector('.diagram-canvas')?.ready?.();
  const block = from.reading && blocksIn(sheet)[from.reading.index];
  const scroller = scrollerOf(body);
  if (block) scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - from.reading.y;
  else scroller.scrollTop = from.scroll * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const scrolled = scroller.scrollTop;

  const target = surfaceLook(surface, scroller);
  const end = moving?.getBoundingClientRect();
  root.classList.add('morphing');
  const options = { duration: MORPH_MS, easing: EASE, fill: 'both' };
  const backing = document.createElement('div');
  backing.className = 'morph-surface';
  root.append(backing);
  const running = [backing.animate([from.surface, target], options)];

  let finish = () => {};
  if (moving && from.moving) {
    // While it moves, it isn't held by the scrolling space, so it's measured from where it then sits.
    root.classList.add('morph-moving');
    const kept = moving.style.transform;
    moving.style.transform = 'none';
    const home = moving.getBoundingClientRect();
    moving.style.transform = kept;
    moving.style.transformOrigin = '0 0';
    // A zoomed element's own lengths are zoomed too.
    const zoom = parseFloat(getComputedStyle(moving).zoom) || 1;
    const place = (box) => `translate(${(box.left - home.left) / zoom}px, ${(box.top - home.top) / zoom}px) scale(${box.width / home.width})`;
    const move = moving.animate([{ transform: place(from.moving) }, { transform: place(end) }], options);
    running.push(move);
    // What can be seen runs from the old space to the new, so it never covers the bars around it.
    const now = body.getBoundingClientRect();
    const was = from.space;
    const reveal = body.animate([{ clipPath: `inset(${was.top - now.top}px ${now.right - was.right}px ${now.bottom - was.bottom}px ${was.left - now.left}px)` }, { clipPath: 'inset(0px 0px 0px 0px)' }], options);
    running.push(reveal);
    finish = () => {
      root.classList.remove('morph-moving');
      move.cancel();
      reveal.cancel();
      if (!kept) moving.style.removeProperty('transform-origin');
      scroller.scrollTop = scrolled;
    };
  }

  return Promise.allSettled(running.map((one) => one.finished)).then(() => {
    if (!root.isConnected) return;
    finish();
    root.classList.remove('morphing');
    backing.remove();
    for (const one of root.querySelectorAll(AROUND)) one.animate([{ opacity: 0 }, { opacity: getComputedStyle(one).opacity }], { duration: RETURN_MS });
  });
}
