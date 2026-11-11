// Plays the website demo one scene at a time, as the site's pages scroll (see site/story.js), as
// SmartDoc's does. Going to a scene first builds its state at once (where the story's schematics
// have got to, through the stand-in API's goTo, then what's showing: home, a schematic on the board
// or the overview), so scenes can be reached in any order, scrolling up or down. Its moment is then
// a timeline of beats: a drawn cursor moving to and clicking the real interface, typing into it,
// and the AI's part: in the app's own chat, in a window of its own (demo-chat.html, attached with
// attachChat) floating by the app's window, as SmartDoc's demo has it, the cursor going from one
// window to the other (each draws its own); or, for another agent picking up the plan, its messages
// and tool calls for the site's agent window. What the AI does goes through the stand-in API. The site puts the moment wherever its page has scrolled to (seek),
// forwards or back, so the cursor and the typing follow the scrolling; on its own, the demo plays
// each moment through in time (start).
//
// Going back over a beat that can't be undone (a click), the scene is built afresh and its beats
// done again at once, up to the point asked for.
//
// Two sets of scenes: the home page's run-through of a schematic, from asking for it to handing it
// to another agent, and the features page's look at each part of the app.
//
// show(name) resolves with the part of the window the scene is about (its focus, in the window's
// own pixels), for the site to bring into view, or null if another scene was asked for meanwhile.

import { describeStep } from '../../main/describe-step.js';
import { makeCursor } from './hover.js';
import { CHECKOUT_GOAL, COMMENT } from './scenario.js';

const WINDOW = { x: 0, y: 0, width: 1280, height: 800 };
// The least of the window a scene's region takes in, so a click on one button still shows what's
// round it.
const REGION = { width: 760, height: 480 };
// Where the chat's window floats by the app's, in the app window's pixels: over its right edge, a
// little past it, as the user might put it in the app.
export const CHAT_PLACE = { x: 1000, y: 70, width: 400, height: 660 };
// Where a narrow screen centres a scene of the AI at work in the chat.
const CHAT_X = CHAT_PLACE.x + CHAT_PLACE.width / 2;
// Where a scene puts the chat's window instead, so the site's shots vary: apart from the app window
// on either side, over its edge, larger or smaller than it (scale), in the app window's pixels.
// Only on a wide screen (setShots).
const SHOTS = {
  ask: { x: 1330, y: 60, scale: 1.05 }, // apart, on the right
  propose: { x: -450, y: 60, scale: 1 }, // apart, on the left, home's columns clear
  comment: { x: 1310, y: 330, scale: 0.7 }, // small and apart, the board clear
  revise: { x: 920, y: 56, scale: 1 }, // over the app's right edge, its side cards, under the top bar
  accept: { x: -330, y: 140, scale: 0.75 }, // small and apart, on the left
};
const CANCELLED = new Error('The scene changed.');
// Where the cursor comes from at the start of a moment: a little below and right of where it's
// first going, in the window's pixels.
const CURSOR_FROM = { x: 160, y: 140 };
// Where a narrow screen centres a scene of the agent at work: the middle of the board.
const AGENT_X = 640;
const LONG_PRESS = 560; // ms: a little over the app's half second

export function createDirector({ api }) {
  // In the top layer, so it's drawn above everything, open dialogs included (see raise).
  const cursor = makeCursor();
  // A dialog opened since goes above it; shown again, it's back on top.
  const raise = () => {
    if (!document.querySelector('dialog[open]')) return;
    cursor.hidePopover();
    cursor.showPopover();
  };

  let live = 0; // the scene asked for most recently; older ones stop at their next step
  let instant = false; // moments played through at once: for visitors who'd rather not have motion
  let building = Promise.resolve();
  let moment = null; // the built scene's moment (see show)
  let current = null; // the scene asked for most recently
  const agentListeners = [];
  // The chat's window, once attached: its page, where it floats, and its cursor.
  let chat = null; // { win, doc, place, cursor }
  let shots = true; // whether scenes place it (SHOTS)
  let chatWanted = false; // whether the scene being built opens it
  let chatBase = {}; // what's in the chat before the scene's moment: { main: [messages] }
  const start = Date.now() - 6 * 60 * 1000; // the chat's messages are from a few minutes ago on
  const cursorListeners = [];
  let cursorWas = 'null';

  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // What the agent has done so far, for the site to show in its agent window: { type: 'log',
  // entries }, each a 'prompt' (text: what the user pasted), something the agent 'say's (text, as
  // far as it's typed), or a 'tool' call (name, detail, and done once it's finished).
  const agent = (event) => agentListeners.forEach((listener) => listener(event));

  // Waits until `find` returns something (the interface draws a moment after each change).
  async function waitFor(find, id, timeout = 8000) {
    const start = performance.now();
    for (;;) {
      const found = find();
      if (found) return found;
      if (performance.now() - start > timeout) throw new Error('The demo lost its place.');
      await sleep(40);
      if (id !== live) throw CANCELLED;
    }
  }

  // What the cursor is over shows as hovered (.demo-hover, see hover.js), in whichever window it's in.
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
  }

  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
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
  const place = (name = current) => {
    const at = (shots && SHOTS[name]) || chat?.place || CHAT_PLACE;
    const scale = at.scale ?? 1;
    return { x: at.x, y: at.y, width: CHAT_PLACE.width * scale, height: CHAT_PLACE.height * scale, scale };
  };
  // The app window with the chat's window by it.
  const withChat = () => union(WINDOW, place());
  // Halfway between the chat's window and a point in the app's: where a scene of the AI at work is
  // anchored, so a cropped framing keeps both what it says and what it does in view.
  const besideChat = (x, y = 400) => {
    const p = place();
    return { x: (p.x + p.width / 2 + x) / 2, y: (p.y + p.height / 2 + y) / 2 };
  };
  const inChat = (selector) => chat?.doc.querySelector(selector) ?? null;
  const chatInput = () => inChat('.chat-compose textarea');
  const chatSend = () => inChat('.chat-send');
  const pad = (r, by = 24) => r && { left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by };
  // The board's or the overview's item, by its id.
  const item = (id) => document.querySelector(`:is(.board > .board-item, .overview-world > .overview-item)[data-item="${id}"]`);
  const part = (itemId, partId) => item(itemId)?.querySelector(`[data-part="${partId}"]`);
  const button = (scope, label) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === label);
  const marker = () => document.querySelector('.comment-marker:not(.away)');

  // --- Building a scene's state ----------------------------------------------------------

  // --- The chat ---
  // A message in the chat, as agent.js keeps them: n numbers it, so it's the same each time.
  const message = (n, role, text) => ({ id: `demo-main-${n}`, at: new Date(start + n * 20 * 1000).toISOString(), by: 'claude', role, text });
  // A conversation that's already happened, from its turns: [role, text] each ('context' for a line
  // of context the app posted).
  const said = (turns) => turns.map(([role, text], n) => (role === 'context' ? { ...message(n, 'event', text), kind: 'context' } : message(n, role, text)));
  // Each scene's chat starts from nothing but what it sets.
  function forgetChat() {
    chatWanted = false;
    chatBase = {};
    api.clearChats();
    const box = chatInput(); // nothing left typed from a scene before
    if (box) setText(box, '');
  }
  // The chat's window open, with what's been said so far (`turns`), waiting for it to show it.
  async function openChat(turns, id) {
    chatWanted = true;
    chatBase = { main: said(turns) };
    api.setChat(chatBase, []);
    api.showChat(true);
    if (!chat) return;
    await waitFor(() => inChat('.chat-panel:not([hidden]) .chat-body'), id);
    if (turns.length) await waitFor(() => inChat('.chat-body .chat-message:not(.chat-start)'), id);
    await frame();
  }

  function hideChat() {
    if (api.chatShown) api.showChat(false);
  }

  function closeAll() {
    hover(null);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // closes a comment box or menu
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.querySelectorAll('.demo-menu').forEach((el) => el.remove());
  }

  // Home, with the story at `state`.
  async function onHome(state, id) {
    await api.goTo(state);
    api.setAiControl(null);
    closeAll();
    if (!document.querySelector('.browser-column')) (await waitFor(() => document.getElementById('crumb-home'), id)).click();
    await waitFor(() => document.querySelector('.groups-column .browser-row'), id);
    await frame();
  }

  // Checkout, with the story at `state`, in `view` (focus or overview), as the user left it.
  async function onCheckout(state, view, id) {
    await api.goTo(state);
    api.setAiControl(null);
    closeAll();
    api.showSchema('checkout');
    const switcher = await waitFor(() => document.querySelector(`#view-switch:not([hidden]) button[data-view="${view}"]`), id);
    if (switcher.getAttribute('aria-pressed') !== 'true') switcher.click();
    await waitFor(() => (view === 'overview' ? document.querySelector('.overview-world .overview-item') : document.querySelector('.board > .board-item')), id);
    await settle(id);
  }

  // Waits until the page stops moving (cards glide into place), for up to 2 seconds.
  async function settle(id) {
    let last = null;
    let still = 0;
    const start = performance.now();
    while (still < 4 && performance.now() - start < 2000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (id !== live) throw CANCELLED;
      const now = JSON.stringify([...document.querySelectorAll('.board-item, .overview-world')].map((el) => el.getBoundingClientRect().toJSON()));
      still = now === last ? still + 1 : 0;
      last = now;
    }
  }

  // A long press, as the app hears one: the pointer down on `el` and held, then let go.
  async function longPress(el) {
    const { x, y } = pointAt(el);
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    await sleep(instant ? LONG_PRESS : LONG_PRESS);
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  }

  // --- Beats -----------------------------------------------------------------------------
  // A moment's beats, each taking `ms` of the timeline (which sets how far the page scrolls for
  // it):
  //   - move: the cursor goes to what `find` finds
  //   - press: the cursor presses, then `act` (a click) is done on what `find` finds
  //   - typed: text typed into what `find` finds, a character at a time
  //   - act: something done once the beat's reached (`undo` takes it back; without one, going
  //     back over it builds the scene afresh)
  //   - log: the agent's part: 'clear', a 'prompt', something it 'say's (typed out over the beat)
  //     or a 'tool' call (under way over the beat, done at its end, when its `act` is done)
  //   - hide: the cursor's put away (while the agent works)
  //   - drag: what `find` finds is picked up and carried to the point `drag` gives, as far as the
  //     beat's got, so the board follows the scrolling both ways; it's let go once the beat's passed

  const wait = (ms) => ({ ms });
  const move = (find, ms = 650) => ({ ms, find, move: true });
  const click = (find) => [move(find), wait(120), { ms: 330, find, press: true, act: (el) => el.click() }];
  const doubleClick = (find) => [move(find), wait(120), { ms: 420, find, press: true, act: (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }];
  const typeInto = (find, text) => [
    move(find),
    { ms: 330, find, press: true, act: (el) => { el.focus({ preventScroll: true }); } },
    { ms: text.length * 32, find, typed: text },
  ];
  const act = (fn, undo, ms = 0) => ({ ms, act: fn, undo });
  // Picks up what `find` finds and carries it to `to()` (in the window's pixels).
  const drag = (find, to, ms = 1800) => [move(find), wait(150), { ms, find, drag: to, act: () => {} }];
  // A long press on what `find` finds, the cursor pressed while it's held, opening a comment box.
  const hold = (find) => [move(find), wait(150), { ms: 700, find, press: true, act: (el) => longPress(el) }];

  // The user writing to the AI in the chat: typed into its message box and sent. The AI is at work
  // from then on.
  const send = () => [move(chatSend), wait(120), { ms: 330, find: chatSend, press: true, act: (el) => { el.click(); setText(chatInput(), ''); } }];
  const askInChat = (text) => [
    ...typeInto(chatInput, text),
    wait(200),
    ...send(),
    { ms: 300, chat: 'prompt', text, hide: true },
  ];
  // The AI at work in the chat: each step in turn, { say } for something it says (typed out),
  // { tool, input, act, undo, wait } for a SmartSpec tool it calls, a step in the chat while it's
  // under way, its `act` done at its end, or { note } for a line of context the app posts. The chat
  // shows it working until it's said its last.
  const aiWork = (steps) => {
    const beats = [
      { ms: 0, chat: 'working', hide: true },
      ...steps.map((step) => (step.note
        ? { ms: 250, chat: 'note', text: step.note }
        : step.say
        ? { ms: 500 + step.say.length * 14, chat: 'say', text: step.say }
        : { ms: step.wait ?? 700, chat: 'tool', text: describeStep(step.tool, step.input ?? {}), act: step.act, undo: step.act ? step.undo : undefined })),
    ];
    beats.at(-1).last = true;
    return beats;
  };
  // A line of context the app posts to the chat as the user does something.
  const note = (text) => ({ ms: 250, chat: 'note', text });

  // Another agent at work (in an AI app of the user's, for the site's agent window): the prompt pasted to it, then each step in turn: { say } for something it
  // says (typed out), or { tool, detail, act, undo, wait } for a SmartSpec tool call, a step as the
  // app's chat words it (describeStep), its `act` done once it's finished.
  const agentWork = (prompt, steps) => [
    { ms: 0, log: 'clear', hide: true },
    { ms: 800, log: 'prompt', text: prompt },
    ...steps.map((step) => (step.say
      ? { ms: 500 + step.say.length * 14, log: 'say', text: step.say }
      : { ms: step.wait ?? 700, log: 'tool', name: describeStep(step.tool, { item_id: step.detail, name: step.detail }), detail: '', done: '', act: step.act, undo: step.act ? step.undo : undefined })),
  ];

  // --- Seeking -------------------------------------------------------------------------------

  // Where the cursor points at an element, in the app window's pixels (the chat's window floating
  // at its place): a little in from its left, below its middle.
  const pointAt = (el) => {
    const r = el.getBoundingClientRect();
    const off = el.ownerDocument === document ? { x: 0, y: 0, scale: 1 } : place();
    return { x: off.x + (r.left + Math.min(r.width * 0.5, 60)) * off.scale, y: off.y + (r.top + r.height * 0.6) * off.scale };
  };
  const overChat = (point) => {
    const p = place();
    return Boolean(chat && api.chatShown && point && point.x >= p.x && point.x <= p.x + p.width && point.y >= p.y && point.y <= p.y + p.height);
  };
  const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

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
    if (beat.drag) {
      // Carried the rest of the way in steps, as a hand would, so it lands as it does when scrolled.
      for (const u of [0.2, 0.4, 0.6, 0.8, 1]) carry(beat, u);
      pointer('pointerup', document.querySelector('.board') ?? el, beat.drag());
      moment.carrying = null;
    }
    if (beat.typed !== undefined) setText(el, beat.typed);
    if (beat.act) await beat.act(el, id);
    if (id !== live) throw CANCELLED;
  }
  async function undo(beat, id) {
    if (beat.typed !== undefined) setText(await element(beat, id), '');
    if (beat.undo) await beat.undo(id);
  }
  const undoable = (beat) => !beat.act || beat.undo;

  // A pointer event at a point, as the board hears one.
  function pointer(type, target, { x, y }) {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' }));
  }
  // A drag beat u of the way through: picked up the first time, then carried that far, back or on.
  // Where the pointer is, for the cursor.
  function carry(beat, u) {
    const { el, point: from } = moment.found.get(beat);
    if (moment.carrying !== beat) {
      pointer('pointerdown', el, from);
      moment.carrying = beat;
    }
    const to = beat.drag();
    const e = ease(u);
    const at = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    pointer('pointermove', document.querySelector('.board') ?? el, at);
    return at;
  }
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
    let start = 0;
    while (k < beats.length && start + beats[k].ms <= at) {
      start += beats[k].ms;
      k++;
    }
    const u = k < beats.length && beats[k].ms ? Math.min(1, (at - start) / beats[k].ms) : 0;

    // Back before a drag that's under way: the scene afresh, as what's carried can't be put back.
    if (m.carrying && k < beats.indexOf(m.carrying)) {
      await rebuild(m);
      if (id !== live) return;
    }
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
    m.chat = null;
    agent({ type: 'log', entries: [] });
    await SCENES[m.name].build(m.id);
    if (!chatWanted) hideChat();
    await frame();
    m.found.clear();
    m.done = 0;
    m.carrying = null;
  }

  // Draws the moment's continuous parts at beat k, u of the way through it.
  async function draw(m, k, u, id) {
    const { beats } = m;
    const beat = beats[k];
    if (beat?.find) await element(beat, id);
    if (id !== live) return;

    // The cursor: at the last place it moved to, or on its way to the next; hidden before its first
    // move and while the agent works.
    let from = null;
    let shown = false;
    let last = null; // the element the cursor last arrived at
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
        from = beats[i].drag();
        last = null;
      }
    }
    let point = from;
    if (beat?.move) {
      const to = m.found.get(beat).point;
      from ??= { x: Math.min(WINDOW.width - 20, to.x + CURSOR_FROM.x), y: Math.min(WINDOW.height - 20, to.y + CURSOR_FROM.y) };
      const e = ease(u);
      point = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      shown ||= u > 0;
      if (u < 1) last = null;
    }
    if (beat?.drag && u > 0) {
      point = carry(beat, u);
      last = null;
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
    const pressed = Boolean((beat?.press || beat?.drag) && u > 0 && u < 1);
    cursor.classList.toggle('pressed', pressed);
    chat?.cursor?.classList.toggle('pressed', pressed);
    hover(shown ? last : null);

    // Typing: as much of the text as the point's reached.
    if (beat?.typed !== undefined) setText(m.found.get(beat).el, beat.typed.slice(0, Math.round(beat.typed.length * u)));

    // What's in the chat so far, and whether the AI's at work there.
    if (chatWanted) {
      const convo = structuredClone(chatBase.main ?? []);
      let running = false;
      for (let i = 0; i <= k && i < beats.length; i++) {
        const b = beats[i];
        if (!b.chat) continue;
        const partial = i === k;
        if (partial && !(u > 0) && b.ms) continue;
        if (b.chat === 'working') running = true;
        else if (b.chat === 'note') convo.push({ ...message(convo.length, 'event', b.text), kind: 'context' });
        else {
          const role = { prompt: 'user', say: 'assistant', tool: 'step' }[b.chat];
          const text = b.chat === 'say' && partial ? b.text.slice(0, Math.round(b.text.length * u)) : b.text;
          // A reply still being written out: the chat shows no Working while it is.
          if (text) convo.push({ ...message(convo.length, role, text), ...(b.chat === 'say' && partial && u < 1 && { streaming: true }) });
          running = b.chat === 'prompt' || !(b.last && !(partial && u < 1));
        }
      }
      const chatNow = JSON.stringify([convo, running]);
      if (chatNow !== m.chat) {
        m.chat = chatNow;
        api.setChat({ main: convo }, running ? ['main'] : []);
      }
    }

    // Another agent's part so far.
    let entries = [];
    for (let i = 0; i <= k && i < beats.length; i++) {
      const b = beats[i];
      const partial = i === k;
      if (b.log === 'clear') entries = [];
      if (partial && !(u > 0) && b.ms) continue;
      if (b.log === 'prompt') entries.push({ kind: 'prompt', text: b.text });
      if (b.log === 'say') entries.push({ kind: 'say', text: partial ? b.text.slice(0, Math.round(b.text.length * u)) : b.text });
      if (b.log === 'tool') entries.push({ kind: 'tool', name: b.name, detail: partial ? b.detail : b.done, done: !partial });
    }
    const log = JSON.stringify(entries);
    if (log !== m.log) {
      m.log = log;
      agent({ type: 'log', entries });
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

  // What the user asks for in the chat, and what the AI does about it.
  const CHECKOUT_ASK = `Design a new schematic for ${CHECKOUT_GOAL}`;
  const REVISE_ASK = 'Answer my comments';
  const PROPOSE_SAYS = [
    'I’ll see what’s already designed, so Checkout can build on it.',
    'Payments needs a token, so I’ll embed Service auth rather than describe it again.',
    'Checkout is waiting for you: an overview, the journey, its business rules and the order’s fields. Press and hold anything to comment on it.',
  ];
  const REVISE_SAYS = [
    'Good question: Payments is ours, and it calls a card provider. I’ll show that.',
    'I’ve added the card provider to the overview and answered your comment. Nothing more needed on it.',
  ];
  // The lines the app posts to the chat as the window moves and the user comments (`onShown` and
  // `onNote` in schemas.js).
  const REVIEWING_NEW = 'Reviewing the new schematic “Checkout”';
  const COMMENTED = 'Commented on “Payments”';
  const OPENED_DRAFT_1 = 'Opened “Checkout”, draft 1 of 1';
  // The window's one chat, as each scene finds it.
  const ASKED = [['user', CHECKOUT_ASK]];
  const PROPOSED = [
    ...ASKED,
    ['assistant', PROPOSE_SAYS[0]],
    ['step', describeStep('list_schematics')],
    ['step', describeStep('get_schematic')],
    ['assistant', PROPOSE_SAYS[1]],
    ['step', describeStep('propose_schematic', { name: 'Checkout' })],
    ['context', REVIEWING_NEW],
    ['assistant', PROPOSE_SAYS[2]],
  ];
  const COMMENTED_ON = [...PROPOSED, ['context', COMMENTED]];
  const REVISED = [
    ...COMMENTED_ON,
    ['user', REVISE_ASK],
    ['step', describeStep('get_comments')],
    ['assistant', REVISE_SAYS[0]],
    ['step', describeStep('propose_schematic', { name: 'Checkout' })],
    ['step', describeStep('reply_to_comment')],
    ['assistant', REVISE_SAYS[1]],
  ];

  const SCENES = {
    // --- The hero: Focus and Overview, which it swaps between ---

    'intro-focus': {
      build: (id) => onCheckout('accepted', 'focus', id),
      focus: () => WINDOW,
      beats: () => [wait(900), move(() => item('rules')?.querySelector('.pane-head, .board-card')), wait(900), move(() => part('overview', 'payments'))],
    },
    'intro-overview': {
      build: (id) => onCheckout('accepted', 'overview', id),
      focus: () => WINDOW,
      beats: () => [wait(900), move(() => part('overview', 'payments'))],
    },

    // --- The home page: a schematic, from asking for it to handing it on ---

    // The chat opened from the top bar, and a new schematic asked for in it.
    // The chat opened from the top bar, and a new schematic asked for in it.
    ask: {
      narrowX: CHAT_X,
      build: (id) => onHome('base', id),
      focus: withChat,
      reach: () => place(), // the chat, opened in the moment
      beats: () => [
        wait(500),
        ...click(() => document.getElementById('chat-button')),
        wait(600),
        ...askInChat(CHECKOUT_ASK),
        wait(600),
      ],
    },
    // The AI reads what's there and proposes Checkout, which opens by itself.
    propose: {
      narrowX: CHAT_X,
      async build(id) {
        await onHome('base', id);
        await openChat(ASKED, id);
      },
      focus: withChat,
      region: () => ({ x: 0, y: 0, width: 760, height: 520 }), // home, where the proposal opens
      anchor: () => besideChat(400), // and the chat
      beats: () => aiWork([
        { say: PROPOSE_SAYS[0] },
        { tool: 'list_schematics' },
        { tool: 'get_schematic', wait: 600 },
        { say: PROPOSE_SAYS[1] },
        {
          tool: 'propose_schematic', input: { name: 'Checkout' }, wait: 1400,
          act: async () => {
            await api.goTo('proposed');
            api.showSchema('checkout');
          },
        },
        { note: REVIEWING_NEW },
        { say: PROPOSE_SAYS[2] },
      ]),
    },
    // A long press on the Payments node, and a comment on it.
    comment: {
      async build(id) {
        await onCheckout('proposed', 'focus', id);
        await openChat(PROPOSED, id);
      },
      focus: withChat,
      beats: () => [
        wait(500),
        ...hold(() => part('overview', COMMENT.part)),
        wait(300),
        ...typeInto(() => document.querySelector('.comment-thread .comment-input'), COMMENT.text),
        wait(300),
        ...click(() => button('.comment-thread', 'Comment')),
        note(COMMENTED),
        wait(900),
      ],
    },
    // Asked in the chat, the AI reads the comment, revises the proposal and answers it.
    revise: {
      narrowX: CHAT_X,
      async build(id) {
        await onCheckout('commented', 'focus', id);
        await openChat(COMMENTED_ON, id);
      },
      focus: withChat,
      beats: () => [
        wait(400),
        ...askInChat(REVISE_ASK),
        ...aiWork([
          { tool: 'get_comments' },
          { say: REVISE_SAYS[0] },
          {
            tool: 'propose_schematic', input: { name: 'Checkout' }, wait: 1200,
            act: () => api.goTo('revised'),
            undo: () => api.goTo('commented'),
          },
          { tool: 'reply_to_comment' },
          { say: REVISE_SAYS[1] },
        ]),
      ],
    },
    // The answer read, then the proposal accepted: Checkout's first draft.
    accept: {
      async build(id) {
        await onCheckout('revised', 'focus', id);
        await openChat(REVISED, id);
      },
      focus: withChat,
      beats: () => [
        wait(500),
        ...click(marker),
        wait(1600),
        act(closeAll),
        ...click(() => document.querySelector('[data-action="proposal-accept"]')),
        note(OPENED_DRAFT_1),
        wait(1000),
      ],
    },
    // The board arranged: a card dragged in from the side, growing as it nears the middle, and
    // dropped there to work on beside the overview.
    arrange: {
      build: (id) => onCheckout('accepted', 'focus', id),
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        ...drag(() => item('journey')?.querySelector('.board-card, .pane-head'), () => ({ x: 860, y: 300 }), 2400),
        wait(900),
      ],
    },
    // Everything at once, on the overview.
    overview: {
      build: (id) => onCheckout('accepted', 'focus', id),
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        ...click(() => document.querySelector('#view-switch button[data-view="overview"]')),
        wait(1500),
      ],
    },
    // Another agent picks up the plan and reads only what it needs.
    handover: {
      narrowX: AGENT_X,
      build: (id) => onCheckout('accepted', 'overview', id),
      focus: () => WINDOW,
      beats: () => agentWork('Build Checkout from its schematic in SmartSpec.', [
        { tool: 'list_schematics', done: 'Checkout, in Orders' },
        { tool: 'get_schematic', detail: 'Checkout', done: 'Draft 1: 4 items, 14 links' },
        { tool: 'get_schematic_item', detail: 'Business rules' },
        { tool: 'get_schematic_item', detail: 'Order fields' },
        { say: 'I have what I need: charge once with the checkout’s id as the key, reserve stock only after payment, and an order with five fields. Starting on POST /checkouts.' },
      ]),
    },

    // --- The features page: each part of the app ---

    'f-board': {
      build: (id) => onCheckout('accepted', 'focus', id),
      focus: () => WINDOW,
      beats: () => [wait(600), move(() => item('journey')?.querySelector('.board-card, .pane-head')), wait(1200), move(() => item('fields')?.querySelector('.board-card, .pane-head'))],
    },
    'f-overview': {
      build: (id) => onCheckout('accepted', 'overview', id),
      focus: () => WINDOW,
      beats: () => [wait(600), move(() => document.querySelector('.overview-svg path, .overview-item'))],
    },
    'f-comments': {
      build: (id) => onCheckout('revised', 'focus', id),
      focus: () => WINDOW,
      beats: () => [wait(600), ...click(marker), wait(1200)],
    },
    // An item full screen, from its title bar's button.
    'f-full': {
      build: (id) => onCheckout('accepted', 'focus', id),
      focus: () => WINDOW,
      beats: () => [wait(600), ...click(() => item('overview')?.querySelector('.pane-actions button')), wait(1600)],
    },
    // An embedded schematic: one card, opening to its own overview in the middle.
    'f-embed': {
      build: (id) => onCheckout('accepted', 'focus', id),
      focus: () => WINDOW,
      beats: () => [wait(600), ...doubleClick(() => item('auth')?.querySelector('.board-card, .pane-head')), wait(1600)],
    },
    // The AI working in this window, named in the top bar, and the panel to take it back.
    'f-ai': {
      async build(id) {
        await onCheckout('proposed', 'focus', id);
        api.setAiControl('Claude Code');
      },
      focus: () => WINDOW,
      beats: () => [wait(600), ...click(() => document.getElementById('server-pill')), wait(1600)],
    },
    'f-home': {
      build: (id) => onHome('accepted', id),
      focus: () => WINDOW,
      beats: () => [wait(600), ...click(() => [...document.querySelectorAll('.groups-column .browser-row')].find((r) => r.textContent.includes('Orders'))), wait(900)],
    },
    'f-focus': {
      build: (id) => onCheckout('accepted', 'focus', id),
      focus: () => union(pad(rect('#breadcrumb')), pad(rect('#focus-menu:not([hidden])')), { left: 0, top: 0, right: 700, bottom: 320 }),
      beats: () => [wait(600), ...click(() => document.getElementById('focus-button')), wait(1200)],
    },
  };

  const lengthOf = (beats) => beats.reduce((sum, beat) => sum + beat.ms, 0);
  let playing = 0; // the moment playing through in time, if any (see start)

  return {
    scenes: Object.keys(SCENES),
    setInstant(on) {
      instant = on;
    },
    // Where the chat's window floats by the app's, in the app window's pixels (CHAT_PLACE).
    chatPlace: CHAT_PLACE,
    // The chat's window (demo-chat.html, loaded beside this one): started with this demo's API, and
    // driven from here. `at` is where it floats, if not at CHAT_PLACE.
    async attachChat(win, at = CHAT_PLACE) {
      while (!win.startChat) await new Promise((resolve) => setTimeout(resolve, 30));
      if (!chat) win.startChat(api);
      chat = { win, doc: win.document, place: at, cursor: win.demoCursor };
    },
    // Hears whether the chat's window shows, for the site to show it.
    onChatShown: (listener) => api.onChatShown(listener),
    onChatMoved() {}, // (nothing drags it here)
    // Whether scenes put the chat's window in places of their own (SHOTS): a wide screen's.
    setShots(on) {
      shots = on;
    },
    // Where each scene's about before it's built (its focus as it'd be now), and where its chat is.
    focusHints: () => Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => {
      const was = current;
      current = name;
      try {
        return [name, { ...scene.focus(), narrowX: scene.narrowX, chatAt: place(name) }];
      } finally {
        current = was;
      }
    })),
    // How long each scene's moment is, in milliseconds, for the site to give it room to scroll.
    lengths: () => Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => [name, lengthOf(scene.beats())])),
    dragTo() {}, // (SmartDoc's site drags a file in; nothing here does)
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
    onAgent(listener) {
      agentListeners.push(listener);
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
      const scene = SCENES[name] ?? SCENES['intro-focus'];
      agent({ type: 'log', entries: [] });
      const result = Promise.all([building, seeking]).then(async () => {
        if (id !== live) return null;
        cursor.classList.remove('shown');
        chat?.cursor?.classList.remove('shown');
        hover(null);
        try {
          forgetChat();
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
        moment = { id, name: SCENES[name] ? name : 'intro-focus', beats, total: lengthOf(beats), done: 0, found: new Map(), log: '[]', chat: null };
        return focus;
      });
      building = result.catch(() => {});
      return result;
    },
  };
}
