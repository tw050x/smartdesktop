// The app's own scrollbar, used wherever something scrolls in the window (the pages, the comparison,
// the chat): the native one is hidden, and this one is a thin thumb drawn over the scrolling area's
// right edge with no track, shown only when there's something to scroll. Hovering its strip for a
// moment widens the thumb; it narrows on leaving, and stays wide while dragged (see .scrollbar).

const THUMB_MIN = 32;

// `scrollbarEl` holds a `.scrollbar-thumb`; `scroller()` is the element it scrolls right now;
// `watch` lists the elements whose size changes the scroll range.
export function customScrollbar({ scrollbarEl, scrollers, scroller, watch }) {
  const thumbEl = scrollbarEl.querySelector('.scrollbar-thumb');

  function geometry(el) {
    const track = scrollbarEl.clientHeight;
    const height = Math.max(THUMB_MIN, (el.clientHeight / el.scrollHeight) * track);
    const range = el.scrollHeight - el.clientHeight;
    return { track, height, range, top: range > 0 ? (el.scrollTop / range) * (track - height) : 0 };
  }

  function update() {
    const el = scroller();
    const { height, range, top } = geometry(el);
    scrollbarEl.classList.toggle('scrollable', range > 0);
    thumbEl.style.height = `${height}px`;
    thumbEl.style.transform = `translateY(${top}px)`;
  }

  for (const el of scrollers) el.addEventListener('scroll', update, { passive: true });
  const observer = new ResizeObserver(update);
  for (const el of watch) observer.observe(el);
  // Content that changes height without resizing a watched element (e.g. a list re-rendered).
  for (const el of scrollers) new MutationObserver(update).observe(el, { childList: true, subtree: true });

  // Dragging the thumb scrolls proportionally; clicking the track jumps so the thumb centres on
  // the click; the wheel over the scrollbar scrolls as usual.
  thumbEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = scroller();
    const { track, height, range } = geometry(el);
    const startY = e.clientY;
    const startScroll = el.scrollTop;
    thumbEl.setPointerCapture(e.pointerId);
    scrollbarEl.classList.add('dragging');
    const onMove = (m) => {
      el.scrollTop = startScroll + ((m.clientY - startY) * range) / Math.max(1, track - height);
    };
    const onEnd = () => {
      scrollbarEl.classList.remove('dragging');
      thumbEl.removeEventListener('pointermove', onMove);
      thumbEl.removeEventListener('lostpointercapture', onEnd);
    };
    thumbEl.addEventListener('pointermove', onMove);
    thumbEl.addEventListener('lostpointercapture', onEnd);
  });
  scrollbarEl.addEventListener('pointerdown', (e) => {
    const el = scroller();
    const { track, height, range } = geometry(el);
    const y = e.clientY - scrollbarEl.getBoundingClientRect().top - height / 2;
    el.scrollTo({ top: (y / Math.max(1, track - height)) * range, behavior: 'smooth' });
  });
  scrollbarEl.addEventListener('wheel', (e) => scroller().scrollBy(e.deltaX, e.deltaY), { passive: true });
  return update;
}
