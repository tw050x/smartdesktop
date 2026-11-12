import { iconSvg } from '../main/icons.js';
import { CONTRACT, connectedPairs, isInternalLink, neighboursOf, parseLink, TABLE_ROWS_SHOWN, tableSummary } from '../main/items.js';
import { makeCanvas } from './canvas-view.js';
import { bringToMiddle, cleanLayout, defaultLayout, emptyLayout, isCard, layoutToSave, placeNew } from './board.js';
import { watchBoard } from './board-view.js';
import { watchPage } from './page-view.js';
import { drawOverview, watchOverview } from './overview-view.js';
import { againButton, commentCard, earlierLine, keyOf, targetAt, watchComments } from './comments.js';
import { closeThread, openThread, refreshThread } from './comment-overlay.js';
import { shadeScrolling } from './scroll-shade.js';
import { watchLongPress } from './long-press.js';
import { itemView, kindLabel, sequenceKey, wipeView } from './item-views.js';
import { markInline, readText } from './diff-marks.js';
import { diffOf } from './item-diffs.js';
import { CROSS, openCompare } from './compare-view.js';
import { CHEVRON, createModeSwitcher } from './mode-switcher.js';
import { arrowKeysIn } from './menu-keys.js';
import { plainText, renderMarkdown } from './markdown.js';
import { levelOf } from './home-level.js';

// The window's content: the home screen (schemas › drafts), or one schema, opened level by level.
// Where the window is, is a path of levels: the schema opened from home, then each embedded schema
// opened from the one before. Each level shows its items on a board the user arranges (see
// board-view.js), or an overview of them. The main process owns the schemas; this asks for what it
// shows, again whenever they change.

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key === 'className' ? 'class' : key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}
const pill = (text, kind = '') => h('span', { className: `pill ${kind}` }, text);
// Status pills come from the app, for what needs the user's attention. They sit on the title row if
// they all fit, else all of them go beneath it (see .status-pills). The normal state shows nothing.
const WAITING = () => pill('Waiting for you', 'proposed');
const statusPills = (...pills) => (pills.some(Boolean) ? h('span', { className: 'status-pills' }, ...pills) : null);

// The kind of item on a small card at the sides, as an icon rather than a pill, so the card's
// title has the room. Its name is still there, for pointing at and for screen readers.
const KIND_ICONS = {
  // The Markdown mark: an M and a down arrow in a rounded box.
  document: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M6 15V9l3 3 3-3v6M17 9v6M14.5 12.5L17 15l2.5-2.5"/>',
  flow: '<rect x="8.5" y="3" width="7" height="5" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M12 8v4M6.5 16v-4h11v4"/>',
  sequence: '<rect x="3" y="2.5" width="6" height="4" rx="1"/><rect x="15" y="2.5" width="6" height="4" rx="1"/><path d="M6 6.5V22M18 6.5V22" stroke-dasharray="2 2.5"/><path d="M6 11.5h11M15 9.5l2 2-2 2M18 17H7M9 15l-2 2 2 2"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 15h18M9.5 9.5V20"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  schematic: '<rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="3" width="7" height="6" rx="1"/><rect x="8.5" y="15" width="7" height="6" rx="1"/><path d="M10 6h4M6.5 9v3h5.5v3M17.5 9v3H12"/>',
};
function kindIcon(kind, label) {
  const icon = h('span', { className: 'kind-icon', role: 'img', 'aria-label': label, title: label });
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS[kind] ?? KIND_ICONS.document}</svg>`;
  return icon;
}

const ARROW_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.18,13H4V11H16.18l-5.6-5.6L12,4l8,8l-8,8l-1.42-1.4l5.6-5.6Z"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5,21q-0.83,0-1.41-0.59T3,19V5Q3,4.17 3.59,3.59T5,3h7V5H5V19H19V12h2v7q0,0.82-0.59,1.41T19,21H5Zm4.7-5.3L8.3,14.3L17.6,5H14V3h7v7H19V6.4L9.7,15.7Z"/></svg>';
const FULL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/></svg>';
const LEAVE_FULL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59z"/></svg>';
// SmartDoc's folder icons: a folder on home's list, and New folder.
const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const NEW_DOMAIN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const BACK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const HOVER_OPENS_MS = 500; // holding something dragged over a folder or the back arrow
const PATH_SHOWN = 3; // folders named on the path row; any before them as …
const DRAG_TYPE = 'application/x-smartspec-item';
const NEW_FOLDER_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
const BIN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const UNGROUPED = 'ungrouped'; // No domain: where a schema in no domain (no group) is, which always exists
const SORT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3,18V16H9v2H3Zm0-5V11H15v2H3ZM3,8V6H21V8H3Z"/></svg>';
// Each column's sort orders, the first the default.
const SORTS = {
  groups: [
    ['name', 'Name', (list) => [...list].sort((a, b) => a.name.localeCompare(b.name))],
    ['size', 'Most schematics', (list) => [...list].sort((a, b) => b.schemas - a.schemas || a.name.localeCompare(b.name))],
    ['newest', 'Newest', (list) => [...list].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))],
  ],
  schemas: [
    ['changed', 'Recently changed', (list) => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))],
    ['name', 'Name', (list) => [...list].sort((a, b) => a.name.localeCompare(b.name))],
    ['waiting', 'Waiting for you', (list) => [...list].sort((a, b) => Boolean(b.proposal) - Boolean(a.proposal) || b.updatedAt.localeCompare(a.updatedAt))],
  ],
  drafts: [
    ['newest', 'Newest first', (list) => [...list].sort((a, b) => b.number - a.number)],
    ['oldest', 'Oldest first', (list) => [...list].sort((a, b) => a.number - b.number)],
  ],
};
// The chosen order is a convenience: without it, a column has its default.
const rememberedSort = (column) => {
  try {
    return localStorage.getItem(`sort-${column}`);
  } catch {
    return null;
  }
};

// Focus (one item, with what it links to around it) or overview (every item on a canvas). The list
// the overview replaced was remembered as 'list'.
const rememberedView = () => {
  try {
    return ['overview', 'list'].includes(localStorage.getItem('schema-view')) ? 'overview' : 'focus';
  } catch {
    return 'focus';
  }
};

const CHANGE_LABELS = { added: 'New', changed: 'Changed', removed: 'Removed' };
const smoothly = () => typeof document.startViewTransition === 'function' && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

// `onShown({ chatId, name, line })` hears where the window is, for the chat (see app-shell.js), with
// the chat's line of context for going there: home
// ('home', name null), or a schematic's draft (`<schematic>/<draft>`; a proposal is the draft it
// changes', or `<schematic>/new` for a new schematic's first). `onCards(cards, shortcuts)` hears what there is
// to decide about what it shows (drawn in the bottom bar: see showBar) and what to ask the AI about
// it, as shortcuts for the chat (see reviewBar); `onAsk(text)` sends the chat's AI a
// request (from the question before accepting); `onNote(note)` gives the chat a line of context for
// the AI, about what the user looked at or did ({ text, detail, focus, about }: see note in
// main/agent.js).
export function createSchemas({ el, bottomBar, crumbs, draftNav, modeCard, focusMenu, viewSwitch, api, onShown = () => {}, onCards = () => {}, onAsk = () => {}, onNote = () => {}, onChooseIcon = () => {} }) {
  // A level: { schemaId, draftId (null for the latest), proposal (showing the proposed change),
  // label, item (what's selected in it), focus (a part of it to bring into view) }.
  let path = [];
  let selected = null; // the schema whose drafts home shows
  let selectedGroup = null; // the domain (group) whose schemas home shows, UNGROUPED for those in none
  let naming = null; // a domain or folder being named on home: { kind, id }, with id null for a new one
  const sorts = Object.fromEntries(Object.entries(SORTS).map(([column, options]) => [column, options.find(([id]) => id === rememberedSort(column)) ?? options[0]]));
  const modes = createModeSwitcher({ card: modeCard, onChange: () => render() });
  let rendering = 0;
  let aiWaiting = []; // the proposals an AI in another app is waiting on (`smartspec wait`)
  let homeShowing = false; // home's columns rise in only as it arrives, not each time it's drawn again
  // A schema shows one item with what links to it, or a list of everything in it. Remembered on this
  // computer, as a convenience.
  let layout = rememberedView();
  let moving = false; // the next drawing animates, as the browser can, to what it shows next
  const top = () => path.at(-1);

  // Which tab this is (see main.js): Home, the only one showing home, which opens a schematic in a
  // tab of its own; or a schematic's, which never shows home (going home shows the Home tab). The
  // website's demo is neither: a whole window, going between home and a schematic as it did.
  const inHome = api.tabKind === 'home';
  const inTab = api.tabKind === 'document';
  let hadSchema = false; // a schematic's tab has shown its schematic (and closes once it's gone)

  // Back and forward: where this tab has been, as a browser keeps it. Each stop is the levels open,
  // the item each shows, and whether that was in focus or on the overview. Choosing somewhere new
  // drops what was ahead. The buttons are in the window's top bar (tab-strip.js), which asks this
  // tab to go back or forward (`onHistoryStep`) and is told when it can (`historyState`).
  const HISTORY_LIMIT = 200;
  const stop = () => JSON.stringify({ layout: path.length ? layout : null, path: path.map(({ schemaId, draftId, proposal, label, item, full }) => ({ schemaId, draftId, proposal, label, item, full })) });
  // (A schematic's tab starts with nothing: its first stop is its schematic, never home.)
  let visited = inTab ? [] : [stop()];
  let visiting = visited.length - 1;
  let historyShown = null;
  const showHistory = () => {
    const state = { back: visiting > 0, forward: visiting < visited.length - 1 };
    if (JSON.stringify(state) === historyShown) return;
    historyShown = JSON.stringify(state);
    api.historyState?.(state);
  };
  function remember() {
    const here = stop();
    if (visited[visiting] === here) return;
    visited = [...visited.slice(0, visiting + 1), here].slice(-HISTORY_LIMIT);
    visiting = visited.length - 1;
    showHistory();
  }
  function travel(delta) {
    const next = visiting + delta;
    if (next < 0 || next >= visited.length) return;
    const was = top();
    const wasLayout = layout;
    visiting = next;
    const stopped = JSON.parse(visited[next]);
    path = stopped.path.map((one) => ({ ...one, focus: null }));
    if (stopped.layout && stopped.layout !== layout) {
      layout = stopped.layout;
      rememberView();
    }
    showHistory();
    // Within one level, in focus, an item stepped back or on to comes to the middle again.
    const now = top();
    const sameView = wasLayout === 'focus' && layout === 'focus';
    if (sameView && was && now && was.schemaId === now.schemaId && was.item !== now.item && !now.full) now.bring = true;
    moving = Boolean(sameView && was && now && was.schemaId === now.schemaId && Boolean(was.full) !== Boolean(now.full));
    if (path.length) selected = path[0].schemaId;
    closeFocus();
    render();
  }
  api.onHistoryStep?.((delta) => travel(delta));
  showHistory();
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.key === '[') travel(-1);
    else if (event.key === ']') travel(1);
  });
  const level = (schemaId, { draftId = null, proposal = false, label = '', item = CONTRACT } = {}) => ({ schemaId, draftId, proposal, label, item, full: false, focus: null });

  let showingPlace = null;
  const placeShowing = () => {
    const here = top();
    return here ? [here.schemaId, here.item, Boolean(here.full), layout, modes.mode()].join(':') : 'home';
  };

  const KEYS = ['data-folder', 'data-group', 'data-schema', 'data-draft', 'data-proposal']; // home's rows
  function focusKey(element) {
    if (!element || element === document.body) return null;
    if (element.id) return `#${CSS.escape(element.id)}`;
    const key = KEYS.find((name) => element.hasAttribute(name));
    return key ? `${element.tagName.toLowerCase()}[${key}="${CSS.escape(element.getAttribute(key))}"]` : null;
  }

  // Where each item's scrolling parts are scrolled to, by item and part, to put back after drawing.
  const SCROLLERS = '.focus-body, .item-table-holder';
  const scrollKey = (scroller) => `${scroller.closest('[data-item]')?.dataset.item ?? 'full'}|${scroller.classList.contains('item-table-holder') ? 'table' : 'body'}`;
  function itemScrolls() {
    const kept = new Map();
    for (const scroller of el.querySelectorAll(SCROLLERS)) {
      if (scroller.scrollTop || scroller.scrollLeft) kept.set(scrollKey(scroller), [scroller.scrollLeft, scroller.scrollTop]);
    }
    return kept;
  }
  function restoreItemScrolls(kept) {
    if (!kept.size) return;
    const put = () => {
      for (const scroller of el.querySelectorAll(SCROLLERS)) {
        const at = kept.get(scrollKey(scroller));
        if (at) [scroller.scrollLeft, scroller.scrollTop] = at;
      }
    };
    put();
    // Again once pages are fitted to their items' sizes, which can change how far they scroll.
    requestAnimationFrame(() => requestAnimationFrame(put));
  }

  // A schematic's tab with no schematic yet (an AI's, opening one): nothing, under the line saying so
  // (#tab-waiting).
  const waitingView = () => h('div', { className: 'tab-waiting-view' });

  async function render() {
    const ticket = ++rendering;
    // The same thing drawn again keeps its place. Anything else starts at its top, once it shows.
    const place = placeShowing();
    const scroll = place === showingPlace ? el.scrollTop : 0;
    const view = path.length ? await schemaView(top()) : inTab ? waitingView() : await homeView();
    if (ticket !== rendering) return;
    // Home's columns scroll on their own, and keep their place when it's drawn again.
    const lists = [...el.querySelectorAll('.browser-list')].map((list) => list.scrollTop);
    // What has focus keeps it when it's drawn again: found by its id, or by the row it is.
    const focused = focusKey(document.activeElement);
    const show = () => {
      // What scrolls inside each item keeps its place when the same thing is drawn again (a comment
      // flagged or written again redraws the page).
      const scrolled = place === showingPlace ? itemScrolls() : new Map();
      focusMenu.hidden = true;
      holdDragged();
      // Home arriving (at launch, or back from a schematic): its columns rise in, as SmartDoc's do.
      if (!path.length && !homeShowing) view.classList.add('arriving');
      homeShowing = !path.length;
      document.body.classList.toggle('has-schematic', path.length > 0);
      el.replaceChildren(view);
      showBar(view.bottomBar);
      onCards(view.bottomBar?.cards ?? [], view.bottomBar?.shortcuts ?? []);
      crumbs.replaceChildren(...breadcrumb());
      crumbs.title = path.map((one) => one.label).join(' › ');
      draftNav.replaceChildren(...(view.draftNav ?? []));
      draftNav.hidden = !view.draftNav;
      viewSwitch.hidden = !path.length || modes.mode() !== 'design';
      for (const button of viewSwitch.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.view === layout));
      placeDraftNav();
      if (focused) el.ownerDocument.querySelector(focused)?.focus({ preventScroll: true });
      el.scrollTop = scroll;
      showingPlace = place;
      el.querySelectorAll('.browser-list').forEach((list, index) => { list.scrollTop = lists[index] ?? 0; });
      // The board first: it sets each item's size, which a page is fitted to.
      const board = el.querySelector('.board');
      if (board) showBoard(board);
      else {
        const overview = el.querySelector('.overview-page .diagram.overview');
        watchComments(overview?.comments ? overview : null, overview?.comments);
      }
      restoreItemScrolls(scrolled);
      // A box of comments open before the page was drawn again opens again on the same thing.
      const threads = (board ?? el.querySelector('.overview-page .diagram.overview'))?.threads;
      if (threads) refreshThread(threads);
      else closeThread();
      const fullPage = el.querySelector('.focus-full .sheet-body');
      if (fullPage) watchPage(fullPage);
      const overview = el.querySelector('.overview-page .diagram.overview');
      if (overview) watchOverview(overview, overview.pairs, overview.connections);
      bringFocusIntoView();
    };
    // Opening or closing full screen, the browser carries the item between its two places, as each
    // has the same name (see moves). A move that can't be animated, as in a hidden window, still
    // happens: only the animation is lost.
    const animate = moving && smoothly();
    moving = false;
    if (animate) {
      const transition = document.startViewTransition(show);
      transition.ready.catch(() => {});
      transition.finished.catch(() => {});
    } else show();
  }

  function bringFocusIntoView() {
    const here = top();
    if (!here?.focus) return;
    const within = el.querySelector(`.board-item[data-item="${CSS.escape(here.item)}"]`) ?? el;
    const part = [...within.querySelectorAll('[data-part]')].find((element) => element.dataset.part === here.focus);
    here.focus = null;
    if (!part) return;
    const canvas = part.closest('.diagram-canvas');
    if (canvas) canvas.centreOn(part);
    else part.scrollIntoView({ block: 'center' });
    part.classList.add('part-focus');
    setTimeout(() => part.classList.remove('part-focus'), 2000);
  }

  function go(next) {
    // Home opens a schematic in a tab of its own (see main.js), and a schematic's tab goes home by
    // showing the Home tab.
    if (inHome && next.length) {
      selected = next[0].schemaId;
      api.openInTab({ path: next.map(({ schemaId, draftId, proposal, label, item }) => ({ schemaId, draftId, proposal, label, item })), layout });
      return render();
    }
    if (inTab && !next.length) return api.goHome();
    // Back home, the schema you were in is the one selected.
    if (!next.length && path.length) selected = path[0].schemaId;
    path = next;
    remember();
    return render();
  }

  // --- Home ---------------------------------------------------------------------------------

  // Home: the domains schemas belong to, the schemas in the chosen one, and the drafts of the chosen
  // schema. A domain is a group in the store. The first column shows one folder at a time, its
  // folders and domains sorted together, as SmartDoc's documents column does: opening one replaces
  // the list, and a row under the column's title shows the path back, so folders can nest to any
  // depth. No domain is always first at the top level, for schemas in none. Things move by dragging:
  // a domain or folder onto a folder, the path or the list, where holding it over a folder or the back
  // arrow opens it on the way; a schema onto a domain. Or by a right-click menu's Cut and Paste, or a
  // schema's Move to. Domains and folders only organise the list (see main/folders.js).
  let folderState = { folders: [], placement: {} };
  let shownFolder = null; // the folder the domains column shows, null for the top level
  let cut = null; // { kind: 'domain' | 'folder', id }, waiting to be pasted
  let drag = null; // { kind: 'domain' | 'folder' | 'schema', id, from, itemEl, dropped }
  let hover = null; // { key, timer }: something dragged, held over something that opens
  const folderById = (id) => folderState.folders.find((f) => f.id === id);
  const folderOfGroup = (id) => (id === UNGROUPED ? null : folderState.placement[id] ?? null);
  function pathTo(folderId) {
    const path = [];
    const seen = new Set();
    for (let f = folderById(folderId); f && !seen.has(f.id); f = folderById(f.parentId)) {
      seen.add(f.id);
      path.unshift(f);
    }
    return path;
  }
  // Whether a domain or folder can go to a place: not where it is already, nor a folder inside itself.
  function canGo({ kind, id }, place) {
    if (kind === 'domain') return folderOfGroup(id) !== place;
    if (kind !== 'folder' || (folderById(id)?.parentId ?? null) === place) return false;
    return !pathTo(place).some((f) => f.id === id);
  }
  const moveItem = ({ kind, id }, place) => (kind === 'domain' ? api.moveGroup(id, place) : api.moveFolder(id, place));

  // Opening a folder shows its first domain; held over by a drag, what's chosen stays.
  function showFolder(id, { keepSelection = false } = {}) {
    shownFolder = id;
    naming = null;
    if (!keepSelection) {
      selected = null;
      selectedGroup = null;
    }
    render();
  }

  async function homeView() {
    onShown({ chatId: 'home', name: null, line: { text: 'Went home', detail: 'The window shows SmartSpec\'s home.' } });
    const [all, { groups }, folders] = await Promise.all([api.listSchemas(), api.listGroups(), api.folders()]);
    folderState = folders;
    if (shownFolder && !folderById(shownFolder)) shownFolder = null;
    if (cut && !(cut.kind === 'folder' ? folderById(cut.id) : groups.some((group) => group.id === cut.id))) cut = null;
    const groupOf = (one) => one.group ?? UNGROUPED;
    // The chosen schema's domain is the one showing, in its folder, wherever it was chosen (here, an
    // AI's proposal, or coming back home), and wherever it's moved to; but not while something is
    // dragged, as a folder held open on the way stays open. Choosing a domain lets go of the schema.
    const chosen = all.find((each) => each.id === selected);
    if (chosen && !drag) {
      selectedGroup = groupOf(chosen);
      shownFolder = folderOfGroup(selectedGroup);
    }
    if (selectedGroup && selectedGroup !== UNGROUPED && !groups.some((group) => group.id === selectedGroup)) selectedGroup = null;
    const here = sorts.groups[2](levelOf(folderState, groups, shownFolder));
    // The chosen domain is one on this level: with none chosen, the first (No domain at the top).
    if (!drag && selectedGroup && (selectedGroup === UNGROUPED ? shownFolder !== null : folderOfGroup(selectedGroup) !== shownFolder)) selectedGroup = null;
    if (!drag && !selectedGroup) selectedGroup = shownFolder === null ? UNGROUPED : here.find((one) => one.kind === 'domain')?.id ?? null;
    const schemas = selectedGroup ? sorts.schemas[2](all.filter((each) => groupOf(each) === selectedGroup)) : [];
    const schema = schemas.find((each) => each.id === selected) ?? schemas[0] ?? null;
    if (!drag) selected = schema?.id ?? null;
    const drafts = schema ? sorts.drafts[2](await api.listDrafts(schema.id)) : [];
    const ungrouped = all.filter((each) => !each.group).length;
    const count = (n) => (n === 1 ? '1 schematic' : `${n} schematics`);

    const domainRow = (id, name, schemasIn) => {
      if (naming?.kind === 'domain' && naming.id === id) return namingRow(name);
      const button = row({
        attributes: { 'data-group': id, 'aria-pressed': String(id === selectedGroup) },
        onclick: () => {
          selectedGroup = id;
          selected = null;
          render();
        },
        title: name,
        meta: count(schemasIn),
      });
      dropTarget(button, { domain: id });
      if (id === UNGROUPED) return button;
      if (cut?.kind === 'domain' && cut.id === id) button.classList.add('browser-cut');
      makeDraggable(button, 'domain', id);
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu([
          { id: 'rename', label: 'Rename' },
          { id: 'cut', label: 'Cut' },
          { separator: true },
          { id: 'delete', label: 'Delete Domain…' },
        ], {
          rename: () => startNaming({ kind: 'domain', id }),
          cut: () => cutItem({ kind: 'domain', id }),
          delete: async () => { if (await api.deleteGroup(id)) render(); },
        });
      });
      const action = (label, icon, run) => {
        const one = h('button', { className: 'icon-button group-action', type: 'button', title: label, 'aria-label': `${label} ${name}`, onclick: run });
        one.innerHTML = icon;
        return one;
      };
      return h('div', { className: 'group-row' }, button, h('span', { className: 'group-actions' },
        action('Rename', PENCIL_ICON, () => startNaming({ kind: 'domain', id })),
        action('Delete', BIN_ICON, async () => { if (await api.deleteGroup(id)) render(); })));
    };
    const folderRow = (folder, item) => {
      if (naming?.kind === 'folder' && naming.id === folder.id) return namingRow(folder.name);
      const inside = item.domains + folderState.folders.filter((f) => f.parentId === folder.id).length;
      const title = h('span', { className: 'title-row folder-title' }, h('strong', {}, folder.name));
      title.insertAdjacentHTML('afterbegin', FOLDER_ICON);
      const button = h('button', { className: `browser-row folder-row${cut?.kind === 'folder' && cut.id === folder.id ? ' browser-cut' : ''}`, type: 'button', 'data-folder': folder.id, title: folder.name, onclick: () => showFolder(folder.id) },
        title,
        h('span', { className: 'browser-row-meta' }, inside ? `${inside} item${inside === 1 ? '' : 's'}` : 'Empty'));
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu([
          { id: 'open', label: 'Open' },
          { id: 'rename', label: 'Rename' },
          { id: 'cut', label: 'Cut' },
          { separator: true },
          { id: 'delete', label: 'Delete Folder' },
        ], {
          open: () => showFolder(folder.id),
          rename: () => startNaming({ kind: 'folder', id: folder.id }),
          cut: () => cutItem({ kind: 'folder', id: folder.id }),
          delete: () => api.deleteFolder(folder.id),
        });
      });
      makeDraggable(button, 'folder', folder.id);
      dropTarget(button, { place: folder.id, opens: true });
      return button;
    };

    // The column's title is the way back to the top level, and a row under it the way to any folder
    // on the path, with the back arrow first.
    const folderPath = pathTo(shownFolder);
    const crumb = (name, id) => {
      const button = h('button', { className: 'browser-crumb', type: 'button', title: name, onclick: () => showFolder(id) }, name);
      dropTarget(button, { place: id });
      return button;
    };
    const iconButton = (id, label, icon, onclick) => {
      const button = h('button', { className: 'icon-button', type: 'button', id, title: label, 'aria-label': label, onclick });
      button.innerHTML = icon;
      return button;
    };
    let pathRow = null;
    if (folderPath.length) {
      const back = iconButton('domains-back', 'Back', BACK_ICON, () => showFolder(folderById(shownFolder)?.parentId ?? null));
      back.classList.add('browser-back');
      dropTarget(back, { place: folderById(shownFolder)?.parentId ?? null, opens: true, key: 'back' });
      const hidden = folderPath.length - PATH_SHOWN;
      pathRow = h('nav', { className: 'browser-path', 'aria-label': 'Folder path' }, back,
        hidden > 0 && h('span', { className: 'browser-crumb-more' }, '…'),
        ...folderPath.slice(Math.max(hidden, 0)).map((f) => (f.id === shownFolder ? h('span', { className: 'browser-crumb-here', title: f.name }, f.name) : crumb(f.name, f.id))));
    }

    const newRow = naming && !naming.id && h('li', {}, namingRow(''));
    const rows = here.map((item) => h('li', {}, item.kind === 'folder' ? folderRow(folderById(item.id), item) : domainRow(item.id, item.name, item.schemas)));
    const list = h('ul', { className: 'browser-list' },
      // A new one's name is written at the very top, as in SmartDoc; then No domain, first whatever
      // the order.
      newRow,
      shownFolder === null && h('li', {}, domainRow(UNGROUPED, 'No domain', ungrouped)),
      ...rows,
      shownFolder !== null && !rows.length && !newRow && h('li', { className: 'browser-empty' }, 'This folder is empty. Drag domains here, or right-click to paste.'));
    dropTarget(list, { place: shownFolder });
    list.addEventListener('contextmenu', (event) => {
      if (event.target.closest('.browser-row, .group-naming')) return;
      event.preventDefault();
      openMenu([
        { id: 'domain', label: 'New Domain' },
        { id: 'folder', label: 'New Folder' },
        { id: 'paste', label: 'Paste', enabled: Boolean(cut && canGo(cut, shownFolder)) },
      ], {
        domain: () => startNaming({ kind: 'domain', id: null }),
        folder: () => startNaming({ kind: 'folder', id: null }),
        paste,
      });
    });
    const domainsColumn = h('section', { className: 'browser-column groups-column', 'aria-label': 'Domains' },
      h('div', { className: 'browser-head' }, h('h2', {}, folderPath.length ? crumb('Domains', null) : 'Domains'),
        iconButton('new-folder', 'New folder', NEW_FOLDER_ICON, () => startNaming({ kind: 'folder', id: null })),
        iconButton('new-group', 'New domain', NEW_DOMAIN_ICON, () => startNaming({ kind: 'domain', id: null })),
        sortControl('groups')),
      pathRow,
      list);

    return h('div', { className: 'browser' },
      domainsColumn,
      column('Schematics', {
        sort: 'schemas',
        // Placeholder rows, the shape of a schematic's: its name, then its summary.
        skeleton: [[44, 82], [58, 70], [36, 88]],
      }, ...schemas.map((each) => {
        const one = row({
          attributes: { 'data-schema': each.id, 'aria-pressed': String(each.id === schema.id) },
          onclick: () => { selected = each.id; render(); },
          title: each.name,
          icon: each.icon,
          arrow: true,
          tag: each.proposal && WAITING(),
          text: each.summary,
        });
        makeDraggable(one, 'schema', each.id);
        one.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          moveMenu(each, groups, event);
        });
        return one;
      })),
      column('Drafts', {
        sort: 'drafts',
        // A draft's: its number, its note, and when.
        skeleton: [[22, 62, 20], [24, 48, 20], [20, 54, 20]],
      },
        schema?.proposal && row({
          attributes: { 'data-proposal': schema.proposal.id },
          className: 'proposal-row',
          onclick: () => go([level(schema.id, { proposal: true, label: schema.name })]),
          // Named as the top bar names it, and as SmartDoc names its draft preview.
          title: `Draft ${(schema.drafts ?? 0) + 1} preview`,
          tag: WAITING(),
          text: schema.proposal.note,
          meta: when(schema.proposal.createdAt),
        }),
        ...drafts.map((draft) => row({
          attributes: { 'data-draft': draft.id },
          // The latest follows the schema as it changes; an earlier one stays where it is.
          onclick: () => go([level(schema.id, { draftId: draft.latest ? null : draft.id, label: schema.name })]),
          title: `Draft ${draft.number}`,
          text: draft.note,
          meta: when(draft.createdAt),
        }))));
  }

  async function openMenu(items, actions) {
    const chosen = await api.showHomeMenu(items);
    actions[chosen]?.();
  }
  function cutItem(item) {
    cut = item;
    render();
  }
  async function paste() {
    if (!cut || !canGo(cut, shownFolder)) return;
    const item = cut;
    cut = null;
    await moveItem(item, shownFolder);
  }
  // The Edit menu's Cut and Paste, and their keys, on home, outside anything being typed in.
  const typing = (event) => event.target.closest?.('input, textarea, select, [contenteditable]') || path.length || document.querySelector('dialog[open]');
  document.addEventListener('cut', (event) => {
    if (typing(event) || window.getSelection()?.toString()) return;
    const on = document.activeElement?.closest?.('[data-folder], [data-group]');
    if (on?.dataset.folder) cutItem({ kind: 'folder', id: on.dataset.folder });
    else if (on?.dataset.group && on.dataset.group !== UNGROUPED) cutItem({ kind: 'domain', id: on.dataset.group });
  });
  document.addEventListener('paste', (event) => {
    if (!typing(event) && cut) paste();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cut && !path.length) cutItem(null);
  });

  function startNaming(target) {
    naming = target;
    render();
  }

  // A domain's or folder's name being written: a new one's, or a rename. Enter or leaving it saves,
  // Escape doesn't, and a name that's refused says why, keeping what was typed. A new one goes in the
  // folder showing.
  function namingRow(name) {
    const target = naming;
    const folder = target.kind === 'folder';
    const words = folder ? 'Folder name' : 'Domain name';
    const field = h('input', { className: 'group-name-input', type: 'text', value: name, 'aria-label': target.id ? words : `New ${words.toLowerCase()}`, placeholder: folder ? 'Folder name, such as a department' : 'Domain name, such as Auth or Payments', maxlength: '80' });
    const said = h('span', { className: 'group-name-error', role: 'alert' });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      const named = field.value.trim();
      if (!save || !named || named === name) {
        done = true;
        naming = null;
        return render();
      }
      try {
        done = true;
        if (folder) {
          if (target.id) await api.renameFolder(target.id, named);
          else await api.createFolder(named, shownFolder);
        } else if (target.id) await api.renameGroup(target.id, named);
        else {
          const made = await api.createGroup(named, shownFolder);
          selectedGroup = made.id;
          selected = null;
        }
        naming = null;
        render();
      } catch (error) {
        done = false;
        said.textContent = String(error.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        field.focus();
      }
    };
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    field.addEventListener('blur', () => setTimeout(() => document.activeElement !== field && finish(true)));
    setTimeout(() => {
      field.focus();
      field.select();
    });
    return h('div', { className: 'group-naming' }, field, said);
  }

  // Something dragged can be dropped on: a place (a folder, or null for the top level) takes a domain
  // or a folder, and a domain takes a schema. With `opens`, held over it for a moment, a folder opens
  // there instead, whatever is dragged, and the drag carries on.
  function dropTarget(node, { place, domain, opens = false, key = null }) {
    const takes = () => {
      if (!drag) return false;
      if (drag.kind === 'schema') return domain !== undefined;
      return place !== undefined && canGo(drag, place);
    };
    const leave = () => {
      node.classList.remove('drop-here');
      if (opens && hover?.key === (key ?? place)) stopHover();
    };
    node.addEventListener('dragover', (event) => {
      if (!drag) return;
      event.stopPropagation();
      // A folder doesn't open as itself is dragged over it.
      if (opens && !hover && place !== drag.id) {
        hover = { key: key ?? place, timer: setTimeout(() => {
          hover = null;
          showFolder(place, { keepSelection: true });
        }, HOVER_OPENS_MS) };
      }
      if (!takes()) {
        event.dataTransfer.dropEffect = 'none';
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      node.classList.add('drop-here');
    });
    // Moving between a target's own parts fires dragleave too; only leaving its bounds counts.
    node.addEventListener('dragleave', (event) => {
      const box = node.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom) leave();
    });
    node.addEventListener('drop', async (event) => {
      if (!drag) return;
      event.preventDefault();
      event.stopPropagation();
      leave();
      stopHover();
      if (!takes()) return;
      drag.dropped = true;
      if (drag.kind === 'schema') {
        selected = drag.id;
        await api.moveSchema(drag.id, domain === UNGROUPED ? null : domain);
      } else await moveItem(drag, place);
    });
  }
  function stopHover() {
    clearTimeout(hover?.timer);
    hover = null;
  }
  function makeDraggable(node, kind, id) {
    node.draggable = true;
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData(DRAG_TYPE, id);
      event.dataTransfer.effectAllowed = 'move';
      drag = { kind, id, from: shownFolder, itemEl: node, dropped: false };
      node.classList.add('browser-dragging');
    });
    node.addEventListener('dragend', () => {
      const { kind: was, id: which, from, dropped } = drag ?? {};
      drag = null;
      stopHover();
      node.remove();
      // Called off: back where it started, with nothing moved.
      if (!dropped) {
        shownFolder = from ?? null;
        if (was === 'schema') selected = which;
      }
      render();
    });
  }
  // A dragged row stays in the page while home is drawn again under it, or the drag would end.
  let holder = null;
  function holdDragged() {
    if (!drag?.itemEl) return;
    holder ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'browser-drag-holder' });
    holder.append(drag.itemEl);
  }

  // A schema's right-click menu: the domains it can move to, each with its folder's path.
  function moveMenu(schema, groups, event) {
    document.querySelector('.move-menu')?.remove();
    const here = schema.group ?? UNGROUPED;
    const choices = [[UNGROUPED, 'No domain', null], ...groups.map((group) => [group.id, group.name, group.path])].filter(([id]) => id !== here);
    const menu = h('div', { className: 'move-menu', role: 'menu', 'aria-label': `Move ${schema.name} to` },
      // Its icon, chosen in a card beside the row (icon-picker.js).
      h('button', { type: 'button', role: 'menuitem', 'data-icon': '', onclick: () => {
        menu.remove();
        onChooseIcon({ docId: schema.id, current: schema.icon, name: schema.name, at: { left: event.clientX, top: event.clientY } });
      } }, 'Change Icon…'),
      h('span', { className: 'move-menu-head' }, 'Move to'),
      ...(choices.length ? choices.map(([id, name, folder]) => h('button', { type: 'button', role: 'menuitem', 'data-move-to': id, onclick: async () => {
        menu.remove();
        await api.moveSchema(schema.id, id === UNGROUPED ? null : id);
        render();
      } }, name, folder && h('span', { className: 'move-menu-path' }, folder))) : [h('span', { className: 'move-menu-none' }, 'Make a domain first, with the button above Domains.')]));
    document.body.append(menu);
    const { width, height } = menu.getBoundingClientRect();
    Object.assign(menu.style, { left: `${Math.min(event.clientX, innerWidth - width - 8)}px`, top: `${Math.min(event.clientY, innerHeight - height - 8)}px` });
    menu.querySelector('button')?.focus();
    const close = (next) => {
      if (next.type === 'keydown' && next.key !== 'Escape') return;
      if (next.type === 'mousedown' && menu.contains(next.target)) return;
      menu.remove();
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', close, true);
    };
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', close, true);
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // A column's sort, as on SmartDoc's home: a button at the right of its title with the sort's name,
  // then its icon, opening a menu of the sorts like the MCP panel's app picker.
  function sortControl(column) {
    const options = SORTS[column];
    const button = h('button', { className: 'browser-sort', id: `sort-${column}`, type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Sort by: ${sorts[column][1]}` },
      h('span', { className: 'browser-sort-text' }, sorts[column][1]));
    button.insertAdjacentHTML('beforeend', SORT_ICON);
    const items = options.map(([id, label]) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(id === sorts[column][0]), onclick: () => choose(id) }, label));
    const menu = h('div', { className: 'app-picker-menu browser-sort-menu', role: 'menu' }, ...items);
    menu.hidden = true;
    const picker = h('div', { className: 'browser-sort-picker' }, button, menu);
    // A press elsewhere closes it. Home is drawn again on each change, so this only listens while open.
    const outside = (event) => {
      if (!picker.contains(event.target)) setOpen(false);
    };
    function setOpen(open) {
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        document.addEventListener('pointerdown', outside, true);
        items.find((item) => item.getAttribute('aria-checked') === 'true')?.focus();
      } else document.removeEventListener('pointerdown', outside, true);
    }
    function choose(id) {
      setOpen(false);
      sorts[column] = options.find(([one]) => one === id);
      try {
        localStorage.setItem(`sort-${column}`, id);
      } catch {}
      render();
      // Drawn again: the focus goes back to this column's new button.
      requestAnimationFrame(() => document.getElementById(`sort-${column}`)?.focus());
    }
    button.addEventListener('click', () => setOpen(menu.hidden));
    // Up or Down on the button opens the menu too.
    button.addEventListener('keydown', (event) => {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }
    });
    // The focus moving on closes it; Escape closes it back onto the button. Its keys stay its own,
    // not home's arrow keys between rows.
    picker.addEventListener('focusout', (event) => {
      if (!menu.hidden && event.relatedTarget && !picker.contains(event.relatedTarget)) setOpen(false);
    });
    menu.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.focus();
    });
    arrowKeysIn(menu);
    return picker;
  }

  // A column of rows. With none, it shows placeholder rows instead, fading out, and its sort is
  // hidden (keeping its room, so the titles stay level), as SmartDoc's home does: `skeleton` is each placeholder's line widths, in percent.
  function column(title, { sort, skeleton }, ...rows) {
    const shown = rows.filter(Boolean);
    const placeholder = (widths) => h('div', { className: 'browser-row' }, ...widths.map((width) => h('span', { className: 'skeleton-bar', style: `width: ${width}%` })));
    return h('section', { className: `browser-column${shown.length ? '' : ' browser-column-unused'}`, 'aria-label': title },
      h('div', { className: 'browser-head' }, h('h2', {}, title), sortControl(sort)),
      shown.length
        ? h('ul', { className: 'browser-list' }, ...shown.map((one) => h('li', {}, one)))
        : h('div', { className: 'browser-list browser-skeleton', 'aria-hidden': 'true' }, ...skeleton.map(placeholder)));
  }

  // A new schema: what it's for, and a prompt asking the AI to design it, from the File menu.
  function newSchema() {
    if (document.querySelector('.prompt-dialog')) return;
    const field = h('textarea', { className: 'focus-goal-input', id: 'new-schema-goal', rows: 3, 'aria-label': 'What the schematic should describe', placeholder: 'What should your AI design? For example: the billing system, or machine to machine auth as a standard' });
    const dialog = h('dialog', { className: 'prompt-dialog', 'aria-labelledby': 'prompt-title' },
      h('h2', { id: 'prompt-title' }, 'New schematic'),
      h('p', {}, 'Your AI designs it, and you accept it here.'),
      field,
      h('div', { className: 'prompt-buttons' },
        h('button', { className: 'secondary-button', type: 'button', id: 'new-schema-close', onclick: () => dialog.close() }, 'Close'),
        copyButton('primary-button', 'Copy the prompt', 'new-schema-copy', () => [
          field.value.trim() ? `Design a new schematic in SmartSpec for: ${field.value.trim()}` : 'Ask me what to design, then propose a new schematic in SmartSpec.',
          api.windowId && `Take over SmartSpec window ${api.windowId} with use_window first.`,
        ].filter(Boolean).join(' '))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    field.focus();
  }

  // An arrow says a schema leads on to its drafts.
  function row({ attributes, className = '', onclick, title, icon = null, tag, text, meta, arrow = false }) {
    // A schematic's icon (main/icons.js) before its name, as on its tab.
    const mark = icon && h('span', { className: 'home-doc-icon', 'aria-hidden': 'true' });
    if (mark) mark.innerHTML = iconSvg(icon, 15);
    const button = h('button', { ...attributes, className: `browser-row ${className}`, type: 'button', onclick },
      h('span', { className: 'title-row' }, h('strong', {}, ...(mark ? [mark] : []), title), statusPills(tag)),
      h('span', { className: 'browser-row-text' }, text),
      meta && h('span', { className: 'browser-row-meta' }, meta));
    if (arrow) {
      const icon = h('span', { className: 'browser-arrow', 'aria-hidden': 'true' });
      icon.innerHTML = ARROW_ICON;
      button.append(icon);
    }
    return button;
  }

  // --- One schema ---------------------------------------------------------------------------

  async function schemaView(here) {
    // Refreshes overlap (a change arrives as the user's answer returns), so each works this out for
    // itself: a proposal that has gone means the draft it became, or the one it was set against.
    let shown = null;
    if (here.proposal) {
      shown = await api.getProposal(here.schemaId).catch(() => null);
      if (!shown) {
        here.proposal = false;
        here.draftId = null;
      }
    }
    if (!shown) shown = await api.getSchema(here.schemaId, here.draftId).catch(() => null);
    if (!shown) {
      // It was discarded: back to the level above. A schematic's tab with nothing left in it closes.
      const at = path.indexOf(here);
      if (at >= 0) path = path.slice(0, at);
      if (path.length) return schemaView(top());
      if (inTab) {
        if (hadSchema) api.tabClose();
        return waitingView();
      }
      return homeView();
    }
    hadSchema = true;
    here.label = shown.name;
    const opened = here.proposal ? (shown.total ? `Reviewing the proposed changes to “${shown.name}”` : `Reviewing the new schematic “${shown.name}”`) : `Opened “${shown.name}”, draft ${shown.number} of ${shown.total}`;
    onShown({ chatId: `${here.schemaId}/${here.proposal ? shown.basedOn ?? 'new' : shown.draftId}`, name: shown.name, line: { text: opened, detail: `${opened} (schematic_id ${here.schemaId})` } });

    const uses = new Map(shown.uses.map((use) => [use.id, use]));
    // What the proposal removes can still be opened while reviewing it, to see what goes.
    const known = (id) => id === CONTRACT || uses.has(id) || shown.items.some((item) => item.id === id) || Boolean(shown.changes?.removed.some((item) => item.id === id));
    if (!known(here.item)) here.item = CONTRACT;

    // Going into an embedded schema, from its overview here. `item` is where to land, if not its contract.
    const openUse = (use, item) => {
      if (!use.missing) go([...path, level(use.schemaId, { draftId: use.draftId, label: use.name, item })]);
    };
    // A link followed brings what it goes to into the middle. `from` is the item it's in.
    const follow = (link, from = here.item) => {
      const { target, part } = parseLink(link, from);
      if (!known(target)) return undefined;
      here.item = target;
      here.focus = part;
      here.bring = true;
      remember();
      return render();
    };

    here.choices = { shown };
    approvals = new Set(here.proposal ? shown.approved ?? [] : []);
    if (modes.mode() === 'test') {
      const page = testView(shown);
      page.draftNav = draftControls(here, shown);
      page.bottomBar = reviewBar(here, shown);
      return page;
    }

    // Full screen from the overview is the same as from Focus; leaving it goes back to the overview.
    if (layout === 'overview' && !here.full) {
      const connections = await api.getConnections(here.schemaId, here.proposal ? { proposal: true } : { draftId: shown.draftId }).catch(() => ({}));
      const page = await overviewView(here, shown, uses, connections, openUse);
      page.draftNav = draftControls(here, shown);
      page.bottomBar = reviewBar(here, shown);
      return page;
    }

    const page = h('div', { className: `page schema-page${here.full ? ' full' : ' board-page'}` },
      await boardView(here, shown, uses, follow, openUse));
    page.draftNav = draftControls(here, shown);
    page.bottomBar = reviewBar(here, shown);
    return page;
  }

  // Test mode: nothing to test against yet, and it says so rather than pretending.
  const testView = (shown) => h('div', { className: 'mode-empty' },
    h('h1', {}, 'Testing isn’t built yet'),
    h('p', {}, `This is where ${shown.name} will link to its implementation and run its contract tests, and you’ll see what’s passing or failing.`));

  // In the toolbar, with a schema open: the mode, and the focus: what the AI's work on this draft is
  // for.
  function breadcrumb() {
    if (!path.length) return [];
    // (Home is a tab of its own, in the window's top bar.)
    const list = [modes.button];
    // A focus is what the AI's design work is for, so it belongs to Design.
    if (modes.mode() === 'design' && top().choices) list.push(focusButton(top()));
    return list;
  }

  // The focus: what this draft was written for. Clicking it opens the card to set the AI a new one.
  function focusButton(here) {
    const { shown } = here.choices;
    const focus = shown.focus;
    const label = focus?.title ?? 'No focus yet';
    const button = h('button', { className: 'tool-button crumb-focus', type: 'button', id: 'focus-button', title: focus?.goal ?? label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': focusMenu.id },
      h('span', { className: 'crumb-here' }, label));
    button.insertAdjacentHTML('beforeend', CHEVRON);
    button.addEventListener('click', async () => {
      if (!focusMenu.hidden) return setFocusMenuOpen(false);
      focusMenu.style.left = `${button.getBoundingClientRect().left}px`;
      await fillFocusMenu(here);
      return setFocusMenuOpen(true);
    });
    return button;
  }

  const closeFocus = () => { focusMenu.hidden = true; };

  function setFocusMenuOpen(open) {
    focusMenu.hidden = !open;
    document.getElementById('focus-button')?.setAttribute('aria-expanded', String(open));
  }

  // The prompt to send the AI. It names the window, so the AI that gets it works in this one.
  const focusPrompt = (shown, goal, title) => [
    `Work on the design of “${shown.name}” (schematic ${shown.id}) in SmartSpec${goal ? `, focusing on: ${goal}` : ', and suggest improvements.'}`,
    title && `Call this focus “${title}”.`,
    api.windowId && `Take over SmartSpec window ${api.windowId} with use_window first.`,
  ].filter(Boolean).join(' ');

  function copyButton(kind, text, id, getPrompt) {
    const button = h('button', { className: `${kind} focus-copy`, type: 'button', id });
    button.textContent = text;
    let reset;
    button.addEventListener('click', async () => {
      await api.copyText(getPrompt());
      button.textContent = 'Copied';
      clearTimeout(reset);
      reset = setTimeout(() => { button.textContent = text; }, 1500);
    });
    return button;
  }

  // This draft's focus, earlier drafts' to run again, and a new one.
  async function fillFocusMenu(here) {
    const { shown } = here.choices;
    const { current, earlier } = await api.listFocuses(here.schemaId, here.proposal ? { proposal: true } : { draftId: shown.draftId });
    const heading = (text) => h('h2', { className: 'focus-heading' }, text);
    const field = h('textarea', { className: 'focus-goal-input', id: 'focus-goal', rows: 2, 'aria-label': 'What the AI should focus on', placeholder: 'What should your AI focus on? Leave empty for general improvements. For example: what happens when the ledger is down' });
    focusMenu.replaceChildren(
      heading(here.proposal ? 'On this proposal' : 'On this draft'),
      current
        ? h('div', { className: 'tool-option focus-option focus-current' }, h('span', { className: 'tool-option-text' },
          h('strong', {}, current.title),
          current.goal !== current.title && h('span', { className: 'focus-goal' }, current.goal)))
        : h('p', { className: 'focus-empty' }, 'No focus on this draft.'),
      ...(earlier.length ? [heading('From earlier drafts')] : []),
      ...earlier.map((focus, index) => h('div', { className: 'tool-option focus-option focus-earlier' },
        h('span', { className: 'tool-option-text' },
          h('strong', {}, focus.title),
          focus.goal !== focus.title && h('span', { className: 'focus-goal' }, focus.goal),
          h('span', { className: 'focus-meta' }, `From ${focus.draft}`)),
        copyButton('secondary-button', 'Copy the prompt to run it again', `focus-again-${index}`, () => focusPrompt(shown, focus.goal, focus.title)))),
      heading('New focus'),
      h('div', { className: 'focus-new' }, field, copyButton('primary-button', 'Copy the prompt', 'focus-copy', () => focusPrompt(shown, field.value.trim()))),
      api.windowId && h('p', { className: 'take-over-note' }, 'Your AI will take over this window when you send it the prompt.'),
    );
  }

  // The draft controls: the draft showing, with arrows to the ones either side, and its note on
  // hover. A proposal counts as the draft it would become.
  // The drafts, in the top bar just after the focus, as SmartDoc's: the draft showing (or the next
  // draft's preview, for a proposal), opening a card of the schematic's drafts, newest first, each
  // with when it was made and its note, the proposal waiting on it first as the next draft's preview,
  // the one showing marked. Choosing one shows it. It replaced Previous and Next buttons either side
  // of the name (the user's choice, as in SmartDoc).
  const draftCard = Object.assign(document.createElement('div'), { className: 'tool-card draft-card', id: 'draft-card', hidden: true });
  draftCard.setAttribute('role', 'menu');
  draftCard.setAttribute('aria-label', 'Drafts');
  document.body.append(draftCard);
  let draftButton = null;
  const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  function draftControls(here, shown) {
    const label = here.proposal ? `Draft ${shown.total + 1} preview` : `Draft ${shown.number} of ${shown.total}`;
    const button = h('button', { className: 'tool-button draft-button', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: shown.note ?? null, onclick: () => openDrafts(here, shown, button) },
      h('span', { className: 'draft-label' }, label));
    button.insertAdjacentHTML('beforeend', CHEVRON);
    draftButton = button;
    closeDrafts();
    return [button];
  }
  function closeDrafts() {
    draftCard.hidden = true;
    draftButton?.setAttribute('aria-expanded', 'false');
  }
  async function openDrafts(here, shown, button) {
    if (!draftCard.hidden) return closeDrafts();
    const at = button.getBoundingClientRect();
    draftCard.style.left = `${Math.max(8, Math.min(innerWidth - 320 - 8, at.left))}px`;
    draftCard.replaceChildren(h('p', { className: 'focus-empty' }, 'Loading drafts…'));
    draftCard.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const drafts = await api.listDrafts(here.schemaId).catch(() => []);
    if (draftCard.hidden) return;
    const when = (date) => (date ? new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);
    const option = (name, about, checked, go) => h('button', { className: 'tool-option draft-option', type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), onclick: () => { closeDrafts(); if (!checked) go(); } },
      h('span', { className: 'tool-option-text' }, h('strong', {}, name), about && h('span', { className: 'draft-about' }, about)));
    const waiting = here.proposal ? shown : shown.proposal;
    draftCard.replaceChildren(
      waiting && option(`Draft ${shown.total + 1} preview`, [when(waiting.createdAt), 'Proposed by the AI, for you to review'].filter(Boolean).join(' · '), Boolean(here.proposal), () => { here.proposal = true; here.draftId = null; remember(); render(); }),
      ...drafts.map((draft) => option(`Draft ${draft.number}`, [when(draft.createdAt), draft.note].filter(Boolean).join(' · '), !here.proposal && draft.id === shown.draftId,
        () => { here.proposal = false; here.draftId = draft.latest ? null : draft.id; remember(); render(); })),
    );
    if (!drafts.length && !waiting) draftCard.append(h('p', { className: 'focus-empty' }, 'No drafts yet.'));
  }
  document.addEventListener('pointerdown', (event) => {
    if (!draftCard.hidden && !draftCard.contains(event.target) && !draftButton?.contains(event.target)) closeDrafts();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !draftCard.hidden) closeDrafts();
  });

  // Left-aligned, just after the breadcrumb (its mode and focus), as SmartDoc's: when that leaves no
  // room before the right-hand controls, the label goes, then the control too. Each time starts from
  // everything shown.
  const DRAFT_NAV_GAP = 12;
  function placeDraftNav() {
    if (draftNav.hidden) return;
    draftNav.classList.remove('compact', 'collapsed');
    const bar = draftNav.parentElement.getBoundingClientRect();
    const end = draftNav.parentElement.querySelector('.top-bar-end').getBoundingClientRect().left - DRAFT_NAV_GAP - bar.left;
    const fits = () => {
      const last = crumbs.lastElementChild?.getBoundingClientRect().right ?? bar.left;
      const start = last + DRAFT_NAV_GAP - bar.left;
      draftNav.classList.add('pushed');
      draftNav.style.left = `${start}px`;
      return start + draftNav.offsetWidth <= end;
    };
    if (fits()) return;
    draftNav.classList.add('compact');
    if (fits()) return;
    draftNav.classList.add('collapsed');
  }


  // The bottom bar is about this view. It shows everywhere but home, so it always has something to
  // say: the app's own short sentence on what's being done now or what needs doing, not the AI's note
  // and not what each button does, on one line that never wraps (the full sentence is on hover).
  // What there is to decide is a card in the chat's conversation, saying what it is, with its
  // buttons, not in the bar (the user wants the chat to be where they work, the AI leading):
  // `{ said, cards }`, each card as chat-panel.js takes them, its actions with `run`. The first of
  // these that applies is what it says.
  const reviewLine = (said) => h('p', { className: 'review-bar-text', title: said }, said);
  // The bottom bar is the actions bar: what there is to decide about the view (a card from
  // reviewBar), what it is and a line on what's happening now and what deciding does, on the left,
  // with its buttons on the right (the user's choice: it was a sentence, then a banner across the
  // top); with nothing to decide, its sentence on what's going on. It explains, and no more: what's
  // in a proposal, and the AI's note on it, are for the board and the chat (the user's choice).
  function showBar(view) {
    bottomBar.hidden = !view;
    if (!view) return bottomBar.replaceChildren();
    const card = view.cards?.[0];
    if (!card) return bottomBar.replaceChildren(reviewLine(view.said));
    const line = [...(card.lines ?? []), card.decide].filter(Boolean).join(' ');
    bottomBar.replaceChildren(
      h('div', { className: 'review-bar-card' },
        h('div', { className: 'review-bar-title' }, card.title),
        line && h('div', { className: 'review-bar-line', title: line }, line),
      ),
      h('div', { className: 'review-bar-actions' }, ...(card.actions ?? []).map((action) => h('button', {
        className: action.kind === 'primary' ? 'primary-button' : 'secondary-button',
        type: 'button',
        'data-action': action.id,
        title: action.title ?? null,
        onclick: () => action.run?.(),
      }, action.label))));
  }
  const bar = (said, card = null, shortcuts = []) => ({ said, cards: card ? [card] : [], shortcuts: shortcuts.filter(Boolean) });
  const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
  function reviewBar(here, shown) {
    const name = shown.name;
    // A proposal under review: the card says what it is and what accepting does, with the user's
    // answers. Comments the AI hasn't answered are a shortcut over the message box: the go-ahead
    // for an AI in another app waiting on the proposal, to deal with them before accepting (its wait
    // ends saying so: see store.sendComments), or else a request to the chat's AI to answer them;
    // shown again for each new comment (its `key`).
    if (here.proposal) {
      const { waiting = 0, sent = 0 } = shown.forTheAi ?? {};
      const unsent = waiting - sent;
      const aiWaits = aiWaiting.includes(shown.proposalId);
      const isNew = !shown.total;
      const askText = `I’ve commented on the ${isNew ? 'proposed new schematic' : 'proposed changes to'} ${name} (schematic ${here.schemaId}). Read my comments, answer each one, and propose again if they need changes.`;
      // Comments sent to an AI in another app that has stopped waiting may be with it, or not: the
      // chat's AI can still be asked.
      const shortcut = unsent > 0 && aiWaits
        ? { id: 'send-comments', key: `send-comments:${shown.proposalId}:${unsent}`, kind: 'primary', label: `Send ${many(unsent, 'comment')} to your AI`, title: 'Ask the AI to answer your comments, and change what it proposed if it needs to', run: () => answer(() => api.sendComments(here.schemaId)) }
        : waiting > 0 && !aiWaits && { id: 'ask-comments', key: `ask-comments:${shown.proposalId}:${waiting}`, label: `Ask the AI to answer ${waiting === 1 ? 'your comment' : `your ${waiting} comments`}`, title: 'Asks the AI in the chat to answer your comments, and change what it proposed if they need it', text: askText };
      // An item full screen: the bar is about it.
      const item = here.full ? fullItem(here, shown) : null;
      const reviewed = bar(sent && !unsent ? `The AI is dealing with your ${many(sent, 'comment')} on ${name}.`
        : isNew ? `You're reviewing ${name}, a new schematic the AI has proposed.` : `You're reviewing changes the AI has proposed to ${name}.`, {
        id: `proposal-${shown.proposalId}`,
        at: shown.createdAt ?? null,
        title: item ? `${item.title}, ${isNew ? `in the new schematic ${name}` : `in the proposed changes to ${name}`}` : isNew ? `New schematic: ${name}` : `Proposed changes to ${name}`,
        lines: [
          item?.line ?? approvedLine(shown),
          sent && !unsent ? `The AI is dealing with your ${many(sent, 'comment')}.`
            : unsent ? `You have ${many(unsent, 'comment')} the AI hasn’t answered${aiWaits ? ', and it’s waiting for the go-ahead' : ''}.` : null,
        ].filter(Boolean),
        decide: isNew ? 'Accept to make it a schematic, or discard it.' : `Accept to make it draft ${shown.total + 1} of ${name}, or discard it.`,
        actions: [
          { id: 'proposal-discard', label: 'Discard', run: () => answer(async () => {
            await api.discardProposal(here.schemaId);
            // The chat stays the draft's, so it knows what became of the proposal.
            onNote({ text: `Discarded the proposed ${isNew ? 'new schematic' : 'changes to'} ${name}`, detail: `Discarded the proposed ${isNew ? 'new schematic' : 'changes to'} ${name} (schematic ${here.schemaId})` });
          }) },
          { id: 'proposal-accept', label: 'Accept', kind: 'primary', run: () => answer(async () => {
            if (await api.acceptProposal(here.schemaId) === 'ask') onAsk(askText);
          }) },
        ],
      }, [shortcut]);
      // The proposal is decided from the schematic's own view, not from one item in it (the user's
      // choice): full screen, the bar only says how the item shows.
      if (item) Object.assign(reviewed.cards[0], { decide: null, actions: [] });
      return reviewed;
    }
    // A proposal waiting on this schematic.
    if (shown.proposal) {
      return bar(`The AI has proposed changes to ${name} for you to review.`, {
        id: `proposal-${shown.proposal.id}`,
        at: shown.proposal.createdAt ?? null,
        title: `Proposed changes to ${name}`,
        decide: 'Review them to accept or discard them.',
        actions: [{ id: 'view-proposal', label: 'Review', kind: 'primary', run: () => { here.proposal = true; render(); } }],
      });
    }
    if (modes.mode() === 'test') return bar(`Contract tests for ${name} aren't built yet.`);
    // An earlier draft, with the way back to the latest.
    if (shown.number < shown.total) {
      return bar(`You're looking at draft ${shown.number} of ${name}. Draft ${shown.total} is the latest.`, {
        id: `earlier-${shown.draftId}`,
        at: null,
        title: `Draft ${shown.number} of ${shown.total}`,
        decide: `This is an earlier draft of ${name}. Draft ${shown.total} is the latest.`,
        actions: [{ id: 'latest-draft', label: 'Go to the latest', run: () => { here.draftId = null; remember(); render(); } }],
      });
    }
    // Inside a schematic embedded in another.
    const within = path.length > 1 ? `, inside ${path[path.length - 2].label}` : '';
    if (layout === 'overview') return bar(`You're looking at everything in ${name}${within}.`);
    if (!here.full) return bar(`You're working on ${name}${within}.`);
    const use = shown.uses.find((one) => one.id === here.item);
    if (use) return bar(use.missing ? `The schematic embedded here is no longer available.` : `${use.name} is embedded in ${name}, at its draft ${use.number}.`);
    const what = here.item === CONTRACT ? `the contract of ${name}` : `${shown.items.find((one) => one.id === here.item)?.title ?? here.item}, in ${name}${within}`;
    return bar(`You're looking at ${what}, full screen.`);
  }

  // How many of the proposal's changes the user has approved, for the bar.
  function approvedLine(shown) {
    const changes = shown.changes;
    if (!changes) return null;
    const total = Object.keys(changes.items).length + changes.removed.length + (changes.contract ? 1 : 0);
    const done = approvals.size;
    if (!total) return null;
    if (!done) return `Approve each change as you go, or accept them all as proposed.`;
    return done >= total ? `You’ve approved all ${total === 1 ? 'of it' : `${total} changes`}.` : `You’ve approved ${done} of ${total} changes; the rest are accepted as proposed.`;
  }

  // The item showing full screen while a proposal is reviewed: its title, and a line on how it shows
  // (or what the proposal does to it). Its controls are in its own drawer (see cardDrawer).
  const SHOWING = {
    changes: () => 'Showing what the proposal changes in it: new in green, removed in red, changed in amber.',
    before: (number) => `Showing it as it is in draft ${number}.`,
    after: () => 'Showing it as it would be once accepted.',
  };
  function fullItem(here, shown) {
    const use = shown.uses.find((one) => one.id === here.item);
    const title = here.item === CONTRACT ? 'The contract' : use ? use.name ?? use.id : shown.items.find((one) => one.id === here.item)?.title
      ?? shown.changes?.removed?.find((one) => one.id === here.item)?.title ?? here.item;
    const mark = here.item === CONTRACT ? (shown.changes?.contract ? 'changed' : null)
      : shown.changes?.removed?.some((one) => one.id === here.item) ? 'removed' : shown.changes?.items?.[here.item];
    const diff = here.fullDiff;
    const line = diff?.showing ? SHOWING[diff.showing](diff.basedOn)
      : mark === 'added' ? 'New in this proposal.' : mark === 'removed' ? 'The proposal removes it.' : mark === 'changed' ? 'The proposal changes it.' : 'The proposal doesn’t change it.';
    return { title, line };
  }

  // Where this is in the schema's drafts.
  function draftBar(here, shown) {
    const at = shown.number - 1;
    const step = (delta, label, symbol) => h('button', {
      className: 'icon-button',
      type: 'button',
      'aria-label': label,
      title: label,
      disabled: !shown.line[at + delta],
      onclick: () => { here.draftId = shown.line[at + delta]; render(); },
    }, symbol);
    return h('div', { className: 'draft-bar' },
      step(-1, 'Previous draft', '‹'),
      h('span', { className: 'draft-label' }, `Draft ${shown.number} of ${shown.total}`),
      step(1, 'Next draft', '›'),
      shown.note && h('span', { className: 'draft-note' }, shown.note));
  }

  // The answer can be refused, or asked about first: either way the window then shows what's so.
  async function answer(act) {
    try {
      await act();
    } finally {
      render();
    }
  }

  // Each item keeps its own name through a move, so the browser can carry its card to its new place.
  const moves = (id) => `view-transition-name: item-${id}`;
  // A comment on the whole schematic has a place on the board like an item's, under this and its id.
  const WHOLE = 'comment:';
  // What the proposal does to an item, until the user approves it: then Accepted (the user's choice).
  const marker = (mark, approved = false) => (!mark ? [] : approved ? [pill('Accepted', 'item-change accepted')] : [pill(CHANGE_LABELS[mark], `item-change ${mark}`)]);
  // The changes the user has approved in the proposal showing (see approveButton).
  let approvals = new Set();

  // Where the user has placed each schematic's items on the board, as loaded, or as changed here
  // since (see board.js). Kept on this computer a moment after the user stops moving things, never
  // with the schematic.
  const layouts = new Map();
  async function layoutOf(schemaId) {
    if (!layouts.has(schemaId)) layouts.set(schemaId, cleanLayout(await api.getLayout(schemaId).catch(() => null)));
    return layouts.get(schemaId);
  }
  const saving = new Map();
  function keepLayout(schemaId, layout) {
    layouts.set(schemaId, layout);
    clearTimeout(saving.get(schemaId));
    saving.set(schemaId, setTimeout(() => api.saveLayout(schemaId, layoutToSave(layout, Object.keys(layout.boxes))).catch(() => {}), 400));
  }
  // The website's demo starts each scene from the board as first laid out (the app never does).
  api.onLayoutsReset?.(() => {
    for (const timer of saving.values()) clearTimeout(timer);
    saving.clear();
    layouts.clear();
  });

  // The item linked with the most others: what a schematic with no layout yet starts on.
  const mostLinked = (ids, pairs) => {
    const counts = new Map();
    for (const pair of pairs) for (const id of pair) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...ids].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];
  };

  // The focus view: every item in the schematic on a board, where the user has placed it (see
  // board-view.js). The middle is for working on things; out to the sides they're smaller, and at the
  // edges they're cards. Full screen, one item has the whole window.
  async function boardView(here, shown, uses, follow, openUse) {
    // Under review, what the proposal removes is still here, as it was in the draft it changes.
    const removed = here.proposal ? shown.changes?.removed ?? [] : [];
    const isRemoved = (id) => removed.some((one) => one.id === id);
    const ids = [CONTRACT, ...shown.items.map((one) => one.id), ...shown.uses.map((use) => use.id), ...removed.map((one) => one.id)];
    if (!ids.includes(here.item)) here.item = CONTRACT;
    const on = here.proposal ? { proposal: true } : { draftId: shown.draftId };
    const contents = new Map();
    const content = (id) => {
      if (id === CONTRACT || uses.has(id)) return Promise.resolve(null);
      if (!contents.has(id)) contents.set(id, api.getItem(here.schemaId, id, isRemoved(id) ? { draftId: shown.basedOn } : on).catch(() => null));
      return contents.get(id);
    };
    const mark = (id) => (id === CONTRACT ? (shown.changes?.contract ? 'changed' : null) : isRemoved(id) ? 'removed' : shown.changes?.items[id]);
    const views = { shown, uses, content, mark, follow, openUse, isRemoved };

    if (here.full) return h('div', { className: 'focus-full' }, await fullView(here, here.item, { ...views, full: true }));

    // Every comment on this draft or proposal, and the earlier ones still about something here (see
    // store.js). Those on an item gather by what they're on, each lot with a marker there (see
    // comments.js); those on the schematic as a whole are cards on the board, placed like items.
    const [comments, earlier] = await Promise.all([api.listComments(here.schemaId, on).catch(() => []), api.listEarlierComments(here.schemaId, on).catch(() => [])]);
    const everything = [...comments, ...earlier];
    const groups = groupComments(everything.filter((comment) => !comment.target.schematic && !comment.target.missing && ids.includes(comment.target.item)));
    const onWhole = everything.filter((comment) => comment.target.schematic);

    let layout = await layoutOf(here.schemaId);
    const fresh = !Object.keys(layout.boxes).length;
    const asked = here.bring || here.item !== CONTRACT;
    // Brought to the middle (with no layout yet, it starts there anyway).
    if (here.bring && !fresh) {
      layout = bringToMiddle(layout, here.item, { width: el.clientWidth, height: el.clientHeight }, { alone: here.bring === 'alone' });
      keepLayout(here.schemaId, layout);
    }
    here.bring = false;
    const pairs = connectedPairs(shown.links).filter((pair) => pair.every((id) => ids.includes(id)));
    // With no layout yet: the item asked for (or the most linked) in the middle, what links to it
    // down the left edge, and the rest down the right.
    const centre = asked ? here.item : mostLinked(ids.filter((id) => !isRemoved(id)), pairs) ?? CONTRACT;
    const into = neighboursOf(centre, shown.links).left.map((entry) => entry.id).filter((id) => ids.includes(id));
    const showsFull = (id) => (fresh ? id === centre : layout.boxes[id] && !isCard(layout.boxes[id]));

    const build = async (id) => (id.startsWith(WHOLE) ? null : fullView(here, id, views));
    const items = await Promise.all(ids.map(async (id) => {
      const card = await boardCard(id, { ...views, removed });
      const element = h('article', { className: `board-item${isRemoved(id) ? ' removed' : ''}`, 'data-item': id, style: moves(id), 'aria-label': titleOf(id, shown, uses, removed) }, card);
      // What shows at full size is drawn now, so it doesn't arrive a moment after.
      if (showsFull(id)) {
        const full = await build(id);
        full.classList.add('board-full');
        element.prepend(full);
      }
      return element;
    }));
    // Comments on the whole schematic, as cards on the board.
    const wholeCards = onWhole.map((comment) => h('article', { className: 'board-item board-comment', 'data-item': `${WHOLE}${comment.id}`, 'aria-label': 'Comment on the whole schematic' },
      h('div', { className: 'board-card comment-board-card' }, wholeCommentCard(here, on, comment))));
    const board = h('div', { className: 'board' }, ...items, ...wholeCards);
    const threads = threadsFor(here, on, groups, (id) => titleOf(id, shown, uses, removed));
    board.watch = { schemaId: here.schemaId, ids: [...ids, ...onWhole.map((comment) => `${WHOLE}${comment.id}`)], centre, left: into, right: ids.filter((id) => id !== centre && !into.includes(id)), build, groups, threads, name: shown.name, proposal: Boolean(here.proposal), title: (id) => titleOf(id, shown, uses, removed) };
    board.threads = threads.find;
    // A long press on an open item starts a comment on what was pressed; on empty space, a comment
    // on the whole schematic, put where it was pressed.
    watchLongPress(board, {
      accept: (event) => {
        if (event.target.closest('.board-grip, .comment-marker, button, input, textarea, .comment-thread')) return false;
        const element = event.target.closest('.board-item');
        if (!element) return event.target === board;
        return !element.classList.contains('is-card') && !element.classList.contains('board-comment') && Boolean(element.querySelector(':scope > .board-full'));
      },
      fire: (event) => {
        const element = event.target.closest('.board-item');
        if (!element) return commentOnWhole(here, on, shown, event, (made) => {
          const rect = board.getBoundingClientRect();
          const kept = layouts.get(here.schemaId) ?? emptyLayout();
          const z = Math.max(0, ...Object.values(kept.boxes).map((box) => box.z ?? 0)) + 1;
          keepLayout(here.schemaId, { boxes: { ...kept.boxes, [`${WHOLE}${made.id}`]: { cx: (event.clientX - rect.left) / rect.width, cy: (event.clientY - rect.top) / rect.height, w: 0.2, h: 0.2, z, sized: false } } });
        });
        const target = targetAt(element, event);
        if (!target) return;
        threads.open(target, event.clientX, event.clientY, true);
      },
    });
    return board;
  }

  // Once the board is on the page: anything without a place yet is given one, now its card can be
  // measured, and the board is watched for the user moving things.
  function showBoard(board) {
    const { schemaId, ids, centre, left, right, build, groups, threads } = board.watch;
    let layout = layouts.get(schemaId) ?? emptyLayout();
    if (ids.some((id) => !layout.boxes[id])) {
      const heights = Object.fromEntries([...board.querySelectorAll(':scope > .board-item')].map((one) => [one.dataset.item, one.querySelector(':scope > .board-card')?.offsetHeight || 80]));
      const size = { width: board.clientWidth, height: board.clientHeight };
      if (!Object.keys(layout.boxes).length) layout = { boxes: defaultLayout({ centre, left, right }, heights, size).boxes };
      layout = placeNew(layout, ids, heights, size);
      keepLayout(schemaId, layout);
    }
    let remark = () => {};
    watchBoard(board, {
      layout,
      // Something dragged in from the edge is drawn in full, and its comments marked.
      build: async (id) => {
        const built = await build(id);
        setTimeout(() => remark());
        return built;
      },
      onChange: (next) => keepLayout(schemaId, next),
      // A card clicked comes to the middle, which is a step back and forward go through.
      // What the user brought to the middle is what they're looking at: a line of context for the chat.
      onBring: (id) => {
        const here = top();
        if (!here || here.schemaId !== schemaId) return;
        here.item = id;
        remember();
        const title = board.watch.title(id);
        onNote({ text: `Looking at “${title}”`, detail: `Looking at the item “${title}” (${id}) of ${board.watch.name}${board.watch.proposal ? ', as the AI has proposed it' : ''}`, focus: true, about: title });
      },
    });
    remark = watchComments(board, { groups, open: (group, x, y) => threads.open(group.target, x, y) });
  }

  const titleOf = (id, shown, uses, removed = []) => (id === CONTRACT ? 'Contract' : shown.items.find((one) => one.id === id)?.title ?? removed.find((one) => one.id === id)?.title ?? uses.get(id)?.name ?? id);

  // An item at full size: its title along the top, which it's dragged by, and its content. Full
  // screen, the same thing with the window to itself.
  // `still`: diagrams are drawn as they are, not as canvases of their own (the overview pans and zooms them).
  async function fullView(here, id, { shown, uses, content, mark, follow, openUse, isRemoved, full = false, still = false }) {
    const use = uses.get(id);
    const item = id === CONTRACT || use ? null : await content(id);
    const middle = h('article', { className: 'focus-card', ...(full && { style: moves(id) }), 'aria-label': use ? use.name ?? use.id : id === CONTRACT ? 'Contract' : item?.title ?? id });
    // Links in Markdown are followed here, whichever kind of item they're in.
    middle.addEventListener('click', (event) => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!isInternalLink(href)) return; // the main process opens web links in the browser
      event.preventDefault();
      // An embedded schema's contract links within that schema, so they lead into it.
      if (use) openUse(use, parseLink(href).target);
      else follow(href, id);
    });
    if (full) here.fullDiff = null;
    const body = h('div', { className: 'focus-body' });
    // Why the proposal changes it, as the AI said (`reasons` in propose_schematic), while it's
    // reviewed, and what the user does about the change (Before · Changes · After and Approve): in a
    // drawer along the bottom of the card, so its title row is only its title (see cardDrawer).
    // Full screen too (the user's choice); the bottom bar then says what the item is and how it shows.
    const reason = here.proposal ? shown.reasons?.[use ? null : id] : null;
    const foot = [];
    if (use) {
      await useOverview(use, middle, body, openUse);
    } else if (item) {
      middle.append(paneHead(item.title, item.description, mark(item.id), pill(kindLabel(item), 'kind-pill'), approvals.has(item.id)));
      // An item the proposal under review changes shows Before, its Changes (the default) or After,
      // as its card's switch says (the user's choice): see changedView.
      const onLink = (link) => follow(link, id);
      const earlier = here.proposal && shown.basedOn && mark(item.id) === 'changed'
        ? await api.getItem(here.schemaId, item.id, { draftId: shown.basedOn }).catch(() => null) : null;
      // Changes, unless the user has approved it: then After, as it will be (the user's choice). Either
      // way, until they pick another.
      const showing = earlier ? here.diffs?.[item.id] ?? (approvals.has(item.id) ? 'after' : 'changes') : 'after';
      const view = changedView(item, earlier, showing, onLink);
      if (earlier) foot.push(diffSwitch(here, item.id, showing));
      // Writing can be compared with the draft side by side too: a button of its own beside the
      // switch, as it opens a view across the window rather than changing how the card shows.
      if (earlier && changedWriting(here, shown, item, mark)) foot.push(h('button', { type: 'button', className: 'side-by-side', title: 'Open it beside the draft it changes, across the window', onclick: () => openCompareOf(here, shown, item) }, 'Side by side'));
      if (earlier && full) here.fullDiff = { showing, basedOn: shown.line.indexOf(shown.basedOn) + 1 };
      // Where a canvas has been moved to is kept for each size it shows at, and each way it shows.
      const place = `${item.id}:${Boolean(full)}:${showing}`;
      here.views ??= {};
      const drawing = view.querySelector?.(':scope > svg');
      const canvas = view.classList.contains('diagram') && !still
        ? makeCanvas(view, {
          saved: here.views[place] ?? null,
          onChange: (kept) => { here.views[place] = kept; },
          fitted: true,
        })
        : view;
      // A sequence diagram has a key to its lines and boxes, for anyone who doesn't know them.
      if (drawing?.keyParts && canvas.classList.contains('diagram-canvas')) {
        const key = h('button', { type: 'button', title: 'What the lines and boxes mean', 'aria-label': 'Key to this diagram', onclick: () => showKey(item.title, drawing.keyParts) }, 'Key');
        canvas.querySelector(':scope > .canvas-controls')?.prepend(key);
      }
      body.append(canvas);
    } else if (id === CONTRACT) {
      middle.append(paneHead('Contract', shown.summary, mark(CONTRACT), null, approvals.has(CONTRACT)));
      const contract = h('div', {});
      if (shown.contract) renderMarkdown(contract, shown.contract);
      else contract.append(h('p', { className: 'muted' }, 'No contract yet.'));
      body.append(contract);
      if (shown.parameters.length) {
        body.append(h('h3', { className: 'pane-subhead' }, 'Parameters'), h('dl', { className: 'parameters' }, ...shown.parameters.flatMap((parameter) => [
          h('dt', {}, parameter.name),
          h('dd', {}, parameter.description ?? ''),
        ])));
      }
    } else {
      middle.append(paneHead(id, null, null));
      body.append(h('p', { className: 'muted' }, 'This item couldn’t be read.'));
    }
    middle.append(body);
    // What's removed says so across it, or Accepted once the user has approved the removal.
    if (isRemoved?.(id)) middle.append(h('span', { className: 'removed-over', 'aria-hidden': 'true' }, approvals.has(id) ? 'Accepted' : 'Removed'));
    // Each change is the user's to approve, as a SmartDoc finding is to decide (see approveButton);
    // full screen, in the bottom bar with the item's switch.
    const change = here.proposal && !use ? mark(id) : null;
    if (change && actionsOf(middle)) foot.push(approveButton(here, shown, id, change, item?.title));
    if (foot.length || reason) middle.append(full ? floatingCard(middle, foot, reason) : cardDrawer(here, id, middle, foot, reason));
    actionsOf(middle).append(fullButton(here, id));

    // A diagram is a canvas, writing is a page, and a table or image sits on a surface of its own.
    const canvas = body.querySelector(':scope > .diagram-canvas');
    const writing = !canvas && (use || !item || item.kind === 'document');
    if (canvas) body.classList.add('canvas-body');
    else if (writing) {
      const sheet = h('div', { className: 'document-sheet' });
      sheet.append(...body.childNodes);
      body.append(sheet);
      body.classList.add('sheet-body');
      body.dataset.page = `${here.schemaId}:${id}`; // its zoom in a card is kept by this (page-view.js)
    } else body.classList.add(`${item.kind}-body`);

    if (full) {
      middle.classList.add('embeds');
      // The card's title stays apart from the writing, above the page.
      if (writing) body.prepend(h('div', { className: 'sheet-head' }, middle.querySelector('.pane-title')));
      // No bar across the top: what it held floats over the content.
      const head = middle.querySelector('.pane-head');
      // Only its buttons: whether it's new or changed is the bottom bar's to say (the user's choice).
      middle.append(h('div', { className: 'full-actions' }, ...actionsOf(head).children));
      head.remove();
    }
    // Where its content goes on out of sight, an inner shadow says so (a canvas pans instead).
    if (!canvas) shadeScrolling(body);
    const holder = body.querySelector(':scope > .item-table-holder');
    if (holder) shadeScrolling(holder);
    return middle;
  }

  // An item's compact card, for the edges of the board: its kind, title and description, and below a
  // line what the AI wrote for it, or a look inside.
  async function boardCard(id, { shown, uses, content, mark, removed }) {
    const gone = removed.find((one) => one.id === id);
    if (gone) {
      return h('div', { className: 'focus-neighbour board-card removed' },
        kindIcon(gone.kind, kindLabel(gone)),
        h('span', { className: 'title-row' }, h('strong', {}, gone.title)),
        h('span', { className: 'removed-over', 'aria-hidden': 'true' }, approvals.has(id) ? 'Accepted' : 'Removed'));
    }
    const use = uses.get(id);
    if (use) {
      if (use.missing) return h('div', { className: 'focus-neighbour board-card embedded' }, kindIcon('schematic', 'Embedded schematic'), h('span', { className: 'title-row' }, h('strong', {}, use.id)), h('span', { className: 'focus-meta' }, 'This schematic is no longer available.'));
      const settings = Object.entries(use.with ?? {});
      return h('div', { className: 'focus-neighbour board-card embedded' },
        kindIcon('schematic', 'Embedded schematic'),
        h('span', { className: 'title-row' }, h('strong', {}, use.name), h('span', { className: 'card-meta' }, `Draft ${use.number}`), statusPills(use.newerDraftId && pill('Newer draft available', 'proposed'))),
        h('span', { className: 'focus-meta' }, use.summary),
        settings.length > 0 && h('span', { className: 'card-settings' }, ...settings.map(([key, value]) => h('code', {}, `${key}: ${value}`))),
        use.contract && h('span', { className: 'card-contract' }, plainText(use.contract)));
    }
    const contract = id === CONTRACT;
    const item = shown.items.find((one) => one.id === id);
    const preview = cardLines(item) ?? (item?.kind === 'table' ? await content(id).then((table) => table && tablePreview(table, null, shown.links))
      : await previewOf(id, shown, uses, content).catch(() => null));
    return h('div', { className: 'focus-neighbour board-card' },
      !contract && item && kindIcon(item.kind, kindLabel(item)),
      h('span', { className: 'title-row' }, h('strong', {}, contract ? 'Contract' : item?.title ?? id), statusPills(...marker(mark(id), approvals.has(id)))),
      h('span', { className: 'focus-meta' }, contract ? 'What it promises and needs' : item?.description),
      preview);
  }

  const actionsOf = (card) => card.querySelector('.pane-actions');

  function setFull(here, full) {
    here.full = full;
    moving = true;
    remember();
    return render();
  }

  // Full screen for one item, from its title bar on the board, and back.
  function fullButton(here, id = here.item) {
    const name = here.full ? 'Leave full screen' : 'Full screen';
    const button = h('button', { className: 'icon-button', type: 'button', ...(here.full && { id: 'full-toggle' }), title: name, 'aria-label': name, onclick: () => {
      here.item = id;
      setFull(here, !here.full);
    } });
    button.innerHTML = here.full ? LEAVE_FULL_ICON : FULL_ICON;
    return button;
  }

  // An item the proposal changes, as one of three (the switch in its title bar): as it is in the
  // draft ('before'), as proposed ('after'), or with what changed marked ('changes'): writing with
  // its added and removed words (diff-marks.js), a diagram or table drawn from both versions
  // (item-diffs.js), an image wiped between the two.
  function changedView(item, earlier, showing, onLink) {
    if (!earlier || showing === 'after') return itemView(item, onLink);
    if (showing === 'before') return itemView(earlier, onLink);
    if (item.kind === 'image' && earlier.kind === 'image') return wipeView(item, earlier);
    if (item.kind === 'document' && typeof earlier.markdown === 'string') {
      const view = itemView(item, onLink);
      markInline(view, readText((element) => renderMarkdown(element, earlier.markdown)));
      return view;
    }
    const diff = diffOf(item, earlier);
    return diff ? itemView(diff.item, onLink, diff) : itemView(item, onLink);
  }
  // Approving a change: the user's say on it before the proposal is accepted. Accepting doesn't wait
  // for it: what isn't approved is accepted as proposed, and the confirmation says so (the user's
  // choice, as SmartDoc goes on with sensible defaults). The chat is told, as a line of context.
  const APPROVE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function approveButton(here, shown, key, change, title) {
    const approved = approvals.has(key);
    const what = key === CONTRACT ? 'the contract' : `“${title ?? key}”`;
    const doing = change === 'added' ? `adding ${what}` : change === 'removed' ? `removing ${what}` : `the change to ${what}`;
    const button = h('button', {
      className: 'approve-button',
      type: 'button',
      'aria-pressed': String(approved),
      title: approved ? `You’ve approved ${doing}. Click to take it back.` : `Approve ${doing}`,
      onclick: () => answer(async () => {
        await api.approveChange(here.schemaId, key, !approved);
        const said = `${approved ? 'Took back approving' : 'Approved'} ${doing}`;
        onNote({ text: said, detail: `${said} in the proposal for ${shown.name} (schematic ${here.schemaId})` });
      }),
    });
    button.innerHTML = APPROVE_ICON;
    button.append(approved ? 'Approved' : 'Approve');
    return button;
  }

  const DIFF_WAYS = [['before', 'Before', 'As it is in the draft'], ['changes', 'Changes', 'What the proposal changes, marked'], ['after', 'After', 'As it would be, once accepted']];
  // The drawer along the bottom of a card under review: its controls in a row (or, with none, a
  // heading), and below them why the item changes, scrolling. A handle on its top edge drags it
  // taller or shorter; double-clicking the handle opens or closes it (the user's choice: it doesn't
  // go back to a size). Its size is kept for each item while the app is open, never stored. Full
  // screen, it's a floating card instead (see floatingCard).
  const DRAWER_OPEN = 140;
  function cardDrawer(here, key, card, controls, reason) {
    here.drawers ??= {};
    const kept = (here.drawers[key] ??= { open: false, height: null });
    const row = h('div', { className: 'card-drawer-row' }, ...(controls.length ? controls : [h('strong', { className: 'card-drawer-title' }, 'Why it changes')]));
    const more = reason && h('div', { className: 'card-drawer-more' }, controls.length > 0 && h('strong', { className: 'card-drawer-title' }, 'Why it changes'), h('p', {}, reason));
    const drawer = h('div', { className: 'card-drawer' }, row, more);
    // Pressing in it never picks up the card or starts a comment.
    drawer.addEventListener('pointerdown', (event) => event.stopPropagation());
    drawer.addEventListener('dblclick', (event) => event.stopPropagation());
    // The content stops above it shut, and it lies over the content when it's opened.
    requestAnimationFrame(() => card.style.setProperty('--drawer-shut', `${row.offsetHeight + 1}px`));
    if (!more) return drawer;
    if (!controls.length) drawer.classList.add('titled');
    const shut = () => row.offsetHeight + 1; // its row and its top border
    const most = () => Math.max(shut() + 40, (card.clientHeight || 400) * 0.7);
    const size = (height, open) => {
      drawer.classList.toggle('open', open);
      drawer.style.height = open ? `${height}px` : '';
      card.style.setProperty('--drawer-height', `${open ? height : drawer.offsetHeight}px`);
    };
    // Opened before it's been sized, it's as tall as what it says.
    const natural = () => {
      drawer.classList.add('open');
      drawer.style.height = '';
      return drawer.offsetHeight + 2;
    };
    const show = () => size(Math.min(most(), kept.height ?? (kept.open ? natural() : DRAWER_OPEN)), kept.open);
    // Drawn again (anything decided redraws the board), it's as it was, without opening again.
    drawer.classList.add('dragging');
    requestAnimationFrame(() => {
      show();
      requestAnimationFrame(() => drawer.classList.remove('dragging'));
    });

    const handle = h('div', { className: 'card-drawer-handle', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Why it changes', title: 'Drag to make it bigger or smaller. Double-click to open or close it.' });
    handle.addEventListener('dblclick', () => {
      kept.open = !kept.open;
      show();
    });
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // Followed on the window: the board takes the pointer for its own drags, which a capture here
      // would lose part way.
      // An item at a side is scaled down as a whole: the pointer moves in screen pixels.
      const scale = drawer.getBoundingClientRect().height / drawer.offsetHeight || 1;
      const start = event.clientY;
      const from = drawer.offsetHeight;
      drawer.classList.add('dragging');
      let height = from;
      const move = (moved) => {
        height = Math.min(most(), Math.max(shut(), from - (moved.clientY - start) / scale));
        size(height, height > shut() + 1);
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        drawer.classList.remove('dragging');
        // Let go nearly shut, it shuts; otherwise it stays as it was left, and opens to that.
        kept.open = height > shut() + 24;
        if (kept.open) kept.height = height;
        show();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    drawer.prepend(handle);
    return drawer;
  }

  // Full screen, the same as a card floating over the content, a fixed size with what it says
  // scrolling, which the user drags anywhere by any part of it but its buttons (the user's choice:
  // across the bottom it was mostly empty). Where it was put is kept while the app is open.
  let floatPlace = null;
  function floatingCard(card, controls, reason) {
    const float = h('div', { className: 'change-float' },
      h('div', { className: 'change-float-grip', 'aria-hidden': 'true' }),
      controls.length > 0 && h('div', { className: 'card-drawer-row' }, ...controls),
      reason && h('div', { className: 'change-float-why' }, h('strong', { className: 'card-drawer-title' }, 'Why it changes'), h('p', {}, reason)));
    const place = (left, top) => {
      const room = card.getBoundingClientRect();
      const x = Math.min(Math.max(0, left), Math.max(0, room.width - float.offsetWidth));
      const y = Math.min(Math.max(0, top), Math.max(0, room.height - float.offsetHeight));
      Object.assign(float.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto' });
      return { left: x, top: y };
    };
    if (floatPlace) requestAnimationFrame(() => { floatPlace = place(floatPlace.left, floatPlace.top); });
    float.addEventListener('dblclick', (event) => event.stopPropagation());
    float.addEventListener('pointerdown', (event) => {
      // Pressing in it never picks up the item or starts a comment.
      event.stopPropagation();
      if (event.button !== 0 || event.target.closest('button, .change-float-why p')) return;
      event.preventDefault();
      const box = float.getBoundingClientRect();
      const room = card.getBoundingClientRect();
      const grab = { x: event.clientX - box.left, y: event.clientY - box.top };
      float.classList.add('moving');
      const move = (moved) => { floatPlace = place(moved.clientX - room.left - grab.x, moved.clientY - room.top - grab.y); };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        float.classList.remove('moving');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    return float;
  }

  function diffSwitch(here, id, showing) {
    return h('div', { className: 'diff-switch', role: 'group', 'aria-label': 'Show' }, ...DIFF_WAYS.map(([way, label, about]) => h('button', {
      type: 'button',
      title: about,
      'aria-pressed': String(way === showing),
      onclick: () => {
        here.diffs = { ...here.diffs, [id]: way };
        render();
      },
    }, label)));
  }

  // Writing that the proposal under review changes, from a draft there is to compare it with.
  const changedWriting = (here, shown, item, mark) => Boolean(here.proposal && shown.basedOn && item?.kind === 'document' && mark(item.id) === 'changed');

  // Opens the writing beside the draft it changes, across the window (see compare-view.js).
  async function openCompareOf(here, shown, item) {
    const earlier = await api.getItem(here.schemaId, item.id, { draftId: shown.basedOn }).catch(() => null);
    openCompare({
      title: item.title,
      beforeLabel: `Draft ${shown.line.indexOf(shown.basedOn) + 1}`,
      afterLabel: 'Proposed',
      render: (element, which) => renderMarkdown(element, which === 'before' ? earlier?.markdown ?? '' : item.markdown),
    });
  }

  // A close button: a cross.
  function cross(onclick, name) {
    const button = h('button', { className: 'icon-button', type: 'button', title: 'Close', 'aria-label': name, onclick });
    button.innerHTML = CROSS;
    return button;
  }

  // A sequence diagram's key, over the window: each kind of line and box it uses, and what it means.
  function showKey(title, parts) {
    const dialog = h('dialog', { className: 'key-dialog', 'aria-label': `Key to ${title}` },
      h('div', { className: 'key-dialog-head' },
        h('h2', {}, 'Key'),
        h('span', { className: 'key-dialog-for' }, title),
        cross(() => dialog.close(), 'Close the key')),
      sequenceKey(parts));
    // Clicking outside it closes it, as Escape does.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // An embedded schema in the middle: what it is, as this schema uses it, before going into it.
  async function useOverview(use, middle, body, openUse) {
    if (use.missing) {
      middle.append(paneHead(use.id, null, null, pill('Embedded schematic', 'kind-pill schema-pill')));
      body.append(h('p', { className: 'muted' }, 'This schematic is no longer available.'));
      return;
    }
    const inner = await api.getSchema(use.schemaId, use.draftId).catch(() => null);
    const head = paneHead(use.name, `Draft ${use.number}`, null, pill('Embedded schematic', 'kind-pill schema-pill'));
    head.querySelector('.title-row').append(...[statusPills(use.newerDraftId && pill('Newer draft available', 'proposed'))].filter(Boolean));
    const open = h('button', { className: 'icon-button', type: 'button', id: 'use-open', title: 'Open schematic', 'aria-label': 'Open schematic', onclick: () => openUse(use) });
    open.innerHTML = OPEN_ICON;
    actionsOf(head).append(open);
    middle.append(head);

    // Its overview, still in this schematic: every item in it, laid out as on its own overview and
    // fitted to the card. Zoomed out too far to read, each item shows its card's face instead, its
    // kind and title, as the side cards do (see watchFar).
    if (!inner) {
      body.append(h('p', { className: 'muted' }, 'This schematic couldn’t be read.'));
      return;
    }
    const innerUses = new Map(inner.uses.map((one) => [one.id, one]));
    const contents = new Map();
    const content = (id) => {
      if (!contents.has(id)) contents.set(id, api.getItem(use.schemaId, id, { draftId: use.draftId }).catch(() => null));
      return contents.get(id);
    };
    let canvas = null;
    // A link inside moves the canvas to what it goes to, as on an overview.
    const follow = (link, from) => {
      const { target } = parseLink(link, from);
      const element = canvas?.world.querySelector(`:scope > [data-item="${CSS.escape(target)}"]`);
      if (element) canvas.centreOn(element);
    };
    const views = { shown: inner, uses: innerUses, content, mark: () => null, follow, openUse: () => openUse(use), isRemoved: () => false, removed: [], still: true };
    const innerHere = { schemaId: use.schemaId, views: {} };
    const element = async (id) => {
      const face = await boardCard(id, views);
      // A schematic embedded in this one stays a card at any zoom: it opens from inside its own.
      const nested = innerUses.has(id);
      const open = nested ? null : await fullView(innerHere, id, views);
      open?.classList.add('board-full');
      // Nothing to do to it here but look: changing anything is done inside the schematic.
      open?.querySelector('.pane-actions')?.replaceChildren();
      const item = h('article', { className: `overview-item${nested ? ' card-only' : ''}`, 'data-item': id }, open, face);
      item.addEventListener('dblclick', (event) => {
        if (!event.target.closest('button, a[href]')) openUse(use, id);
      });
      return item;
    };
    const ids = [CONTRACT, ...inner.items.map((one) => one.id), ...inner.uses.map((one) => one.id)];
    const drawing = drawOverview(await Promise.all(ids.map(element)), connectedPairs(inner.links), { width: 1600, height: 1000 });
    drawing.classList.add('embed-overview');
    canvas = makeCanvas(drawing, {
      drawing: drawing.world,
      size: drawing.size,
      minScale: 0.05,
      fitted: true,
      // It's only to look at, so a drag anywhere on it pans, over its items too.
      panFrom: (event) => !event.target.closest('button, a[href]'),
      onShow: () => watchFar(drawing),
    });
    body.append(canvas);
    const settings = Object.entries(use.with ?? {});
    if (settings.length) body.append(h('div', { className: 'embed-settings', title: 'Set here' }, ...settings.map(([key, value]) => h('code', {}, `${key}: ${value}`))));
  }

  // Too small on screen to read, an embedded schematic's items show their cards' faces, sized to be
  // read whatever the zoom: the title as a side card's, or as large as the item leaves room for, and
  // the kind's icon above it only where there's room for both.
  const READABLE = 0.45;
  const FACE_TITLE = 13; // px on screen, as on a side card
  const FACE_ICON = 38;
  function watchFar(drawing) {
    const world = drawing.world;
    const scale = world.offsetWidth ? world.getBoundingClientRect().width / world.offsetWidth : 1;
    const far = scale < READABLE;
    drawing.classList.toggle('far', far);
    if (!far) return;
    for (const item of world.querySelectorAll(':scope > .overview-item')) {
      const face = item.querySelector(':scope > .board-card');
      if (!face) continue;
      const width = item.offsetWidth * scale;
      const height = item.offsetHeight * scale;
      const title = Math.max(7, Math.min(FACE_TITLE, height / 3, width / 8));
      const icon = Math.min(FACE_ICON, height - 2.5 * title - 16);
      face.style.setProperty('--face-title', `${title / scale}px`);
      face.style.setProperty('--face-icon', `${Math.max(0, icon) / scale}px`);
      face.style.setProperty('--face-gap', `${4 / scale}px`);
      face.classList.toggle('no-icon', icon < 16);
    }
  }

  // Every item in the schema on a canvas, with a line between each pair that link to each other (see
  // overview-view.js). Each card is the full card a side card is a compact version of: the same tag,
  // title and description, and beneath, a look inside and how it's linked. Clicking one brings it
  // into focus.
  async function overviewView(here, shown, uses, connections, openUse) {
    const links = (id) => {
      const out = new Set(shown.links.filter(({ from, to }) => parseLink(from).target === id && parseLink(to).target !== id).map(({ to }) => parseLink(to).target));
      const into = new Set(shown.links.filter(({ from, to }) => parseLink(to).target === id && parseLink(from).target !== id).map(({ from }) => parseLink(from).target));
      if (!out.size && !into.size) return 'Not linked to anything';
      return [out.size && `Links to ${out.size}`, into.size && `Linked from ${into.size}`].filter(Boolean).join(' · ');
    };
    // Taken to Focus, it's brought to the middle, alone: the rest go to the sides.
    const open = (id) => () => {
      layout = 'focus';
      rememberView();
      here.item = id;
      here.bring = 'alone';
      remember();
      render();
    };
    // Under review, what the proposal removes is still shown, as it was in the draft the proposal
    // changes, struck through; and comments on anything since removed stay, so none disappear unseen.
    const removedItems = here.proposal ? shown.changes?.removed ?? [] : [];
    const isRemoved = (id) => removedItems.some((one) => one.id === id);
    const on = here.proposal ? { proposal: true } : { draftId: shown.draftId };
    const contents = new Map();
    const content = (id) => {
      if (id === CONTRACT || uses.has(id)) return Promise.resolve(null);
      if (!contents.has(id)) contents.set(id, api.getItem(here.schemaId, id, isRemoved(id) ? { draftId: shown.basedOn } : on).catch(() => null));
      return contents.get(id);
    };
    const mark = (id) => (id === CONTRACT ? (shown.changes?.contract ? 'changed' : null) : isRemoved(id) ? 'removed' : shown.changes?.items[id]);
    // A link followed on the overview moves the canvas to what it goes to.
    let holder = null;
    const follow = (link, from) => {
      const { target } = parseLink(link, from);
      const element = holder?.world.querySelector(`:scope > [data-item="${CSS.escape(target)}"]`);
      if (element) holder.centreOn(element);
    };
    const views = { shown, uses, content, mark, follow, openUse, isRemoved, still: true };
    const ids = [CONTRACT, ...shown.items.map((one) => one.id), ...removedItems.map((one) => one.id)];
    const removed = removedItems.map(({ id }) => id);
    const titleFor = (id) => titleOf(id, shown, uses, removedItems);

    // Each item at full size, as large as its content. Double-clicking its title bar, or Enter on it,
    // takes it to Focus.
    const fullItem = async (id) => {
      const full = await fullView(here, id, views);
      full.classList.add('board-full');
      const element = h('article', { className: `overview-item${isRemoved(id) ? ' removed' : ''}`, 'data-item': id, tabindex: '0', 'aria-label': titleFor(id) }, full);
      full.querySelector('.pane-head')?.addEventListener('dblclick', (event) => {
        if (!event.target.closest('button')) open(id)();
      });
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.target === element) open(id)();
      });
      return element;
    };
    // An embedded schematic stays a card here: going into it is Open schematic, in Focus.
    const useCard = (use) => {
      const settings = Object.entries(use.with ?? {});
      return h('button', { className: 'overview-card embedded', type: 'button', 'data-item': use.id, onclick: open(use.id) },
        pill('Embedded schematic', 'kind-pill schema-pill'),
        h('span', { className: 'title-row' }, h('strong', {}, use.name ?? use.id), !use.missing && h('span', { className: 'card-meta' }, `Draft ${use.number}`), statusPills(use.newerDraftId && pill('Newer draft available', 'proposed'))),
        h('span', { className: 'focus-meta' }, use.missing ? 'This schematic is no longer available.' : use.summary),
        settings.length > 0 && h('span', { className: 'card-settings' }, ...settings.map(([key, value]) => h('code', {}, `${key}: ${value}`))),
        use.contract && h('span', { className: 'card-contract' }, plainText(use.contract)),
        h('span', { className: 'overview-card-foot' }, h('span', { className: 'overview-card-links' }, links(use.id))));
    };

    const [comments, earlierComments] = await Promise.all([api.listComments(here.schemaId, on).catch(() => []), api.listEarlierComments(here.schemaId, on).catch(() => [])]);
    const everything = [...comments, ...earlierComments];
    const orphans = comments.filter((comment) => comment.target.missing).map((comment) => commentCard(comment, { onDelete: (gone) => api.deleteComment(here.schemaId, gone.id).then(render), onNoFurtherAction: flagComment(here) }));
    // Comments on the whole schematic: where they were put on the overview, else laid out with the rest.
    const onWhole = everything.filter((comment) => comment.target.schematic);
    const pinned = onWhole.filter((comment) => comment.target.at).map((comment) => ({ card: wholeCommentCard(here, on, comment), at: comment.target.at }));
    const loose = onWhole.filter((comment) => !comment.target.at).map((comment) => wholeCommentCard(here, on, comment));
    const items = [...(await Promise.all(ids.map(fullItem))), ...shown.uses.map(useCard), ...orphans, ...loose];
    const pairs = connectedPairs(shown.links);
    // Laid out to fill the window as it is now; a place kept from a different layout would be lost in this one.
    const drawing = drawOverview(items, pairs, { width: el.clientWidth, height: el.clientHeight }, pinned);
    const sameLayout = here.overviewColumns === drawing.columns;
    here.overviewColumns = drawing.columns;
    holder = makeCanvas(drawing, {
      drawing: drawing.world,
      size: drawing.size,
      minScale: 0.05,
      rubber: true,
      // Dragging in an item's content picks words, as anywhere else; elsewhere it moves the canvas.
      panFrom: (event) => !event.target.closest('.focus-body, button, a[href], input, textarea, .comment-marker, .comment-thread'),
      saved: (sameLayout && here.views?.overview) || null,
      onChange: (kept) => {
        here.views ??= {};
        here.views.overview = kept;
      },
    });
    // Markers shrink as it zooms out, to half their size at most.
    holder.markerScale = () => {
      const scale = Number(/scale\(([\d.]+)\)/.exec(drawing.world.style.transform)?.[1] ?? 1);
      return Math.min(1, Math.max(0.5, scale));
    };
    // Comments on items show as on the board: marked where they are, opened in a box.
    const groups = groupComments(everything.filter((comment) => !comment.target.schematic && !comment.target.missing && ids.includes(comment.target.item)));
    const threads = threadsFor(here, on, groups, titleFor);
    Object.assign(holder, { pairs, connections, threads: threads.find, comments: { groups, open: (group, x, y) => threads.open(group.target, x, y) } });
    // A long press on an item comments on what was pressed; on empty space, on the whole schematic,
    // kept where it was pressed.
    watchLongPress(holder, {
      accept: (event) => {
        if (event.target.closest('button, input, textarea, .comment-marker, .comment-thread, .canvas-controls, .overview-pinned, .comment-card')) return false;
        if (event.target.closest('.overview-item')) return true;
        return event.target === holder || event.target === holder.world || Boolean(event.target.closest('svg.overview-svg'));
      },
      fire: (event) => {
        const element = event.target.closest('.overview-item');
        if (element) {
          const target = targetAt(element, event);
          if (target) threads.open(target, event.clientX, event.clientY, true);
          return;
        }
        const box = holder.world.getBoundingClientRect();
        const at = { x: Math.min(1, Math.max(0, (event.clientX - box.left) / (box.width || 1))), y: Math.min(1, Math.max(0, (event.clientY - box.top) / (box.height || 1))) };
        commentOnWhole(here, on, shown, event, null, at);
      },
    });
    return h('div', { className: 'page overview-page', 'aria-label': `${shown.items.length === 1 ? '1 item' : `${shown.items.length} items`} in ${shown.name}` }, holder);
  }

  // The overview is shaped to the window, so a window reshaped draws it again.
  let reshaping = null;
  addEventListener('resize', () => {
    clearTimeout(reshaping);
    reshaping = setTimeout(() => {
      if (path.length && layout === 'overview' && el.querySelector('.overview-page')) render();
    }, 250);
  });

  const rememberView = () => {
    try {
      localStorage.setItem('schema-view', layout);
    } catch {}
  };

  // The lines the AI wrote for an item's card, below its line, if it wrote any.
  const cardLines = (item) => (item?.card?.length ? h('span', { className: 'focus-preview card-lines' }, ...item.card.map((line) => h('span', {}, line))) : null);

  // What a comment is on, without what the store adds to describe it, to write another on the same.
  const bareTarget = (target) => {
    if (target.schematic) return { schematic: true, ...(target.at && { at: target.at }) };
    if (target.card) return { item: target.item, card: true };
    if (target.point && !target.part && !target.quote) return { item: target.item, point: target.point };
    return { item: target.item, ...(target.part && !target.partMissing && { part: target.part }), ...(target.quote && { quote: target.quote }) };
  };

  // Comments gathered by what they're on (see keyOf), this draft's first.
  function groupComments(comments) {
    const groups = new Map();
    for (const comment of comments) {
      const key = keyOf(comment.target);
      if (!groups.has(key)) groups.set(key, { key, target: comment.target, comments: [] });
      groups.get(key).comments.push(comment);
    }
    for (const group of groups.values()) group.comments.sort((a, b) => Number(Boolean(a.earlier)) - Number(Boolean(b.earlier)));
    return [...groups.values()];
  }

  // The boxes of comments for the board: `open(target, x, y, writing)` opens the box on what
  // `target` is on, with the comments already there; `find(key)` gives what opens it again after the
  // page is drawn again (see comment-overlay.js).
  function threadsFor(here, on, groups, titleFor) {
    const heading = (target) => {
      const title = target.title ?? titleFor(target.item);
      return target.card ? `On the title and description of ${title}` : `Comments on ${title}`;
    };
    const options = (target, comments = []) => ({
      heading: heading(target),
      target,
      comments,
      send: async (text) => {
        await api.addComment(here.schemaId, { ...on, target: bareTarget(target), text });
        // What the user said there is context for the chat too.
        const title = target.title ?? titleFor(target.item);
        onNote({ text: `Commented on “${title}”`, detail: `Commented on “${title}”${target.quote ? ` (on the words “${target.quote}”)` : ''}: “${text}”` });
        render();
      },
      remove: async (comment) => {
        await api.deleteComment(here.schemaId, comment.id);
        render();
      },
      flag: flagComment(here),
      again: commentAgain(here, on),
    });
    const find = (key) => {
      const group = groups.find((one) => one.key === key);
      return group && options(group.target, group.comments);
    };
    const open = (target, x, y, writing = false) => {
      const key = keyOf(target);
      const group = groups.find((one) => one.key === key);
      openThread({ key, x, y, writing, ...options(group?.target ?? target, group?.comments ?? []) });
    };
    return { find, open };
  }

  // A long press on empty space: a box to write a comment on the whole schematic. `placed(comment)`
  // is called once it's written, to put its card where it was pressed on the board; on the overview
  // it's kept with the comment, as `at`.
  function commentOnWhole(here, on, shown, event, placed, at = null) {
    openThread({
      key: 'whole-new',
      x: event.clientX,
      y: event.clientY,
      writing: true,
      heading: `On ${shown.name} as a whole`,
      target: null,
      send: async (text) => {
        const made = await api.addComment(here.schemaId, { ...on, target: { schematic: true, ...(at && { at }) }, text });
        placed?.(made);
        closeThread();
        render();
      },
    });
  }

  // A comment on the whole schematic, as a card: an earlier one, from the draft this came from,
  // dashed, with Comment again.
  function wholeCommentCard(here, on, comment) {
    if (comment.earlier) {
      return h('div', { className: 'focus-neighbour comment-card earlier', 'data-comment': comment.id, role: 'note', 'aria-label': 'Earlier comment' },
        h('span', { className: 'comment-about' }, 'On the whole schematic'),
        h('p', { className: 'comment-text' }, comment.text),
        h('span', { className: 'comment-earlier-foot' }, earlierLine(comment), againButton(comment, commentAgain(here, on))));
    }
    return commentCard(comment, { onDelete: (gone) => api.deleteComment(here.schemaId, gone.id).then(render), onNoFurtherAction: flagComment(here) });
  }

  // The user says an earlier comment again, on what's showing.
  const commentAgain = (here, on) => async (comment) => {
    await api.addComment(here.schemaId, { ...on, target: bareTarget(comment.target), text: comment.text, from: comment.id });
    render();
  };

  // The user marks a comment as needing no further action, or opens it again.
  const flagComment = (here) => async (comment, flag) => {
    await api.setNoFurtherAction(here.schemaId, comment.id, flag);
    render();
  };

  // What a table beside the focus holds: the rows the links are about, if any, then how much there is.
  function tablePreview(table, focus, links) {
    const { rows, linked, rowCount, columnCount } = tableSummary(table, focus, links);
    const count = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;
    const totals = [linked > TABLE_ROWS_SHOWN && `${linked} linked`, count(rowCount, 'row'), count(columnCount, 'column')].filter(Boolean).join(' · ');
    return h('span', { className: 'focus-preview table-preview' },
      ...rows.map(({ id, name, detail }) => h('span', { className: 'table-preview-row', 'data-row': id }, h('span', { className: 'table-preview-name' }, name), detail && ` ${detail}`)),
      h('span', { className: 'table-preview-totals' }, totals));
  }

  // A very small look at a relevant neighbour.
  async function previewOf(id, shown, uses, content) {
    if (uses.has(id)) return null;
    if (id === CONTRACT) return shown.contract ? h('span', { className: 'focus-preview text' }, plainText(shown.contract)) : null;
    const item = await content(id);
    if (item.kind === 'document') return h('span', { className: 'focus-preview text' }, plainText(item.markdown));
    if (item.kind === 'sequence') {
      const count = item.messages.length;
      return h('span', { className: 'focus-preview text' }, `${item.participants.map((one) => one.label).join(', ')} · ${count} ${count === 1 ? 'message' : 'messages'}`);
    }
    if (item.kind === 'flow') {
      const [parts, joins] = [item.nodes.length, item.edges.length];
      return h('span', { className: 'focus-preview text' }, `${parts} ${parts === 1 ? 'part' : 'parts'} · ${joins} ${joins === 1 ? 'connection' : 'connections'}`);
    }
    // An image only shows when it's in focus.
    return null;
  }

  // The title alone along the top. What it is, and its description, are on a card while pointing at
  // the title, or with it focused from the keyboard.
  const paneHead = (title, detail, mark, tag = null, approved = false) => {
    const about = (tag || detail) && h('div', { className: 'title-card', role: 'tooltip', id: 'title-card' }, tag, detail && h('span', { className: 'title-card-detail' }, detail));
    return h('div', { className: 'pane-head' },
      h('div', { className: 'pane-title' },
        h('div', { className: 'title-row' }, h('h2', about ? { tabIndex: 0, 'aria-describedby': 'title-card' } : {}, title), statusPills(...marker(mark, approved))),
        about),
      h('div', { className: 'pane-actions' }));
  };

  new ResizeObserver(placeDraftNav).observe(draftNav.parentElement);
  for (const button of viewSwitch.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      layout = button.dataset.view;
      rememberView();
      remember();
      render();
    });
  }
  // Clicking anywhere else, or Escape, closes the list.
  document.addEventListener('pointerdown', (event) => {
    if (!focusMenu.hidden && !focusMenu.contains(event.target) && !event.target.closest?.('#focus-button')) setFocusMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !focusMenu.hidden) {
      setFocusMenuOpen(false);
      document.getElementById('focus-button')?.focus();
    } else if (event.key === 'Escape' && el.querySelector('.focus-full') && modeCard.hidden && !document.querySelector('dialog[open]')) {
      setFull(top(), false);
    }
  });
  api.onSchemasChanged(render);
  // While an AI in another app waits on a proposal, the chat offers it the go-ahead.
  const heardWaiting = (list) => {
    aiWaiting = list ?? [];
    if (path.length) render();
  };
  api.aiWaiting?.().then(heardWaiting, () => {});
  api.onAiWaiting?.(heardWaiting);
  api.onNewSchema(newSchema);
  // A schematic opened from Home, in this tab (see go and main.js's openInTab), as it was there.
  api.onOpenLevel?.(({ path: next = [], layout: chosen = null } = {}) => {
    if (!next.length) return;
    if (chosen && chosen !== layout && ['focus', 'overview'].includes(chosen)) {
      layout = chosen;
      rememberView();
    }
    selected = next[0].schemaId;
    path = next.map((one) => ({ ...level(one.schemaId, one), focus: null }));
    remember();
    render();
  });
  // Home, from the website demo's top bar (in the app it's a tab of its own).
  api.onGoHome?.(() => go([]));
  // An AI's proposal, in the window it works in.
  api.onShowSchema(({ schemaId, name }) => {
    selected = schemaId;
    go([level(schemaId, { proposal: true, label: name })]);
  });
  render();
}
