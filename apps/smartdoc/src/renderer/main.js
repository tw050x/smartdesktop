import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { closeLeftSidebar, openLeftSidebar } from './icons.js';
import { clearPages, pageTexts, registerPage } from './anchors.js';
import { redraw, revealAnchors, setHovered, setMarks } from './overlays.js';
import { renderRecentCards } from './recent-cards.js';
import { createServerStatus } from './server-status.js';
import { createReviewPanel } from './review-panel.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const api = window.shortlistDock;
const { platform, openDroppedFile, openRecent, readRecent, onFullScreenChange } = api;
document.body.classList.add(`platform-${platform}`);
onFullScreenChange((isFullScreen) => {
  document.body.classList.toggle('full-screen', isFullScreen);
  placeDraftNav();
});
createServerStatus({ api });

// --- Review column -------------------------------------------------------------------------

const toggleReview = document.getElementById('toggle-review');
let reviewOpen = true;

function renderToggle() {
  document.body.classList.toggle('review-closed', !reviewOpen);
  toggleReview.innerHTML = reviewOpen ? closeLeftSidebar : openLeftSidebar;
  toggleReview.title = `${reviewOpen ? 'Close' : 'Open'} review`;
  toggleReview.setAttribute('aria-label', toggleReview.title);
  toggleReview.setAttribute('aria-expanded', String(reviewOpen));
}

function setReviewOpen(open) {
  reviewOpen = open;
  // A dragged width only lasts until the review is closed; it reopens at the default.
  if (!open) document.documentElement.style.removeProperty('--review-width');
  renderToggle();
}

toggleReview.addEventListener('click', () => setReviewOpen(!reviewOpen));
renderToggle();

// Dragging the review's inner edge sets its width, between 33% and 66% of the window (or
// less in a narrow window, where it leaves the PDF view its minimum; the same limits are
// applied in CSS when the window resizes). Past the maximum the edge rubber-bands and springs
// back on release. Below the minimum the edge (and the PDF view) still follows the pointer,
// but the card slides out straight away, so it's clear that letting go there closes the
// review; dragging back above the minimum slides it back in. A closed review keeps its
// handle at the window edge, so it can be dragged back out the same way. Double-clicking the
// handle splits the window evenly between the review and the PDF view, opening it if closed.
const REVIEW_MIN_SHARE = 0.33;
const REVIEW_MAX_SHARE = 0.66;
const DOCUMENT_MIN = 320;
const RUBBER_BAND = 48; // the most the edge can stretch past the maximum
const SNAP_MS = 180; // matches the .workspace transition
const reviewMax = () => Math.min(window.innerWidth * REVIEW_MAX_SHARE, window.innerWidth - DOCUMENT_MIN);
const reviewMin = () => Math.min(window.innerWidth * REVIEW_MIN_SHARE, reviewMax());
// Resistance that grows with distance: the edge follows less and less, approaching RUBBER_BAND.
const rubberBand = (overshoot) => RUBBER_BAND * (1 - 1 / (overshoot / RUBBER_BAND + 1));

function snap() {
  document.body.classList.add('snapping');
  clearTimeout(snap.timer);
  snap.timer = setTimeout(() => document.body.classList.remove('snapping'), SNAP_MS);
}

{
  const handle = document.querySelector('.resizer');
  const panel = handle.parentElement;
  const setWidth = (w) => document.documentElement.style.setProperty('--review-width', `${Math.round(w)}px`);
  const CLOSED_WIDTH = 14; // matches .review-closed .workspace

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    const startX = e.clientX;
    const wasOpen = reviewOpen;
    const startWidth = panel.getBoundingClientRect().width;
    // A closed review is dragged out from the window edge with its card still out of view.
    setWidth(startWidth);
    document.body.classList.add('resizing');
    let collapsed = !wasOpen;
    document.body.classList.toggle('review-closing', collapsed);
    document.body.classList.remove('review-closed');
    let raw = startWidth;

    const onMove = (m) => {
      raw = startWidth + m.clientX - startX;
      const max = reviewMax();
      const shouldCollapse = raw < reviewMin();
      if (shouldCollapse !== collapsed) {
        collapsed = shouldCollapse;
        document.body.classList.toggle('review-closing', collapsed);
      }
      setWidth(raw > max ? max + rubberBand(raw - max) : Math.max(CLOSED_WIDTH, raw));
    };
    // Ends on release, or whenever the handle loses the pointer (e.g. released outside the
    // window), so a drag can never be left half-finished.
    let ended = false;
    const onUp = () => {
      if (ended) return;
      ended = true;
      handle.classList.remove('active');
      document.body.classList.remove('resizing', 'review-closing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.removeEventListener('lostpointercapture', onUp);
      snap();
      if (collapsed) {
        setReviewOpen(false);
      } else {
        setWidth(Math.min(reviewMax(), raw));
        if (!wasOpen) setReviewOpen(true);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    handle.addEventListener('lostpointercapture', onUp);
  });

  handle.addEventListener('dblclick', () => {
    setWidth(Math.min(reviewMax(), window.innerWidth / 2));
    setReviewOpen(true);
  });
}

// --- PDF view ----------------------------------------------------------------------------

const documentEl = document.getElementById('document');
const pagesEl = document.getElementById('pages');
const PAGE_GUTTER = 10; // the .pages side padding (var(--card-gap) on the right only)
// Pages are drawn once at this scale, then shrunk with CSS to fit the space available, so
// resizing the window or the review never needs a redraw.
const RENDER_SCALE = 1.5;

let loading = 0; // newest draft wins if drafts are switched quickly

async function showPdf(data, { docId, draftId }) {
  const ticket = ++loading;
  const pdf = await getDocument({ data }).promise;
  if (ticket !== loading) return;
  pagesEl.replaceChildren();
  clearPages();
  setHasDocument(true);

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const ratio = window.devicePixelRatio || 1;

    // .page takes the fitted size in the layout; .page-content holds the page at its drawn
    // size and is scaled down to match, keeping the canvas and text layer aligned.
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.dataset.width = String(viewport.width);
    pageEl.dataset.height = String(viewport.height);

    const contentEl = document.createElement('div');
    contentEl.className = 'page-content';
    contentEl.style.width = `${viewport.width}px`;
    contentEl.style.height = `${viewport.height}px`;
    contentEl.style.setProperty('--total-scale-factor', String(RENDER_SCALE));

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);

    const textLayerEl = document.createElement('div');
    textLayerEl.className = 'textLayer';

    contentEl.append(canvas, textLayerEl);
    pageEl.append(contentEl);
    pagesEl.append(pageEl);
    fitPage(pageEl);

    await page.render({ canvas, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
    const textContent = await page.getTextContent();
    const textLayer = new TextLayer({ textContentSource: textContent, container: textLayerEl, viewport });
    await textLayer.render();
    if (ticket !== loading) return;
    keepSelectionSteady(textLayerEl);
    registerPage(n, textContent.items, textLayer.textDivs, contentEl);
  }
  // The app needs the page texts to place the AI's quotes and to give the AI the document.
  await api.reportPageTexts(docId, draftId, pageTexts());
  redraw();
}

function fitPage(pageEl) {
  const available = documentEl.clientWidth - PAGE_GUTTER;
  const k = Math.max(0, Math.min(1, available / Number(pageEl.dataset.width)));
  pageEl.style.width = `${Number(pageEl.dataset.width) * k}px`;
  pageEl.style.height = `${Number(pageEl.dataset.height) * k}px`;
  pageEl.firstElementChild.style.transform = `scale(${k})`;
}

new ResizeObserver(() => pagesEl.querySelectorAll('.page').forEach(fitPage)).observe(documentEl);

// --- Scrolling ---------------------------------------------------------------------------
// The PDF view and the review use a custom scrollbar: the native one is hidden, and this
// one is drawn over the scrolling area's right edge with no visible track. In the PDF view,
// loaded pages scroll the PDF view itself; the empty view doesn't scroll.

const THUMB_MIN = 32;

// `scrollbarEl` holds a `.scrollbar-thumb`; `scroller()` is the element it scrolls right now;
// `watch` lists the elements whose size changes the scroll range.
function customScrollbar({ scrollbarEl, scrollers, scroller, watch }) {
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

// Only an open document scrolls; the empty pages shown without one don't.
const updateScrollUi = customScrollbar({
  scrollbarEl: document.getElementById('scrollbar'),
  scrollers: [documentEl],
  scroller: () => documentEl,
  watch: [documentEl, pagesEl],
});
const reviewScroll = document.getElementById('review-scroll');
customScrollbar({
  scrollbarEl: reviewScroll.parentElement.querySelector('.scrollbar'),
  scrollers: [reviewScroll],
  scroller: () => reviewScroll,
  watch: [reviewScroll, reviewScroll.firstElementChild],
});

// The empty view shows the most recent documents as cards with page previews.
api.onRecentDocuments((documents) => renderRecentCards({
  documents,
  list: document.getElementById('recent-list'),
  none: document.getElementById('recent-none'),
  readRecent,
  openRecent,
}));

// --- Document, draft and review ----------------------------------------------------------
// The main process owns the document and its drafts and reviews (it drives the menu and the MCP
// server); the window shows them and sends the user's decisions back.

const draftNav = document.getElementById('draft-nav');
const draftLabel = document.getElementById('draft-label');
const draftPrev = document.getElementById('draft-prev');
const draftNext = document.getElementById('draft-next');
draftPrev.addEventListener('click', () => api.stepDraft(-1));
draftNext.addEventListener('click', () => api.stepDraft(1));

// The draft controls are centred over the PDF view rather than the window. When there isn't
// room for them there, within the PDF view and clear of the other top-bar items, the label is
// hidden first, then the arrows too.
const topBar = document.querySelector('.top-bar');
const topBarStart = document.querySelector('.top-bar-start');
const topBarEnd = document.querySelector('.top-bar-end');
const DRAFT_NAV_GAP = 8; // the least space kept between the controls and their neighbours

function placeDraftNav() {
  if (draftNav.hidden) return;
  const view = documentEl.getBoundingClientRect();
  const left = Math.max(view.left, topBarStart.getBoundingClientRect().right + DRAFT_NAV_GAP);
  const right = Math.min(view.right, topBarEnd.getBoundingClientRect().left - DRAFT_NAV_GAP);
  const centre = view.left + view.width / 2;
  const room = 2 * Math.min(centre - left, right - centre);
  draftNav.style.left = `${centre - topBar.getBoundingClientRect().left}px`;
  draftNav.classList.remove('compact', 'collapsed');
  if (draftNav.offsetWidth > room) draftNav.classList.add('compact');
  if (draftNav.offsetWidth > room) draftNav.classList.add('collapsed');
}

new ResizeObserver(placeDraftNav).observe(documentEl);
new ResizeObserver(placeDraftNav).observe(topBarEnd);

const reviewPanel = createReviewPanel({
  container: document.getElementById('review-panel'),
  scroller: reviewScroll,
  api,
  onReveal: (anchors) => revealAnchors(anchors, documentEl),
  onHover: setHovered,
});

// The user's requests and the AI's annotations are drawn on the page.
function showReview(review) {
  reviewPanel.update({ review });
  setMarks(review ? [
    ...review.requests.map((r) => ({ anchors: r.anchors, className: `mark-request mark-${r.kind}`, title: r.note })),
    ...review.annotations.map((a) => ({ anchors: a.anchors, className: `mark-annotation mark-${a.style}`, title: a.note })),
  ] : []);
}

api.onDraftOpened(async ({ document: doc, draft, pdf, review }) => {
  draftNav.hidden = false;
  draftLabel.textContent = draft.isOriginal ? 'Original' : `Draft ${draft.number} of ${draft.total}`;
  draftLabel.title = draft.summary ?? (draft.isOriginal ? `${doc.name}, as imported` : '');
  draftPrev.disabled = draft.number === 0;
  draftNext.disabled = draft.number === draft.total;
  placeDraftNav();
  reviewPanel.update({ hasDocument: true });
  showReview(review);
  reviewPanel.minimiseAll();
  documentEl.scrollTop = 0;
  await showPdf(pdf, { docId: doc.id, draftId: draft.id });
  updateScrollUi();
});

api.onDocumentClosed(() => {
  loading++;
  draftNav.hidden = true;
  clearPdf();
  clearPages();
  reviewPanel.update({ hasDocument: false, review: null });
  updateScrollUi();
});

api.onReview(showReview);

// As in pdf.js's own viewer: while selecting, an unselectable layer fills the gaps between the
// text, so a cursor between lines doesn't make the selection jump to text further down the page
// (the stylesheet from pdf_viewer.css places .endOfContent and stretches it under .selecting).
function keepSelectionSteady(textLayerEl) {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  textLayerEl.append(end);
  textLayerEl.addEventListener('mousedown', () => textLayerEl.classList.add('selecting'));
}
const stopSelecting = () => {
  for (const layer of document.querySelectorAll('.textLayer.selecting')) layer.classList.remove('selecting');
};
document.addEventListener('pointerup', stopSelecting);
window.addEventListener('blur', stopSelecting);

// Select All selects the document's text when working in the viewer, a field's text when typing,
// and nothing anywhere else (the rest of the app isn't selectable).
let inViewer = false;
document.addEventListener('pointerdown', (e) => { inViewer = documentEl.contains(e.target); }, true);
document.addEventListener('focusin', (e) => { if (!documentEl.contains(e.target)) inViewer = false; });
document.addEventListener('keydown', (e) => {
  const selectAll = e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
  if (!selectAll || document.activeElement?.matches('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  if (!inViewer || !pagesEl.querySelector('.textLayer')) {
    getSelection().removeAllRanges();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(pagesEl);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
});

function clearPdf() {
  pagesEl.replaceChildren();
  setHasDocument(false);
}

// The review column appears and disappears with the document in one step, without the
// column's resize animation (which would slide the view sideways).
function setHasDocument(on) {
  if (document.body.classList.contains('has-document') === on) return;
  document.body.classList.add('switching-document');
  document.body.classList.toggle('has-document', on);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('switching-document')));
}

documentEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  documentEl.classList.add('dragging');
});
documentEl.addEventListener('dragleave', (e) => {
  // Moving between the pages fires dragleave too; only clear when leaving the view itself.
  if (!documentEl.contains(e.relatedTarget)) documentEl.classList.remove('dragging');
});
documentEl.addEventListener('drop', (e) => {
  e.preventDefault();
  documentEl.classList.remove('dragging');
  const file = [...e.dataTransfer.files].find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (file) openDroppedFile(file);
});
