import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { closeLeftSidebar, closeRightSidebar, openLeftSidebar, openRightSidebar } from './icons.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const { platform, openDroppedFile, onFileOpened, onFileClosed, onFullScreenChange } = window.employmentShortList;
document.body.classList.add(`platform-${platform}`);
onFullScreenChange((isFullScreen) => document.body.classList.toggle('full-screen', isFullScreen));

// --- Sidebars ----------------------------------------------------------------------------

const sidebars = {
  left: { button: document.getElementById('toggle-left'), open: true, icons: [openLeftSidebar, closeLeftSidebar], label: 'left sidebar' },
  right: { button: document.getElementById('toggle-right'), open: true, icons: [openRightSidebar, closeRightSidebar], label: 'right sidebar' },
};

function renderToggle(side) {
  const s = sidebars[side];
  document.body.classList.toggle(`${side}-closed`, !s.open);
  s.button.innerHTML = s.open ? s.icons[1] : s.icons[0];
  s.button.title = `${s.open ? 'Close' : 'Open'} ${s.label}`;
  s.button.setAttribute('aria-label', s.button.title);
  s.button.setAttribute('aria-expanded', String(s.open));
}

function setSidebarOpen(side, open) {
  sidebars[side].open = open;
  // A dragged width only lasts until the sidebar is closed; it reopens at the default.
  if (!open) document.documentElement.style.removeProperty(`--sidebar-${side}-width`);
  renderToggle(side);
}

for (const side of Object.keys(sidebars)) {
  sidebars[side].button.addEventListener('click', () => setSidebarOpen(side, !sidebars[side].open));
  renderToggle(side);
}

// Dragging a sidebar's inner edge sets its width. Both sidebars share the same limits: the
// maximum is 520px, or less in a narrow window, where each gets at most half of what's left
// after the PDF view's minimum (the same cap is applied in CSS when the window shrinks).
// Past either limit the edge rubber-bands and springs back on release; dragging far enough
// past the minimum collapses the sidebar, and releasing there closes it. A closed sidebar
// keeps its handle at the window edge, so it can be dragged back out the same way.
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const DOCUMENT_MIN = 320;
const RUBBER_BAND = 48; // the most the edge can stretch past a limit
const CLOSE_DISTANCE = 72; // how far past the minimum the pointer must go to close
const SNAP_MS = 180; // matches the .workspace transition
const sidebarMax = () => Math.min(SIDEBAR_MAX, (window.innerWidth - DOCUMENT_MIN) / 2);
// Resistance that grows with distance: the edge follows less and less, approaching RUBBER_BAND.
const rubberBand = (overshoot) => RUBBER_BAND * (1 - 1 / (overshoot / RUBBER_BAND + 1));

function snap() {
  document.body.classList.add('snapping');
  clearTimeout(snap.timer);
  snap.timer = setTimeout(() => document.body.classList.remove('snapping'), SNAP_MS);
}

for (const handle of document.querySelectorAll('.resizer')) {
  const side = handle.dataset.side;
  const panel = handle.parentElement;
  const setWidth = (w) => document.documentElement.style.setProperty(`--sidebar-${side}-width`, `${Math.round(w)}px`);

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const wasOpen = sidebars[side].open;
    const startWidth = wasOpen ? panel.getBoundingClientRect().width : 0;
    let collapsed = !wasOpen;
    let raw = startWidth;

    const onMove = (m) => {
      raw = startWidth + (side === 'left' ? m.clientX - startX : startX - m.clientX);
      const max = sidebarMax();
      const shouldCollapse = raw < SIDEBAR_MIN - CLOSE_DISTANCE;
      if (shouldCollapse !== collapsed) {
        collapsed = shouldCollapse;
        snap();
        document.body.classList.toggle(`${side}-closed`, collapsed);
      }
      if (collapsed) return;
      if (raw > max) setWidth(max + rubberBand(raw - max));
      else if (raw < SIDEBAR_MIN) setWidth(SIDEBAR_MIN - rubberBand(SIDEBAR_MIN - raw));
      else setWidth(raw);
    };
    // Ends on release, or whenever the handle loses the pointer (e.g. released outside the
    // window), so a drag can never be left half-finished.
    let ended = false;
    const onUp = () => {
      if (ended) return;
      ended = true;
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.removeEventListener('lostpointercapture', onUp);
      if (collapsed) {
        setSidebarOpen(side, false);
      } else {
        snap();
        setWidth(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, raw)));
        if (!wasOpen) setSidebarOpen(side, true);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    handle.addEventListener('lostpointercapture', onUp);
  });
}

// --- PDF view ----------------------------------------------------------------------------

const documentEl = document.getElementById('document');
const pagesEl = document.getElementById('pages');
const PAGE_GUTTER = 48;
// Pages are drawn once at this scale, then shrunk with CSS to fit the space available, so
// resizing the window or a sidebar never needs a redraw.
const RENDER_SCALE = 1.5;

async function showPdf(data) {
  const pdf = await getDocument({ data }).promise;
  pagesEl.replaceChildren();
  document.body.classList.add('has-document');

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
    await new TextLayer({ textContentSource: page.streamTextContent(), container: textLayerEl, viewport }).render();
  }
}

function fitPage(pageEl) {
  const available = documentEl.clientWidth - PAGE_GUTTER;
  const k = Math.max(0, Math.min(1, available / Number(pageEl.dataset.width)));
  pageEl.style.width = `${Number(pageEl.dataset.width) * k}px`;
  pageEl.style.height = `${Number(pageEl.dataset.height) * k}px`;
  pageEl.firstElementChild.style.transform = `scale(${k})`;
}

new ResizeObserver(() => pagesEl.querySelectorAll('.page').forEach(fitPage)).observe(documentEl);

function clearPdf() {
  pagesEl.replaceChildren();
  document.body.classList.remove('has-document');
}

// The main process owns the open file (it drives the File menu); the window just shows it.
onFileOpened((file) => showPdf(file.data));
onFileClosed(clearPdf);

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
