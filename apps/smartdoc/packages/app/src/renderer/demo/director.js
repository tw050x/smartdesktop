// Plays the website demo one scene at a time, as the site's pages scroll (see site/story.js).
// Going to a scene first builds its state at once (whether the document's been added, which
// screen, which drafts exist, how far each review has got, what's been decided, which card is
// open), so scenes can be reached in any order, scrolling up or down. It then plays the scene's
// own moment: a drawn cursor working the real interface, while the stand-in API (demo-api.js) and
// the agent events (see onAgent) play the agent's part. Going to another scene cancels a moment
// still playing.
//
// Two sets of scenes: the home page's run-through of a real session, from opening the CV to a
// variation for one job, and the features page's look at each part of the app.
//
// show(name) resolves with the part of the window the scene is about (its focus, in the window's
// own pixels), for the site to bring into view, or null if another scene was asked for meanwhile.
// The scene's moment waits for start(), which the site calls once its camera has arrived.

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
  let instant = false; // no cursor or pauses: for visitors who'd rather not have motion
  let hovered = null;
  let building = Promise.resolve();
  let ready = null; // the built scene's moment, waiting for start()
  let current = null; // the scene asked for most recently
  const agentListeners = [];
  const focusListeners = [];
  // Moves the camera on mid-scene, to a new focus (in the window's pixels).
  const refocus = (focus, id) => {
    if (id === live) focusListeners.forEach((listener) => listener(focus));
  };

  const pause = (ms, id) => new Promise((resolve, reject) => setTimeout(() => (id === live ? resolve() : reject(CANCELLED)), instant ? 0 : ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  // What the agent is doing, for the site to show in its agent window: { type, ... }: 'clear', a
  // 'prompt' (text: what the user pasted), the agent 'say'ing something (text), or a 'tool' call
  // (key, name, detail) under way until a 'tool-done' with the same key (detail: its result).
  const agent = (event, id) => {
    if (id === undefined || id === live) agentListeners.forEach((listener) => listener(event));
  };

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

  function place(x, y, animate) {
    cursor.classList.toggle('moving', animate && !instant);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  }
  function showCursor(on) {
    cursor.classList.toggle('shown', on && !instant);
  }

  // What the cursor is over shows as hovered (.demo-hover, see demo.js), and margin cards answer
  // hovering too: the page fades behind the hovered card.
  let hoverShown = [];
  function hover(element) {
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

  async function moveTo(element, id) {
    const r = element.getBoundingClientRect();
    raise();
    showCursor(true);
    place(r.left + Math.min(r.width * 0.5, 60), r.top + r.height * 0.6, true);
    await pause(650, id);
    hover(element);
  }

  async function click(element, id) {
    await moveTo(element, id);
    cursor.classList.add('pressed');
    await pause(130, id);
    cursor.classList.remove('pressed');
    element.click();
    await pause(200, id);
  }

  async function type(field, text, id) {
    await click(field, id);
    field.focus();
    field.value = '';
    for (const ch of instant ? [text] : text) {
      field.value += ch;
      field.dispatchEvent(new Event('input'));
      await pause(32, id);
    }
  }

  // A stand-in for the system's right-click menu (the app shows macOS's own), at the cursor.
  async function contextMenu(element, labels, id) {
    await moveTo(element, id);
    const r = element.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'demo-menu';
    menu.style.left = `${r.left + Math.min(r.width * 0.5, 60) + 4}px`;
    menu.style.top = `${r.top + r.height * 0.6 + 4}px`;
    const items = labels.map((label) => Object.assign(document.createElement('div'), { className: 'demo-menu-item', textContent: label }));
    menu.append(...items);
    document.body.append(menu);
    await pause(500, id).catch((error) => {
      menu.remove();
      throw error;
    });
    return { items, close: () => menu.remove() };
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

  // Types a goal in the focus menu's new focus and copies its prompt, as the user does to start a
  // review; the prompt goes to the agent.
  async function askInFocusMenu(goal, id) {
    await click(await waitFor(() => document.getElementById('focus-button'), id), id);
    const field = await waitFor(() => document.querySelector('#focus-card:not([hidden]) .focus-goal-input'), id);
    await pause(400, id);
    await type(field, goal, id);
    await pause(300, id);
    await click(await waitFor(() => button('.focus-new', 'Copy the prompt'), id), id);
    await pause(700, id);
    closeAll();
  }

  // The agent at work: the prompt pasted to it, then each step in turn: { say } for something it
  // says (it takes a moment to type), or { tool, detail, run, done } for a SmartDoc tool call,
  // under way until `run` (the call's work, or a pause) finishes, then showing `done`.
  async function agentWork(prompt, steps, id) {
    agent({ type: 'clear' }, id);
    agent({ type: 'prompt', text: prompt }, id);
    showCursor(false);
    await pause(800, id);
    let n = 0;
    for (const step of steps) {
      if (step.say) {
        agent({ type: 'say', text: step.say }, id);
        await pause(500 + step.say.length * 14, id);
        continue;
      }
      const key = `call-${n++}`;
      agent({ type: 'tool', key, name: step.tool, detail: step.detail ?? '' }, id);
      await (step.run ? step.run() : pause(step.wait ?? 700, id));
      agent({ type: 'tool-done', key, detail: step.done ?? step.detail ?? '' }, id);
    }
  }

  // A file dragged over the window, as the app sees it: the drop indicator takes the page's place.
  // Then dropped: the document is added and opens.
  function dragOver() {
    document.getElementById('document').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  }
  async function drop() {
    document.getElementById('document').classList.remove('dragging');
    api.addDocument();
    await api.showDraft(0);
  }

  // --- The scenes ------------------------------------------------------------------------
  // build: the scene's state; focus: what it's about; play: its moment.

  const SCENES = {
    // --- The hero: the two tools, which it swaps between ---

    'intro-improve': {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(900, id);
        await moveTo(await waitFor(() => tab('Lead with what you built'), id), id);
      },
    },
    'intro-highlights': {
      build: (id) => onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(900, id);
        await moveTo(await waitFor(() => tab('Six years leading platform work'), id), id);
      },
    },

    // --- The home page: a session, from opening the CV to a variation for one job ---

    // An empty home screen, waiting for the CV: the site drags it in from beside the window and
    // drops it (dragOver and drop, below). On its own, the demo drags in a file of its own.
    upload: {
      async build(id) {
        api.state.tool = 'improve'; // opens in Review and draft, whatever the hero last showed
        await onHome({ added: false, made: 0 }, id);
      },
      focus: () => WINDOW,
      async play(id) {
        if (window.parent !== window) return; // the site's page does the dragging
        const file = document.createElement('div');
        file.className = 'demo-file';
        file.innerHTML = '<span class="demo-file-icon">PDF</span><span>Alex Example CV.pdf</span>';
        document.body.append(file);
        file.style.transform = 'translate(1180px, 860px)';
        await pause(400, id);
        file.classList.add('moving');
        file.style.transform = 'translate(560px, 330px)';
        await pause(900, id);
        dragOver();
        await pause(1100, id);
        file.remove();
        await drop();
      },
    },
    // What the review is for, typed in the focus menu, and the prompt copied for the agent.
    ask: {
      build: (id) => onDocument(0, 'improve', {}, id),
      focus: topLeft,
      play: (id) => askInFocusMenu(IMPROVE_GOAL, id),
    },
    // The agent reads the CV and adds its suggestions one by one, then finishes.
    review: {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: [0, false] } }, id),
      focus: () => WINDOW,
      async play(id) {
        const items = api.reviews.improve.items;
        await agentWork(`Review “${DOC.name}” in SmartDoc and suggest improvements, focusing on: ${IMPROVE_GOAL}`, [
          { say: 'I’ll read your CV first, then go through it as a hiring manager would.' },
          { tool: 'get_document_info', done: '2 pages, 640 words' },
          { tool: 'get_document', done: 'pages 1–2', wait: 1100 },
          { tool: 'start_review', detail: IMPROVE_GOAL },
          ...items.map((item, i) => ({ tool: 'add_finding', detail: item.title, run: async () => {
            await pause(900, id);
            api.setProgress('improve', { shown: i + 1 });
          } })),
          { tool: 'commit_review', run: async () => {
            await pause(600, id);
            api.setProgress('improve', { done: true });
          }, done: `${items.length} suggestions` },
          { say: 'Done: four suggestions are in SmartDoc. The profile is the big one. It could be anyone’s, so I’ve offered two rewrites. I’ve also asked what came of the checkout work, since a result would make that line much stronger.' },
        ], id);
      },
    },
    // A rewrite chosen, and a wording change accepted.
    decide: {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(500, id);
        await click(await waitFor(() => button('.review-bar', 'Next ›'), id), id);
        await pause(900, id);
        await click(await waitFor(() => document.querySelector('.margin-card .option input'), id), id);
        await pause(1000, id);
        await click(await waitFor(() => button('.review-bar', 'Next ›'), id), id);
        await pause(1000, id);
        await click(await waitFor(() => button('.margin-card', 'Accept'), id), id);
      },
    },
    // A question answered, and a move accepted.
    answer: {
      build: (id) => onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(500, id);
        await open('What came of the checkout', id);
        await pause(500, id);
        await type(await waitFor(() => document.querySelector('.margin-card .decision-answer'), id), DECISIONS[2].answer, id);
        await click(await waitFor(() => button('.margin-card', 'Answer'), id), id);
        await pause(900, id);
        await click(await waitFor(() => button('.review-bar', 'Next ›'), id), id);
        await pause(1000, id);
        await click(await waitFor(() => button('.margin-card', 'Accept'), id), id);
      },
    },
    // Everything decided: the prompt goes to the agent, which writes Draft 1; it opens by itself.
    redraft: {
      build: (id) => onDocument(0, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS }, made: 0 }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(500, id);
        await click(await waitFor(() => document.querySelector('.copy-prompt'), id), id);
        await pause(500, id);
        await agentWork(`I’ve made my decisions in SmartDoc. Apply the review and write the next draft of “${DOC.name}”.`, [
          { tool: 'get_decisions', done: '4 decided' },
          { say: 'You chose the first rewrite, accepted the wording and the move, and told me conversion rose 12%. Writing Draft 1 now.' },
          { tool: 'apply_review', detail: 'Draft 1', run: async () => {
            await pause(2000, id);
            api.setMade(1);
            await api.showDraft(1);
          }, done: 'Draft 1 written' },
          { say: 'Draft 1 is open in SmartDoc. The profile now leads with your platform work, Skills come first, and the checkout line has its result.' },
        ], id);
      },
    },
    // The other tool: switched to, asked what matters, and its highlights added one by one.
    highlight: {
      build: (id) => onDocument(1, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS } }, id),
      focus: topLeft,
      async play(id) {
        await pause(400, id);
        await click(await waitFor(() => document.getElementById('tool-button'), id), id);
        const option = await waitFor(() => [...document.querySelectorAll('#tool-card .tool-option')].find((o) => o.textContent.includes('Review and highlight')), id);
        await pause(400, id);
        await click(option, id);
        await pause(500, id);
        await askInFocusMenu(HIGHLIGHTS_GOAL, id);
        refocus(WINDOW, id); // back to the whole window, for the highlights as they come
        api.setProgress('highlights', { started: true, shown: 0, done: false });
        const highlights = api.reviews.highlights.highlights;
        await agentWork(`Go through “${DOC.name}” in SmartDoc and highlight the key information for: ${HIGHLIGHTS_GOAL}`, [
          { say: 'I’ll read Draft 1 the way a recruiter skims it: the first few seconds count most.' },
          { tool: 'get_document', done: 'Draft 1, pages 1–2', wait: 1000 },
          { tool: 'start_review', detail: 'Recruiter skim' },
          ...highlights.map((h, i) => ({ tool: 'add_highlight', detail: h.title, run: async () => {
            await pause(700, id);
            api.setProgress('highlights', { shown: i + 1 });
          } })),
          { tool: 'commit_review', run: async () => {
            await pause(500, id);
            api.setProgress('highlights', { done: true });
          }, done: `${highlights.length} highlights` },
          { say: 'A recruiter will take in six years of platform leadership and a 12% conversion lift at a glance. One gap: you don’t say how big your team at Acme is.' },
        ], id);
      },
    },
    // Home: Draft 1's menu, New Variation, the job typed in, and the agent makes the variation.
    variation: {
      build: (id) => onHome({ made: 1, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => union(rect('.home-column:nth-child(2)'), rect('.home-column:nth-child(3)'), { left: 380, right: 900, top: 240, bottom: 560 }),
      async play(id) {
        await pause(500, id);
        const row = await waitFor(() => document.querySelector('#home-drafts .home-item'), id);
        const menu = await contextMenu(row, ['New Variation…', 'Make a Document from This Draft'], id);
        await moveTo(menu.items[0], id);
        menu.items[0].classList.add('active');
        await pause(300, id);
        menu.close();
        api.requestVariation({ docId: DOC.id, docName: DOC.name, variationId: 'original', variationName: 'Original', draft: 1 });
        await type(await waitFor(() => document.querySelector('#variation-dialog[open] #variation-purpose'), id), VARIATION_PURPOSE, id);
        await pause(300, id);
        await click(document.getElementById('variation-copy'), id);
        await pause(900, id);
        document.querySelector('dialog[open]')?.close();
        await agentWork(`Make a variation of “${DOC.name}” in SmartDoc from Draft 1, and tailor it for: ${VARIATION_PURPOSE}`, [
          { tool: 'create_variation', detail: 'from Draft 1', run: async () => {
            await pause(1100, id);
            api.setMade(1, true);
          }, done: 'Acme product lead' },
          { say: 'The job leads with the design system and a team of six, so I’ll bring those to the top.' },
          { tool: 'get_document', done: 'Draft 1, pages 1–2' },
          { tool: 'apply_review', detail: 'Draft 2', wait: 1600, done: 'Draft 2 written' },
          { say: 'Made “Acme product lead” and wrote its Draft 2 for the job. Your original CV and its drafts are unchanged.' },
        ], id);
        await selectVariation('Acme', id);
      },
    },

    // --- The features page: each part of the app ---

    // Suggestions in the margins, beside their text, coloured by kind.
    'f-margin': {
      build: (id) => onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(600, id);
        await moveTo(await waitFor(() => tab('Lead with what you built'), id), id);
        await pause(1400, id);
        await moveTo(await waitFor(() => tab('Rewrite the profile'), id), id);
      },
    },
    // Options: a choice of rewrites.
    'f-options': {
      async build(id) {
        await onDocument(0, 'improve', { reviews: { improve: ALL_FINDINGS } }, id);
        await open('Rewrite the profile', id);
      },
      focus: () => cardFocus('r'),
      async play(id) {
        await pause(900, id);
        await click(await waitFor(() => document.querySelectorAll('.margin-card .option input')[1], id), id);
      },
    },
    // A change: accept, reject or edit it, and comment for the agent.
    'f-edit': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 1, reviews: { improve: ALL_FINDINGS } }, id);
        await open('Lead with what you built', id);
      },
      focus: () => cardFocus('r'),
      async play(id) {
        await pause(800, id);
        await click(await waitFor(() => button('.margin-card', 'Edit'), id), id);
      },
    },
    // Questions only the user can answer.
    'f-questions': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id);
        await open('What came of the checkout', id);
      },
      focus: () => cardFocus('r'),
      async play(id) {
        await pause(600, id);
        await type(await waitFor(() => document.querySelector('.margin-card .decision-answer'), id), DECISIONS[2].answer, id);
      },
    },
    // Structure and design, in the left margin.
    'f-structure': {
      async build(id) {
        await onDocument(0, 'improve', { decided: 3, reviews: { improve: ALL_FINDINGS } }, id);
        await open('Put Skills before Experience', id);
      },
      focus: () => cardFocus('l'),
      async play() {},
    },
    // Progress, and To do: only what's left.
    'f-todo': {
      build: (id) => onDocument(0, 'improve', { decided: 2, reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(700, id);
        await click(await waitFor(() => document.querySelector('#done-switch button[data-show="todo"]'), id), id);
      },
    },
    // Every draft kept, stepped through in the top bar.
    'f-drafts': {
      build: (id) => onDocument(1, 'improve', { decided: 4, reviews: { improve: ALL_FINDINGS } }, id),
      focus: () => ({ x: 0, y: 0, width: 1280, height: 420 }), // the top bar's draft arrows, and the page under them
      async play(id) {
        await pause(700, id);
        await click(await waitFor(() => document.getElementById('draft-prev'), id), id);
        await pause(1600, id);
        await click(await waitFor(() => document.getElementById('draft-next'), id), id);
      },
    },
    // Focuses: what each review is for, and the prompt to start a new one.
    'f-focus': {
      async build(id) {
        await onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        document.getElementById('focus-button').click();
        await waitFor(() => document.querySelector('#focus-card:not([hidden]) .focus-goal-input'), id);
      },
      focus: topLeft,
      async play(id) {
        await pause(700, id);
        await type(document.querySelector('#focus-card .focus-goal-input'), 'Anything that would worry a hiring manager', id);
      },
    },
    // Highlights: the key information, ranked, by category.
    'f-highlights': {
      build: (id) => onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(600, id);
        await click(await waitFor(() => button('.review-bar', 'Next ›'), id), id);
      },
    },
    // What the document doesn't say.
    'f-gaps': {
      async build(id) {
        await onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        await open('No team size', id);
      },
      focus: () => cardFocus('l'),
      async play() {},
    },
    // The highlights as a list.
    'f-list': {
      build: (id) => onDocument(1, 'highlights', { decided: 4, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(600, id);
        await click(await waitFor(() => document.querySelector('#view-switch button[data-view="list"]'), id), id);
      },
    },
    // Home: documents, variations and drafts.
    'f-home': {
      build: (id) => onHome({ made: 1, variation: true, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => WINDOW,
      async play(id) {
        await pause(600, id);
        await moveTo(await waitFor(() => [...document.querySelectorAll('#home-variations .home-row')].find((r) => r.textContent.includes('Acme')), id), id);
      },
    },
    // A variation's own drafts, sharing those it started from.
    'f-variation': {
      async build(id) {
        await onHome({ made: 1, variation: true, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id);
        await selectVariation('Acme', id);
      },
      focus: () => union(rect('.home-column:nth-child(3)')),
      async play(id) {
        for (const item of [...document.querySelectorAll('#home-drafts .home-item')].slice(0, 3)) {
          await moveTo(item, id);
          await pause(800, id);
        }
      },
    },
    // Any draft as a new document.
    'f-document': {
      build: (id) => onHome({ made: 1, reviews: { improve: ALL_FINDINGS, highlights: ALL_HIGHLIGHTS } }, id),
      focus: () => union(rect('.home-column:nth-child(3)'), { left: 900, right: 1260, top: 100, bottom: 300 }),
      async play(id) {
        await pause(500, id);
        const menu = await contextMenu(await waitFor(() => document.querySelector('#home-drafts .home-item'), id), ['New Variation…', 'Make a Document from This Draft'], id);
        await moveTo(menu.items[1], id);
        menu.items[1].classList.add('active');
      },
    },
  };

  return {
    scenes: Object.keys(SCENES),
    setInstant(on) {
      instant = on;
    },
    // The site dragging the CV in from beside the window (the upload scene only): over the window,
    // then dropped.
    dragOver: () => current === 'upload' && dragOver(),
    drop: () => (current === 'upload' && api.state.screen === 'home' ? drop() : null),
    // Plays the built scene's moment, if it's still the scene; resolves once it's over (finished,
    // or stopped by another scene).
    start() {
      const moment = ready?.id === live ? ready.play() : Promise.resolve();
      ready = null;
      return moment;
    },
    onAgent(listener) {
      agentListeners.push(listener);
    },
    // Hears the camera's new focus when a scene moves on to another part of the window.
    onFocus(listener) {
      focusListeners.push(listener);
    },
    // Builds the scene; its moment plays on start().
    show(name) {
      const id = ++live;
      current = name;
      ready = null;
      const scene = SCENES[name] ?? SCENES['intro-improve'];
      agent({ type: 'clear' });
      const result = building.then(async () => {
        if (id !== live) return null;
        showCursor(false);
        try {
          await scene.build(id);
          await frame();
        } catch (error) {
          if (error !== CANCELLED) console.warn(error);
          return null;
        }
        if (id !== live) return null;
        const focus = scene.focus();
        ready = { id, play: () => scene.play(id).catch((error) => error !== CANCELLED && console.warn(error)) };
        return focus;
      });
      building = result.catch(() => {});
      return result;
    },
  };
}
