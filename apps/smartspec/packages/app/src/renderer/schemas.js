import { CONTRACT, connectedPairs, isInternalLink, neighboursOf, parseLink, partsOf, previewsFor, TABLE_ROWS_SHOWN, tableSummary } from '../main/items.js';
import { makeCanvas } from './canvas-view.js';
import { captureMorph, leaveAround, morphInto } from './morph.js';
import { arrive, canChoreograph, drawLines, leaveFor, watchStage } from './focus-view.js';
import { watchPage } from './page-view.js';
import { drawOverview, watchOverview } from './overview-view.js';
import { commentCard, composerCard, watchComments } from './comments.js';
import { cardCommentTag, watchCardComments } from './card-comments.js';
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
// SmartDoc's New folder icon, for a new group.
const NEW_GROUP_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
const BIN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const UNGROUPED = 'ungrouped'; // the group a schema is in when it's in none, which always exists
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
const SIDE_LIMIT = 6; // cards on a side before the rest wait behind "more"
const smoothly = () => typeof document.startViewTransition === 'function' && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createSchemas({ el, bottomBar, crumbs, draftNav, modeCard, focusMenu, viewSwitch, api }) {
  // A level: { schemaId, draftId (null for the latest), proposal (showing the proposed change),
  // label, item (what's selected in it), focus (a part of it to bring into view) }.
  let path = [];
  let selected = null; // the schema whose drafts home shows
  let selectedGroup = null; // the group whose schemas home shows, UNGROUPED for those in none
  let naming = null; // a group being named on home: { id } for a rename, { id: null } for a new one
  const sorts = Object.fromEntries(Object.entries(SORTS).map(([column, options]) => [column, options.find(([id]) => id === rememberedSort(column)) ?? options[0]]));
  const modes = createModeSwitcher({ card: modeCard, onChange: () => render() });
  let rendering = 0;
  // A schema shows one item with what links to it, or a list of everything in it. Remembered on this
  // computer, as a convenience.
  let layout = rememberedView();
  let morphing = false; // the next drawing opens or closes full screen
  let moving = false; // the item the focus is moving to, so the next drawing animates to it
  const top = () => path.at(-1);

  // Back and forward: where this window has been, as a browser keeps it. Each stop is the levels open,
  // the item each shows, and whether that was in focus or on the overview. Choosing somewhere new
  // drops what was ahead.
  const HISTORY_LIMIT = 200;
  const backButton = document.getElementById('history-back');
  const forwardButton = document.getElementById('history-forward');
  const stop = () => JSON.stringify({ layout: path.length ? layout : null, path: path.map(({ schemaId, draftId, proposal, label, item, full }) => ({ schemaId, draftId, proposal, label, item, full })) });
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
    const wasLayout = layout;
    visiting = next;
    const stopped = JSON.parse(visited[next]);
    path = stopped.path.map((one) => ({ ...one, focus: null, expanded: false }));
    if (stopped.layout && stopped.layout !== layout) {
      layout = stopped.layout;
      rememberView();
    }
    showHistory();
    // Within one level, in focus, it moves as following a card does.
    const now = top();
    const sameView = wasLayout === 'focus' && layout === 'focus';
    moving = sameView && was && now && was.schemaId === now.schemaId && path.length && was.item !== now.item ? now.item : false;
    morphing = Boolean(sameView && was && now && path.length && was.schemaId === now.schemaId && was.item === now.item && Boolean(was.full) !== Boolean(now.full));
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

  const KEYS = ['data-group', 'data-schema', 'data-draft', 'data-proposal']; // home's rows
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
      watchComments(stage, stage?.comments);
      const withCards = stage ?? el.querySelector('.overview-page .diagram.overview');
      watchCardComments(withCards, withCards?.cardComments);
      const writing = el.querySelector('.comment-card.composing');
      if (writing && top()?.composing?.fresh) {
        top().composing.fresh = false;
        writing.focusField();
      }
      const pageSpace = el.querySelector('.sheet-body');
      if (pageSpace) watchPage(pageSpace);
      const overview = el.querySelector('.overview-page .diagram.overview');
      if (overview) watchOverview(overview, overview.pairs, overview.connections);
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
    const turning = morphing && layout === 'focus' && view.classList.contains('schema-page') && el.querySelector('.focus-card .focus-body') && canChoreograph();
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

  // Home: the groups schemas are organised into, the schemas in the chosen one, and the drafts of the
  // chosen schema. Ungrouped is always first, for schemas in no group. Groups only organise the list,
  // so the user makes, renames and deletes them here, and moves schemas between them by dragging one
  // onto a group, or with a schema's right-click menu.
  async function homeView() {
    const [all, { groups }] = await Promise.all([api.listSchemas(), api.listGroups()]);
    const groupOf = (one) => one.group ?? UNGROUPED;
    // The chosen schema's group is the one showing, wherever it was chosen (here, an AI's proposal, or
    // coming back home), and wherever it's moved to. Choosing a group lets go of the schema.
    const chosen = all.find((each) => each.id === selected);
    if (chosen) selectedGroup = groupOf(chosen);
    if (selectedGroup !== UNGROUPED && !groups.some((group) => group.id === selectedGroup)) selectedGroup = UNGROUPED;
    const schemas = sorts.schemas[2](all.filter((each) => groupOf(each) === selectedGroup));
    const schema = schemas.find((each) => each.id === selected) ?? schemas[0] ?? null;
    selected = schema?.id ?? null;
    const drafts = schema ? sorts.drafts[2](await api.listDrafts(schema.id)) : [];
    const ungrouped = all.filter((each) => !each.group).length;
    const count = (n) => (n === 1 ? '1 schematic' : `${n} schematics`);

    const groupRow = (id, name, schemasIn) => {
      if (naming && naming.id === id) return namingRow(name);
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
      acceptDrops(button, id);
      if (id === UNGROUPED) return button;
      const action = (label, icon, run) => {
        const one = h('button', { className: 'icon-button group-action', type: 'button', title: label, 'aria-label': `${label} ${name}`, onclick: run });
        one.innerHTML = icon;
        return one;
      };
      return h('div', { className: 'group-row' }, button, h('span', { className: 'group-actions' },
        action('Rename', PENCIL_ICON, () => { naming = { id }; render(); }),
        action('Delete', BIN_ICON, async () => { if (await api.deleteGroup(id)) render(); })));
    };
    const groupsColumn = h('section', { className: 'browser-column groups-column', 'aria-label': 'Groups' },
      h('div', { className: 'browser-head' }, h('h2', {}, 'Groups'), (() => {
        const add = h('button', { className: 'icon-button', type: 'button', id: 'new-group', title: 'New group', 'aria-label': 'New group', onclick: () => { naming = { id: null }; render(); } });
        add.innerHTML = NEW_GROUP_ICON;
        return add;
      })(), sortControl('groups')),
      h('ul', { className: 'browser-list' },
        h('li', {}, groupRow(UNGROUPED, 'Ungrouped', ungrouped)),
        // Ungrouped stays first, whatever the order.
        ...sorts.groups[2](groups).map((group) => h('li', {}, groupRow(group.id, group.name, group.schemas))),
        naming && naming.id === null && h('li', {}, namingRow(''))));

    const groupName = selectedGroup === UNGROUPED ? 'Ungrouped' : groups.find((group) => group.id === selectedGroup)?.name;
    return h('div', { className: 'browser' },
      groupsColumn,
      column('Schematics', {
        sort: 'schemas',
        // Placeholder rows, the shape of a schematic's: its name, then its summary.
        skeleton: [[44, 82], [58, 70], [36, 88]],
      }, ...schemas.map((each) => {
        const one = row({
          attributes: { 'data-schema': each.id, 'aria-pressed': String(each.id === schema.id), draggable: 'true' },
          onclick: () => { selected = each.id; render(); },
          title: each.name,
          arrow: true,
          tag: each.proposal && WAITING(),
          text: each.summary,
        });
        one.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData('application/x-smartspec-schema', each.id);
          event.dataTransfer.effectAllowed = 'move';
        });
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
          title: schema.drafts ? 'Proposed change' : 'Proposed schematic',
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

  // A group's name being written: a new group's, or a rename. Enter or leaving it saves, Escape
  // doesn't, and a name that's refused says why, keeping what was typed.
  function namingRow(name) {
    const field = h('input', { className: 'group-name-input', type: 'text', value: name, 'aria-label': naming.id ? 'Group name' : 'New group name', placeholder: 'Group name, such as Auth or Payments team', maxlength: '80' });
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
        const made = naming.id ? await api.renameGroup(naming.id, named) : await api.createGroup(named);
        if (!naming.id) {
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
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    });
    field.addEventListener('blur', () => setTimeout(() => document.activeElement !== field && finish(true)));
    setTimeout(() => {
      field.focus();
      field.select();
    });
    return h('div', { className: 'group-naming' }, field, said);
  }

  // A group takes a schema dropped on it.
  function acceptDrops(target, groupId) {
    const carrying = (event) => event.dataTransfer?.types.includes('application/x-smartspec-schema');
    target.addEventListener('dragover', (event) => {
      if (!carrying(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      target.classList.add('drop-here');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-here'));
    target.addEventListener('drop', async (event) => {
      target.classList.remove('drop-here');
      const schemaId = event.dataTransfer.getData('application/x-smartspec-schema');
      if (!schemaId) return;
      event.preventDefault();
      await api.moveSchema(schemaId, groupId === UNGROUPED ? null : groupId);
      render();
    });
  }

  // A schema's right-click menu: the groups it can move to.
  function moveMenu(schema, groups, event) {
    document.querySelector('.move-menu')?.remove();
    const here = schema.group ?? UNGROUPED;
    const choices = [[UNGROUPED, 'Ungrouped'], ...groups.map((group) => [group.id, group.name])].filter(([id]) => id !== here);
    const menu = h('div', { className: 'move-menu', role: 'menu', 'aria-label': `Move ${schema.name} to` },
      h('span', { className: 'move-menu-head' }, 'Move to'),
      ...(choices.length ? choices.map(([id, name]) => h('button', { type: 'button', role: 'menuitem', 'data-move-to': id, onclick: async () => {
        menu.remove();
        await api.moveSchema(schema.id, id === UNGROUPED ? null : id);
        render();
      } }, name)) : [h('span', { className: 'move-menu-none' }, 'Make a group first, with the button above Groups.')]));
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
    // The order chosen, then its icon at the column's right edge.
    const label = h('label', { className: 'browser-sort' }, select);
    label.insertAdjacentHTML('beforeend', SORT_ICON);
    return label;
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
    // What the proposal removes can still be opened while reviewing it, to see what goes.
    const known = (id) => id === CONTRACT || uses.has(id) || shown.items.some((item) => item.id === id) || Boolean(shown.changes?.removed.some((item) => item.id === id));
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

    if (layout === 'overview') {
      const connections = await api.getConnections(here.schemaId, here.proposal ? { proposal: true } : { draftId: shown.draftId }).catch(() => ({}));
      const page = await overviewView(here, shown, uses, connections);
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
  function draftControls(here, shown) {
    const step = (enabled, label, symbol, onclick) => h('button', { className: 'icon-button', type: 'button', 'aria-label': label, title: label, disabled: !enabled, onclick }, symbol);
    if (here.proposal) {
      return [
        step(shown.total > 0, 'Back to the current draft', '‹', () => { here.proposal = false; here.draftId = null; remember(); render(); }),
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
      // Past the latest draft is the proposal waiting on it, if there is one: the next draft's preview.
      shown.line[at + 1] || !shown.proposal
        ? step(shown.line[at + 1], 'Next draft', '›', goTo(1))
        : step(true, `Draft ${shown.total + 1} preview`, '›', () => { here.proposal = true; here.draftId = null; remember(); render(); }),
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
          : "You're looking at a new schematic the AI has proposed. Accepting it makes it the first draft.", shown.note),
        h('button', { className: 'secondary-button', type: 'button', id: 'proposal-discard', onclick: () => answer(() => api.discardProposal(here.schemaId)) }, 'Discard'),
        h('button', { className: 'primary-button', type: 'button', id: 'proposal-accept', onclick: () => answer(() => api.acceptProposal(here.schemaId)) }, 'Accept'),
      ];
    }
    if (!shown.proposal) return null;
    return [
      reviewLine('The AI has proposed a change to this schematic.', shown.proposal.note),
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
    // Something the proposal removes is shown as it was, from the draft the proposal changes.
    const gone = Boolean(here.proposal && shown.changes?.removed.some((one) => one.id === here.item));
    const item = here.item === CONTRACT || use ? null : await api.getItem(here.schemaId, here.item, gone ? { draftId: shown.basedOn } : here.proposal ? { proposal: true } : { draftId: shown.draftId });
    const around = neighboursOf(here.item, shown.links, item ? partsOf(item) : []);
    // A table's card always says what's in it, and an image's never shows it, so neither takes one of
    // the few previews.
    const kindOf = (entry) => shown.items.find((one) => one.id === entry.id)?.kind;
    const isTable = (entry) => kindOf(entry) === 'table';
    const previewed = (entry) => !['table', 'image'].includes(kindOf(entry));
    const previews = new Set(previewsFor({ left: around.left.filter(previewed), right: around.right.filter(previewed) }));
    const content = (id) => (id === CONTRACT || uses.has(id) ? null : api.getItem(here.schemaId, id, here.proposal ? { proposal: true } : { draftId: shown.draftId }));
    const mark = (id) => (id === CONTRACT ? (shown.changes?.contract ? 'changed' : null) : gone && id === here.item ? 'removed' : shown.changes?.items[id]);

    // The user's comments on what's in the middle, among the link cards: each on the side with fewer
    // cards so far. Full screen has no sides, so none show there.
    const on = here.proposal ? { proposal: true } : { draftId: shown.draftId };
    const record = here.proposal ? 'proposal' : shown.draftId;
    const everyComment = await api.listComments(here.schemaId, on).catch(() => []);
    const comments = here.full ? [] : everyComment.filter((comment) => comment.target.item === here.item && !comment.target.card);
    const onCards = everyComment.filter((comment) => comment.target.card);
    if (here.composing && (here.composing.record !== record || here.composing.target.item !== here.item)) here.composing = null;
    const counts = { left: Math.min(around.left.length, here.expanded ? Infinity : SIDE_LIMIT), right: Math.min(around.right.length, here.expanded ? Infinity : SIDE_LIMIT) };
    const sideFor = () => {
      const name = counts.left < counts.right ? 'left' : 'right';
      counts[name] += 1;
      return name;
    };
    const commentsBy = { left: [], right: [] };
    for (const comment of comments) {
      commentsBy[sideFor()].push(commentCard(comment, { onDelete: (gone) => api.deleteComment(here.schemaId, gone.id).then(render) }));
    }
    if (here.composing && !here.full) {
      const draft = here.composing;
      commentsBy[sideFor()].push(composerCard(draft, {
        onSave: async (text) => {
          await api.addComment(here.schemaId, { ...on, target: draft.target, text });
          if (here.composing === draft) here.composing = null;
          render();
        },
        onCancel: () => {
          here.composing = null;
          render();
        },
      }));
    }

    const side = async (name, entries) => {
      const shownEntries = here.expanded ? entries : entries.slice(0, SIDE_LIMIT);
      const cards = await Promise.all(shownEntries.map(async (entry) => {
        // What the AI wrote for the card, else what the app works out.
        const preview = cardLines(shown.items.find((one) => one.id === entry.id)) ?? (isTable(entry) ? tablePreview(await content(entry.id), here.item, shown.links)
          : previews.has(entry.id) ? await previewOf(entry.id, shown, uses, content) : null);
        return withCardComments(uses.has(entry.id) ? useCard(uses.get(entry.id), entry, follow) : itemCard(entry, shown, mark(entry.id), preview, follow), onCards);
      }));
      const hidden = entries.length - shownEntries.length;
      return h('section', { className: `focus-side ${name}`, 'aria-label': name === 'left' ? 'Links here' : 'Links from here' },
        ...cards,
        ...commentsBy[name],
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

    const stage = h('div', { className: 'focus-stage', 'data-focus': here.item },
      await side('left', around.left),
      middle,
      await side('right', around.right),
      linesLayer());
    // Picking something in the middle starts a comment on it.
    stage.cardComments = cardCommenting(here, on, onCards, '.focus-side .focus-neighbour[data-item]');
    // There's nothing to comment on in what's being removed: the proposal no longer has it.
    if (!gone) stage.comments = {
      item: here.item,
      start: (target) => {
        here.composing = { record, target, text: '', fresh: true };
        render();
      },
    };
    return h('div', { className: 'focus-page' }, stage);
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
    const contents = [...(inner?.items ?? []).map((one) => [one.title, kindLabel(one), one.description]), ...(inner?.uses ?? []).map((one) => [one.name ?? one.id, 'Embedded schematic', one.summary])];
    if (contents.length) {
      body.append(h('h3', { className: 'pane-subhead' }, 'Inside'), h('ul', { className: 'use-contents' }, ...contents.map(([title, kind, description]) => h('li', {},
        h('strong', {}, title),
        h('span', { className: 'focus-kind' }, kind),
        description && h('span', { className: 'focus-meta' }, description)))));
    }
  }

  // Every item in the schema on a canvas, with a line between each pair that link to each other (see
  // overview-view.js). Each card is the full card a side card is a compact version of: the same tag,
  // title and description, and beneath, a look inside and how it's linked. Clicking one brings it
  // into focus.
  async function overviewView(here, shown, uses, connections) {
    const links = (id) => {
      const out = new Set(shown.links.filter(({ from, to }) => parseLink(from).target === id && parseLink(to).target !== id).map(({ to }) => parseLink(to).target));
      const into = new Set(shown.links.filter(({ from, to }) => parseLink(to).target === id && parseLink(from).target !== id).map(({ from }) => parseLink(from).target));
      if (!out.size && !into.size) return 'Not linked to anything';
      return [out.size && `Links to ${out.size}`, into.size && `Linked from ${into.size}`].filter(Boolean).join(' · ');
    };
    const change = (id) => (id === CONTRACT ? (shown.changes?.contract ? 'changed' : null) : shown.changes?.items[id]);
    const open = (id) => () => {
      layout = 'focus';
      rememberView();
      here.item = id;
      remember();
      render();
    };
    const content = (id) => api.getItem(here.schemaId, id, here.proposal ? { proposal: true } : { draftId: shown.draftId }).catch(() => null);
    const on = here.proposal ? { proposal: true } : { draftId: shown.draftId };
    const comments = await api.listComments(here.schemaId, on).catch(() => []);
    const onCards = comments.filter((comment) => comment.target.card);
    const commentCount = (id) => {
      const count = comments.filter((comment) => comment.target.item === id && !comment.target.card).length;
      return count ? ` · ${count} ${count === 1 ? 'comment' : 'comments'}` : '';
    };
    // What's inside, then how it's linked, beneath the line.
    const inside = async (id) => {
      const item = id === CONTRACT ? null : shown.items.find((one) => one.id === id);
      const look = cardLines(item) ?? (item?.kind === 'table' ? await content(id).then((table) => table && tablePreview(table, null, shown.links))
        : await previewOf(id, shown, uses, content).catch(() => null));
      return h('span', { className: 'overview-card-foot' }, look, h('span', { className: 'overview-card-links' }, links(id) + commentCount(id)));
    };
    const card = async (id, item) => h('button', { className: 'overview-card', type: 'button', 'data-item': id, onclick: open(id) },
      item && pill(kindLabel(item), 'kind-pill'),
      h('span', { className: 'title-row' }, h('strong', {}, item ? item.title : 'Contract'), statusPills(marker(change(id)))),
      h('span', { className: 'focus-meta' }, item ? item.description : 'What it promises and needs'),
      await inside(id));
    const useCard = (use) => {
      const settings = Object.entries(use.with ?? {});
      return h('button', { className: 'overview-card embedded', type: 'button', 'data-item': use.id, onclick: open(use.id) },
        pill('Embedded schematic', 'kind-pill schema-pill'),
        h('span', { className: 'title-row' }, h('strong', {}, use.name ?? use.id), !use.missing && h('span', { className: 'card-meta' }, `Draft ${use.number}`), statusPills(use.newerDraftId && pill('Newer draft available', 'proposed'))),
        h('span', { className: 'focus-meta' }, use.missing ? 'This schematic is no longer available.' : use.summary),
        settings.length > 0 && h('span', { className: 'card-settings' }, ...settings.map(([key, value]) => h('code', {}, `${key}: ${value}`))),
        use.contract && h('span', { className: 'card-contract' }, plainText(use.contract)),
        h('span', { className: 'overview-card-foot' }, h('span', { className: 'overview-card-links' }, links(use.id) + commentCount(use.id))));
    };
    // Under review, what the proposal removes is still shown, struck out; and comments on anything
    // since removed stay, so none disappear unseen.
    const removed = (shown.changes?.removed ?? []).map((item) => h('button', { className: 'overview-card removed', type: 'button', 'data-removed': item.id, 'aria-label': `${item.title}, removed`, onclick: open(item.id) },
      pill(kindLabel(item), 'kind-pill'),
      h('span', { className: 'title-row' }, h('strong', { className: 'overview-card-name' }, item.title)),
      h('span', { className: 'removed-over', 'aria-hidden': 'true' }, 'Removed')));
    const orphans = comments.filter((comment) => comment.target.missing).map((comment) => commentCard(comment, { onDelete: (gone) => api.deleteComment(here.schemaId, gone.id).then(render) }));
    const cards = [...(await Promise.all([card(CONTRACT, null), ...shown.items.map((item) => card(item.id, item))])).map((one) => withCardComments(one, onCards)), ...shown.uses.map((use) => withCardComments(useCard(use), onCards)), ...removed, ...orphans];
    const pairs = connectedPairs(shown.links);
    // Laid out to fill the window as it is now; a place kept from a different layout would be lost in this one.
    const drawing = drawOverview(cards, pairs, { width: el.clientWidth, height: el.clientHeight });
    const sameLayout = here.overviewColumns === drawing.columns;
    here.overviewColumns = drawing.columns;
    const holder = makeCanvas(drawing, {
      saved: (sameLayout && here.views?.overview) || null,
      onChange: (kept) => {
        here.views ??= {};
        here.views.overview = kept;
      },
    });
    Object.assign(holder, { pairs, connections, cardComments: cardCommenting(here, on, onCards, '.overview-card[data-item]') });
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

  function linesLayer() {
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    layer.setAttribute('class', 'focus-lines');
    layer.setAttribute('aria-hidden', 'true');
    return layer;
  }

  // The lines the AI wrote for an item's card, below its line, if it wrote any.
  const cardLines = (item) => (item?.card?.length ? h('span', { className: 'focus-preview card-lines' }, ...item.card.map((line) => h('span', {}, line))) : null);

  // A card with comments on it has a speech bubble saying so, right of its kind tag (see
  // card-comments.js).
  function withCardComments(card, onCards) {
    const count = onCards.filter((comment) => comment.target.item === card.dataset.item).length;
    if (count) {
      card.classList.add('has-card-comments');
      card.append(cardCommentTag(count));
    }
    return card;
  }

  // What right-clicking a card, or its comment tag, works with.
  const cardCommenting = (here, on, onCards, cards) => ({
    cards,
    commentsOn: (item) => onCards.filter((comment) => comment.target.item === item),
    save: async (item, text) => {
      await api.addComment(here.schemaId, { ...on, target: { item, card: true }, text });
      render();
    },
    remove: async (comment) => {
      await api.deleteComment(here.schemaId, comment.id);
      render();
    },
  });

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
    if (use.missing) return h('div', { className: 'focus-neighbour embedded', 'data-item': use.id, 'data-parts': JSON.stringify(entry.parts) }, pill('Embedded schematic', 'kind-pill schema-pill'), h('strong', {}, use.id), h('span', { className: 'focus-meta' }, 'This schematic is no longer available.'));
    const settings = Object.entries(use.with ?? {});
    return h('button', { className: 'focus-neighbour embedded', type: 'button', 'data-item': use.id, 'data-use': use.id, 'data-parts': JSON.stringify(entry.parts), onclick: () => follow(use.id) },
      pill('Embedded schematic', 'kind-pill schema-pill'),
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
  api.onNewSchema(newSchema);
  // An AI's proposal, in the window it works in.
  api.onShowSchema(({ schemaId, name }) => {
    selected = schemaId;
    go([level(schemaId, { proposal: true, label: name })]);
  });
  render();
}
