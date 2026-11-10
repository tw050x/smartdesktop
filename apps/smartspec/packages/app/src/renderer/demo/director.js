// Plays the website demo one scene at a time, as the site's pages scroll (see site/story.js), as
// SmartDoc's does. Going to a scene first builds its state at once (where the story's schematics
// have got to, through the stand-in API's goTo, then what's showing: home, a schematic on the board
// or the overview), so scenes can be reached in any order, scrolling up or down. Its moment is then
// a timeline of beats: a drawn cursor moving to and clicking the real interface, typing into it,
// and the agent's part (its messages and tool calls, for the site's agent window, and what they do
// through the stand-in API). The site puts the moment wherever its page has scrolled to (seek),
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

import { CHECKOUT_GOAL, COMMENT } from './scenario.js';

const WINDOW = { x: 0, y: 0, width: 1280, height: 800 };
const CANCELLED = new Error('The scene changed.');
// Where the cursor comes from at the start of a moment: a little below and right of where it's
// first going, in the window's pixels.
const CURSOR_FROM = { x: 160, y: 140 };
// Where a narrow screen centres a scene of the agent at work: the middle of the board.
const AGENT_X = 640;
const LONG_PRESS = 560; // ms: a little over the app's half second

export function createDirector({ api }) {
  const cursor = document.createElement('div');
  cursor.className = 'demo-cursor';
  // In the top layer, so it's drawn above everything, open dialogs included (see raise).
  cursor.popover = 'manual';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 2.5v17.2l4.6-4.4 2.9 6.6 2.7-1.2-2.9-6.5h6.4Z" fill="#1d1d1f" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.append(cursor);
  cursor.showPopover();
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
  const agentListeners = [];
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

  function showCursor(on) {
    cursor.classList.toggle('shown', on);
  }

  // What the cursor is over shows as hovered (.demo-hover, see demo.js).
  let hoverShown = [];
  let hoverTarget = null;
  function hover(element) {
    if (element === hoverTarget) return;
    hoverTarget = element;
    for (const el of hoverShown) el.classList.remove('demo-hover');
    hoverShown = [];
    for (let el = element; el && el !== document.body; el = el.parentElement) {
      el.classList.add('demo-hover');
      hoverShown.push(el);
    }
  }

  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
  const union = (...rects) => {
    const rs = rects.filter(Boolean);
    if (!rs.length) return WINDOW;
    const x = Math.min(...rs.map((r) => r.left));
    const y = Math.min(...rs.map((r) => r.top));
    return { x, y, width: Math.max(...rs.map((r) => r.right)) - x, height: Math.max(...rs.map((r) => r.bottom)) - y };
  };
  const pad = (r, by = 24) => r && { left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by };
  // The board's or the overview's item, by its id.
  const item = (id) => document.querySelector(`:is(.board > .board-item, .overview-world > .overview-item)[data-item="${id}"]`);
  const part = (itemId, partId) => item(itemId)?.querySelector(`[data-part="${partId}"]`);
  const button = (scope, label) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === label);
  const marker = () => document.querySelector('.comment-marker:not(.away)');

  // --- Building a scene's state ----------------------------------------------------------

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

  // The agent at work: the prompt pasted to it, then each step in turn: { say } for something it
  // says (typed out), or { tool, detail, act, undo, done, wait } for a SmartSpec tool call, under
  // way for `wait`, then showing `done` once its `act` is done.
  const agentWork = (prompt, steps) => [
    { ms: 0, log: 'clear', hide: true },
    { ms: 800, log: 'prompt', text: prompt },
    ...steps.map((step) => (step.say
      ? { ms: 500 + step.say.length * 14, log: 'say', text: step.say }
      : { ms: step.wait ?? 700, log: 'tool', name: step.tool, detail: step.detail ?? '', done: step.done ?? step.detail ?? '', act: step.act, undo: step.act ? step.undo : undefined })),
  ];

  // --- Seeking -------------------------------------------------------------------------------

  // Where the cursor points at an element: a little in from its left, below its middle.
  const pointAt = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width * 0.5, 60), y: r.top + r.height * 0.6 };
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
    agent({ type: 'log', entries: [] });
    await SCENES[m.name].build(m.id);
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
    showCursor(shown && !instant);
    // Where it is, for the site to keep in view on a narrow screen.
    const where = JSON.stringify(shown && !instant ? point : null);
    if (where !== cursorWas) {
      cursorWas = where;
      cursorListeners.forEach((listener) => listener(JSON.parse(where)));
    }
    if (point) cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
    cursor.classList.toggle('pressed', Boolean((beat?.press || beat?.drag) && u > 0 && u < 1));
    hover(shown ? last : null);

    // Typing: as much of the text as the point's reached.
    if (beat?.typed !== undefined) setText(m.found.get(beat).el, beat.typed.slice(0, Math.round(beat.typed.length * u)));

    // The agent's part so far.
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

  const checkoutPrompt = `Design a new schematic in SmartSpec for: ${CHECKOUT_GOAL}`;
  const proposeSteps = [
    { say: 'I’ll see what’s already designed, so Checkout can build on it.' },
    { tool: 'list_schematics', done: '4 schematics in 3 domains' },
    { tool: 'get_schematic', detail: 'Service auth', done: 'Service auth: its contract' },
    { say: 'Payments needs a token, so I’ll embed Service auth rather than describe it again.' },
    {
      tool: 'propose_schematic', detail: 'Checkout', wait: 1400, done: 'Checkout: 4 items, waiting for you',
      act: async () => {
        await api.goTo('proposed');
        api.showSchema('checkout');
      },
    },
    { say: 'Checkout is waiting for you in SmartSpec: an overview, the journey, its business rules and the order’s fields. Press and hold anything to comment on it.' },
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

    // File › New Schematic: what to design, typed in, and the prompt copied for the agent.
    ask: {
      build: (id) => onHome('base', id),
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        act(() => api.newSchema(), () => document.querySelector('.prompt-dialog')?.close()),
        wait(500),
        ...typeInto(() => document.getElementById('new-schema-goal'), CHECKOUT_GOAL),
        wait(300),
        ...click(() => document.getElementById('new-schema-copy')),
        wait(700),
        act(closeAll),
      ],
    },
    // The agent reads what's there and proposes Checkout, which opens by itself.
    propose: {
      narrowX: AGENT_X,
      build: (id) => onHome('base', id),
      focus: () => WINDOW,
      beats: () => agentWork(checkoutPrompt, proposeSteps),
    },
    // A long press on the Payments node, and a comment on it.
    comment: {
      async build(id) {
        await onCheckout('proposed', 'focus', id);
      },
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        ...hold(() => part('overview', COMMENT.part)),
        wait(300),
        ...typeInto(() => document.querySelector('.comment-thread .comment-input'), COMMENT.text),
        wait(300),
        ...click(() => button('.comment-thread', 'Comment')),
        wait(900),
      ],
    },
    // The agent reads the comment, revises the proposal and answers it.
    revise: {
      narrowX: AGENT_X,
      build: (id) => onCheckout('commented', 'focus', id),
      focus: () => WINDOW,
      beats: () => agentWork('I’ve commented on Checkout in SmartSpec. Read my comments and revise it.', [
        { tool: 'get_comments', detail: 'Checkout', done: '1 comment, on Payments' },
        { say: 'Good question: Payments is ours, and it calls a card provider. I’ll show that.' },
        {
          tool: 'propose_schematic', detail: 'Checkout', wait: 1200, done: 'Revised: the overview shows the card provider',
          act: () => api.goTo('revised'),
          undo: () => api.goTo('commented'),
        },
        { tool: 'reply_to_comment', detail: 'Actioned' },
        { say: 'I’ve added the card provider to the overview and answered your comment. Nothing more needed on it.' },
      ]),
    },
    // The answer read, then the proposal accepted: Checkout's first draft.
    accept: {
      build: (id) => onCheckout('revised', 'focus', id),
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        ...click(marker),
        wait(1600),
        act(closeAll),
        ...click(() => document.querySelector('[data-action="proposal-accept"]')),
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
    // Where each scene's about before it's built: the whole window, unless it's known to be
    // somewhere else.
    focusHints: () => Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => [name, { ...WINDOW, narrowX: scene.narrowX }])),
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
      moment = null;
      playing++;
      const scene = SCENES[name] ?? SCENES['intro-focus'];
      agent({ type: 'log', entries: [] });
      const result = Promise.all([building, seeking]).then(async () => {
        if (id !== live) return null;
        showCursor(false);
        hover(null);
        try {
          await scene.build(id);
          await frame();
        } catch (error) {
          if (error !== CANCELLED) console.warn(error);
          return null;
        }
        if (id !== live) return null;
        const beats = scene.beats();
        // Where the cursor first goes, if it's drawn already: a narrow screen starts there.
        const first = beats.find((beat) => beat.move)?.find();
        const focus = { ...scene.focus(), narrowX: scene.narrowX ?? (first ? pointAt(first).x : undefined) };
        moment = { id, name: SCENES[name] ? name : 'intro-focus', beats, total: lengthOf(beats), done: 0, found: new Map(), log: '[]' };
        return focus;
      });
      building = result.catch(() => {});
      return result;
    },
  };
}
