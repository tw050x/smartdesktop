import { bounce, glide, pastLeast } from './canvas-view.js';
import { addResizers } from './resizers.js';

// Writing shows as a page: an A4 sheet laid out at one fixed size, in a card or full screen, and
// scaled to fit the space it's in. As its size on screen is all that changes, its lines never rewrap.
// In a card it lies on a surface of its own, as wide as the card, so the card's handles resize it too,
// until the user zooms it with its controls or by pinching (or Cmd and scrolling), out as far as one
// whole page; Fit goes back to filling the card. Full screen, it can be dragged bigger or smaller by the handles at its edges, even
// past A4's own size. That size is kept for every page on this computer, as a convenience.

export const PAGE_WIDTH = 794;
export const PAGE_HEIGHT = 1123;
const SMALLEST_PAGE = 300;
const STORED_WIDTH = 'page-width';
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const STEP = 1.25;
const SPRING_AFTER = 160; // ms after the last pinch before a page pinched past its limit springs back

// A zoom changed by `factor`, within how far a page zooms either way: out no further than `least`.
export const zoomPage = (zoom, factor, least = MIN_ZOOM) => Math.min(MAX_ZOOM, Math.max(Math.min(least, MAX_ZOOM), zoom * factor));

// The furthest out a page in a card zooms: one whole page in view, as wide as the card or as tall,
// whichever is smaller. Writing that runs to more pages is scrolled through.
export const leastPageZoom = (width, height) => Math.max(MIN_ZOOM, Math.min(width / PAGE_WIDTH, height / PAGE_HEIGHT));

// The zoom chosen for a page in a card (by its body's data-page), for as long as the app is open: it
// isn't stored, as positions are never data.
const cardZooms = new Map();

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
  // In a card it fills the card, however wide that's been dragged, so the lines reach it, unless the
  // user has zoomed it.
  const space = spaceIn(body);
  const zoomed = cardZooms.get(body.dataset.page);
  const wanted = body.closest('.focus-full') ? storedWidth() : space;
  body.style.setProperty('--page-zoom', String(zoomed && !body.closest('.focus-full') ? zoomed : pageZoom(space, wanted)));
}

// In a card: zoom controls in its corner, and pinching (or Cmd and scrolling) over the page. Returns
// what shows the zoom once it has changed some other way.
function addZoom(body) {
  const frame = body.parentElement;
  const sheet = body.querySelector('.document-sheet');
  const zoom = () => parseFloat(body.style.getPropertyValue('--page-zoom')) || 1;
  const least = () => {
    const style = getComputedStyle(body);
    return leastPageZoom(spaceIn(body), body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  };
  const amount = document.createElement('span');
  amount.className = 'canvas-amount';
  const shown = () => { amount.textContent = `${Math.round(zoom() * 100)}%`; };

  // Zooms to `next`, keeping what's at (x, y) on screen where it is (the middle unless given).
  const zoomTo = (next, x, y) => {
    if (!sheet) return;
    const box = body.getBoundingClientRect();
    const scale = box.width / body.offsetWidth || 1; // an item at a side is scaled down as a whole
    x ??= box.left + box.width / 2;
    y ??= box.top + box.height / 2;
    const before = sheet.getBoundingClientRect();
    const kept = next / zoom();
    body.style.setProperty('--page-zoom', String(next));
    cardZooms.set(body.dataset.page, next);
    const after = sheet.getBoundingClientRect();
    const left = (after.left - box.left) / scale + body.scrollLeft;
    const top = (after.top - box.top) / scale + body.scrollTop;
    body.scrollLeft = left + ((x - before.left) / scale) * kept - (x - box.left) / scale;
    body.scrollTop = top + ((y - before.top) / scale) * kept - (y - box.top) / scale;
    shown();
  };

  const button = (label, name, run) => {
    const element = document.createElement('button');
    Object.assign(element, { type: 'button', textContent: label, title: name, onclick: run });
    element.setAttribute('aria-label', name);
    return element;
  };
  // Zooming out at the limit gives a little and springs back, as a canvas does (see pastLeast).
  const zoomOut = () => {
    const floor = least();
    if (zoom() <= floor * 1.001) return bounce(zoom(), (next) => zoomTo(next));
    zoomTo(zoomPage(zoom(), 1 / STEP, floor));
  };
  let pulled = null;
  let settle = 0;
  const settleZoom = () => {
    if (!pulled) return;
    const { x, y } = pulled;
    pulled = null;
    glide(zoom(), least(), (next) => zoomTo(next, x, y));
  };

  const controls = document.createElement('div');
  controls.className = 'canvas-controls page-controls';
  controls.append(
    button('−', 'Zoom out', zoomOut),
    amount,
    button('+', 'Zoom in', () => zoomTo(zoomPage(zoom(), STEP, least()))),
    button('Fit', 'Fit it to the card', () => {
      cardZooms.delete(body.dataset.page);
      fitPage(body);
      shown();
    }),
  );
  // Pressing the controls never picks up or comments on the item.
  controls.addEventListener('pointerdown', (event) => event.stopPropagation());
  frame.append(controls);

  // A trackpad's pinch arrives as a wheel with the Control key.
  body.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const floor = least();
    const wanted = (pulled?.wanted ?? zoom()) * Math.exp(-event.deltaY * 0.01);
    clearTimeout(settle);
    if (wanted < floor) {
      pulled = { wanted, x: event.clientX, y: event.clientY };
      zoomTo(pastLeast(wanted, floor), event.clientX, event.clientY);
      settle = setTimeout(settleZoom, SPRING_AFTER);
      return;
    }
    pulled = null;
    zoomTo(zoomPage(wanted, 1, floor), event.clientX, event.clientY);
  }, { passive: false });
  shown();
  return shown;
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
  // A page on an overview, as in an embedded schematic's, stays at the overview's size.
  if (body.pageWatched || body.closest('.overview-item')) return;
  body.pageWatched = true;
  fitPage(body);
  const full = Boolean(body.closest('.focus-full'));
  const place = full ? addPageHandles(body) : () => {};
  const shown = full ? () => {} : addZoom(body);
  place();
  new ResizeObserver(() => {
    if (document.body.classList.contains('focus-resizing')) return;
    fitPage(body);
    place();
    shown();
  }).observe(body);
}
