import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { clearPages, nearestTextPosition, pageTexts, registerPage, selectionAnchors } from './anchors.js';
import { createFocusPicker } from './focus-picker.js';
import { createHighlightsList } from './highlights-list.js';
import { createMarginReview } from './margin-review.js';
import { redraw, revealAnchors, setMarks } from './overlays.js';
import { createHome } from './home.js';
import { createServerStatus } from './server-status.js';
import { createSettings } from './settings.js';
import { createToolSwitcher } from './tool-switcher.js';
import { createVariationCard } from './variation-card.js';
import { APP_MARKUP } from './app-markup.js';

GlobalWorkerOptions.workerSrc = workerUrl;

// The window's interface, given the API it works through: the app's (window.smartdoc, from the
// preload script, talking to the main process), or the website demo's stand-in (see demo.js).
// It fills the empty body with the window's markup first.
export function startApp(api) {
  document.body.innerHTML = APP_MARKUP;
  const { platform, openDroppedFile, onFullScreenChange } = api;
  document.body.classList.add(`platform-${platform}`);
  onFullScreenChange((isFullScreen) => {
    document.body.classList.toggle('full-screen', isFullScreen);
  });
  createServerStatus({ api });
  createSettings({ button: document.getElementById('settings-button'), dialog: document.getElementById('settings-dialog') });
  const toolSwitcher = createToolSwitcher({
    button: document.getElementById('tool-button'),
    label: document.getElementById('tool-label'),
    card: document.getElementById('tool-card'),
    api,
  });
  const focusPicker = createFocusPicker({
    button: document.getElementById('focus-button'),
    label: document.getElementById('focus-label'),
    separator: document.getElementById('focus-sep'),
    card: document.getElementById('focus-card'),
    api,
  });

  // --- PDF view ----------------------------------------------------------------------------

  const documentEl = document.getElementById('document');
  const pagesEl = document.getElementById('pages');
  // The pages take the middle 60% of the view, leaving a fifth either side for the review's margins.
  const PAGE_SHARE = 0.6;
  // Pages are drawn once at this scale, then shrunk with CSS to fit the space available, so
  // resizing the window never needs a redraw.
  const RENDER_SCALE = 1.5;
  const A4_WIDTH = 595; // points; an A4 page's width, which fitPage never enlarges beyond

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
      // Each page's review cards can be placed once its text is known.
      relayout();
      if (n === 1 && dropping) endDrop(); // a dropped file's first page, drawn under the drop indicator
    }
    // The app needs the page texts to place the AI's quotes and to give the AI the document, and
    // the PDF's details to describe it.
    const details = await pdfDetails(pdf);
    if (ticket !== loading) return;
    await api.reportPageTexts(docId, draftId, pageTexts(), details);
    redraw();
  }

  // The PDF's own details (title, author, subject, the app that made it, dates) and its outline
  // (bookmarks) as [{ title, page, level }]. Either can be missing; neither stops the document
  // loading.
  const OUTLINE_LIMIT = 300;
  async function pdfDetails(pdf) {
    const info = {};
    try {
      const { info: raw } = await pdf.getMetadata();
      for (const [key, name] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Creator', 'createdWith'], ['Producer', 'producer']]) {
        if (typeof raw?.[key] === 'string' && raw[key].trim()) info[name] = raw[key].trim();
      }
      for (const [key, name] of [['CreationDate', 'created'], ['ModDate', 'modified']]) {
        const date = pdfDate(raw?.[key]);
        if (date) info[name] = date;
      }
    } catch {}
    const outline = [];
    try {
      const walk = async (items, level) => {
        for (const item of items ?? []) {
          if (outline.length >= OUTLINE_LIMIT) return;
          outline.push({ title: item.title, page: await outlinePage(pdf, item.dest), level });
          await walk(item.items, level + 1);
        }
      };
      await walk(await pdf.getOutline(), 1);
    } catch {}
    return { info, outline };
  }

  async function outlinePage(pdf, dest) {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      return Array.isArray(explicit) ? (await pdf.getPageIndex(explicit[0])) + 1 : null;
    } catch {
      return null;
    }
  }

  // PDF dates look like D:20261031142500+00'00'; given back as YYYY-MM-DD.
  function pdfDate(value) {
    const match = typeof value === 'string' && value.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?/);
    return match ? [match[1], match[2] ?? '01', match[3] ?? '01'].join('-') : null;
  }

  function fitPage(pageEl) {
    const available = documentEl.clientWidth * PAGE_SHARE;
    const k = Math.max(0, Math.min(1, available / Number(pageEl.dataset.width)));
    pageEl.style.width = `${Number(pageEl.dataset.width) * k}px`;
    pageEl.style.height = `${Number(pageEl.dataset.height) * k}px`;
    pageEl.firstElementChild.style.transform = `scale(${k})`;
    // The bar under the pages matches their width.
    documentEl.style.setProperty('--page-width', pageEl.style.width);
  }

  new ResizeObserver(() => {
    pagesEl.querySelectorAll('.page').forEach(fitPage);
    relayout();
  }).observe(documentEl);

  // The review's cards and marks follow the pages: placed again (once per frame at most) whenever
  // a page is drawn or the pages change size.
  let relayoutQueued = false;
  function relayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      marginReview.layout();
    });
  }

  // --- Scrolling ---------------------------------------------------------------------------
  // The PDF view uses a custom scrollbar: the native one is hidden, and this one is drawn over
  // the scrolling area's right edge with no visible track. In the PDF view,
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

  // The home screen browses the documents, their variations and drafts. A new variation, from a
  // draft there or from the menu, is made by the AI from the prompt on the variation card.
  const newVariation = createVariationCard({ dialog: document.getElementById('variation-dialog'), api });
  api.onVariationRequested(newVariation);
  const home = createHome({
    documentsEl: document.getElementById('home-documents'),
    variationsEl: document.getElementById('home-variations'),
    draftsEl: document.getElementById('home-drafts'),
    api,
  });
  api.onRecentDocuments((documents) => home.update(documents));
  // A document made from a draft shows on the home screen.
  api.onDocumentMade((docId) => home.select(docId));

  // --- Document, draft and review ----------------------------------------------------------
  // The main process owns the document and its drafts and reviews (it drives the menu and the MCP
  // server); the window shows them and sends the user's decisions back.

  // The draft controls, centred in the top bar: the draft showing ("Original" before there are any)
  // with arrows to the ones either side; hovering the label gives the draft's summary.
  const draftNav = document.getElementById('draft-nav');
  const draftLabel = document.getElementById('draft-label');
  const draftPrev = document.getElementById('draft-prev');
  const draftNext = document.getElementById('draft-next');
  draftPrev.addEventListener('click', () => api.stepDraft(-1));
  draftNext.addEventListener('click', () => api.stepDraft(1));

  // They're centred in the top bar while there's room. When the breadcrumb reaches them they move
  // along to sit just after it; when that leaves no room before the right-hand controls, the
  // breadcrumb's tool shrinks to its icon, then the draft label goes, then the controls too. Each
  // time starts from everything shown, so the result only depends on the room there is.
  const topBar = document.querySelector('.top-bar');
  const topBarStart = document.querySelector('.top-bar-start');
  const topBarEnd = document.querySelector('.top-bar-end');
  const DRAFT_NAV_GAP = 12; // the least space kept either side of the controls
  function placeDraftNav() {
    if (draftNav.hidden) return;
    draftNav.classList.remove('compact', 'collapsed');
    topBarStart.classList.remove('tight');
    const bar = topBar.getBoundingClientRect();
    const end = topBarEnd.getBoundingClientRect().left - DRAFT_NAV_GAP - bar.left;
    const fits = () => {
      draftNav.classList.remove('pushed');
      draftNav.style.left = '';
      const start = topBarStart.getBoundingClientRect().right + DRAFT_NAV_GAP - bar.left;
      const width = draftNav.offsetWidth;
      if (bar.width / 2 - width / 2 >= start) return bar.width / 2 + width / 2 <= end; // centred
      draftNav.classList.add('pushed');
      draftNav.style.left = `${start}px`;
      return start + width <= end;
    };
    if (fits()) return;
    topBarStart.classList.add('tight');
    if (fits()) return;
    draftNav.classList.add('compact');
    if (fits()) return;
    draftNav.classList.add('collapsed');
  }
  new ResizeObserver(placeDraftNav).observe(topBar);
  new ResizeObserver(placeDraftNav).observe(topBarStart);
  new ResizeObserver(placeDraftNav).observe(topBarEnd);


  // --- Views: the document, or a highlights review as a list -------------------------------
  // The list view only applies to a highlights review. Which view a document was last left in is
  // remembered for it on this computer.
  const listViewEl = document.getElementById('list-view');
  let current = { doc: null, review: null, tool: 'improve' };
  const viewKey = (docId) => `smartdoc.view.${docId}`;
  function storedView(docId) {
    try {
      return localStorage.getItem(viewKey(docId)) === 'list' ? 'list' : 'document';
    } catch {
      return 'document';
    }
  }
  function setView(view) {
    try {
      if (current.doc) localStorage.setItem(viewKey(current.doc.id), view);
    } catch {}
    showView();
  }
  // In Review and draft, all the findings or only those still to decide: also remembered per
  // document.
  const showKey = (docId) => `smartdoc.show.${docId}`;
  function storedHideDone(docId) {
    try {
      return localStorage.getItem(showKey(docId)) === 'todo';
    } catch {
      return false;
    }
  }
  function setShow(show) {
    try {
      if (current.doc) localStorage.setItem(showKey(current.doc.id), show);
    } catch {}
    showView();
  }
  const doneSwitch = document.getElementById('done-switch');
  for (const button of doneSwitch.querySelectorAll('button')) {
    button.addEventListener('click', () => setShow(button.dataset.show));
  }
  // The list shows when it's chosen and there's a highlights review to list. The switch between the
  // two sits at the right of the top bar whenever there's a highlights review.
  const viewSwitch = document.getElementById('view-switch');
  for (const button of viewSwitch.querySelectorAll('button')) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }
  function showView() {
    const listable = Boolean(current.doc && current.tool === 'highlights' && current.review?.type === 'highlights');
    const list = listable && storedView(current.doc.id) === 'list';
    viewSwitch.hidden = !listable;
    draftNav.hidden = !current.doc;
    focusPicker.update({ doc: current.doc, tool: current.tool, review: current.review });
    // The breadcrumb may have grown or shrunk with the tool and focus.
    requestAnimationFrame(placeDraftNav);
    // All | To do, in Review and draft once there's a finished review to work through.
    const decidable = Boolean(current.doc && current.tool === 'improve' && current.review?.status === 'committed');
    const hideDone = decidable && storedHideDone(current.doc.id);
    doneSwitch.hidden = !decidable;
    for (const button of doneSwitch.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.show === (hideDone ? 'todo' : 'all')));
    }
    for (const button of viewSwitch.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === (list ? 'list' : 'document')));
    }
    document.body.classList.toggle('list-view-open', Boolean(list));
    highlightsList.update(list ? current.review : null);
    marginReview.update({ view: list ? 'list' : 'document', hideDone });
  }

  const highlightsList = createHighlightsList({
    container: listViewEl,
    onShow: (id) => {
      setView('document');
      // The pages need a frame to come back before the card can be placed.
      requestAnimationFrame(() => marginReview.openItem(id));
    },
  });

  document.getElementById('go-home').addEventListener('click', () => api.goHome());

  const marginReview = createMarginReview({
    layer: document.getElementById('margin-layer'),
    pagesEl,
    bar: document.getElementById('review-bar'),
    api,
    onMarks: setMarks,
    onReveal: (anchors) => revealAnchors(anchors, documentEl),
    onClearFilter: () => {
      getSelection().removeAllRanges();
      marginReview.update({ filter: null });
    },
  });

  // Selecting text on the page fades the review's cards that aren't about it; clicking on the page
  // without selecting brings them all back. Only a press that starts on a page counts, so working
  // in a card (which moves the selection there) keeps the filter.
  let pressedOnPage = false;
  pagesEl.addEventListener('mousedown', () => (pressedOnPage = true));
  window.addEventListener('mouseup', () => {
    if (!pressedOnPage) return;
    pressedOnPage = false;
    setTimeout(() => {
      const anchors = selectionAnchors();
      marginReview.update({ filter: anchors.length ? anchors : null });
    });
  });

  // A selection can start anywhere on a page, not only on the text: a press in the space around it
  // starts from the nearest character, and dragging extends to the character nearest the pointer
  // (across pages too). Presses on the text itself select natively. Shift-click extends the
  // current selection.
  const onText = (target) => target.nodeType === Node.ELEMENT_NODE && target.closest('.textLayer') && [...target.childNodes].some((c) => c.nodeType === Node.TEXT_NODE);
  const contentAt = (x, y) => document.elementsFromPoint(x, y).map((el) => el.closest?.('.page-content')).find(Boolean);
  pagesEl.addEventListener('mousedown', (e) => {
    const contentEl = e.target.closest?.('.page-content');
    if (e.button !== 0 || !contentEl || onText(e.target)) return;
    const start = nearestTextPosition(contentEl, e.clientX, e.clientY);
    if (!start) return;
    e.preventDefault();
    const selection = getSelection();
    if (e.shiftKey && selection.rangeCount && !selection.isCollapsed) {
      selection.extend(start.node, start.offset);
      return;
    }
    selection.setBaseAndExtent(start.node, start.offset, start.node, start.offset);
    let last = contentEl;
    const move = (m) => {
      last = contentAt(m.clientX, m.clientY) ?? last;
      const focus = nearestTextPosition(last, m.clientX, m.clientY);
      if (focus) selection.setBaseAndExtent(start.node, start.offset, focus.node, focus.offset);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // The review's cards go in the margins and its marks on the page (the margin review sends them).
  const showReview = (review) => {
    current.review = review;
    marginReview.update({ review });
    showView();
  };

  api.onDraftOpened(async ({ document: doc, variation, draft, pdf, review, tool }) => {
    if (dropping) dropping.opened = true;
    toolSwitcher.update(tool);
    // A variation other than the original is named before the draft.
    const which = draft.isOriginal ? 'Original' : `Draft ${draft.number} of ${draft.total}`;
    draftLabel.textContent = variation.isOriginal ? which : `${variation.name} · ${which}`;
    draftLabel.title = draft.summary ?? (draft.isOriginal ? `${doc.name}, as imported` : doc.name);
    draftPrev.disabled = draft.number === 0;
    draftNext.disabled = draft.number === draft.total;
    requestAnimationFrame(placeDraftNav);
    current = { doc, review, tool };
    marginReview.update({ document: doc, review, tool, filter: null });
    showView();
    marginReview.reset();
    documentEl.scrollTop = 0;
    await showPdf(pdf, { docId: doc.id, draftId: draft.id });
    updateScrollUi();
  });

  api.onDocumentClosed(() => {
    loading++;
    clearPdf();
    clearPages();
    toolSwitcher.close();
    current = { doc: null, review: null, tool: current.tool };
    marginReview.update({ document: null, review: null, filter: null });
    showView();
    updateScrollUi();
  });

  api.onReview(showReview);
  // The active tool, switched by the user or the AI.
  api.onTool((tool) => {
    toolSwitcher.update(tool);
    current.tool = tool;
    marginReview.update({ tool });
    showView();
  });

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

  // Switching between the empty view and a document happens in one step, with no transitions.
  function setHasDocument(on) {
    if (document.body.classList.contains('has-document') === on) return;
    document.body.classList.add('switching-document');
    document.body.classList.toggle('has-document', on);
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('switching-document')));
  }

  // The drop indicator takes the first page's place and size, wherever the view is scrolled to.
  const dropZone = document.getElementById('drop-zone');
  documentEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.top = `${documentEl.scrollTop + 10}px`; // the pages' top padding (--card-gap)
    dropZone.style.width = `${Math.min(documentEl.clientWidth * PAGE_SHARE, A4_WIDTH * RENDER_SCALE)}px`;
    documentEl.classList.add('dragging');
  });
  documentEl.addEventListener('dragleave', (e) => {
    // Moving between the pages fires dragleave too; only clear when leaving the view itself.
    if (!documentEl.contains(e.relatedTarget)) documentEl.classList.remove('dragging');
  });
  // Dropped, the indicator stays until the document's first page is drawn, so what was behind it
  // doesn't show for a moment in between; or, if no document opens (the switch was cancelled, or
  // the file couldn't be read), until opening's over.
  let dropping = null; // a dropped file being opened: { opened } once its document starts drawing
  function endDrop() {
    dropping = null;
    documentEl.classList.remove('dragging');
  }
  documentEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = [...e.dataTransfer.files].find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!file) return void documentEl.classList.remove('dragging');
    const drop = (dropping = {});
    try {
      await openDroppedFile(file);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100)); // the document opening, if it is, arrives first
    if (dropping === drop && !drop.opened) endDrop();
  });
}
