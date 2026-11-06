import { CONTRACT, connectedPairs, isInternalLink, neighboursOf, parseLink, partName, partsOf, previewsFor, TABLE_ROWS_SHOWN, tableSummary } from '../main/items.js';
import { makeCanvas } from './canvas-view.js';
import { captureMorph, leaveAround, morphInto } from './morph.js';
import { arrive, canChoreograph, drawLines, leaveFor, watchStage } from './focus-view.js';
import { watchPage } from './page-view.js';
import { watchList } from './list-lines.js';
import { showHoverCard } from './hover-card.js';
import { itemView, kindLabel } from './item-views.js';
import { CHEVRON, createModeSwitcher } from './mode-switcher.js';
import { plainText, renderMarkdown } from './markdown.js';

// The window's content: the home screen (schemas › drafts), or one schema, opened level by level.
// Where the window is, is a path of levels: the schema opened from home, then each embedded schema
// opened from the one before. Each level has one item in focus, with what it links to around it (see
// focus-view.js). The main process owns the schemas; this asks for what it shows, again whenever
// they change.

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

const ARROW_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.18,13H4V11H16.18l-5.6-5.6L12,4l8,8l-8,8l-1.42-1.4l5.6-5.6Z"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5,21q-0.83,0-1.41-0.59T3,19V5Q3,4.17 3.59,3.59T5,3h7V5H5V19H19V12h2v7q0,0.82-0.59,1.41T19,21H5Zm4.7-5.3L8.3,14.3L17.6,5H14V3h7v7H19V6.4L9.7,15.7Z"/></svg>';
const FULL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/></svg>';
const LEAVE_FULL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59z"/></svg>';
const HOME_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/></svg>';
const SORT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3,18V16H9v2H3Zm0-5V11H15v2H3ZM3,8V6H21V8H3Z"/></svg>';
// Each column's sort orders, the first the default.
const SORTS = {
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

const rememberedView = () => {
  try {
    return localStorage.getItem('schema-view') === 'list' ? 'list' : 'item';
  } catch {
    return 'item';
  }
};

const CHANGE_LABELS = { added: 'New', changed: 'Changed', removed: 'Removed' };
const SIDE_LIMIT = 6; // cards on a side before the rest wait behind "more"
const smoothly = () => typeof document.startViewTransition === 'function' && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createSchemas({ el, bottomBar, crumbs, draftNav, modeCard, focusMenu, viewSwitch, api, onConnect }) {
  // A level: { schemaId, draftId (null for the latest), proposal (showing the proposed change),
  // label, item (what's selected in it), focus (a part of it to bring into view) }.
  let path = [];
  let selected = null; // the schema whose drafts home shows
  const sorts = Object.fromEntries(Object.entries(SORTS).map(([column, options]) => [column, options.find(([id]) => id === rememberedSort(column)) ?? options[0]]));
  const modes = createModeSwitcher({ card: modeCard, onChange: () => render() });
  let rendering = 0;
  // A schema shows one item with what links to it, or a list of everything in it. Remembered on this
  // computer, as a convenience.
  let layout = rememberedView();
  let morphing = false; // the next drawing opens or closes full screen
  let moving = false; // the item the focus is moving to, so the next drawing animates to it
  const top = () => path.at(-1);

  // Back and forward: where this window has been, as a browser keeps it. Each stop is the levels open
  // and the item each shows. Choosing somewhere new drops what was ahead.
  const HISTORY_LIMIT = 200;
  const backButton = document.getElementById('history-back');
  const forwardButton = document.getElementById('history-forward');
  const stop = () => JSON.stringify(path.map(({ schemaId, draftId, proposal, label, item, full }) => ({ schemaId, draftId, proposal, label, item, full })));
  let visited = [stop()];
  let visiting = 0;
  const showHistory = () => {
    backButton.disabled = visiting === 0;
    forwardButton.disabled = visiting === visited.length - 1;
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
    visiting = next;
    path = JSON.parse(visited[next]).map((one) => ({ ...one, focus: null, expanded: false }));
    showHistory();
    // Within one level, it moves as following a card does.
    const now = top();
    moving = was && now && was.schemaId === now.schemaId && path.length && was.item !== now.item ? now.item : false;
    morphing = Boolean(was && now && path.length && was.schemaId === now.schemaId && was.item === now.item && Boolean(was.full) !== Boolean(now.full));
    if (path.length) selected = path[0].schemaId;
    closeFocus();
    render();
  }
  backButton.addEventListener('click', () => travel(-1));
  forwardButton.addEventListener('click', () => travel(1));
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.key === '[') travel(-1);
    else if (event.key === ']') travel(1);
  });
  const level = (schemaId, { draftId = null, proposal = false, label = '', item = CONTRACT } = {}) => ({ schemaId, draftId, proposal, label, item, full: false, focus: null, expanded: false });

  let showingPlace = null;
  const placeShowing = () => {
    const here = top();
    return here ? [here.schemaId, here.item, Boolean(here.full), layout, modes.mode()].join(':') : 'home';
  };

  const KEYS = ['data-schema', 'data-draft', 'data-proposal']; // home's rows
  function focusKey(element) {
    if (!element || element === document.body) return null;
    if (element.id) return `#${CSS.escape(element.id)}`;
    const key = KEYS.find((name) => element.hasAttribute(name));
    return key ? `${element.tagName.toLowerCase()}[${key}="${CSS.escape(element.getAttribute(key))}"]` : null;
  }

  async function render() {
    const ticket = ++rendering;
    // The same thing drawn again keeps its place. Anything else starts at its top, once it shows.
    const place = placeShowing();
    const scroll = place === showingPlace ? el.scrollTop : 0;
    const view = path.length ? await schemaView(top()) : await homeView();
    if (ticket !== rendering) return;
    // Home's columns scroll on their own, and keep their place when it's drawn again.
    const lists = [...el.querySelectorAll('.browser-list')].map((list) => list.scrollTop);
    // What has focus keeps it when it's drawn again: found by its id, or by the row it is.
    const focused = focusKey(document.activeElement);
    const show = () => {
      focusMenu.hidden = true;
      el.replaceChildren(view);
      bottomBar.replaceChildren(...(view.bottomBar ?? []));
      bottomBar.hidden = !view.bottomBar;
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
      // The stage first: it sets the card's size, which the page is fitted to.
      const stage = el.querySelector('.focus-stage');
      if (stage) watchStage(stage);
      const pageSpace = el.querySelector('.sheet-body');
      if (pageSpace) watchPage(pageSpace);
      const list = el.querySelector('.list-page');
      if (list) watchList(list, JSON.parse(list.dataset.pairs), JSON.parse(list.dataset.connections));
      bringFocusIntoView();
    };
    // Moving to a card around the focus has its own choreography (see focus-view.js). Any other move
    // of the focus, say to an item in the row beneath, is left to the browser. A move that can't be
    // animated, as in a hidden window, still happens: only the animation is lost.
    const target = typeof moving === 'string' ? moving : null;
    const oldStage = el.querySelector('.focus-stage');
    const card = target && view.classList.contains('schema-page') && oldStage?.querySelector(`.focus-side [data-item="${target}"]`);
    const animate = moving && smoothly();
    moving = false;
    // Opening or closing full screen: the content itself turns into its other form (see morph.js).
    const turning = morphing && layout === 'item' && view.classList.contains('schema-page') && el.querySelector('.focus-card .focus-body') && canChoreograph();
    morphing = false;
    if (turning) {
      const from = captureMorph(el);
      await leaveAround(el);
      if (ticket !== rendering) return;
      show();
      morphInto(view, from);
    } else if (card && canChoreograph()) {
      await leaveFor(oldStage, card, view.querySelector('.focus-card'));
      if (ticket !== rendering) return;
      show();
      const stage = el.querySelector('.focus-stage');
      if (stage) arrive(stage);
    } else if (animate) {
      const transition = document.startViewTransition(show);
      transition.ready.catch(() => {});
      transition.finished.catch(() => {});
    } else show();
  }

  function bringFocusIntoView() {
    const here = top();
    if (!here?.focus) return;
    const part = [...el.querySelectorAll('[data-part]')].find((element) => element.dataset.part === here.focus);
    here.focus = null;
    if (!part) return;
    const canvas = part.closest('.diagram-canvas');
    if (canvas) canvas.centreOn(part);
    else part.scrollIntoView({ block: 'center' });
    part.classList.add('part-focus');
    setTimeout(() => part.classList.remove('part-focus'), 2000);
  }

  function go(next) {
    // Back home, the schema you were in is the one selected.
    if (!next.length && path.length) selected = path[0].schemaId;
    path = next;
    remember();
    return render();
  }

  // --- Home ---------------------------------------------------------------------------------

  async function homeView() {
    const schemas = sorts.schemas[2](await api.listSchemas());
    const schema = schemas.find((each) => each.id === selected) ?? schemas[0] ?? null;
    selected = schema?.id ?? null;
    const drafts = schema ? sorts.drafts[2](await api.listDrafts(schema.id)) : [];
    return h('div', { className: 'browser' },
      column('Schemas', {
        sort: 'schemas',
        empty: h('div', { className: 'browser-empty' },
          h('p', {}, 'No schemas yet. Your AI designs them: File › New Schema gives you a prompt to send it.'),
          h('button', { className: 'secondary-button', type: 'button', id: 'home-connect', onclick: onConnect }, 'Connect an AI')),
      }, ...schemas.map((each) => row({
        attributes: { 'data-schema': each.id, 'aria-pressed': String(each.id === schema.id) },
        onclick: () => { selected = each.id; render(); },
        title: each.name,
        arrow: true,
        tag: each.proposal && WAITING(),
        text: each.summary,
      }))),
      column('Drafts', {
        sort: 'drafts',
        empty: h('p', { className: 'browser-empty' }, schema ? 'No drafts yet.' : 'A schema’s drafts show here.'),
      },
        schema?.proposal && row({
          attributes: { 'data-proposal': schema.proposal.id },
          className: 'proposal-row',
          onclick: () => go([level(schema.id, { proposal: true, label: schema.name })]),
          title: schema.drafts ? 'Proposed change' : 'Proposed schema',
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

  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function sortControl(column) {
    const select = h('select', { id: `sort-${column}`, 'aria-label': 'Sort by' });
    for (const [id, text] of SORTS[column]) select.append(new Option(text, id, false, id === sorts[column][0]));
    select.addEventListener('change', () => {
      sorts[column] = SORTS[column].find(([id]) => id === select.value);
      try {
        localStorage.setItem(`sort-${column}`, select.value);
      } catch {}
      render();
    });
    const label = h('label', { className: 'browser-sort' });
    label.innerHTML = SORT_ICON;
    label.append(select);
    return label;
  }

  function column(title, { sort, empty }, ...rows) {
    const shown = rows.filter(Boolean);
    return h('section', { className: 'browser-column', 'aria-label': title },
      h('div', { className: 'browser-head' }, h('h2', {}, title), sortControl(sort)),
      shown.length
        ? h('ul', { className: 'browser-list' }, ...shown.map((one) => h('li', {}, one)))
        : h('div', { className: 'browser-list' }, empty));
  }

  // A new schema: what it's for, and a prompt asking the AI to design it, from the File menu.
  function newSchema() {
    if (document.querySelector('.prompt-dialog')) return;
    const field = h('textarea', { className: 'focus-goal-input', id: 'new-schema-goal', rows: 3, 'aria-label': 'What the schema should describe', placeholder: 'What should your AI design? For example: the billing system, or machine to machine auth as a standard' });
    const dialog = h('dialog', { className: 'prompt-dialog', 'aria-labelledby': 'prompt-title' },
      h('h2', { id: 'prompt-title' }, 'New schema'),
      h('p', {}, 'Your AI designs it, and you accept it here.'),
      field,
      h('div', { className: 'prompt-buttons' },
        h('button', { className: 'secondary-button', type: 'button', id: 'new-schema-close', onclick: () => dialog.close() }, 'Close'),
        copyButton('primary-button', 'Copy the prompt', 'new-schema-copy', () => [
          field.value.trim() ? `Design a new schema in SmartSpec for: ${field.value.trim()}` : 'Ask me what to design, then propose a new schema in SmartSpec.',
          api.windowId && `Take over SmartSpec window ${api.windowId} with use_window first.`,
        ].filter(Boolean).join(' '))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    field.focus();
  }

  // An arrow says a schema leads on to its drafts.
  function row({ attributes, className = '', onclick, title, tag, text, meta, arrow = false }) {
    const button = h('button', { ...attributes, className: `browser-row ${className}`, type: 'button', onclick },
      h('span', { className: 'title-row' }, h('strong', {}, title), statusPills(tag)),
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
      // It was discarded: back to the level above.
      const at = path.indexOf(here);
      if (at >= 0) path = path.slice(0, at);
      return path.length ? schemaView(top()) : homeView();
    }
    here.label = shown.name;

    const uses = new Map(shown.uses.map((use) => [use.id, use]));
    const known = (id) => id === CONTRACT || uses.has(id) || shown.items.some((item) => item.id === id);
    if (!known(here.item)) here.item = CONTRACT;

    // Going into an embedded schema, from its overview here. `item` is where to land, if not its contract.
    const openUse = (use, item) => {
      if (!use.missing) go([...path, level(use.schemaId, { draftId: use.draftId, label: use.name, item })]);
    };
    const follow = (link) => {
      const { target, part } = parseLink(link, here.item);
      if (!known(target)) return undefined;
      moving = target !== here.item && target;
      if (moving) here.expanded = false;
      here.item = target;
      here.focus = part;
      remember();
      return render();
    };

    here.choices = { shown };
    if (modes.mode() === 'test') {
      const page = testView(shown);
      page.draftNav = draftControls(here, shown);
      page.bottomBar = reviewBar(here, shown);
      return page;
    }

    if (layout === 'list') {
      const connections = await api.getConnections(here.schemaId, here.proposal ? { proposal: true } : { draftId: shown.draftId }).catch(() => ({}));
      const page = await listView(here, shown, uses, connections);
      page.draftNav = draftControls(here, shown);
      page.bottomBar = reviewBar(here, shown);
      return page;
    }

    const page = h('div', { className: `page schema-page${here.full ? ' full' : ''}` },
      await stageView(here, shown, uses, follow, openUse));
    page.draftNav = draftControls(here, shown);
    page.bottomBar = reviewBar(here, shown);
    return page;
  }

  // Test mode: nothing to test against yet, and it says so rather than pretending.
  const testView = (shown) => h('div', { className: 'mode-empty' },
    h('h1', {}, 'Testing isn’t built yet'),
    h('p', {}, `This is where ${shown.name} will link to its implementation and run its contract tests, and you’ll see what’s passing or failing.`));

  // In the top bar, with a schema open: home, the mode, the schemas open if one's embedded in another,
  // and the focus: what the AI's work on this draft is for.
  function breadcrumb() {
    if (!path.length) return [];
    const home = h('button', { className: 'icon-button crumb-home', type: 'button', id: 'crumb-home', 'aria-label': 'Home', title: 'Home', onclick: () => go([]) });
    home.innerHTML = HOME_ICON;
    const list = [home, modes.button];
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
    `Work on the design of “${shown.name}” (schema ${shown.id}) in SmartSpec${goal ? `, focusing on: ${goal}` : ', and suggest improvements.'}`,
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
  function draftControls(here, shown) {
    const step = (enabled, label, symbol, onclick) => h('button', { className: 'icon-button', type: 'button', 'aria-label': label, title: label, disabled: !enabled, onclick }, symbol);
    if (here.proposal) {
      return [
        step(shown.total > 0, 'Back to the current draft', '‹', () => { here.proposal = false; here.draftId = null; render(); }),
        h('span', { className: 'draft-label', title: shown.note }, `Draft ${shown.total + 1} preview`),
        step(false, 'Next draft', '›'),
      ];
    }
    const at = shown.number - 1;
    // The latest follows the schema as it changes; an earlier one stays where it is.
    const goTo = (delta) => () => { here.draftId = at + delta === shown.line.length - 1 ? null : shown.line[at + delta]; render(); };
    return [
      step(shown.line[at - 1], 'Previous draft', '‹', goTo(-1)),
      h('span', { className: 'draft-label', title: shown.note }, `Draft ${shown.number} of ${shown.total}`),
      step(shown.line[at + 1], 'Next draft', '›', goTo(1)),
    ];
  }

  // The controls are centred in the top bar while there's room. When the breadcrumb reaches them they
  // move along to sit just after it; when that leaves no room before the right-hand controls, the
  // label goes, then the controls too. Each time starts from everything shown.
  const DRAFT_NAV_GAP = 12;
  function placeDraftNav() {
    if (draftNav.hidden) return;
    draftNav.classList.remove('compact', 'collapsed');
    const bar = draftNav.parentElement.getBoundingClientRect();
    const end = draftNav.parentElement.querySelector('.top-bar-end').getBoundingClientRect().left - DRAFT_NAV_GAP - bar.left;
    const fits = () => {
      draftNav.classList.remove('pushed');
      draftNav.style.left = '';
      const last = crumbs.lastElementChild?.getBoundingClientRect().right ?? bar.left;
      const start = last + DRAFT_NAV_GAP - bar.left;
      const width = draftNav.offsetWidth;
      if (bar.width / 2 - width / 2 >= start) return bar.width / 2 + width / 2 <= end;
      draftNav.classList.add('pushed');
      draftNav.style.left = `${start}px`;
      return start + width <= end;
    };
    if (fits()) return;
    draftNav.classList.add('compact');
    if (fits()) return;
    draftNav.classList.add('collapsed');
  }

  // The bottom bar is about this view, and only shows when there's something to say. Its text explains
  // what's going on in plain sentences, with no bold labels; its buttons are what to do about it.
  // Today that's a proposal waiting: what it is, the AI's note on it, and the user's answer or the
  // way to it.
  const sentence = (text) => (text && !/[.!?]$/.test(text) ? `${text}.` : text ?? '');
  const reviewLine = (said, note) => {
    const full = [said, sentence(note)].filter(Boolean).join(' ');
    return h('p', { className: 'review-bar-text', title: full }, said, note ? ' ' : '', note ? h('span', {}, sentence(note)) : '');
  };
  function reviewBar(here, shown) {
    if (here.proposal) {
      return [
        reviewLine(shown.total
          ? `You're looking at a change the AI has proposed. Accepting it makes it draft ${shown.total + 1}.`
          : "You're looking at a new schema the AI has proposed. Accepting it makes it the first draft.", shown.note),
        h('button', { className: 'secondary-button', type: 'button', id: 'proposal-discard', onclick: () => answer(() => api.discardProposal(here.schemaId)) }, 'Discard'),
        h('button', { className: 'primary-button', type: 'button', id: 'proposal-accept', onclick: () => answer(() => api.acceptProposal(here.schemaId)) }, 'Accept'),
      ];
    }
    if (!shown.proposal) return null;
    return [
      reviewLine('The AI has proposed a change to this schema.', shown.proposal.note),
      h('button', { className: 'primary-button', type: 'button', id: 'view-proposal', onclick: () => { here.proposal = true; render(); } }, 'Review'),
    ];
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
  const marker = (mark) => mark && pill(CHANGE_LABELS[mark], `item-change ${mark}`);

  // The focused item in the middle, what links to it on the left, what it links to on the right, and
  // the rest of the schema beneath.
  async function stageView(here, shown, uses, follow, openUse) {
    const use = uses.get(here.item);
    const item = here.item === CONTRACT || use ? null : await api.getItem(here.schemaId, here.item, here.proposal ? { proposal: true } : { draftId: shown.draftId });
    const around = neighboursOf(here.item, shown.links, item ? partsOf(item) : []);
    // A table's card always says what's in it, so it doesn't need one of the few previews.
    const isTable = (entry) => shown.items.find((one) => one.id === entry.id)?.kind === 'table';
    const previews = new Set(previewsFor({ left: around.left.filter((entry) => !isTable(entry)), right: around.right.filter((entry) => !isTable(entry)) }));
    const content = (id) => (id === CONTRACT || uses.has(id) ? null : api.getItem(here.schemaId, id, here.proposal ? { proposal: true } : { draftId: shown.draftId }));
    const mark = (id) => (id === CONTRACT ? (shown.changes?.contract ? 'changed' : null) : shown.changes?.items[id]);

    const side = async (name, entries) => {
      const shownEntries = here.expanded ? entries : entries.slice(0, SIDE_LIMIT);
      const cards = await Promise.all(shownEntries.map(async (entry) => {
        const preview = isTable(entry) ? tablePreview(await content(entry.id), here.item, shown.links)
          : previews.has(entry.id) ? await previewOf(entry.id, shown, uses, content) : null;
        return uses.has(entry.id) ? useCard(uses.get(entry.id), entry, follow) : itemCard(entry, shown, mark(entry.id), preview, follow);
      }));
      const hidden = entries.length - shownEntries.length;
      return h('section', { className: `focus-side ${name}`, 'aria-label': name === 'left' ? 'Links here' : 'Links from here' },
        ...cards,
        hidden > 0 && h('button', { className: 'link-button focus-more', type: 'button', onclick: () => { here.expanded = true; render(); } }, `+${hidden} more`));
    };

    const middle = h('article', { className: 'focus-card', style: moves(here.item), 'aria-label': use ? use.name ?? use.id : item?.title ?? 'Contract' });
    // Links in Markdown are followed here, whichever kind of item they're in.
    middle.addEventListener('click', (event) => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!isInternalLink(href)) return; // the main process opens web links in the browser
      event.preventDefault();
      // An embedded schema's contract links within that schema, so they lead into it.
      if (use) openUse(use, parseLink(href).target);
      else follow(href);
    });
    // And pointing at one says where it goes, to decide whether to.
    const whereTo = linkTips(here, shown, uses, use, item);
    const tip = (event) => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || !middle.contains(anchor)) return;
      const rects = [...anchor.getClientRects()];
      const at = event.clientX === undefined ? rects.at(-1) : rects.find((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) ?? anchor.getBoundingClientRect();
      showHoverCard(anchor, (card) => whereTo(card, anchor.getAttribute('href')), at, 'link-tip');
    };
    middle.addEventListener('mouseover', tip);
    middle.addEventListener('focusin', (event) => event.target.matches?.(':focus-visible') && tip(event));
    const body = h('div', { className: 'focus-body' });
    if (use) {
      await useOverview(use, middle, body, openUse);
    } else if (item) {
      middle.append(paneHead(item.title, item.description, mark(item.id), pill(kindLabel(item), 'kind-pill')));
      const view = itemView(item, follow);
      // Where a canvas has been moved to is kept for each size it shows at.
      const place = `${item.id}:${Boolean(here.full)}`;
      here.views ??= {};
      body.append(view.classList.contains('diagram')
        ? makeCanvas(view, {
          saved: here.views[place] ?? null,
          onChange: (kept) => { here.views[place] = kept; },
          onShow: () => {
            const stage = view.closest('.focus-stage');
            if (stage) drawLines(stage);
          },
        })
        : view);
    } else {
      middle.append(paneHead('Contract', shown.summary, mark(CONTRACT)));
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
    }
    middle.append(body);
    actionsOf(middle).append(fullButton(here));

    // There's no card around what's in the middle: a diagram is a canvas, writing is a page, and a table
    // or image sits on a surface of its own size. Opened full screen, they're the same thing with the
    // space to themselves.
    const canvas = body.querySelector(':scope > .diagram-canvas');
    const writing = !canvas && (use || !item || item.kind === 'document');
    if (canvas) body.classList.add('canvas-body');
    else if (writing) {
      const sheet = h('div', { className: 'document-sheet' });
      sheet.append(...body.childNodes);
      body.append(sheet);
      body.classList.add('sheet-body');
    } else body.classList.add(`${item.kind}-body`);
    middle.classList.add('embeds');

    if (here.full) {
      // The card's title stays apart from the writing, above the page.
      if (writing) body.prepend(h('div', { className: 'sheet-head' }, middle.querySelector('.pane-title')));
      // No bar across the top: what it held floats over the content.
      const head = middle.querySelector('.pane-head');
      const pills = middle.querySelector('.pane-title .status-pills');
      middle.append(h('div', { className: 'full-actions' }, pills, ...actionsOf(head).children));
      head.remove();
      return h('div', { className: 'focus-full' }, middle);
    }

    return h('div', { className: 'focus-page' },
      h('div', { className: 'focus-stage', 'data-focus': here.item },
        await side('left', around.left),
        middle,
        await side('right', around.right),
        linesLayer()));
  }

  const actionsOf = (card) => card.querySelector('.pane-actions');

  function setFull(here, full) {
    here.full = full;
    moving = true;
    morphing = true;
    remember();
    return render();
  }

  function fullButton(here) {
    const name = here.full ? 'Leave full screen' : 'Full screen';
    const button = h('button', { className: 'icon-button', type: 'button', id: 'full-toggle', title: name, 'aria-label': name, onclick: () => setFull(here, !here.full) });
    button.innerHTML = here.full ? LEAVE_FULL_ICON : FULL_ICON;
    return button;
  }

  // An embedded schema in the middle: what it is, as this schema uses it, before going into it.
  async function useOverview(use, middle, body, openUse) {
    if (use.missing) {
      middle.append(paneHead(use.id, null, null, pill('Embedded schema', 'kind-pill schema-pill')));
      body.append(h('p', { className: 'muted' }, 'This schema is no longer available.'));
      return;
    }
    const inner = await api.getSchema(use.schemaId, use.draftId).catch(() => null);
    const head = paneHead(use.name, `Draft ${use.number}`, null, pill('Embedded schema', 'kind-pill schema-pill'));
    head.querySelector('.title-row').append(...[statusPills(use.newerDraftId && pill('Newer draft available', 'proposed'))].filter(Boolean));
    const open = h('button', { className: 'icon-button', type: 'button', id: 'use-open', title: 'Open schema', 'aria-label': 'Open schema', onclick: () => openUse(use) });
    open.innerHTML = OPEN_ICON;
    actionsOf(head).append(open);
    middle.append(head);

    body.append(h('p', { className: 'use-summary' }, use.summary));
    const contract = h('div', {});
    if (use.contract) renderMarkdown(contract, use.contract);
    else contract.append(h('p', { className: 'muted' }, 'No contract yet.'));
    body.append(h('h3', { className: 'pane-subhead' }, 'Contract'), contract);

    const parameters = inner?.parameters ?? [];
    if (parameters.length) {
      body.append(h('h3', { className: 'pane-subhead' }, 'Set here'), h('dl', { className: 'parameters' }, ...parameters.flatMap((parameter) => [
        h('dt', {}, parameter.name),
        h('dd', {}, use.with?.[parameter.name] ? h('code', {}, use.with[parameter.name]) : h('span', { className: 'muted' }, 'Not set'), parameter.description ? ` ${parameter.description}` : ''),
      ])));
    }
    const contents = [...(inner?.items ?? []).map((one) => [one.title, kindLabel(one), one.description]), ...(inner?.uses ?? []).map((one) => [one.name ?? one.id, 'Embedded schema', one.summary])];
    if (contents.length) {
      body.append(h('h3', { className: 'pane-subhead' }, 'Inside'), h('ul', { className: 'use-contents' }, ...contents.map(([title, kind, description]) => h('li', {},
        h('strong', {}, title),
        h('span', { className: 'focus-kind' }, kind),
        description && h('span', { className: 'focus-meta' }, description)))));
    }
  }

  // Everything in the schema, to find an item or see how it's connected, whatever links to what. Each
  // row is the full card a side card is a compact version of: the same tag, title and description,
  // and beneath, a look inside and how it's linked.
  async function listView(here, shown, uses, connections) {
    const links = (id) => {
      const out = new Set(shown.links.filter(({ from, to }) => parseLink(from).target === id && parseLink(to).target !== id).map(({ to }) => parseLink(to).target));
      const into = new Set(shown.links.filter(({ from, to }) => parseLink(to).target === id && parseLink(from).target !== id).map(({ from }) => parseLink(from).target));
      if (!out.size && !into.size) return 'Not linked to anything';
      return [out.size && `Links to ${out.size}`, into.size && `Linked from ${into.size}`].filter(Boolean).join(' · ');
    };
    const change = (id) => (id === CONTRACT ? (shown.changes?.contract ? 'changed' : null) : shown.changes?.items[id]);
    const open = (id) => () => {
      layout = 'item';
      rememberView();
      here.item = id;
      remember();
      render();
    };
    const content = (id) => api.getItem(here.schemaId, id, here.proposal ? { proposal: true } : { draftId: shown.draftId }).catch(() => null);
    // What's inside, then how it's linked, beneath the line.
    const inside = async (id) => {
      const item = id === CONTRACT ? null : shown.items.find((one) => one.id === id);
      const look = item?.kind === 'table' ? await content(id).then((table) => table && tablePreview(table, null, shown.links))
        : await previewOf(id, shown, uses, content).catch(() => null);
      return h('span', { className: 'list-row-foot' }, look, h('span', { className: 'list-row-links' }, links(id)));
    };
    const row = async (id, item) => h('li', {}, h('button', { className: 'list-row', type: 'button', 'data-item': id, onclick: open(id) },
      item && pill(kindLabel(item), 'kind-pill'),
      h('span', { className: 'title-row' }, h('strong', {}, item ? item.title : 'Contract'), statusPills(marker(change(id)))),
      h('span', { className: 'focus-meta' }, item ? item.description : 'What it promises and needs'),
      await inside(id)));
    const useRow = (use) => {
      const settings = Object.entries(use.with ?? {});
      return h('li', {}, h('button', { className: 'list-row embedded', type: 'button', 'data-item': use.id, onclick: open(use.id) },
        pill('Embedded schema', 'kind-pill schema-pill'),
        h('span', { className: 'title-row' }, h('strong', {}, use.name ?? use.id), !use.missing && h('span', { className: 'card-meta' }, `Draft ${use.number}`), statusPills(use.newerDraftId && pill('Newer draft available', 'proposed'))),
        h('span', { className: 'focus-meta' }, use.missing ? 'This schema is no longer available.' : use.summary),
        settings.length > 0 && h('span', { className: 'card-settings' }, ...settings.map(([key, value]) => h('code', {}, `${key}: ${value}`))),
        use.contract && h('span', { className: 'card-contract' }, plainText(use.contract)),
        h('span', { className: 'list-row-foot' }, h('span', { className: 'list-row-links' }, links(use.id)))));
    };
    const removed = shown.changes?.removed ?? [];
    const rows = await Promise.all([row(CONTRACT, null), ...shown.items.map((item) => row(item.id, item))]);
    return h('div', { className: 'page list-page', 'data-pairs': JSON.stringify(connectedPairs(shown.links)), 'data-connections': JSON.stringify(connections) },
      h('div', { className: 'list-head' },
        h('h1', {}, shown.items.length === 1 ? '1 item' : `${shown.items.length} items`)),
      h('ul', { className: 'list-rows' },
        ...rows,
        ...removed.map((item) => h('li', {}, h('div', { className: 'list-row removed', 'data-removed': item.id },
          pill(kindLabel(item), 'kind-pill'),
          h('span', { className: 'title-row' }, h('strong', { className: 'list-row-name' }, item.title), statusPills(marker('removed'))))))),
      shown.uses.length > 0 && h('h2', { className: 'list-section' }, 'Embedded schemas'),
      shown.uses.length > 0 && h('ul', { className: 'list-rows' }, ...shown.uses.map(useRow)));
  }

  const rememberView = () => {
    try {
      localStorage.setItem('schema-view', layout);
    } catch {}
  };

  function linesLayer() {
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    layer.setAttribute('class', 'focus-lines');
    layer.setAttribute('aria-hidden', 'true');
    return layer;
  }

  // A card for an item around the focus. Its lines start from `parts`.
  function itemCard(entry, shown, mark, preview, follow) {
    const contract = entry.id === CONTRACT;
    const item = shown.items.find((one) => one.id === entry.id);
    return h('button', { className: 'focus-neighbour', type: 'button', 'data-item': entry.id, 'data-parts': JSON.stringify(entry.parts), style: moves(entry.id), onclick: () => follow(entry.id) },
      !contract && item && pill(kindLabel(item), 'kind-pill'),
      h('span', { className: 'title-row' }, h('strong', {}, contract ? 'Contract' : item?.title ?? entry.id), statusPills(marker(mark))),
      h('span', { className: 'focus-meta' }, contract ? 'What it promises and needs' : item?.description),
      preview);
  }

  // What a table beside the focus holds: the rows the links are about, if any, then how much there is.
  function tablePreview(table, focus, links) {
    const { rows, linked, rowCount, columnCount } = tableSummary(table, focus, links);
    const count = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;
    const totals = [linked > TABLE_ROWS_SHOWN && `${linked} linked`, count(rowCount, 'row'), count(columnCount, 'column')].filter(Boolean).join(' · ');
    return h('span', { className: 'focus-preview table-preview' },
      ...rows.map(({ id, name, detail }) => h('span', { className: 'table-preview-row', 'data-row': id }, h('span', { className: 'table-preview-name' }, name), detail && ` ${detail}`)),
      h('span', { className: 'table-preview-totals' }, totals));
  }

  // Fills a card with where a link in the middle goes: what it is, which part of it, what it says
  // about itself, and what clicking does. Within an embedded schema's overview, its contract's links
  // are into that schema.
  function linkTips(here, shown, uses, use, item) {
    const inside = use && !use.missing ? api.getSchema(use.schemaId, use.draftId).catch(() => null) : null;
    const contents = new Map();
    const content = (id) => {
      if (!contents.has(id)) contents.set(id, (use ? api.getItem(use.schemaId, id, { draftId: use.draftId }) : api.getItem(here.schemaId, id, here.proposal ? { proposal: true } : { draftId: shown.draftId })).catch(() => null));
      return contents.get(id);
    };
    const line = (className, text) => h('span', { className }, text);
    return async (card, href) => {
      if (!isInternalLink(href)) {
        let url = null;
        try { url = new URL(href); } catch {}
        card.append(pill('Web link', 'kind-pill'), line('link-tip-title', url?.host || href), line('link-tip-url', href), line('link-tip-hint', 'Opens in your browser'));
        return;
      }
      const { target, part } = parseLink(href, use ? null : here.item);
      const schema = use ? await inside : shown;
      const found = schema?.items.find((one) => one.id === target);
      const embedded = (use ? schema?.uses ?? [] : shown.uses).find((one) => one.id === target);
      const same = !use && target === here.item;
      let tag = null;
      let title = target;
      let said = null;
      if (target === CONTRACT) [title, said] = ['Contract', schema?.summary];
      else if (embedded) [tag, title, said] = [pill('Embedded schema', 'kind-pill schema-pill'), embedded.name ?? embedded.id, embedded.summary];
      else if (found) [tag, title, said] = [pill(kindLabel(found), 'kind-pill'), found.title, found.description];
      let where = null;
      if (part === CONTRACT) where = 'Its contract';
      else if (part && found) where = partName(await content(target) ?? found, part);
      const hint = use ? `Opens it in ${use.name}` : same ? 'Goes to it, here' : 'Brings it to the middle';
      card.append(...[
        tag,
        line('link-tip-title', same ? `In this ${found ? kindLabel(found).toLowerCase() : 'item'}` : title),
        where && line('link-tip-part', `→ ${where}`),
        !same && said && line('link-tip-said', said),
        line('link-tip-hint', found || embedded || target === CONTRACT ? hint : 'Not in this schema'),
      ].filter(Boolean));
    };
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
    return h('span', { className: 'focus-preview picture', inert: '' }, itemView(item, () => {}));
  }

  // The title alone along the top. What it is, and its description, are on a card while pointing at
  // the title, or with it focused from the keyboard.
  const paneHead = (title, detail, mark, tag = null) => {
    const about = (tag || detail) && h('div', { className: 'title-card', role: 'tooltip', id: 'title-card' }, tag, detail && h('span', { className: 'title-card-detail' }, detail));
    return h('div', { className: 'pane-head' },
      h('div', { className: 'pane-title' },
        h('div', { className: 'title-row' }, h('h2', about ? { tabIndex: 0, 'aria-describedby': 'title-card' } : {}, title), statusPills(marker(mark))),
        about),
      h('div', { className: 'pane-actions' }));
  };

  // An embedded schema around the focus, collapsed. Clicking brings its overview to the middle.
  function useCard(use, entry, follow) {
    if (use.missing) return h('div', { className: 'focus-neighbour embedded', 'data-item': use.id, 'data-parts': JSON.stringify(entry.parts) }, pill('Embedded schema', 'kind-pill schema-pill'), h('strong', {}, use.id), h('span', { className: 'focus-meta' }, 'This schema is no longer available.'));
    const settings = Object.entries(use.with ?? {});
    return h('button', { className: 'focus-neighbour embedded', type: 'button', 'data-item': use.id, 'data-use': use.id, 'data-parts': JSON.stringify(entry.parts), onclick: () => follow(use.id) },
      pill('Embedded schema', 'kind-pill schema-pill'),
      h('span', { className: 'title-row' },
        h('strong', {}, use.name),
        h('span', { className: 'card-meta' }, `Draft ${use.number}`),
        statusPills(use.newerDraftId && pill('Newer draft available', 'proposed'))),
      h('span', { className: 'focus-meta' }, use.summary),
      settings.length > 0 && h('span', { className: 'card-settings' }, ...settings.map(([key, value]) => h('code', {}, `${key}: ${value}`))),
      use.contract && h('span', { className: 'card-contract' }, plainText(use.contract)));
  }

  new ResizeObserver(placeDraftNav).observe(draftNav.parentElement);
  for (const button of viewSwitch.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      layout = button.dataset.view;
      rememberView();
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
  api.onNewSchema(newSchema);
  // An AI's proposal, in the window it works in.
  api.onShowSchema(({ schemaId, name }) => {
    selected = schemaId;
    go([level(schemaId, { proposal: true, label: name })]);
  });
  render();
}
