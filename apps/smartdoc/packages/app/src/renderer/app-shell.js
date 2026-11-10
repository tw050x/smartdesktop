import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { clearPages, nearestTextPosition, pageTexts, registerPage, selectionAnchors } from './anchors.js';
import { createCommentComposer } from './comment-composer.js';
import { promptNamingWindow } from './take-over-note.js';
import { createCompareView } from './compare.js';
import { createFindBar } from './find-bar.js';
import { createFocusPicker } from './focus-picker.js';
import { createHistoryNav } from './history-nav.js';
import { createHighlightsList } from './highlights-list.js';
import { CARD_INSET, MIN_CARD_WIDTH, PAGE_SPACE, createMarginReview } from './margin-review.js';
import { createChatPanel } from './chat-panel.js';
import { createDraftPicker } from './draft-picker.js';
import { installTooltips } from './tooltips.js';
import { customScrollbar } from './scrollbar.js';
import { redraw, revealAnchors, setMarks } from './overlays.js';
import { RENDER_SCALE, drawPage, fitPageTo, sharpenPage } from './pdf-page.js';
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
  installTooltips();
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
  createSettings({ dialog: document.getElementById('settings-dialog'), api });
  const toolSwitcher = createToolSwitcher({
    button: document.getElementById('tool-button'),
    label: document.getElementById('tool-label'),
    card: document.getElementById('tool-card'),
    api,
  });
  const focusPicker = createFocusPicker({
    button: document.getElementById('focus-button'),
    label: document.getElementById('focus-label'),
    card: document.getElementById('focus-card'),
    api,
  });
  // Back and forward through where the window has been. The website's demo can't open somewhere
  // again, so its arrows stay off.
  const historyNav = createHistoryNav({
    back: document.getElementById('history-back'),
    forward: document.getElementById('history-forward'),
    api,
    canTravel: !api.isDemo,
  });
  // The draft showing, and with it the stop it makes (see history-nav.js). A preview is a stop on
  // the draft it was written from.
  let atDraft = null; // { docId, variationId, draftId } of the draft last opened, not a preview
  function noteWhereAt() {
    if (!current.doc) return historyNav.observe({ home: true });
    if (!atDraft || atDraft.docId !== current.doc.id) return;
    const focus = current.tool === 'highlights' && current.review?.type === 'highlights' ? current.review.id : null;
    historyNav.observe({ ...atDraft, tool: current.tool, focus, preview: Boolean(current.preview) });
  }

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

  // --- Zoom ----------------------------------------------------------------------------------
  // Controls at the bottom left of the document (−, the zoom, +), and pinching on the trackpad
  // (or ⌘ and scrolling), zoom the pages from their fitted size, keeping what's under the pointer
  // (or the middle of the view) where it is. 100% is the fitted size; clicking it goes back to that.
  // Zoomed in, the pages are drawn again, sharper, once the zoom settles (sharpenPage).
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let zoom = 1;
  let sharpenTimer = null;
  function sharpenSoon() {
    clearTimeout(sharpenTimer);
    sharpenTimer = setTimeout(() => {
      for (const pageEl of pagesEl.querySelectorAll('.page')) sharpenPage(pageEl);
    }, 250);
  }
  function zoomTo(next, at) {
    next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (Math.abs(next - zoom) < 0.001) return;
    const view = documentEl.getBoundingClientRect();
    const x = (at?.x ?? view.left + view.width / 2) - view.left;
    const y = (at?.y ?? view.top + view.height / 2) - view.top;
    const fx = (documentEl.scrollLeft + x) / documentEl.scrollWidth;
    const fy = (documentEl.scrollTop + y) / documentEl.scrollHeight;
    zoom = next;
    pagesEl.querySelectorAll('.page').forEach(fitPage);
    documentEl.scrollLeft = fx * documentEl.scrollWidth - x;
    documentEl.scrollTop = fy * documentEl.scrollHeight - y;
    document.body.classList.toggle('zoomed', zoom !== 1);
    showZoom();
    relayout();
  }
  const zoomControls = document.getElementById('zoom-controls');
  const zoomLevel = document.getElementById('zoom-level');
  function showZoom() {
    zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
    document.getElementById('zoom-out').disabled = zoom <= ZOOM_MIN + 0.001;
    document.getElementById('zoom-in').disabled = zoom >= ZOOM_MAX - 0.001;
  }
  const step = (direction) => zoomTo(direction > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_MAX : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_MIN);
  document.getElementById('zoom-in').addEventListener('click', () => step(1));
  document.getElementById('zoom-out').addEventListener('click', () => step(-1));
  zoomLevel.addEventListener('click', () => zoomTo(1));
  // A pinch on the trackpad arrives as a wheel with Ctrl held (as does ⌘-scroll here).
  documentEl.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (!document.body.classList.contains('has-document')) return;
    event.preventDefault();
    zoomTo(zoom * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY });
  }, { passive: false });
  showZoom();

  // Beside the find bar's column, or the chat docked at the side, the pages keep their share of
  // what's left (so the cards keep their gutters), and stay clear of it.
  const FIND_GUTTER = 24;
  function fitPage(pageEl) {
    const { classList } = document.body;
    const docked = classList.contains('find-docked') || classList.contains('chat-docked');
    const room = documentEl.clientWidth - (docked ? parseFloat(getComputedStyle(documentEl).paddingRight) : 0);
    const besideFind = classList.contains('find-docked') ? room - 2 * FIND_GUTTER : Infinity;
    // Zoomed, the fitted size times the zoom: in, a page can grow past the size it was drawn at.
    fitPageTo(pageEl, Math.min(room * pageShare, besideFind) * zoom, Math.max(1, zoom));
    if (pageEl.scale > 1) sharpenSoon();
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
      chat.setOpen(false);
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
  const draftPicker = createDraftPicker({ button: document.getElementById('draft-button'), card: document.getElementById('draft-card'), api, getTool: () => current.tool });

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
    // Left-aligned, just after the tool and focus, not centred.
    const fits = () => {
      const start = topBarStart.getBoundingClientRect().right + DRAFT_NAV_GAP - bar.left;
      draftNav.classList.add('pushed');
      draftNav.style.left = `${start}px`;
      return start + draftNav.offsetWidth <= end;
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
    for (const button of viewSwitch.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === (list ? 'list' : 'document')));
    }
    if (list) findBar.close();
    document.body.classList.toggle('list-view-open', Boolean(list));
    highlightsList.update(list ? current.review : null);
    marginReview.update({ view: list ? 'list' : 'document' });
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

  let chat = null; // the chat panel, made once the review it lists is (see below)
  let chatFloating = false; // the chat is in a window of its own (see chat-window.js)
  // Whether the chat was last in a window of its own or docked: it opens again the same way.
  const CHAT_WINDOW_KEY = 'chat-in-window';
  const chatPrefersWindow = () => {
    try {
      return localStorage.getItem(CHAT_WINDOW_KEY) === '1';
    } catch {
      return false;
    }
  };
  const rememberChatWindow = (inWindow) => {
    try {
      localStorage.setItem(CHAT_WINDOW_KEY, inWindow ? '1' : '0');
    } catch {}
  };
  let sentChatState = null;
  // A floating chat shows what this window's review shows: it's sent whenever that changes.
  const sendChatState = (force = false) => {
    if (!chatFloating) return;
    // With the draft it's on, whose chat it shows (a preview is its draft's).
    const draft = current.doc && atDraft ? `${atDraft.docId}/${atDraft.variationId}/${atDraft.draftId}` : null;
    const state = JSON.stringify({ ...marginReview.snapshot(), chatDraft: draft });
    if (!force && state === sentChatState) return;
    sentChatState = state;
    api.chatState?.(JSON.parse(state));
  };
  const marginReview = createMarginReview({
    layer: document.getElementById('margin-layer'),
    pagesEl,
    bar: document.getElementById('review-bar'),
    api,
    onMarks: setMarks,
    // Opening an item beside the pages opens the chat too (the way it opened last), where the user
    // can ask about it; what they looked at and decided goes to the chat as context.
    onOpenItem: () => {
      if (chatFloating || chat.isOpen()) return;
      if (chatPrefersWindow() && api.chatFloat) api.chatFloat('main');
      else chat.setOpen(true);
    },
    onNote: (note) => api.chatNote?.(note),
    onSuggestion: (next) => chat?.setSuggestion(next),
    // The bar keeps a way to open the chat while it's closed; the chat follows the review.
    onChange: () => {
      if (!chat) return;
      chat.refresh();
      sendChatState();
      showChatButton();
    },
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
  // The chat with Claude (see chat-panel.js): docked, it takes a column at the right, as find does,
  // and the pages fit what's left.
  chat = createChatPanel({
    el: document.getElementById('chat-panel'),
    api,
    review: marginReview,
    onDock: (on) => {
      if (on) findBar.close();
      if (on !== document.body.classList.contains('chat-docked')) refitPages(() => document.body.classList.toggle('chat-docked', on));
      marginReview.layout();
    },
    // Into a window of its own, with the same item open in its tray.
    onFloat: (view) => api.chatFloat?.(view),
    // Resized from its edge: the pages fit what's left.
    onResize: () => {
      if (document.body.classList.contains('chat-docked')) refitPages(() => {});
    },
  });
  // The chat's button in the top bar, beside the server's status: opens the chat, docked, or
  // closes it, docked or in its own window. It's always there: the chat is the window's, home too.
  const chatButton = document.getElementById('chat-button');
  function showChatButton() {
    const on = chat.isOpen() || chatFloating;
    chatButton.hidden = false;
    chatButton.setAttribute('aria-pressed', String(on));
    const name = on ? 'Close the chat' : 'Open the chat';
    chatButton.title = name;
    chatButton.setAttribute('aria-label', name);
  }
  chatButton.addEventListener('click', () => {
    if (chatFloating) api.chatClose?.();
    else if (chat.isOpen()) chat.setOpen(false);
    else if (chatPrefersWindow() && api.chatFloat) api.chatFloat('main');
    else chat.setOpen(true);
  });

  // The chat's own window opened, docked back (on what it showed) or closed.
  api.onChatMode?.(({ mode, view }) => {
    chatFloating = mode === 'floating';
    // Closed, it keeps how it was; floated or docked, that's how it opens next time.
    if (mode !== 'closed') rememberChatWindow(chatFloating);
    if (chatFloating) {
      chat.setOpen(false);
      sendChatState(true);
    } else if (mode === 'docked') {
      chat.openItem(view && view !== 'main' ? view : null);
    }
    // (A card open beside the pages stays open whatever the chat does: it's the window's, not the chat's.)
    marginReview.layout();
  });

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
    noteWhereAt();
  };

  // The draft's label in the top bar.
  let labelled = null; // { doc, variation, draft }
  function showDraftLabel({ doc, variation, draft }) {
    labelled = { doc, variation, draft };
    // A variation other than the original is named before the draft.
    const which = draft.isPreview ? `Draft ${draft.number} preview` : draft.isOriginal ? 'Original' : `Draft ${draft.number} of ${draft.total}`;
    draftLabel.textContent = variation.isOriginal ? which : `${variation.name} · ${which}`;
    draftLabel.title = draft.summary ?? (draft.isOriginal ? `${doc.name}, as imported` : doc.name);
    draftPicker.update({ doc, variation, draft });
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
    requestAnimationFrame(placeDraftNav);
    setComparing(false);
    composer.close();
    const preview = draft.isPreview ? { number: draft.number, setsAside: draft.setsAside, comparesWith: draft.comparesWith } : null;
    // The only draft that can still change.
    const newest = !draft.isPreview && draft.number === draft.total;
    current = { doc, review, tool, preview, newest };
    if (!draft.isPreview) atDraft = { docId: doc.id, variationId: variation.id, draftId: draft.id };
    noteWhereAt();
    marginReview.update({ document: doc, review, earlier: draft.earlierComments ?? [], tool, preview, filter: null, commentable: newest || Boolean(preview) });
    showView();
    marginReview.reset();
    chat.documentChanged(doc.id);
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
    // The chat is the window's, so it stays, docked or in its own window, and carries on at home.
    chat.documentChanged(null);
    marginReview.update({ document: null, review: null, earlier: [], preview: null, filter: null });
    showView();
    noteWhereAt();
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
    noteWhereAt();
  });
  // Where the window starts is the first stop: home, unless a draft opens straight away, which the
  // stop's settling then takes instead.
  noteWhereAt();

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
