// Plays the website demo one scene at a time, as the site's pages scroll (see site/story.js).
// Going to a scene first builds its state at once (whether the document's been added, which
// screen, which drafts exist, how far each review has got, what's been decided, which card is
// open, what the chat says), so scenes can be reached in any order, scrolling up or down. Its
// moment is then a timeline of beats: a drawn cursor moving to and clicking the real interface,
// typing into it, and the AI's part in the chat (its replies and the steps it takes, and what they
// do through the stand-in API, demo-api.js). The site puts the moment wherever its page has
// scrolled to (seek), forwards or back, so the cursor, the typing and the chat follow the
// scrolling; on its own, the demo plays each moment through in time (start).
//
// The chat is the app's own, in a window of its own (demo-chat.html, attached with attachChat),
// floating by the app window's right edge as the app's does. The director drives both windows: the
// cursor goes from one to the other (each draws its own, the one under it showing), and what the
// chat says at any point is worked out from the scene's beats, so it follows the scrolling too.
//
// Going back over a beat that can't be undone (a click), the scene is built afresh and its beats
// done again at once, up to the point asked for. The rest (the cursor's place, typing, what the
// AI's said, the camera's focus) follow the point either way.
//
// Two sets of scenes: the home page's run-through of a real session, from opening the CV to a
// variation for one job, and the features page's look at each part of the app.
//
// show(name) resolves with the part of the window the scene is about (its focus, in the window's
// own pixels, the chat's window by its right edge counting too), for the site to bring into view,
// or null if another scene was asked for meanwhile. It also says where across the window a narrow
// screen, showing only part of its width, should centre on before the cursor's shown (narrowX):
// where the cursor first goes, or, for the AI at work, the chat.

import { describeStep } from '../../main/describe-step.js';
import { makeCursor } from './hover.js';
import { DOCUMENT, VARIATION } from './scenario.js';

const WINDOW = { x: 0, y: 0, width: 1280, height: 800 };
// The least of the window a scene's region takes in, so a click on one button still shows what's
// round it.
const REGION = { width: 760, height: 480 };
// Where the chat's window floats, in the app window's pixels: over its right side, and a little
// past it, as a window of its own can be (the user wanted it over the window, and the window
// larger, rather than beside it). It covers the cards in the right margin, as it would in the app,
// so scenes that open one drag it out of the way first (drag beats). A floating chat doesn't move
// the document: only the docked one does.
export const CHAT_PLACE = { x: 1000, y: 70, width: 400, height: 660 };
// Where a suggestion opened from its card floats (the app keeps where the user last put it): over
// the page, left of the chat.
const PANEL_PLACE = { left: 560, top: 150 };
const CANCELLED = new Error('The scene changed.');
const DOC = { id: 'demo', name: 'Alex Example CV.pdf' };
// The findings' decisions, in the order they're decided (the review's order: profile, wording,
// checkout question, Skills move).
const DECISIONS = [
  { status: 'accepted', choice: 0 },
  { status: 'accepted' },
  { status: 'answered', answer: 'Rebuilt it; conversion rose 12%' },
  { status: 'accepted' },
];
const IMPROVE_ASK = 'Review my CV and make it stand out to a hiring manager';
const HIGHLIGHTS_ASK = 'What would a recruiter take in at a glance?';
const REDRAFT_ASK = 'Write the next draft';
// The lines the app posts to the chat as the window moves (`whatShows` in main.js).
const OPENED_PREVIEW = `Opened “${DOCUMENT.name}”, the preview of draft 1`;
const OPENED_DRAFT_1 = `Opened “${DOCUMENT.name}”, draft 1`;
const OPENED_ORIGINAL = `Opened “${DOCUMENT.name}”, the original`;
const OPENED_VARIATION = `Opened “${DOCUMENT.name}”, the variation “${VARIATION.name}”, the preview of draft 2`;
const REDRAFT_SAYS = [
  'You chose the first rewrite, accepted the wording and the move, and told me conversion rose 12%. Writing the next draft now.',
  'Have a look at the draft preview. The profile leads with your platform work, Skills come first, and the checkout line has its result. Accept it and it becomes Draft 1.',
];
const VARIATION_ASK = 'Make a version for the product lead role at Acme: leading a team of 6 on the design system';
const TALK_ASK = 'Keep my wording, but make it clear I built it';
// Where the cursor comes from at the start of a moment: a little below and right of where it's
// first going, in the window's pixels.
const CURSOR_FROM = { x: 160, y: 140 };
// Where the scenes whose focus depends on the interface's layout are about, measured at the
// window's size, for the site to frame them before they're first built (see focusHints). The
// scene's own measure replaces it once it's built.
const FOCUS_HINTS = {
  variation: WINDOW,
  'f-focus': { x: 0, y: 0, width: 689, height: 282 },
  'f-variation': { x: 839, y: 100, width: 377, height: 708 },
  'f-document': { x: 839, y: 100, width: 421, height: 708 },
  'f-setup': { x: 0, y: 0, width: 520, height: 800 },
};
// The top bar's left part and the focus menu that opens under it.
// How far the chat's window is dragged to show what's under it: clear of the cards beside the pages.
const CHAT_DRAG = 260;
// Where a narrow screen centres a scene of the AI at work: the chat.
const CHAT_X = CHAT_PLACE.x + CHAT_PLACE.width / 2;
// Where a scene puts the chat's window instead (its chatAt), so the site's shots vary: beside the
// app window on either side, apart from it, larger or smaller than it (scale), in the app window's
// pixels. Only on a wide screen (setShots).
const SHOTS = {
  ask: { x: 1330, y: 40, scale: 1.1 }, // apart, on the right, larger
  review: { x: 1310, y: 330, scale: 0.7 }, // small and apart, clear of the cards the review adds
  redraft: { x: 890, y: 16, scale: 1.08 }, // larger than the app, clear of the bar's Accept
  highlight: { x: -460, y: 70, scale: 1 }, // apart, on the left
  variation: { x: -170, y: 190, scale: 0.95 }, // over the left edge
  'f-structure': { x: 1020, y: 280, scale: 0.8 },
  'f-todo': { x: -450, y: 60, scale: 1 },
  'f-drafts': { x: 1320, y: 20, scale: 1.15 },
  'f-gaps': { x: 1320, y: 100, scale: 0.9 },
};

export function createDirector({ api }) {
  const cursor = makeCursor();
  // A dialog opened since goes above it; shown again, it's back on top.
  const raise = () => {
    if (!document.querySelector('dialog[open]')) return;
    cursor.hidePopover();
    cursor.showPopover();
  };

  let live = 0; // the scene asked for most recently; older ones stop at their next step
  let instant = false; // moments played through at once: for visitors who'd rather not have motion
  let hovered = null;
  let building = Promise.resolve();
  let current = null; // the scene asked for most recently
  let moment = null; // the built scene's moment (see show)
  const cursorListeners = [];
  let cursorWas = 'null';
  // The chat's window, once attached: its page, where it floats, and its cursor.
  let chat = null; // { win, doc, place, cursor }
  let moved = { x: 0, y: 0 }; // how far it's been dragged from its place in this scene
  const movedListeners = [];
  // The scene's chat before its moment: { main: [messages], [item id]: [messages] }.
  let chatBase = {};
  const start = Date.now() - 6 * 60 * 1000; // the chat's messages are from a few minutes ago on

  const pause = (ms, id) => new Promise((resolve, reject) => setTimeout(() => (id === live ? resolve() : reject(CANCELLED)), instant ? 0 : ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  // Waits until `find` returns something (the interface draws a moment after each change).
  async function waitFor(find, id, timeout = 8000) {
    const begin = performance.now();
    for (;;) {
      const found = find();
      if (found) return found;
      if (performance.now() - begin > timeout) throw new Error('The demo lost its place.');
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (id !== live) throw CANCELLED;
    }
  }

  // What the cursor is over shows as hovered (.demo-hover, see hover.js), in whichever window it's
  // in, and margin cards answer hovering too: the page fades behind the hovered card.
  let hoverShown = [];
  let hoverTarget = null;
  function hover(element) {
    if (element === hoverTarget) return;
    hoverTarget = element;
    for (const el of hoverShown) el.classList.remove('demo-hover');
    hoverShown = [];
    for (let el = element; el && el !== el.ownerDocument.body; el = el.parentElement) {
      el.classList.add('demo-hover');
      hoverShown.push(el);
    }
    const slot = element?.ownerDocument === document ? element.closest('.margin-slot') : null;
    if (slot === hovered) return;
    hovered?.dispatchEvent(new MouseEvent('mouseleave'));
    slot?.dispatchEvent(new MouseEvent('mouseenter'));
    hovered = slot;
  }

  // --- Finding things in the two windows ---------------------------------------------------------

  const button = (scope, label) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === label);
  const tab = (title) => [...document.querySelectorAll('.margin-tab')].find((t) => t.textContent.includes(title));
  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
  // In the chat's window.
  const inChat = (selector) => chat?.doc.querySelector(selector) ?? null;
  // In the floating panel of the suggestion opened from its card.
  const inPanel = (selector) => document.querySelector(`.margin-opened:not([hidden]) ${selector}`);
  const panelButton = (label) => [...document.querySelectorAll('.margin-opened:not([hidden]) button')].find((b) => b.textContent.trim() === label);
  const chatInput = () => inChat('.chat-compose textarea');
  const chatSend = () => inChat('.chat-send');
  const union = (...rects) => {
    const rs = rects.filter(Boolean);
    if (!rs.length) return WINDOW;
    const x = Math.min(...rs.map((r) => r.left ?? r.x));
    const y = Math.min(...rs.map((r) => r.top ?? r.y));
    return { x, y, width: Math.max(...rs.map((r) => r.right ?? r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.bottom ?? r.y + r.height)) - y };
  };
  // An element's box in the app window's pixels (the chat's window floating at its place).
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    const off = el.ownerDocument === document ? { x: 0, y: 0, scale: 1 } : place();
    return { x: off.x + r.left * off.scale, y: off.y + r.top * off.scale, width: r.width * off.scale, height: r.height * off.scale };
  };
  // The part of a box in the app's window (or anywhere, for the chat's), or null if none is.
  const inView = (box, inWindow) => {
    if (!inWindow) return box;
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const width = Math.min(WINDOW.width, box.x + box.width) - x;
    const height = Math.min(WINDOW.height, box.y + box.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  };
  const grow = (box, by) => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
  const centreOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  // A scene's region made at least REGION in size, round its middle, inside the windows.
  const atLeast = (box) => {
    const all = union(WINDOW, api.chatShown ? place() : null, box);
    const width = Math.min(all.width, Math.max(box.width, REGION.width));
    const height = Math.min(all.height, Math.max(box.height, REGION.height));
    const x = Math.min(all.x + all.width - width, Math.max(all.x, box.x + box.width / 2 - width / 2));
    const y = Math.min(all.y + all.height - height, Math.max(all.y, box.y + box.height / 2 - height / 2));
    return { x, y, width, height };
  };
  // Where the chat's window is, in the app window's pixels (scale: its size to the app window's).
  let shots = true;
  const place = (name = current) => {
    const at = (shots && SHOTS[name]) || chat?.place || CHAT_PLACE;
    const scale = at.scale ?? 1;
    return { x: at.x + moved.x, y: at.y + moved.y, width: CHAT_PLACE.width * scale, height: CHAT_PLACE.height * scale, scale };
  };
  function moveChat(to) {
    if (to.x === moved.x && to.y === moved.y) return;
    moved = to;
    movedListeners.forEach((listener) => listener({ ...place(), scene: current }));
  }
  // The app window with the chat's window by it, and as far as a scene drags it aside (CHAT_DRAG).
  const withChat = () => union(WINDOW, place());
  const withChatDragged = () => union(WINDOW, { ...place(), x: place().x + CHAT_DRAG });
  // Where a scene drags the chat's window to, and where a suggestion opens in its panel: in a
  // scene's region, as they come only once its moment's under way.
  const draggedChat = () => ({ ...place(), x: place().x + CHAT_DRAG });
  const panelPlace = () => ({ x: PANEL_PLACE.left - 20, y: PANEL_PLACE.top - 20, width: 460, height: 540 });
  // Halfway between the chat's window and a point in the app's: where a scene of the AI at work is
  // anchored, so a cropped framing keeps both what it says and what it does in view.
  const besideChat = (x, y = 400) => {
    const p = place();
    return { x: (p.x + p.width / 2 + x) / 2, y: (p.y + p.height / 2 + y) / 2 };
  };
  // The suggestion open in its panel, with room round it.
  const panelFocus = (pad = 40) => {
    const r = rect('.margin-opened:not([hidden])');
    return r ? { x: r.left - pad, y: Math.max(0, r.top - pad), width: r.width + pad * 2, height: r.height + pad * 2 } : WINDOW;
  };
  // The top bar's left part, with whatever menu is open under it.
  const topLeft = () => union({ left: 0, top: 0, right: 640, bottom: 44 }, rect('.tool-card:not([hidden])'));

  // --- Building a scene's state ----------------------------------------------------------

  function closeAll() {
    hover(null);
    document.querySelector('.comment-composer .secondary-button')?.click();
    if (getSelection().rangeCount && !getSelection().isCollapsed) selectOnPage(null);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // closes an open card or menu
    document.querySelector('dialog[open]')?.close();
    document.querySelectorAll('.demo-menu, .demo-file').forEach((el) => el.remove());
    document.getElementById('document')?.classList.remove('dragging');
    if (document.body.classList.contains('mcp-open')) document.getElementById('server-pill')?.click();
    if (chat) {
      chat.doc.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // closes the AI picker's menu
      const input = chatInput();
      if (input?.value) setText(input, '');
    }
  }

  // Remembered per document (see app-shell.js): every scene starts on all the findings, in the
  // document view, and the chat opens in its own window, on Claude.
  function resetViews() {
    try {
      localStorage.setItem(`smartdoc.show.${DOC.id}`, 'all');
      localStorage.setItem(`smartdoc.view.${DOC.id}`, 'document');
      localStorage.setItem('chat-in-window', '1');
      localStorage.setItem('chat-ai', 'claude');
      localStorage.setItem('opened-card-place', JSON.stringify(PANEL_PLACE));
    } catch {}
  }

  // Selects text on the page as a press and release there would, or clears the selection. (Not
  // bubbling: only the pages hear the press, as the app's own handling of a press isn't needed.)
  function selectOnPage(range) {
    const selection = getSelection();
    selection.removeAllRanges();
    if (range) selection.addRange(range);
    document.getElementById('pages').dispatchEvent(new MouseEvent('mousedown'));
    window.dispatchEvent(new MouseEvent('mouseup'));
  }

  // The reviews as far as they've got: { improve: [shown, done], highlights: [shown, done] }, a
  // review left out not started.
  function progress({ improve, highlights } = {}) {
    api.clearComments();
    api.setAiControl(null);
    for (let i = 0; i < api.reviews.improve.items.length; i++) api.reviseItem(i, null);
    api.setProgress('improve', improve ? { started: true, shown: improve[0], done: improve[1] } : { started: false, shown: 0, done: false });
    api.setProgress('highlights', highlights ? { started: true, shown: highlights[0], done: highlights[1] } : { started: false, shown: 0, done: false });
  }
  const ALL_FINDINGS = [4, true];
  const ALL_HIGHLIGHTS = [5, true];

  // The document on draft `n` in `tool`, with the first `decided` findings decided (and the drafts
  // up to `n` made). A scene with the chat opens it (openChat); one without puts it away, once
  // it's built (so it stays from one scene with it to the next).
  async function onDocument(n, tool, { decided = 0, reviews = {}, made = n } = {}, id) {
    api.state.added = true;
    api.setMade(made);
    api.setAis();
    progress(reviews);
    resetViews();
    const s = api.state;
    if (s.screen !== 'document' || s.draft !== n || s.tool !== tool || s.previewing != null) {
      s.tool = tool;
      await api.showDraft(n);
      await waitFor(() => document.querySelector('.page .textLayer'), id);
    }
    api.setDecided(decided, DECISIONS);
    closeAll();
    document.getElementById('document').scrollTop = 0;
    await frame();
  }

  async function onHome({ added = true, made = 1, variation = false, reviews = {} } = {}, id) {
    api.state.added = added;
    api.setMade(made, variation);
    progress(reviews);
    hideChat();
    if (api.state.screen !== 'home') api.showHome(); // (on the home screen already, setMade listed it afresh)
    closeAll();
    await waitFor(() => (added ? document.querySelector('#home-drafts .home-item') : document.querySelector('#home-documents .home-empty')), id);
  }

  // --- The chat ----------------------------------------------------------------------------------

  // A message in the chat, as agent.js keeps them: n numbers it, so it's the same each time.
  const message = (convo, n, role, text) => ({ id: `demo-${convo}-${n}`, at: new Date(start + n * 20 * 1000).toISOString(), by: 'claude', role, text });
  // A conversation that's already happened, from its turns: [role, text] each ('context' for a line
  // of context the app posted).
  const said = (convo, turns) => turns.map(([role, text], n) => (role === 'context' ? { ...message(convo, n, 'event', text), kind: 'context' } : message(convo, n, role, text)));

  let chatWanted = false; // whether the scene being built opens the chat
  function hideChat() {
    if (api.chatShown) api.showChat(false);
  }
  // Each scene's chat starts from nothing but what it sets.
  function forgetChat() {
    chatWanted = false;
    chatBase = {};
    api.clearChats();
    builds++;
    setCommitTimes();
  }

  // The chat's window open on a conversation ('main' or an item's id), with what's been said so
  // far in the window's chat (`base`), waiting for it to show it.
  async function openChat(view, base, id) {
    chatWanted = true;
    chatBase = base;
    api.setChat(base, []);
    api.showChat(true, view);
    if (!chat) return;
    await waitFor(() => inChat('.chat-panel:not([hidden]) .chat-body'), id);
    if (Object.values(base).some((m) => m.length)) await waitFor(() => inChat('.chat-body .chat-message:not(.chat-start)'), id);
    await waitFor(() => inChat('.chat-compose textarea:not([disabled])'), id);
    await frame();
  }

  // What's been said in each scene's chat before its moment.
  const ASKED = [['user', IMPROVE_ASK], ['step', 'Looking over the document'], ['step', 'Reading the document'], ['step', 'Starting a review']];
  const REVIEWED = [
    ...ASKED,
    ...api.reviews.improve.items.map((item) => ['step', describeStep('add_finding', { title: item.title })]),
    ['step', 'Finishing the review'],
    ['assistant', 'Done: four suggestions, each beside the text it’s about. The profile is the big one. It could be anyone’s, so I’ve offered two rewrites. I’ve also asked what came of the checkout work, since a result would make that line much stronger.'],
  ];
  // The window's one chat goes on as the draft does: the next draft written and accepted, then the
  // highlights asked for on it.
  const REDRAFTED = [
    ...REVIEWED,
    ['user', REDRAFT_ASK],
    ['step', describeStep('get_review', {})],
    ['assistant', REDRAFT_SAYS[0]],
    ['step', describeStep('apply_review', {})],
    ['context', OPENED_PREVIEW],
    ['assistant', REDRAFT_SAYS[1]],
    ['context', OPENED_DRAFT_1],
  ];
  const HIGHLIGHTED = [
    ...REDRAFTED,
    ['user', HIGHLIGHTS_ASK],
    ['step', 'Reading the document'],
    ['step', 'Starting a review'],
    ...api.reviews.highlights.highlights.map((h) => ['step', describeStep('add_highlight', { title: h.title })]),
    ['step', 'Finishing the review'],
    ['assistant', 'At a glance: six years of platform leadership and a 12% lift in conversion. One gap: you don’t say how big your team at Acme is.'],
  ];

  // When each review was finished: between its last step and the AI's reply (both conversations
  // have their 'Finishing the review' second from the end), where the chat puts its card.
  // A millisecond more for each scene built: the chat keeps a review's list unfolded by when it
  // was finished, and each scene starts with it folded.
  let builds = 0;
  const finishedAfter = (n) => new Date(start + n * 20 * 1000 + 10 * 1000 + builds).toISOString();
  const setCommitTimes = () => api.setCommitTimes({ improve: finishedAfter(REVIEWED.length - 2), highlights: finishedAfter(HIGHLIGHTED.length - 2) });
  setCommitTimes();

  // --- Placing the cursor, and other helpers -------------------------------------------------------

  // Opens a suggestion in its floating panel, as clicking its card beside the page does.
  async function openCard(title, id) {
    (await waitFor(() => tab(title), id)).click();
    await waitFor(() => document.querySelector('.margin-opened:not([hidden]) .margin-opened-title')?.textContent.includes(title.slice(0, 12)), id);
    await frame();
  }
  // A conversation so far, then the line of context the app posts as a suggestion's opened.
  const saidThenLooking = (turns, title) => [...said('main', turns), { ...message('main', turns.length, 'event', `Looking at “${title}”`), kind: 'context', focus: true, about: title }];

  // Selects a variation on the home screen (choosing one draws the list afresh, so its row is
  // looked up again each time).
  async function selectVariation(name, id) {
    const row = () => [...document.querySelectorAll('#home-variations .home-row')].find((r) => r.textContent.includes(name));
    const chosen = await waitFor(row, id);
    if (chosen.getAttribute('aria-pressed') !== 'true') chosen.click();
    await waitFor(() => row()?.getAttribute('aria-pressed') === 'true' && document.querySelector('#home-drafts .home-item'), id);
  }

  // A file dragged over the window, as the app sees it: the drop indicator takes the page's place.
  // Then dropped, as the app sees it too: the document is added and opens (openDroppedFile, in
  // demo-api.js), the indicator showing until its first page is drawn.
  // A file being dragged, as the window sees one (it only takes a drag that carries files).
  function fileDrag() {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([], DOC.name, { type: 'application/pdf' }));
    return dataTransfer;
  }
  function dragOver() {
    document.getElementById('document').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: fileDrag() }));
  }
  async function drop() {
    const doc = document.getElementById('document');
    doc.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: fileDrag() }));
    await waitFor(() => !doc.classList.contains('dragging'), live);
  }
  // Where the site has the CV, as its page scrolls (the upload scene only): 'away' beside the
  // window, 'over' it (the drop indicator showing) or 'dropped' (the document open). It can go back
  // as well as on: back from dropped, the document's put away again. Each change waits for the last
  // to finish, then goes to wherever the page is by then.
  let dragWanted = 'away';
  let dragging = false;
  function dragTo(where) {
    dragWanted = where;
    if (dragging) return;
    dragging = true;
    (async () => {
      let done;
      try {
        do {
          done = dragWanted;
          if (current !== 'upload') break;
          const doc = document.getElementById('document');
          if (done === 'dropped') {
            if (api.state.screen !== 'document') await drop();
            continue;
          }
          if (api.state.added || api.state.screen !== 'home') {
            api.state.added = false;
            api.showHome();
          }
          if (done === 'over') {
            if (!doc.classList.contains('dragging')) dragOver();
          } else {
            doc.classList.remove('dragging');
          }
        } while (done !== dragWanted);
      } catch (error) {
        if (error !== CANCELLED) throw error; // left for another scene while dropping
      } finally {
        dragging = false;
      }
    })();
  }

  // --- Beats -----------------------------------------------------------------------------
  // A moment's beats, each taking `ms` of the timeline (which sets how far the page scrolls for
  // it):
  //   - move: the cursor goes to what `find` finds (in either window)
  //   - press: the cursor presses, then `act` (a click) is done on what `find` finds
  //   - typed: text typed into what `find` finds, a character at a time
  //   - act: something done once the beat's reached (`undo` takes it back; without one, going
  //     back over it builds the scene afresh)
  //   - log: the AI's part, in the chat: the user's message ('prompt'), something it 'say's (typed
  //     out over the beat) or a 'tool' it calls (a step in the chat, its `act` done at its end)
  //   - hide: the cursor's put away (while the AI works)

  const wait = (ms) => ({ ms });
  const move = (find, ms = 650) => ({ ms, find, move: true });
  const click = (find) => [move(find), wait(120), { ms: 330, find, press: true, act: (el) => el.click() }];
  const typeInto = (find, text) => [
    move(find),
    { ms: 330, find, press: true, act: (el) => { el.click(); el.focus({ preventScroll: true }); } },
    { ms: text.length * 32, find, typed: text },
  ];
  const act = (fn, undo, ms = 0) => ({ ms, act: fn, undo });
  // A line of context the app posts to the chat as the user looks at or decides something (it goes
  // to the AI with their next message): `about` for what they're looking at.
  const note = (text, about = null) => ({ ms: 250, log: 'note', text, about, convo: 'main' });
  // The chat's window dragged by its header by (dx, dy), out of the way of what's under it.
  const dragChat = (dx, dy) => [
    move(() => inChat('.chat-head')),
    { ms: 200, find: () => inChat('.chat-head'), press: true },
    { ms: 900, drag: { dx, dy } },
    wait(200),
  ];
  // The chat's send button clicked: what's written goes (the chat empties its box itself, unless
  // it's still busy from a scene before, so it's emptied here too).
  const send = () => [move(chatSend), wait(120), { ms: 330, find: chatSend, press: true, act: (el) => { el.click(); setText(chatInput(), ''); } }];

  // The user writing to the AI in the chat (in a thread, if `convo` is an item's id), then the AI
  // at work: each step in turn, { say } for something it says (typed out), or { tool, input, act,
  // undo, wait } for a SmartDoc tool it calls, a step in the chat while it's under way, its `act`
  // done at its end. The chat shows it working until it's said its last.
  let works = 0;
  const ask = (text, steps, convo = 'main') => {
    const work = ++works;
    const beats = [
      ...typeInto(chatInput, text),
      wait(200),
      ...send(),
      { ms: 300, log: 'prompt', text, convo, work, hide: true },
      ...steps.map((step) => (step.note
        ? { ms: 250, log: 'note', text: step.note, convo, work }
        : step.say
        ? { ms: 500 + step.say.length * 14, log: 'say', text: step.say, convo, work }
        : { ms: step.wait ?? 700, log: 'tool', text: describeStep(step.tool, step.input ?? {}), convo, work, act: step.act, undo: step.act ? step.undo : undefined })),
    ];
    beats.at(-1).last = true;
    return beats;
  };

  // A stand-in for the system's right-click menu (the app shows macOS's own), at the cursor.
  const contextMenu = (find, labels) => [
    move(find),
    act(() => {
      const at = pointAt(find());
      const menu = document.createElement('div');
      menu.className = 'demo-menu';
      menu.style.left = `${at.x + 4}px`;
      menu.style.top = `${at.y + 4}px`;
      menu.append(...labels.map((label) => Object.assign(document.createElement('div'), { className: 'demo-menu-item', textContent: label })));
      document.body.append(menu);
    }),
    wait(500),
  ];
  const menuItem = (n) => () => document.querySelectorAll('.demo-menu-item')[n];

  // --- Seeking -------------------------------------------------------------------------------

  // Where the cursor points at an element, in the app window's pixels (the chat's window floating
  // at its place): a little in from its left, below its middle.
  const pointAt = (el) => {
    const r = el.getBoundingClientRect();
    const off = el.ownerDocument === document ? { x: 0, y: 0, scale: 1 } : place();
    return { x: off.x + (r.left + Math.min(r.width * 0.5, 60)) * off.scale, y: off.y + (r.top + r.height * 0.6) * off.scale };
  };
  const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
  const overChat = (point) => {
    const p = place();
    return Boolean(chat && api.chatShown && point && point.x >= p.x && point.x <= p.x + p.width && point.y >= p.y && point.y <= p.y + p.height);
  };

  // The element a beat is about, found once per build (waiting for it to be drawn).
  async function element(beat, id) {
    if (!beat.find) return null;
    if (!moment.found.has(beat)) {
      const el = await waitFor(beat.find, id);
      moment.found.set(beat, { el, point: pointAt(el) });
    }
    return moment.found.get(beat).el;
  }

  // Does a beat's lasting part: its act (and the whole of a typed text).
  async function finish(beat, id) {
    const el = await element(beat, id);
    if (beat.typed !== undefined) setText(el, beat.typed);
    if (beat.act) await beat.act(el, id);
    if (id !== live) throw CANCELLED;
  }
  async function undo(beat, id) {
    if (beat.typed !== undefined) setText(await element(beat, id), '');
    if (beat.undo) await beat.undo(id);
  }
  const undoable = (beat) => !beat.act || beat.undo;
  function setText(field, text) {
    if (field.value === text) return;
    field.value = text;
    field.dispatchEvent(new Event('input'));
  }

  // Puts the moment at point p (0 to 1) of its timeline: beats before it done, beats after it not,
  // and the one it's in part way.
  async function seekTo(p) {
    const m = moment;
    if (!m || m.id !== live) return;
    const id = m.id;
    const { beats } = m;
    // The beat the point's in, and how far through it (beats taking no time are done once reached).
    const at = p * m.total;
    let k = 0;
    let begin = 0;
    while (k < beats.length && begin + beats[k].ms <= at) {
      begin += beats[k].ms;
      k++;
    }
    const u = k < beats.length && beats[k].ms ? Math.min(1, (at - begin) / beats[k].ms) : 0;

    // Back: undoing what can be, or building the scene afresh if anything can't.
    if (k < m.done) {
      const back = beats.slice(k, m.done);
      if (back.every(undoable)) {
        for (const beat of back.reverse()) await undo(beat, id);
      } else {
        await rebuild(m);
        if (id !== live) return;
      }
      m.done = Math.min(m.done, k);
    }
    // On: doing what's been passed.
    while (m.done < k) {
      await finish(beats[m.done], id);
      m.done++;
    }
    await draw(m, k, u, id);
  }

  async function rebuild(m) {
    closeAll();
    forgetChat();
    moveChat({ x: 0, y: 0 });
    await SCENES[m.name].build(m.id);
    if (!chatWanted) hideChat();
    await frame();
    m.found.clear();
    m.done = 0;
    m.chat = null;
  }

  // Draws the moment's continuous parts at beat k, u of the way through it.
  async function draw(m, k, u, id) {
    const { beats } = m;
    const beat = beats[k];
    if (beat?.find) await element(beat, id);
    if (id !== live) return;

    // The cursor: at the last place it moved to, or on its way to the next; hidden before its first
    // move and while the AI works.
    let from = null; // (none before its first move: it comes from near where that goes)
    let shown = false;
    let last = null; // the element the cursor last arrived at
    let dragged = { x: 0, y: 0 }; // the chat's window, dragged so far
    for (let i = 0; i < k; i++) {
      if (beats[i].hide) {
        shown = false;
        last = null;
      }
      if (beats[i].move) {
        const found = m.found.get(beats[i]);
        from = found.point;
        last = found.el;
        shown = true;
      }
      if (beats[i].drag) {
        dragged = { x: dragged.x + beats[i].drag.dx, y: dragged.y + beats[i].drag.dy };
        if (from) from = { x: from.x + beats[i].drag.dx, y: from.y + beats[i].drag.dy };
      }
    }
    let point = from;
    if (beat?.drag && from) {
      // The window and the cursor holding its header go together.
      const e = ease(u);
      dragged = { x: dragged.x + beat.drag.dx * e, y: dragged.y + beat.drag.dy * e };
      point = { x: from.x + beat.drag.dx * e, y: from.y + beat.drag.dy * e };
    }
    moveChat(dragged);
    if (beat?.move) {
      const to = m.found.get(beat).point;
      from ??= { x: Math.min(WINDOW.width - 20, to.x + CURSOR_FROM.x), y: Math.min(WINDOW.height - 20, to.y + CURSOR_FROM.y) };
      const e = ease(u);
      point = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      shown ||= u > 0;
      if (u < 1) last = null;
    }
    raise();
    // Each window draws its own cursor: the chat's while the cursor's over it, as it's in front.
    const visible = shown && !instant;
    const inChatWindow = visible && overChat(point);
    cursor.classList.toggle('shown', visible && !inChatWindow);
    chat?.cursor?.classList.toggle('shown', inChatWindow);
    // Where it is, for the site to keep in view on a narrow screen.
    const where = JSON.stringify(visible ? point : null);
    if (where !== cursorWas) {
      cursorWas = where;
      cursorListeners.forEach((listener) => listener(JSON.parse(where)));
    }
    if (point) {
      cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
      if (chat?.cursor) {
        const p = place();
        chat.cursor.style.transform = `translate(${(point.x - p.x) / p.scale}px, ${(point.y - p.y) / p.scale}px)`;
      }
    }
    const pressed = Boolean((beat?.press && u > 0 && u < 1) || (beat?.drag && u < 1));
    cursor.classList.toggle('pressed', pressed);
    chat?.cursor?.classList.toggle('pressed', pressed);
    hover(shown ? last : null);

    // Typing: as much of the text as the point's reached.
    if (beat?.typed !== undefined) setText(m.found.get(beat).el, beat.typed.slice(0, Math.round(beat.typed.length * u)));

    // The chat: what was said before the moment, then what's been said in it so far, and where the
    // AI is still at work.
    const conversations = structuredClone(chatBase);
    let running = null;
    for (let i = 0; i <= k && i < beats.length; i++) {
      const b = beats[i];
      if (!b.log) continue;
      const partial = i === k;
      if (partial && !(u > 0) && b.ms) continue;
      const convo = (conversations[b.convo] ??= []);
      if (b.log === 'note') {
        // Looking at something new replaces a line about what was looked at before, as in the app.
        if (b.about && convo.at(-1)?.kind === 'context' && convo.at(-1).focus) convo.pop();
        convo.push({ ...message(b.convo, convo.length, 'event', b.text), kind: 'context', ...(b.about && { focus: true, about: b.about }) });
        continue;
      }
      const role = { prompt: 'user', say: 'assistant', tool: 'step' }[b.log];
      const text = b.log === 'say' && partial ? b.text.slice(0, Math.round(b.text.length * u)) : b.text;
      // A reply still being written out: the chat shows no Working while it is.
      if (text) convo.push({ ...message(b.convo, convo.length, role, text), ...(b.log === 'say' && partial && u < 1 && { streaming: true }) });
      running = b.last && !(partial && u < 1) ? null : b.convo;
    }
    const chatNow = JSON.stringify([conversations, running]);
    if (chatNow !== m.chat) {
      m.chat = chatNow;
      api.setChat(conversations, running ? [running] : []);
    }
  }

  // Seeks run one at a time, each going to wherever the page has got to by the time it starts.
  let seekWanted = null;
  let seeking = Promise.resolve();
  let seekBusy = false;
  function seek(p) {
    seekWanted = p;
    if (seekBusy) return;
    seekBusy = true;
    seeking = (async () => {
      while (seekWanted !== null) {
        const next = seekWanted;
        seekWanted = null;
        try {
          await seekTo(next);
        } catch (error) {
          if (error !== CANCELLED) console.warn(error);
        }
      }
      seekBusy = false;
    })();
  }

  // --- The scenes ------------------------------------------------------------------------
  // build: the scene's state; focus: what it's about; beats: its moment.

  const SCENES = {
    // --- The hero: the two tools, which it swaps between ---

    'intro-improve': {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(900), move(() => tab('Lead with what you built'))],
    },
    'intro-highlights': {
      build: (id) => onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(900), move(() => tab('Six years leading platform work'))],
    },

    // --- The home page: a session, from opening the CV to a variation for one job ---

    // An empty home screen, waiting for the CV: the site drags it in from beside the window and
    // drops it as its page scrolls (dragTo, above). On its own, the demo drags in a file of its own.
    upload: {
      async build(id) {
        api.state.tool = 'improve'; // opens in Review and draft, whatever the hero last showed
        await onHome({ added: false, made: 0 }, id);
      },
      focus: () => WINDOW,
      beats: () => (window.parent !== window ? [] : [
        act(() => {
          const file = document.createElement('div');
          file.className = 'demo-file';
          file.innerHTML = '<span class="demo-file-icon">PDF</span><span>Alex Example CV.pdf</span>';
          document.body.append(file);
          file.style.transform = 'translate(1180px, 860px)';
        }),
        wait(400),
        act(() => {
          const file = document.querySelector('.demo-file');
          file.classList.add('moving');
          file.style.transform = 'translate(560px, 330px)';
        }),
        wait(900),
        act(dragOver),
        wait(1100),
        act(async () => {
          document.querySelector('.demo-file')?.remove();
          await drop();
        }),
      ]),
    },
    // The chat opened, Claude chosen (or ChatGPT: it's the user's own), and what the review is for
    // written to it.
    ask: {
      async build(id) {
        await onDocument(0, 'improve', {}, id);
        await openChat('main', {}, id);
      },
      focus: withChat,
      beats: () => [
        wait(400),
        ...click(() => inChat('.chat-ai')),
        wait(700),
        ...click(() => [...(chat?.doc.querySelectorAll('.chat-ai-option') ?? [])].find((o) => o.textContent.includes('Claude'))),
        wait(400),
        ...typeInto(chatInput, IMPROVE_ASK),
        wait(300),
        ...send(),
        { ms: 400, log: 'prompt', text: IMPROVE_ASK, convo: 'main', work: -1, last: true },
      ],
    },
    // The AI reads the CV and adds its suggestions one by one, beside their text and in the chat's
    // list, then finishes.
    review: {
      narrowX: CHAT_X,
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: [0, false] } }, id);
        await openChat('main', { main: said('main', [['user', IMPROVE_ASK]]) }, id);
      },
      focus: withChat,
      region: () => ({ x: 700, y: 60, width: 580, height: 700 }), // the suggestions arriving beside the page
      anchor: () => besideChat(1150), // and the chat
      beats: () => {
        const beats = [
          wait(300),
          ...[['get_document_info'], ['get_document'], ['start_review']].map(([tool]) => ({ ms: tool === 'get_document' ? 1100 : 700, log: 'tool', text: describeStep(tool), convo: 'main', work: 0, hide: true })),
          ...api.reviews.improve.items.map((item, i) => ({
            ms: 900, log: 'tool', text: describeStep('add_finding', { title: item.title }), convo: 'main', work: 0,
            act: () => api.setProgress('improve', { shown: i + 1 }),
            undo: () => api.setProgress('improve', { shown: i }),
          })),
          {
            ms: 600, log: 'tool', text: describeStep('commit_review'), convo: 'main', work: 0,
            act: () => api.setProgress('improve', { done: true }),
            undo: () => api.setProgress('improve', { done: false }),
          },
          { ms: 2600, log: 'say', text: REVIEWED.at(-1)[1], convo: 'main', work: 0, last: true },
          wait(600),
        ];
        // It was already at work when the scene began: the user had just sent it.
        return beats;
      },
    },
    // The chat moved aside, a suggestion opened from its card beside the page, a rewrite picked and
    // confirmed in its panel, and a wording change accepted: each noted in the chat, for the AI.
    decide: {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id);
        await openChat('main', { main: said('main', REVIEWED) }, id);
      },
      focus: () => withChatDragged(),
      region: panelPlace, // (the chat, dragged aside, needn't all show,
      reach: draggedChat, // but nothing may cover it)
      main: panelPlace, // the suggestion open in its panel, where it's decided
      beats: () => {
        const profile = api.reviews.improve.items[0];
        return [
          wait(400),
          ...dragChat(CHAT_DRAG, 0),
          ...click(() => tab('Rewrite the profile')),
          note(`Looking at “${profile.title}”`, profile.title),
          wait(600),
          ...click(() => inPanel('.option input')),
          wait(300),
          ...click(() => panelButton('Confirm')),
          note(`Chose “${profile.options[0].label}” for “${profile.title}”`),
          wait(700),
          ...click(() => tab('Lead with what you built')),
          note('Looking at “Lead with what you built”', 'Lead with what you built'),
          wait(600),
          ...click(() => panelButton('Accept')),
          note('Accepted “Lead with what you built”'),
          wait(600),
        ];
      },
    },
    // A question answered in its panel, and a move accepted.
    answer: {
      async build(id) {
        await onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id);
        await openChat('main', { main: said('main', REVIEWED) }, id);
      },
      focus: () => withChatDragged(),
      region: panelPlace, // (the chat, dragged aside, needn't all show,
      reach: draggedChat, // but nothing may cover it)
      main: panelPlace, // the suggestion open in its panel, where it's decided
      beats: () => {
        const question = api.reviews.improve.items[2];
        return [
          wait(400),
          ...dragChat(CHAT_DRAG, 0),
          ...click(() => tab('What came of the checkout')),
          note(`Looking at “${question.title}”`, question.title),
          wait(500),
          ...typeInto(() => inPanel('.decision-answer'), DECISIONS[2].answer),
          ...click(() => panelButton('Answer')),
          note(`Answered “${question.title}”`),
          wait(800),
          ...click(() => tab('Put Skills before Experience')),
          note('Looking at “Put Skills before Experience”', 'Put Skills before Experience'),
          wait(600),
          ...click(() => panelButton('Accept')),
          note('Accepted “Put Skills before Experience”'),
          wait(600),
        ];
      },
    },
    // Everything decided: asked for in the chat, the AI writes a preview of Draft 1, which opens by
    // itself; accepting it makes it the draft, and the chat goes on, saying so.
    redraft: {
      narrowX: CHAT_X,
      async build(id) {
        await onDocument(0, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS }, made: 0 }, id);
        await openChat('main', { main: said('main', REVIEWED) }, id);
      },
      focus: withChat,
      beats: () => [
        wait(400),
        ...ask(REDRAFT_ASK, [
          { tool: 'get_review', wait: 600 },
          { say: REDRAFT_SAYS[0] },
          { tool: 'apply_review', wait: 2000, act: () => api.showPreview(1), undo: () => api.showDraft(0) },
          { note: OPENED_PREVIEW },
          { say: REDRAFT_SAYS[1] },
        ]),
        wait(400),
        ...click(() => button('.review-bar', 'Accept as Draft 1')),
        note(OPENED_DRAFT_1),
        wait(1200),
      ],
    },
    // The other tool: switched to, and asked in the chat what a recruiter would see; its highlights
    // added one by one.
    highlight: {
      narrowX: CHAT_X,
      async build(id) {
        await onDocument(1, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS } }, id);
        await openChat('main', { main: said('main', REDRAFTED) }, id);
      },
      focus: withChat,
      beats: () => [
        wait(400),
        ...click(() => document.getElementById('tool-button')),
        wait(400),
        ...click(() => [...document.querySelectorAll('#tool-card .tool-option')].find((o) => o.textContent.includes('Review and highlight'))),
        wait(500),
        ...ask(HIGHLIGHTS_ASK, [
          { tool: 'get_document', wait: 1000 },
          { tool: 'start_review', act: () => api.setProgress('highlights', { started: true, shown: 0, done: false }), undo: () => api.setProgress('highlights', { started: false, shown: 0, done: false }) },
          ...api.reviews.highlights.highlights.map((h, i) => ({
            tool: 'add_highlight', input: { title: h.title },
            act: () => api.setProgress('highlights', { shown: i + 1 }),
            undo: () => api.setProgress('highlights', { shown: i }),
          })),
          { tool: 'commit_review', wait: 500, act: () => api.setProgress('highlights', { done: true }), undo: () => api.setProgress('highlights', { done: false }) },
          { say: HIGHLIGHTED.at(-1)[1] },
        ]),
      ],
    },
    // A version for one job, asked for in the chat: the AI makes a variation from Draft 1, tailors
    // it, and home shows the new variation, the original as it was.
    variation: {
      narrowX: CHAT_X,
      async build(id) {
        await onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        await openChat('main', { main: said('main', HIGHLIGHTED) }, id);
      },
      focus: withChat,
      beats: () => [
        wait(400),
        ...ask(VARIATION_ASK, [
          { tool: 'create_variation', wait: 1100, act: () => api.setMade(1, true), undo: () => api.setMade(1, false) },
          { say: 'The job leads with the design system and a team of six, so I’ll bring those to the top.' },
          { tool: 'get_document' },
          { tool: 'apply_review', wait: 1600 },
          { note: OPENED_VARIATION },
          { say: 'Made “Acme product lead” from Draft 1, with a draft preview of its Draft 2 for the job, for you to accept. Your original CV and its drafts are as they were.' },
        ]),
        wait(600),
        act(async (_, id) => {
          await onHome({ made: 1, variation: true, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
          await selectVariation('Acme', id);
        }),
        note('Went home'),
        wait(900),
      ],
    },

    // --- The features page: each part of the app ---

    // Suggestions in the margins, beside their text, coloured by kind.
    'f-margin': {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(600), move(() => tab('Lead with what you built')), wait(1400), move(() => tab('Rewrite the profile'))],
    },
    // The chat: your own AI, Claude or ChatGPT, chosen under its message box.
    'f-chat': {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id);
        await openChat('main', { main: said('main', REVIEWED) }, id);
      },
      // The app's window and the chat's, as far as it's dragged.
      focus: () => withChatDragged(),
      reach: draggedChat,
      beats: () => [
        wait(600),
        ...click(() => inChat('.chat-ai')),
        wait(600),
        move(() => [...(chat?.doc.querySelectorAll('.chat-ai-option') ?? [])].find((o) => o.textContent.includes('ChatGPT'))),
        wait(1200),
        ...click(() => [...(chat?.doc.querySelectorAll('.chat-ai-option') ?? [])].find((o) => o.textContent.includes('Claude'))),
        wait(500),
        // A window of its own: moved out of the way of the cards beside the pages.
        ...dragChat(CHAT_DRAG, 0),
        wait(300),
        move(() => tab('Lead with what you built')),
        wait(900),
      ],
    },
    // Options: a choice of rewrites, picked then confirmed, in the suggestion's panel.
    'f-options': {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id);
        await openCard('Rewrite the profile', id);
      },
      focus: () => panelFocus(),
      beats: () => [wait(900), ...click(() => document.querySelectorAll('.margin-opened:not([hidden]) .option input')[1]), wait(500), ...click(() => panelButton('Confirm'))],
    },
    // A change: accept, reject or edit it.
    'f-edit': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 1, reviews: { improve: ALL_FINDINGS } }, id);
        await openCard('Lead with what you built', id);
      },
      focus: () => panelFocus(),
      beats: () => [wait(800), ...click(() => panelButton('Edit'))],
    },
    // Talking a suggestion over: the chat knows which one's open, and the AI reworks it in its panel.
    'f-talk': {
      narrowX: CHAT_X,
      async build(id) {
        await onDocument(0, 'improve', { decided: 1, reviews: { improve: ALL_FINDINGS } }, id);
        await openChat('main', { main: saidThenLooking(REVIEWED, 'Lead with what you built') }, id);
        await openCard('Lead with what you built', id);
      },
      focus: () => union(panelFocus(), place()),
      beats: () => {
        const item = api.reviews.improve.items[1];
        return [
          wait(500),
          ...ask(TALK_ASK, [
            {
              tool: 'revise_finding', wait: 1200,
              act: () => api.reviseItem(1, { proposal: { before: item.proposal.before, after: 'Responsible for the design system 4 teams use across 3 apps, which I built' } }),
              undo: () => api.reviseItem(1, null),
            },
            { say: 'Done: it keeps “Responsible for” and says you built it. Decide on the new version in its card.' },
          ]),
        ];
      },
    },
    // Questions only the user can answer.
    'f-questions': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id);
        await openCard('What came of the checkout', id);
      },
      focus: () => panelFocus(),
      beats: () => [wait(600), ...typeInto(() => inPanel('.decision-answer'), DECISIONS[2].answer)],
    },
    // Structure and design, in the left margin.
    'f-structure': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 3, reviews: { improve: ALL_FINDINGS } }, id);
        await openChat('main', { main: said('main', REVIEWED) }, id);
      },
      focus: withChat,
      beats: () => [wait(600), ...click(() => tab('Put Skills before Experience')), note('Looking at “Put Skills before Experience”', 'Put Skills before Experience'), wait(900)],
    },
    // A comment of the user's own: text selected, the comment typed, and its card in the margin.
    'f-comment': {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id);
        const span = await waitFor(() => [...document.querySelectorAll('#pages .textLayer span')].find((s) => s.textContent.startsWith('Lead the frontend platform team')), id);
        const text = span.firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 'Lead the frontend platform team'.length);
        selectOnPage(range);
        await waitFor(() => document.querySelector('.comment-offer'), id);
      },
      focus: () => WINDOW,
      beats: () => [
        wait(700),
        ...click(() => document.querySelector('.comment-offer')),
        wait(200),
        ...typeInto(() => document.querySelector('.comment-composer textarea'), 'Say how big the team is.'),
        wait(300),
        ...click(() => document.querySelector('.comment-composer .primary-button')),
        wait(900),
      ],
    },
    // The chat follows along: what's opened and decided is noted there, for the AI with the next
    // message, and the message box says what a question would be about.
    'f-todo': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id);
        await openChat('main', { main: said('main', REVIEWED) }, id);
      },
      focus: withChat,
      beats: () => [
        wait(500),
        ...click(() => tab('Put Skills before Experience')),
        note('Looking at “Put Skills before Experience”', 'Put Skills before Experience'),
        wait(700),
        move(chatInput),
        wait(1200),
      ],
    },
    // Every draft kept, picked from the list in the top bar, the window's chat going on.
    'f-drafts': {
      async build(id) {
        await onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        await openChat('main', { main: said('main', HIGHLIGHTED) }, id);
      },
      focus: withChat,
      beats: () => [
        wait(700),
        ...click(() => document.getElementById('draft-button')),
        wait(700),
        ...click(() => [...document.querySelectorAll('#draft-card .draft-option')].find((o) => o.textContent.includes('Original'))),
        note(OPENED_ORIGINAL),
        wait(1600),
      ],
    },
    // The preview beside the draft it was written from, stepping through what changed.
    'f-compare': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS }, made: 0 }, id);
        await api.showPreview(1);
        (await waitFor(() => button('.review-bar', 'Compare with Original'), id)).click();
        await waitFor(() => document.querySelector('.compare-mark'), id, 15000);
      },
      focus: () => WINDOW,
      beats: () => [
        wait(700),
        ...click(() => document.querySelector('.compare-step[aria-label="Next change"]')),
        wait(1300),
        ...click(() => document.querySelector('.compare-step[aria-label="Next change"]')),
      ],
    },
    // Focuses: what each review is for, and a prompt for another AI app to start a new one.
    'f-focus': {
      async build(id) {
        await onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        document.getElementById('focus-button').click();
        await waitFor(() => document.querySelector('#focus-card:not([hidden]) .focus-goal-input'), id);
      },
      focus: topLeft,
      beats: () => [wait(700), ...typeInto(() => document.querySelector('#focus-card .focus-goal-input'), 'Anything that would worry a hiring manager')],
    },
    // Highlights: the key information, ranked, by category.
    'f-highlights': {
      build: (id) => onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(600), move(() => tab('Six years leading platform work')), wait(1200), move(() => tab('Conversion up 12%'))],
    },
    // What the document doesn't say.
    'f-gaps': {
      async build(id) {
        await onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        await openChat('main', { main: saidThenLooking(HIGHLIGHTED, 'No team size') }, id);
        await openCard('No team size', id);
      },
      focus: withChat,
      region: () => {
        const r = rect('.margin-opened:not([hidden])');
        return r && { x: r.left, y: r.top, width: r.width, height: r.height };
      },
      anchor: () => {
        const r = rect('.margin-opened:not([hidden])');
        return r ? besideChat(r.left + r.width / 2, r.top + r.height / 2) : undefined;
      },
      beats: () => [],
    },
    // The highlights as a list.
    'f-list': {
      build: (id) => onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(600), ...click(() => document.querySelector('#view-switch button[data-view="list"]'))],
    },
    // Setting an AI up from the app: installed with its maker's installer, how far it's got where
    // the button was, then signed in on its maker's page.
    'f-setup': {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id);
        api.setAis({ codex: { installed: false, loggedIn: false } });
        document.getElementById('server-pill').click();
        await waitFor(() => [...document.querySelectorAll('#ai-list .ai-row')].find((r) => r.textContent.includes('Codex') && r.querySelector('button')), id);
      },
      focus: () => ({ x: 0, y: 0, width: 520, height: 800 }),
      beats: () => {
        const codex = () => [...document.querySelectorAll('#ai-list .ai-row')].find((r) => r.textContent.includes('Codex'));
        const percent = (n) => act(() => api.aiProgress('codex', 'install', 'Downloading Codex…', n), undefined, 160);
        return [
          wait(600),
          ...click(() => codex()?.querySelector('button')),
          act(() => api.aiProgress('codex', 'install', 'Getting ready to install Codex…'), undefined, 500),
          ...[4, 11, 19, 28, 37, 45, 54, 63, 71, 80, 88, 95, 99].map(percent),
          act(() => api.aiProgress('codex', 'install', 'Setting up Codex…'), undefined, 700),
          act(() => api.finishSetup({ codex: { installed: true } })),
          wait(700),
          ...click(() => codex()?.querySelector('button')),
          act(() => api.aiProgress('codex', 'sign-in', 'Waiting for you to sign in in your browser…'), undefined, 1400),
          act(() => api.finishSetup({ codex: { loggedIn: true } })),
          wait(900),
        ];
      },
    },
    // Two AIs at once, a window each (the site shows the second scene in a second window beside the
    // first): one reviewing the original, the other picking out the key information in Draft 1.
    'f-windows': {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: [0, false] }, made: 1 }, id);
        api.setAiControl('Claude Code');
      },
      focus: () => WINDOW,
      beats: () => [1, 2, 3, 4].flatMap((shown) => [
        wait(650),
        act(() => api.setProgress('improve', { shown }), () => api.setProgress('improve', { shown: shown - 1 })),
      ]),
    },
    'f-windows-right': {
      async build(id) {
        await onDocument(1, 'highlights', { reviews: { improve: ALL_FINDINGS, highlights: [0, false] } }, id);
        api.setAiControl('Claude Desktop');
      },
      focus: () => WINDOW,
      beats: () => [1, 2, 3, 4, 5].flatMap((shown) => [
        wait(700),
        act(() => api.setProgress('highlights', { shown }), () => api.setProgress('highlights', { shown: shown - 1 })),
      ]),
    },
    // Home: documents, variations and drafts.
    'f-home': {
      build: (id) => onHome({ made: 1, variation: true, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(600), move(() => [...document.querySelectorAll('#home-variations .home-row')].find((r) => r.textContent.includes('Acme')))],
    },
    // A variation's own drafts, sharing those it started from.
    'f-variation': {
      async build(id) {
        await onHome({ made: 1, variation: true, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        await selectVariation('Acme', id);
      },
      focus: () => union(rect('.home-column:nth-child(3)')),
      beats: () => [0, 1, 2].flatMap((n) => [move(() => document.querySelectorAll('#home-drafts .home-item')[n]), wait(800)]),
    },
    // Any draft as a new document.
    'f-document': {
      build: (id) => onHome({ made: 1, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => union(rect('.home-column:nth-child(3)'), { left: 900, right: 1260, top: 100, bottom: 300 }),
      beats: () => [
        wait(500),
        ...contextMenu(() => document.querySelector('#home-drafts .home-item'), ['New Variation…', 'New Document from Draft', 'Delete this draft']),
        move(menuItem(1)),
        { ms: 0, find: menuItem(1), act: (el) => el.classList.add('active') },
      ],
    },
  };

  const lengthOf = (beats) => beats.reduce((sum, beat) => sum + beat.ms, 0);
  let playing = 0; // the moment playing through in time, if any (see start)

  return {
    scenes: Object.keys(SCENES),
    // Where the chat's window floats by the app's, in the app window's pixels (CHAT_PLACE).
    chatPlace: CHAT_PLACE,
    // The chat's window (demo-chat.html, loaded beside this one): started with this demo's API, and
    // driven from here. `at` is where it floats, if not at CHAT_PLACE.
    async attachChat(win, at = CHAT_PLACE) {
      while (!win.startChat) await new Promise((resolve) => setTimeout(resolve, 30));
      if (!chat) win.startChat(api);
      chat = { win, doc: win.document, place: at, cursor: win.demoCursor };
    },
    // Hears whether the chat's window shows, for the site to show it, and where it's been dragged
    // to (in the app window's pixels).
    onChatShown: (listener) => api.onChatShown(listener),
    onChatMoved(listener) {
      movedListeners.push(listener);
    },
    setInstant(on) {
      instant = on;
    },
    // Where each scene's about before it's built (see FOCUS_HINTS): the whole window, unless it's
    // known to be somewhere else.
    focusHints: () => Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => {
      const was = current;
      current = name; // its chat's place, for its focus
      try {
        return [name, { ...(FOCUS_HINTS[name] ?? scene.focus()), narrowX: scene.narrowX, chatAt: place(name) }];
      } finally {
        current = was;
      }
    })),
    // Whether scenes put the chat's window in places of their own (SHOTS): a wide screen's.
    setShots(on) {
      shots = on;
    },
    // How long each scene's moment is, in milliseconds, for the site to give it room to scroll.
    lengths: () => Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => [name, lengthOf(scene.beats())])),
    // The site dragging the CV in from beside the window as its page scrolls (the upload scene
    // only): 'away', 'over' the window, or 'dropped'.
    dragTo,
    // Puts the built scene's moment at point p (0 to 1), as the site's page scrolls.
    seek(p) {
      playing++;
      seek(p);
    },
    // Plays the built scene's moment through in time, from where it is; resolves once it's over
    // (finished, or stopped by a seek or another scene).
    start() {
      const m = moment;
      if (!m) return Promise.resolve();
      const token = ++playing;
      const begin = performance.now();
      return new Promise((resolve) => {
        const tick = () => {
          if (token !== playing || m !== moment) return resolve();
          const p = instant || !m.total ? 1 : Math.min(1, (performance.now() - begin) / m.total);
          seek(p);
          if (p < 1) requestAnimationFrame(tick);
          else resolve();
        };
        tick();
      });
    },
    // Hears where the cursor is (in the window's pixels) as it moves, or null when it's hidden.
    onCursor(listener) {
      cursorListeners.push(listener);
    },
    // Builds the scene, its moment at its start.
    show(name) {
      const id = ++live;
      current = name;
      moment = null;
      playing++;
      const scene = SCENES[name] ?? SCENES['intro-improve'];
      const result = Promise.all([building, seeking]).then(async () => {
        if (id !== live) return null;
        cursor.classList.remove('shown');
        chat?.cursor?.classList.remove('shown');
        hover(null);
        try {
          forgetChat();
          moveChat({ x: 0, y: 0 });
          await scene.build(id);
          if (!chatWanted) hideChat();
          await frame();
        } catch (error) {
          if (error !== CANCELLED) console.warn(error);
          return null;
        }
        if (id !== live) return null;
        const beats = scene.beats();
        // Where the cursor first goes, if it's drawn already: a narrow screen starts there.
        const first = beats.find((beat) => beat.move)?.find();
        // What the moment's about, for the site to keep in view (in the window's pixels): where its
        // cursor goes (what's there once it's built), the chat's window if it shows, and the part of
        // the window the scene says it's about, if it's a part; at least REGION in size. And its
        // anchor, the middle of where the cursor stays longest (the card or the field it works in),
        // for the site to centre on when it has to crop.
        const found = [];
        let last = null;
        for (const beat of beats) {
          if (beat.move) {
            let el = null;
            try {
              el = beat.find();
            } catch {}
            // (Only what's in view: a card scrolled out of the window isn't where the moment is.)
            const box = el && inView(boxOf(el), el.ownerDocument === document);
            last = box ? { box, dwell: 0 } : null;
            if (last) found.push(last);
          } else if (last) last.dwell += beat.ms;
        }
        const about = scene.focus();
        const parts = found.map((one) => grow(one.box, 30));
        if (api.chatShown) parts.push(place());
        if (about.width < WINDOW.width * 0.9) parts.push(about);
        if (scene.region) parts.push(scene.region()); // where the AI's work shows, without the cursor
        const region = parts.length ? atLeast(union(...parts)) : WINDOW;
        // Its main part: what the scene says (`main`), or where the cursor stays longest. The site
        // keeps it whole when it can't show all of the region.
        const longest = found.reduce((best, one) => (!best || one.dwell > best.dwell ? one : best), null);
        const main = scene.main?.() ?? (longest ? grow(longest.box, 20) : null);
        const anchor = scene.anchor?.() ?? centreOf(main ?? region);
        // (And where else its windows go in the moment, such as the chat dragged aside: `reach`.)
        const focus = { x: region.x, y: region.y, width: region.width, height: region.height, chat: api.chatShown, chatAt: place(), anchor, main, reach: scene.reach?.() };
        moment = { id, name: SCENES[name] ? name : 'intro-improve', beats, total: lengthOf(beats), done: 0, found: new Map(), chat: null };
        return focus;
      });
      building = result.catch(() => {});
      return result;
    },
  };
}
