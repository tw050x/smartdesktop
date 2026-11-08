// An inner shadow along each edge where an item's content goes on out of sight, so it's clear there's
// more to scroll to. The shadow is a layer laid over the scrolling element, not part of it, so it
// stays put as the content scrolls and nothing in the content (a page, a row) can cover it.

const EDGE = 1; // px: closer than this to the end counts as at the end

// Watches `scroller`, which must have a positioned parent, for as long as it's on the page.
export function shadeScrolling(scroller) {
  const shade = document.createElement('div');
  shade.className = 'scroll-shade';
  shade.setAttribute('aria-hidden', 'true');
  scroller.after(shade);
  const update = () => {
    const { scrollTop, scrollLeft, scrollWidth, scrollHeight, clientWidth, clientHeight } = scroller;
    Object.assign(shade.style, {
      top: `${scroller.offsetTop}px`,
      left: `${scroller.offsetLeft}px`,
      width: `${scroller.offsetWidth}px`,
      height: `${scroller.offsetHeight}px`,
    });
    const edges = [
      scrollTop > EDGE && '0 16px',
      scrollTop + clientHeight < scrollHeight - EDGE && '0 -16px',
      scrollLeft > EDGE && '16px 0',
      scrollLeft + clientWidth < scrollWidth - EDGE && '-16px 0',
    ].filter(Boolean);
    shade.style.boxShadow = edges.map((offset) => `inset ${offset} 14px -10px var(--shade)`).join(', ');
  };
  scroller.addEventListener('scroll', update, { passive: true });
  // Its size, and what's in it, change as the item is resized and its content is drawn.
  const sizes = new ResizeObserver(() => {
    if (!scroller.isConnected) {
      sizes.disconnect();
      return;
    }
    update();
  });
  sizes.observe(scroller);
  for (const child of scroller.children) sizes.observe(child);
  update();
}
