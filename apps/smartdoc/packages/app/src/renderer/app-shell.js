import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { clearPages, nearestTextPosition, pageTexts, registerPage, selectionAnchors } from './anchors.js';
import { createCommentComposer } from './comment-composer.js';
import { promptNamingWindow } from './take-over-note.js';
import { createCompareView } from './compare.js';
import { createFindBar } from './find-bar.js';
import { createFocusPicker } from './focus-picker.js';
import { createHighlightsList } from './highlights-list.js';
import { CARD_INSET, MIN_CARD_WIDTH, PAGE_SPACE, createMarginReview } from './margin-review.js';
import { redraw, revealAnchors, setMarks } from './overlays.js';
import { RENDER_SCALE, drawPage, fitPageTo } from './pdf-page.js';
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
export function startApp(appApi) {
  // A prompt copied from this window names it, so the AI that gets it takes it over.
  const api = appApi.windowId
    ? { ...appApi, copyText: (text) => appApi.copyText(promptNamingWindow(text, appApi.windowId)) }
    : appApi;
  document.body.innerHTML = APP_MARKUP;
  const { platform, openDroppedFile, onFullScreenChange } = api;
  document.body.classList.add(`platform-${platform}`);
  onFullScreenChange((isFullScreen) => {
    document.body.classList.toggle('full-screen', isFullScreen);
  });
  const serverStatus = createServerStatus({ api });
  api.onAiControl?.((name) => {
    serverStatus.setAiControl(name);
    requestAnimationFrame(placeDraftNav);
  });
  createSettings({ button: document.getElementById('settings-button'), dialog: document.getElementById('settings-dialog'), api });
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
  const compareEl = document.getElementById('compare');
  const compareView = createCompareView({ el: compareEl, api });
  let comparing = false;
  // The pages take the middle 60% of the view, leaving a fifth either side for the review's margins,
  // unless the user has dragged them to another size (see the page resizers below).
  const DEFAULT_PAGE_SHARE = 0.6;
  const PAGE_SHARE_KEY = 'page-share';
  const storedPageShare = () => {
    const share = Number(localStorage.getItem(PAGE_SHARE_KEY));
    return share > 0 && share <= 1 ? share : null;
  };
  let pageShare = storedPageShare() ?? DEFAULT_PAGE_SHARE;
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
      const { items, textDivs, contentEl, textLayerEl } = await drawPage(await pdf.getPage(n), (pageEl) => {
        pagesEl.append(pageEl);
        fitPage(pageEl);
      });
      if (ticket !== loading) return;
      keepSelectionSteady(textLayerEl);
      registerPage(n, items, textDivs, contentEl);
      findBar.pageDrawn(n);
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

  // Beside the find bar's column the pages keep their size if they can, and shrink if they must.
  const FIND_GUTTER = 24;
  function fitPage(pageEl) {
    const besideFind = document.body.classList.contains('find-docked')
      ? documentEl.clientWidth - parseFloat(getComputedStyle(documentEl).paddingRight) - 2 * FIND_GUTTER
      : Infinity;
    fitPageTo(pageEl, Math.min(documentEl.clientWidth * pageShare, besideFind));
    // The page resizers sit at the pages' edges.
    documentEl.parentElement.style.setProperty('--page-width', pageEl.style.width);
  }

  // --- Page resizers -------------------------------------------------------------------------
  // A handle in each gutter, at the page's edge. Dragging either resizes the pages from both sides
  // at once, staying centred, trading page width for room for the review's cards. Double-clicking
  // goes back to the usual size. The size is kept for every document.
  const MIN_PAGE_WIDTH = 300;
  const MIN_GUTTER = MIN_CARD_WIDTH + CARD_INSET + PAGE_SPACE;
  const NEAR_PAGE_EDGE = 48; // px either side of a page edge that bring up its resize handle
  const MAX_PAGE_WIDTH = A4_WIDTH * RENDER_SCALE;
  const firstPage = () => pagesEl.querySelector('.page');

  // Makes a change to what the pages fit and redraws, keeping the same part of the document at the
  // top of the view.
  function refitPages(change) {
    const before = firstPage()?.offsetWidth;
    const pagesTop = firstPage()?.offsetTop ?? 0;
    const { scrollTop } = documentEl;
    change();
    pagesEl.querySelectorAll('.page').forEach(fitPage);
    const after = firstPage()?.offsetWidth;
    if (before && after && scrollTop > pagesTop) documentEl.scrollTop = pagesTop + (scrollTop - pagesTop) * (after / before);
    relayout();
  }
  const setPageShare = (share) => refitPages(() => { pageShare = share; });

  for (const handle of document.querySelectorAll('.page-resizer')) {
    const side = handle.classList.contains('left') ? -1 : 1;
    handle.addEventListener('pointerdown', (e) => {
      const first = firstPage();
      if (!first) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = first.offsetWidth;
      document.body.classList.add('page-resizing');
      const onMove = (m) => {
        const view = documentEl.clientWidth;
        const largest = Math.max(MIN_PAGE_WIDTH, Math.min(MAX_PAGE_WIDTH, view - 2 * MIN_GUTTER));
        // Twice the pointer's travel: the far edge moves as much as the near one.
        const width = Math.min(largest, Math.max(MIN_PAGE_WIDTH, startWidth + 2 * side * (m.clientX - startX)));
        setPageShare(width / view);
      };
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('lostpointercapture', onEnd);
        document.body.classList.remove('page-resizing');
        if (pageShare !== DEFAULT_PAGE_SHARE) localStorage.setItem(PAGE_SHARE_KEY, String(pageShare));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('lostpointercapture', onEnd);
    });
    handle.addEventListener('dblclick', () => {
      localStorage.removeItem(PAGE_SHARE_KEY);
      setPageShare(DEFAULT_PAGE_SHARE);
    });
    handle.addEventListener('wheel', (e) => documentEl.scrollBy(e.deltaX, e.deltaY), { passive: true });
  }

  // A handle stays faint until the pointer is near its page edge, at any height in the view. Watched
  // from the document, as the cards in the gutters would catch a hover area's events.
  const pageResizers = [...document.querySelectorAll('.page-resizer')];
  const showNearResizers = (x, y) => {
    const view = documentEl.getBoundingClientRect();
    const inView = y >= view.top && y < view.bottom && x >= view.left && x < view.right;
    for (const handle of pageResizers) {
      const box = handle.getBoundingClientRect();
      handle.classList.toggle('near', inView && Math.abs(x - (box.left + box.right) / 2) <= NEAR_PAGE_EDGE);
    }
  };
  document.addEventListener('pointermove', (e) => showNearResizers(e.clientX, e.clientY), { passive: true });
  document.documentElement.addEventListener('pointerleave', () => showNearResizers(-1, -1));

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
      composer.place();
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
    scrollers: [documentEl, compareEl],
    scroller: () => (comparing ? compareEl : documentEl),
    watch: [documentEl, pagesEl, compareEl],
  });

  // The preview beside the draft it was written from (see compare.js), in place of the document.
  function setComparing(on) {
    if (on === comparing) return;
    comparing = on;
    if (on) findBar.close();
    composer.close();
    document.body.classList.toggle('comparing', on);
    if (on) compareView.open();
    else compareView.close();
    marginReview.update({ comparing: on });
    updateScrollUi();
  }

  // Find works on the document's pages, so it brings them back from the views that replace them.
  const findBar = createFindBar({
    el: document.getElementById('find-bar'),
    api,
    scroller: documentEl,
    reveal: (match) => revealAnchors([match], documentEl),
    beforeOpen: () => {
      setComparing(false);
      if (document.body.classList.contains('list-view-open')) setView('document');
    },
    // Open, it has a column of its own beside the pages, so it never covers them, and the review's
    // cards make way (see .find-docked).
    onToggle: () => {
      const open = findBar.isOpen();
      if (open !== document.body.classList.contains('find-docked')) refitPages(() => document.body.classList.toggle('find-docked', open));
    },
  });
  api.onFind?.((which) => {
    if (current.doc && !document.querySelector('dialog[open]')) findBar.command(which);
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
    const decidable = Boolean(current.doc && !current.preview && current.tool === 'improve' && current.review?.status === 'committed');
    const hideDone = decidable && storedHideDone(current.doc.id);
    doneSwitch.hidden = !decidable;
    for (const button of doneSwitch.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.show === (hideDone ? 'todo' : 'all')));
    }
    for (const button of viewSwitch.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === (list ? 'list' : 'document')));
    }
    if (list) findBar.close();
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
    onCompare: () => setComparing(!comparing),
    // A gutter the user has widened is for the cards to use.
    pagesResized: () => storedPageShare() !== null || document.body.classList.contains('page-resizing'),
    onReveal: (anchors) => revealAnchors(anchors, documentEl),
    onClearFilter: () => {
      getSelection().removeAllRanges();
      marginReview.update({ filter: null });
    },
  });

  // Comments can be added to the newest draft, in Review and draft, or to a draft preview (not in
  // the website's demo).
  const canComment = () => Boolean(api.addRequest && current.doc && !findBar.isOpen() && (current.preview || (current.newest && current.tool === 'improve')));
  const composer = createCommentComposer({
    wrapEl: document.getElementById('pages-wrap'),
    api,
    canComment,
    cardPlace: () => marginReview.cardPlace(),
    onDone: () => {
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
      composer.offer(anchors);
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

  // The draft's label in the top bar.
  let labelled = null; // { doc, variation, draft }
  function showDraftLabel({ doc, variation, draft }) {
    labelled = { doc, variation, draft };
    // A variation other than the original is named before the draft.
    const which = draft.isPreview ? `Draft ${draft.number} preview` : draft.isOriginal ? 'Original' : `Draft ${draft.number} of ${draft.total}`;
    draftLabel.textContent = variation.isOriginal ? which : `${variation.name} · ${which}`;
    draftLabel.title = draft.summary ?? (draft.isOriginal ? `${doc.name}, as imported` : doc.name);
    requestAnimationFrame(placeDraftNav);
  }
  // The document showing, or its variation, has a new name.
  api.onNames?.(({ document: name, variation }) => {
    if (!current.doc || !labelled) return;
    current.doc = { ...current.doc, name };
    marginReview.update({ document: current.doc });
    showDraftLabel({ ...labelled, doc: current.doc, variation: { ...labelled.variation, name: variation } });
  });

  api.onDraftOpened(async ({ document: doc, variation, draft, pdf, review, tool }) => {
    if (dropping) dropping.opened = true;
    toolSwitcher.update(tool);
    showDraftLabel({ doc, variation, draft });
    draftPrev.disabled = draft.number === 0;
    draftNext.disabled = draft.isPreview || draft.number === draft.total;
    requestAnimationFrame(placeDraftNav);
    setComparing(false);
    composer.close();
    const preview = draft.isPreview ? { number: draft.number, setsAside: draft.setsAside, comparesWith: draft.comparesWith } : null;
    // The only draft that can still change.
    const newest = !draft.isPreview && draft.number === draft.total;
    current = { doc, review, tool, preview, newest };
    marginReview.update({ document: doc, review, tool, preview, filter: null, commentable: newest || Boolean(preview) });
    showView();
    marginReview.reset();
    documentEl.scrollTop = 0;
    findBar.draftOpened({ docId: doc.id, draftId: draft.id });
    await showPdf(pdf, { docId: doc.id, draftId: draft.id });
    updateScrollUi();
  });

  api.onDocumentClosed(() => {
    loading++;
    setComparing(false);
    composer.close();
    findBar.close();
    clearPdf();
    clearPages();
    toolSwitcher.close();
    current = { doc: null, review: null, tool: current.tool, preview: null };
    marginReview.update({ document: null, review: null, preview: null, filter: null });
    showView();
    updateScrollUi();
  });

  api.onReview(showReview);
  api.onAiWaiting?.((aiWaiting) => marginReview.update({ aiWaiting }));
  api.aiWaiting?.().then((aiWaiting) => marginReview.update({ aiWaiting }));
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
    if (!e.dataTransfer.types.includes('Files')) return; // something being moved on the home screen
    e.preventDefault();
    dropZone.style.top = `${documentEl.scrollTop + parseFloat(getComputedStyle(pagesEl).paddingTop)}px`;
    dropZone.style.width = `${Math.min(documentEl.clientWidth * pageShare, A4_WIDTH * RENDER_SCALE)}px`;
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
    if (!e.dataTransfer.types.includes('Files')) return;
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
