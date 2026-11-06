import { addResizers } from './resizers.js';

// Writing shows as a page: an A4 sheet laid out at one fixed size, in a card or full screen, and
// scaled to fit the space it's in. As its size on screen is all that changes, its lines never rewrap.
// In a card it fills the card, so the card's handles resize it too. Full screen, it can be dragged
// bigger or smaller by the handles at its edges, even past A4's own size. That size is kept for every
// page on this computer, as a convenience.

export const PAGE_WIDTH = 794;
export const PAGE_HEIGHT = 1123;
const SMALLEST_PAGE = 300;
const STORED_WIDTH = 'page-width';

// The scale for a page in this much space: as wide as it fits, up to its own size, or at the width
// asked for, within the space.
export const pageZoom = (space, wanted = null) => Math.max(0.1, wanted ? Math.min(space, wanted) / PAGE_WIDTH : Math.min(1, space / PAGE_WIDTH));

function storedWidth() {
  try {
    return Number(localStorage.getItem(STORED_WIDTH)) || null;
  } catch {
    return null;
  }
}
function rememberWidth(width) {
  try {
    if (width) localStorage.setItem(STORED_WIDTH, String(Math.round(width)));
    else localStorage.removeItem(STORED_WIDTH);
  } catch {}
}

function spaceIn(body) {
  const style = getComputedStyle(body);
  return body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

export function fitPage(body) {
  // In a card it fills the card, however wide that's been dragged, so the lines reach it.
  const space = spaceIn(body);
  const wanted = body.closest('.focus-full') ? storedWidth() : space;
  body.style.setProperty('--page-zoom', String(pageZoom(space, wanted)));
}

// Full screen: the handles sit outside the page's edges, not moving as the writing scrolls.
function addPageHandles(body) {
  const card = body.closest('.focus-card');
  const zoom = () => parseFloat(body.style.getPropertyValue('--page-zoom')) || 1;
  const place = () => {
    // Worked out, not measured: an animation may be carrying the page there, and the handles belong
    // where it will be. It's always centred.
    const box = card.getBoundingClientRect();
    const space = body.getBoundingClientRect();
    const middle = space.left + body.clientWidth / 2;
    const width = PAGE_WIDTH * zoom();
    const page = { left: middle - width / 2, right: middle + width / 2 };
    // Short of the window's edge and any scrollbar, which have to stay usable.
    const leftWidth = Math.min(48, Math.max(0, page.left - space.left));
    const rightWidth = Math.min(48, Math.max(0, space.left + body.clientWidth - page.right));
    Object.assign(handles[0].style, { left: `${page.left - box.left - leftWidth}px`, width: `${leftWidth}px` });
    Object.assign(handles[1].style, { left: `${page.right - box.left}px`, right: 'auto', width: `${rightWidth}px` });
  };
  // Keeping the same part of the writing in view, as the page's height changes with its width.
  const show = (width) => {
    const before = zoom();
    const next = Math.max(0.1, width / PAGE_WIDTH);
    body.style.setProperty('--page-zoom', String(next));
    body.scrollTop *= next / before;
    place();
  };
  const handles = addResizers(card, {
    name: 'page',
    className: 'page-resizer',
    width: () => PAGE_WIDTH * zoom(),
    limits: () => [SMALLEST_PAGE, Math.max(SMALLEST_PAGE, spaceIn(body))],
    show,
    keep: rememberWidth,
    reset: () => {
      rememberWidth(null);
      show(pageZoom(spaceIn(body)) * PAGE_WIDTH);
    },
  });
  for (const handle of handles) handle.addEventListener('wheel', (event) => body.scrollBy(event.deltaX, event.deltaY), { passive: true });
  return place;
}

export function watchPage(body) {
  fitPage(body);
  const place = body.closest('.focus-full') ? addPageHandles(body) : () => {};
  place();
  new ResizeObserver(() => {
    if (document.body.classList.contains('focus-resizing')) return;
    fitPage(body);
    place();
  }).observe(body);
}
