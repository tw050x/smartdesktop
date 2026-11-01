// Plays the website demo one scene at a time, as the site's pages scroll (see site/story.js).
// Going to a scene first builds its state at once (whether the document's been added, which
// screen, which drafts exist, how far each review has got, what's been decided, which card is
// open), so scenes can be reached in any order, scrolling up or down. Its moment is then a
// timeline of beats: a drawn cursor moving to and clicking the real interface, typing into it,
// and the agent's part (its messages and tool calls, for the site's agent window, and what they do
// through the stand-in API, demo-api.js). The site puts the moment wherever its page has scrolled
// to (seek), forwards or back, so the cursor and the typing follow the scrolling; on its own, the
// demo plays each moment through in time (start).
//
// Going back over a beat that can't be undone (a click), the scene is built afresh and its beats
// done again at once, up to the point asked for. The rest (the cursor's place, typing, what the
// agent's said, the camera's focus) follow the point either way.
//
// Two sets of scenes: the home page's run-through of a real session, from opening the CV to a
// variation for one job, and the features page's look at each part of the app.
//
// show(name) resolves with the part of the window the scene is about (its focus, in the window's
// own pixels), for the site to bring into view, or null if another scene was asked for meanwhile.
// It also says where across the window a narrow screen, showing only part of its width, should
// centre on before the cursor's shown (narrowX): where the cursor first goes, or, for the agent at
// work, the pages' right half and the margin beside them, where the suggestions and highlights
// come in.

const WINDOW = { x: 0, y: 0, width: 1280, height: 800 };
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
const IMPROVE_GOAL = 'Make it stand out to a hiring manager';
const HIGHLIGHTS_GOAL = 'What a recruiter takes in at a glance';
const VARIATION_PURPOSE = 'Tailor it to the product lead role at Acme: leading a team of 6 on the design system.';
// Where the cursor comes from at the start of a moment: a little below and right of where it's
// first going, in the window's pixels.
const CURSOR_FROM = { x: 160, y: 140 };
// Where the scenes whose focus depends on the interface's layout are about, measured at the
// window's size, for the site to frame them before they're first built (see focusHints). The
// scene's own measure replaces it once it's built.
const FOCUS_HINTS = {
  variation: { x: 380, y: 100, width: 836, height: 708 },
  'f-options': { x: 654, y: 124, width: 626, height: 670 },
  'f-edit': { x: 654, y: 401, width: 626, height: 341 },
  'f-questions': { x: 654, y: 124, width: 626, height: 401 },
  'f-structure': { x: 0, y: 124, width: 626, height: 328 },
  'f-focus': { x: 0, y: 0, width: 689, height: 282 },
  'f-gaps': { x: 0, y: 14, width: 626, height: 213 },
  'f-variation': { x: 839, y: 100, width: 377, height: 708 },
  'f-document': { x: 839, y: 100, width: 421, height: 708 },
};
// The top bar's left part and the focus menu that opens under it.
const FOCUS_MENU = { x: 0, y: 0, width: 690, height: 300 };
// Where a narrow screen centres a scene of the agent at work (see show).
const AGENT_X = 900;

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
  let hovered = null;
  let building = Promise.resolve();
  let current = null; // the scene asked for most recently
  let moment = null; // the built scene's moment (see show)
  const agentListeners = [];
  const cursorListeners = [];
  let cursorWas = 'null';

  const pause = (ms, id) => new Promise((resolve, reject) => setTimeout(() => (id === live ? resolve() : reject(CANCELLED)), instant ? 0 : ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

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
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (id !== live) throw CANCELLED;
    }
  }

  function showCursor(on) {
    cursor.classList.toggle('shown', on);
  }

  // What the cursor is over shows as hovered (.demo-hover, see demo.js), and margin cards answer
  // hovering too: the page fades behind the hovered card.
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
    const slot = element?.closest('.margin-slot') ?? null;
    if (slot === hovered) return;
    hovered?.dispatchEvent(new MouseEvent('mouseleave'));
    slot?.dispatchEvent(new MouseEvent('mouseenter'));
    hovered = slot;
  }

  const button = (scope, label) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === label);
  const tab = (title) => [...document.querySelectorAll('.margin-tab')].find((t) => t.textContent.includes(title));
  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
  const union = (...rects) => {
    const rs = rects.filter(Boolean);
    if (!rs.length) return WINDOW;
    const x = Math.min(...rs.map((r) => r.left));
    const y = Math.min(...rs.map((r) => r.top));
    return { x, y, width: Math.max(...rs.map((r) => r.right)) - x, height: Math.max(...rs.map((r) => r.bottom)) - y };
  };
  // An open card, with some of the page beside it (the side its text is on).
  const cardFocus = (side) => {
    const r = rect('.margin-slot.open');
    if (!r) return WINDOW;
    const reach = 380;
    const y = Math.max(0, r.top - 40);
    return side === 'r'
      ? { x: r.left - reach, y, width: r.width + reach + 20, height: r.height + 80 }
      : { x: Math.max(0, r.left - 20), y, width: r.width + reach + 20, height: r.height + 80 };
  };
  // The top bar's left part, with whatever menu is open under it.
  const topLeft = () => union({ left: 0, top: 0, right: 640, bottom: 44 }, rect('.tool-card:not([hidden])'));

  // --- Building a scene's state ----------------------------------------------------------

  function closeAll() {
    hover(null);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // closes an open card or menu
    document.querySelector('dialog[open]')?.close();
    document.querySelectorAll('.demo-menu, .demo-file').forEach((el) => el.remove());
    document.getElementById('document')?.classList.remove('dragging');
  }

  // Remembered per document (see app-shell.js): every scene starts on all the findings, in the
  // document view.
  function resetViews() {
    try {
      localStorage.setItem(`smartdoc.show.${DOC.id}`, 'all');
      localStorage.setItem(`smartdoc.view.${DOC.id}`, 'document');
    } catch {}
  }

  // The reviews as far as they've got: { improve: [shown, done], highlights: [shown, done] }, a
  // review left out not started.
  function progress({ improve, highlights } = {}) {
    api.setProgress('improve', improve ? { started: true, shown: improve[0], done: improve[1] } : { started: false, shown: 0, done: false });
    api.setProgress('highlights', highlights ? { started: true, shown: highlights[0], done: highlights[1] } : { started: false, shown: 0, done: false });
  }
  const ALL_FINDINGS = [4, true];
  const ALL_HIGHLIGHTS = [5, true];

  // The document on draft `n` in `tool`, with the first `decided` findings decided (and the drafts
  // up to `n` made).
  async function onDocument(n, tool, { decided = 0, reviews = {}, made = n } = {}, id) {
    api.state.added = true;
    api.setMade(made);
    progress(reviews);
    resetViews();
    const s = api.state;
    if (s.screen !== 'document' || s.draft !== n || s.tool !== tool) {
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
    if (api.state.screen !== 'home') api.showHome(); // (on the home screen already, setMade listed it afresh)
    closeAll();
    await waitFor(() => (added ? document.querySelector('#home-drafts .home-item') : document.querySelector('#home-documents .home-empty')), id);
  }

  // Opens a card at once, as clicking its tab does, and scrolls the page so it's in view (a tab
  // further down the page may be out of sight), then waits for it to stop moving so its place can
  // be measured.
  async function open(title, id) {
    (await waitFor(() => tab(title), id)).click();
    const card = await waitFor(() => rect('.margin-slot.open'), id);
    const view = document.getElementById('document').getBoundingClientRect();
    if (card.top < view.top + 40 || card.bottom > view.bottom - 40) {
      document.getElementById('document').scrollBy({ top: card.top - view.top - 120, behavior: 'instant' });
    }
    await settle(id);
  }

  // Waits until the open card stops moving (a few frames in the same place), for up to 2 seconds.
  async function settle(id) {
    let last = null;
    let still = 0;
    const start = performance.now();
    while (still < 4 && performance.now() - start < 2000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (id !== live) throw CANCELLED;
      const top = rect('.margin-slot.open')?.top;
      still = top === last ? still + 1 : 0;
      last = top;
    }
  }

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
  function dragOver() {
    document.getElementById('document').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  }
  async function drop() {
    const doc = document.getElementById('document');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([], DOC.name, { type: 'application/pdf' }));
    doc.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
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
      dragging = false;
    })();
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

  const wait = (ms) => ({ ms });
  const move = (find, ms = 650) => ({ ms, find, move: true });
  const click = (find) => [move(find), wait(120), { ms: 330, find, press: true, act: (el) => el.click() }];
  const typeInto = (find, text) => [
    move(find),
    { ms: 330, find, press: true, act: (el) => { el.click(); el.focus({ preventScroll: true }); } },
    { ms: text.length * 32, find, typed: text },
  ];
  const act = (fn, undo, ms = 0) => ({ ms, act: fn, undo });

  // The agent at work: the prompt pasted to it, then each step in turn: { say } for something it
  // says (typed out), or { tool, detail, act, undo, done, wait } for a SmartDoc tool call, under
  // way for `wait`, then showing `done` once its `act` is done.
  const agentWork = (prompt, steps) => [
    { ms: 0, log: 'clear', hide: true },
    { ms: 800, log: 'prompt', text: prompt },
    ...steps.map((step) => (step.say
      ? { ms: 500 + step.say.length * 14, log: 'say', text: step.say }
      : { ms: step.wait ?? 700, log: 'tool', name: step.tool, detail: step.detail ?? '', done: step.done ?? step.detail ?? '', act: step.act, undo: step.act ? step.undo : undefined })),
  ];

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

  // Types a goal in the focus menu's new focus and copies its prompt, as the user does to start a
  // review; the prompt goes to the agent.
  const askInFocusMenu = (goal) => [
    ...click(() => document.getElementById('focus-button')),
    wait(400),
    ...typeInto(() => document.querySelector('#focus-card:not([hidden]) .focus-goal-input'), goal),
    wait(300),
    ...click(() => button('.focus-new', 'Copy the prompt')),
    wait(700),
    act(closeAll),
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
    let start = 0;
    while (k < beats.length && start + beats[k].ms <= at) {
      start += beats[k].ms;
      k++;
    }
    const u = k < beats.length && beats[k].ms ? Math.min(1, (at - start) / beats[k].ms) : 0;

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
  }

  // Draws the moment's continuous parts at beat k, u of the way through it.
  async function draw(m, k, u, id) {
    const { beats } = m;
    const beat = beats[k];
    if (beat?.find) await element(beat, id);
    if (id !== live) return;

    // The cursor: at the last place it moved to, or on its way to the next; hidden before its first
    // move and while the agent works.
    let from = null; // (none before its first move: it comes from near where that goes)
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
    raise();
    showCursor(shown && !instant);
    // Where it is, for the site to keep in view on a narrow screen.
    const where = JSON.stringify(shown && !instant ? point : null);
    if (where !== cursorWas) {
      cursorWas = where;
      cursorListeners.forEach((listener) => listener(JSON.parse(where)));
    }
    if (point) cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
    cursor.classList.toggle('pressed', Boolean(beat?.press && u > 0 && u < 1));
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
    // What the review is for, typed in the focus menu, and the prompt copied for the agent.
    ask: {
      build: (id) => onDocument(0, 'improve', {}, id),
      focus: () => FOCUS_MENU,
      beats: () => askInFocusMenu(IMPROVE_GOAL),
    },
    // The agent reads the CV and adds its suggestions one by one, then finishes.
    review: {
      narrowX: AGENT_X,
      build: (id) => onDocument(0, 'improve', { reviews: { improve: [0, false] } }, id),
      focus: () => WINDOW,
      beats: () => agentWork(`Review “${DOC.name}” in SmartDoc and suggest improvements, focusing on: ${IMPROVE_GOAL}`, [
        { say: 'I’ll read your CV first, then go through it as a hiring manager would.' },
        { tool: 'get_document_info', done: '2 pages, 640 words' },
        { tool: 'get_document', done: 'pages 1–2', wait: 1100 },
        { tool: 'start_review', detail: IMPROVE_GOAL },
        ...api.reviews.improve.items.map((item, i) => ({
          tool: 'add_finding', detail: item.title, wait: 900,
          act: () => api.setProgress('improve', { shown: i + 1 }),
          undo: () => api.setProgress('improve', { shown: i }),
        })),
        {
          tool: 'commit_review', wait: 600, done: `${api.reviews.improve.items.length} suggestions`,
          act: () => api.setProgress('improve', { done: true }),
          undo: () => api.setProgress('improve', { done: false }),
        },
        { say: 'Done: four suggestions are in SmartDoc. The profile is the big one. It could be anyone’s, so I’ve offered two rewrites. I’ve also asked what came of the checkout work, since a result would make that line much stronger.' },
      ]),
    },
    // A rewrite chosen, and a wording change accepted.
    decide: {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        ...click(() => button('.review-bar', 'Next ›')),
        wait(900),
        ...click(() => document.querySelector('.margin-card .option input')),
        wait(1000),
        ...click(() => button('.review-bar', 'Next ›')),
        wait(1000),
        ...click(() => button('.margin-card', 'Accept')),
      ],
    },
    // A question answered, and a move accepted.
    answer: {
      build: (id) => onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        act((_, id) => open('What came of the checkout', id)),
        wait(500),
        ...typeInto(() => document.querySelector('.margin-card .decision-answer'), DECISIONS[2].answer),
        ...click(() => button('.margin-card', 'Answer')),
        wait(900),
        ...click(() => button('.review-bar', 'Next ›')),
        wait(1000),
        ...click(() => button('.margin-card', 'Accept')),
      ],
    },
    // Everything decided: the prompt goes to the agent, which writes Draft 1; it opens by itself.
    redraft: {
      narrowX: AGENT_X,
      build: (id) => onDocument(0, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS }, made: 0 }, id),
      focus: () => WINDOW,
      beats: () => [
        wait(500),
        ...click(() => document.querySelector('.copy-prompt')),
        wait(500),
        ...agentWork(`I’ve made my decisions in SmartDoc. Apply the review and write the next draft of “${DOC.name}”.`, [
          { tool: 'get_decisions', done: '4 decided' },
          { say: 'You chose the first rewrite, accepted the wording and the move, and told me conversion rose 12%. Writing Draft 1 now.' },
          {
            tool: 'apply_review', detail: 'Draft 1', wait: 2000, done: 'Draft 1 written',
            act: async () => {
              api.setMade(1);
              await api.showDraft(1);
            },
            undo: async () => {
              api.setMade(0);
              await api.showDraft(0);
            },
          },
          { say: 'Draft 1 is open in SmartDoc. The profile now leads with your platform work, Skills come first, and the checkout line has its result.' },
        ]),
      ],
    },
    // The other tool: switched to, asked what matters, and its highlights added one by one.
    highlight: {
      narrowX: AGENT_X,
      build: (id) => onDocument(1, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      beats: () => [
        wait(400),
        ...click(() => document.getElementById('tool-button')),
        wait(400),
        ...click(() => [...document.querySelectorAll('#tool-card .tool-option')].find((o) => o.textContent.includes('Review and highlight'))),
        wait(500),
        ...askInFocusMenu(HIGHLIGHTS_GOAL),
        act(() => api.setProgress('highlights', { started: true, shown: 0, done: false })),
        ...agentWork(`Go through “${DOC.name}” in SmartDoc and highlight the key information for: ${HIGHLIGHTS_GOAL}`, [
          { say: 'I’ll read Draft 1 the way a recruiter skims it: the first few seconds count most.' },
          { tool: 'get_document', done: 'Draft 1, pages 1–2', wait: 1000 },
          { tool: 'start_review', detail: 'Recruiter skim' },
          ...api.reviews.highlights.highlights.map((h, i) => ({
            tool: 'add_highlight', detail: h.title,
            act: () => api.setProgress('highlights', { shown: i + 1 }),
            undo: () => api.setProgress('highlights', { shown: i }),
          })),
          {
            tool: 'commit_review', wait: 500, done: `${api.reviews.highlights.highlights.length} highlights`,
            act: () => api.setProgress('highlights', { done: true }),
            undo: () => api.setProgress('highlights', { done: false }),
          },
          { say: 'A recruiter will take in six years of platform leadership and a 12% conversion lift at a glance. One gap: you don’t say how big your team at Acme is.' },
        ]),
      ],
    },
    // Home: Draft 1's menu, New Variation, the job typed in, and the agent makes the variation.
    variation: {
      build: (id) => onHome({ made: 1, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => union(rect('.home-column:nth-child(2)'), rect('.home-column:nth-child(3)'), { left: 380, right: 900, top: 240, bottom: 560 }),
      beats: () => [
        wait(500),
        ...contextMenu(() => document.querySelector('#home-drafts .home-item'), ['New Variation…', 'Make a Document from This Draft']),
        move(menuItem(0)),
        { ms: 0, find: menuItem(0), act: (el) => el.classList.add('active') },
        wait(300),
        act(() => {
          document.querySelector('.demo-menu')?.remove();
          api.requestVariation({ docId: DOC.id, docName: DOC.name, variationId: 'original', variationName: 'Original', draft: 1 });
        }),
        ...typeInto(() => document.querySelector('#variation-dialog[open] #variation-purpose'), VARIATION_PURPOSE),
        wait(300),
        ...click(() => document.getElementById('variation-copy')),
        wait(900),
        act(() => document.querySelector('dialog[open]')?.close()),
        ...agentWork(`Make a variation of “${DOC.name}” in SmartDoc from Draft 1, and tailor it for: ${VARIATION_PURPOSE}`, [
          {
            tool: 'create_variation', detail: 'from Draft 1', wait: 1100, done: 'Acme product lead',
            act: () => api.setMade(1, true),
            undo: () => api.setMade(1, false),
          },
          { say: 'The job leads with the design system and a team of six, so I’ll bring those to the top.' },
          { tool: 'get_document', done: 'Draft 1, pages 1–2' },
          { tool: 'apply_review', detail: 'Draft 2', wait: 1600, done: 'Draft 2 written' },
          { say: 'Made “Acme product lead” and wrote its Draft 2 for the job. Your original CV and its drafts are unchanged.' },
        ]),
        act((_, id) => selectVariation('Acme', id)),
      ],
    },

    // --- The features page: each part of the app ---

    // Suggestions in the margins, beside their text, coloured by kind.
    'f-margin': {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(600), move(() => tab('Lead with what you built')), wait(1400), move(() => tab('Rewrite the profile'))],
    },
    // Options: a choice of rewrites.
    'f-options': {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id);
        await open('Rewrite the profile', id);
      },
      focus: () => cardFocus('r'),
      beats: () => [wait(900), ...click(() => document.querySelectorAll('.margin-card .option input')[1])],
    },
    // A change: accept, reject or edit it, and comment for the agent.
    'f-edit': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 1, reviews: { improve: ALL_FINDINGS } }, id);
        await open('Lead with what you built', id);
      },
      focus: () => cardFocus('r'),
      beats: () => [wait(800), ...click(() => button('.margin-card', 'Edit'))],
    },
    // Questions only the user can answer.
    'f-questions': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id);
        await open('What came of the checkout', id);
      },
      focus: () => cardFocus('r'),
      beats: () => [wait(600), ...typeInto(() => document.querySelector('.margin-card .decision-answer'), DECISIONS[2].answer)],
    },
    // Structure and design, in the left margin.
    'f-structure': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 3, reviews: { improve: ALL_FINDINGS } }, id);
        await open('Put Skills before Experience', id);
      },
      focus: () => cardFocus('l'),
      beats: () => [],
    },
    // Progress, and To do: only what's left.
    'f-todo': {
      build: (id) => onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(700), ...click(() => document.querySelector('#done-switch button[data-show="todo"]'))],
    },
    // Every draft kept, stepped through in the top bar.
    'f-drafts': {
      build: (id) => onDocument(1, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => ({ x: 240, y: 0, width: 800, height: 380 }), // the top bar's draft arrows, and the page under them
      beats: () => [
        wait(700),
        ...click(() => document.getElementById('draft-prev')),
        wait(1600),
        ...click(() => document.getElementById('draft-next')),
      ],
    },
    // Focuses: what each review is for, and the prompt to start a new one.
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
      beats: () => [wait(600), ...click(() => button('.review-bar', 'Next ›'))],
    },
    // What the document doesn't say.
    'f-gaps': {
      async build(id) {
        await onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        await open('No team size', id);
      },
      focus: () => cardFocus('l'),
      beats: () => [],
    },
    // The highlights as a list.
    'f-list': {
      build: (id) => onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      beats: () => [wait(600), ...click(() => document.querySelector('#view-switch button[data-view="list"]'))],
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
        ...contextMenu(() => document.querySelector('#home-drafts .home-item'), ['New Variation…', 'Make a Document from This Draft']),
        move(menuItem(1)),
        { ms: 0, find: menuItem(1), act: (el) => el.classList.add('active') },
      ],
    },
  };

  const lengthOf = (beats) => beats.reduce((sum, beat) => sum + beat.ms, 0);
  let playing = 0; // the moment playing through in time, if any (see start)

  return {
    scenes: Object.keys(SCENES),
    setInstant(on) {
      instant = on;
    },
    // Where each scene's about before it's built (see FOCUS_HINTS): the whole window, unless it's
    // known to be somewhere else.
    focusHints: () => Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => [name, { ...(FOCUS_HINTS[name] ?? scene.focus()), narrowX: scene.narrowX }])),
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
      const scene = SCENES[name] ?? SCENES['intro-improve'];
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
        moment = { id, name: SCENES[name] ? name : 'intro-improve', beats, total: lengthOf(beats), done: 0, found: new Map(), log: '[]' };
        return focus;
      });
      building = result.catch(() => {});
      return result;
    },
  };
}
