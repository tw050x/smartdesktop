// Where writing changed, along its scrollbar's track (the user's choice, as SmartDoc's review cards
// and comparison mark theirs): a short line for each change, green where words were added and red
// where they were removed (diff-marks.js), at its height in all there is to scroll through, so the
// changes out of sight can be found. Laid over the scrolling element, as its edge shadows are
// (scroll-shade.js), so it stays put as the content scrolls; the scrollbar under it still works.
// Removed on the left half of a mark and added on the right, so a change that does both shows both;
// `sides`: the two versions side by side (compare-view.js), the halves a little wider.

const KINDS = [['diff-removed', 'removed'], ['diff-added', 'added']];
const MIN_GAP = 3; // px: marks closer than this on the track are one

// Watches `scroller`, which must have a positioned parent, for as long as it's on the page.
export function markScrolling(scroller, { sides = false } = {}) {
  const strip = document.createElement('div');
  strip.className = `scroll-marks${sides ? ' sides' : ''}`;
  strip.setAttribute('aria-hidden', 'true');
  scroller.after(strip);
  let last = '';
  const update = () => {
    if (!scroller.isConnected) return;
    Object.assign(strip.style, {
      top: `${scroller.offsetTop}px`,
      left: `${scroller.offsetLeft}px`,
      width: `${scroller.offsetWidth}px`,
      height: `${scroller.offsetHeight}px`,
    });
    const { scrollHeight, clientHeight } = scroller;
    const scrolls = scrollHeight > clientHeight + 1;
    strip.hidden = !scrolls;
    if (!scrolls) return;
    // The track runs between the card's rounded corners (see .board-item ::-webkit-scrollbar-track).
    const inset = scroller.closest('.board-item') ? parseFloat(getComputedStyle(scroller).getPropertyValue('--card-radius')) || 0 : 0;
    const track = Math.max(1, clientHeight - 2 * inset);
    // A card at a side is drawn smaller (scaled): its boxes on screen are, its scrolling isn't.
    const box = scroller.getBoundingClientRect();
    const scale = scroller.offsetHeight ? box.height / scroller.offsetHeight : 1;
    const marks = [];
    for (const [className, kind] of KINDS) {
      const at = [];
      for (const el of scroller.querySelectorAll(`.${className}`)) {
        const within = (el.getBoundingClientRect().top - box.top) / scale + scroller.scrollTop;
        const y = Math.round(inset + (within / scrollHeight) * track);
        if (!at.some((other) => Math.abs(other - y) < MIN_GAP)) at.push(y);
      }
      marks.push(...at.map((y) => ({ y, kind })));
    }
    const key = JSON.stringify(marks);
    if (key === last) return;
    last = key;
    strip.replaceChildren(...marks.map(({ y, kind }) => {
      const mark = document.createElement('div');
      mark.className = `scroll-mark ${kind}`;
      mark.style.top = `${y}px`;
      return mark;
    }));
  };
  const sizes = new ResizeObserver(() => {
    if (!scroller.isConnected) {
      sizes.disconnect();
      return;
    }
    update();
  });
  sizes.observe(scroller);
  for (const child of scroller.children) sizes.observe(child);
  // Once laid out: on the next frame, or soon if frames aren't coming (a window not showing).
  requestAnimationFrame(update);
  setTimeout(update, 50);
  return update;
}
