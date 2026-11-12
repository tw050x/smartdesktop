import { createChatPanel } from './chat-panel.js';
import { trackAiProgress } from './ai-progress.js';
import { installTooltips } from './tooltips.js';
import { createUpdateToast } from './update-toast.js';

// The chat window (see main.js): under its top bar (the traffic lights), chats in tabs, in a row of
// columns side by side, each with its own row of tabs and the chat it shows below (the user's
// choice, after openp41ge code's tab grid). The layout lives in the main process (chat-layout.js),
// which sends it with the chats in it (`onChatState`); this draws it, and asks it to change:
//   - a tab clicked shows its chat; `+` starts a new chat in its column; its × (or ⌘W) closes it,
//     keeping the chat; right-click: Rename… (in the tab) or Close;
//   - a tab dragged along its row reorders it, onto another column's row or the middle of its chat
//     moves it there, onto a column's left or right edge (its outer 15%) splits it off into a new
//     column on that side; the drop shows in blue as it's dragged over;
//   - the line between two columns resizes them (each at least MIN_COLUMN wide); double-clicking it
//     evens them.
// The chat with the focus (the one last used) has a blue line under its tab, as the apps' tabs do.
const api = window.smartdesktop;
document.body.classList.add(`platform-${api.platform}`);
installTooltips();
trackAiProgress(api);
createUpdateToast({ api, name: 'SmartDesktop' });

const MIN_COLUMN = 280;
const EDGE = 0.15; // the share of a column's width at either edge that splits it
const DRAG_START = 4; // px the pointer moves before a press on a tab is a drag

const gridEl = document.getElementById('chat-grid');
const panels = new Map(); // chat id → its panel, kept while its tab is open (its scroll and draft too)
let state = { layout: { columns: [], widths: [] }, focused: null, chats: {}, connected: [] };
let renaming = null; // the chat whose tab is being renamed
let dragging = null; // a tab being dragged (see below)

function panelFor(chatId) {
  if (!panels.has(chatId)) {
    const el = document.createElement('section');
    el.className = 'chat-panel';
    panels.set(chatId, createChatPanel({ el, api, chatId }));
  }
  return panels.get(chatId);
}

// --- Drawing -----------------------------------------------------------------------------------

function render() {
  const { columns, widths } = state.layout;
  // Chats whose tabs have closed let their panels go.
  const open = new Set(columns.flatMap((c) => c.chats));
  for (const chatId of [...panels.keys()]) if (!open.has(chatId)) panels.delete(chatId);
  if (!columns.length) {
    gridEl.replaceChildren(emptyState());
    return;
  }
  const parts = [];
  columns.forEach((column, index) => {
    if (index) parts.push(divider(index));
    parts.push(columnEl(column, index, widths[index]));
  });
  gridEl.replaceChildren(...parts);
  for (const [chatId, panel] of panels) panel.setState({ ...(state.chats[chatId] ?? {}), connected: state.connected });
}

function emptyState() {
  const box = div('chat-empty-window');
  box.append(div('chat-empty-window-text', 'No chats open'));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary-button';
  button.textContent = 'New Chat';
  button.addEventListener('click', () => api.chatNew(0));
  box.append(button);
  return box;
}

function columnEl(column, index, width) {
  const el = div('chat-column');
  el.dataset.column = String(index);
  el.style.flexBasis = `${(width * 100).toFixed(3)}%`;
  const row = div('chat-tab-row');
  row.dataset.column = String(index);
  for (const chatId of column.chats) row.append(tabEl(chatId, column, index));
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'chat-tab-new';
  plus.title = 'New chat';
  plus.setAttribute('aria-label', 'New chat');
  plus.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  plus.addEventListener('click', () => api.chatNew(index));
  row.append(plus);
  const body = div('chat-column-body');
  body.dataset.column = String(index);
  const panel = panelFor(column.active);
  body.append(panel.el);
  // Using a chat gives it the focus.
  body.addEventListener('pointerdown', () => state.focused !== column.active && api.chatFocus(column.active));
  el.append(row, body);
  return el;
}

function tabEl(chatId, column, index) {
  const tab = div('chat-tab');
  tab.dataset.chat = chatId;
  tab.dataset.column = String(index);
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', String(column.active === chatId));
  tab.classList.toggle('focused', state.focused === chatId);
  const title = state.chats[chatId]?.title ?? 'New chat';
  if (renaming === chatId) {
    const input = document.createElement('input');
    input.className = 'chat-tab-rename';
    input.value = title;
    const done = (save) => {
      if (renaming !== chatId) return;
      renaming = null;
      if (save && input.value.trim() && input.value.trim() !== title) api.chatRename(chatId, input.value.trim());
      render();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') done(true);
      if (event.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    tab.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return tab;
  }
  tab.append(Object.assign(div('chat-tab-title'), { textContent: title }));
  tab.title = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'chat-tab-close';
  close.setAttribute('aria-label', `Close ${title}`);
  close.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    api.chatCloseTab(chatId);
  });
  tab.append(close);
  tab.addEventListener('pointerdown', (event) => startDrag(event, tab, chatId, index));
  tab.addEventListener('contextmenu', async (event) => {
    event.preventDefault();
    const chosen = await api.chatTabMenu(chatId);
    if (chosen === 'close') api.chatCloseTab(chatId);
    if (chosen === 'rename') {
      renaming = chatId;
      render();
    }
  });
  return tab;
}

// --- Dividers --------------------------------------------------------------------------------
// Between two columns: dragged, it moves the edge between them (each kept at least MIN_COLUMN);
// double-clicked, every column gets the same width.
function divider(index) {
  const el = div('chat-divider');
  el.addEventListener('dblclick', () => api.chatEven());
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    el.classList.add('dragging');
    const columns = [...gridEl.querySelectorAll('.chat-column')];
    const total = gridEl.clientWidth;
    const start = columns.map((c) => c.getBoundingClientRect().width);
    const startX = event.clientX;
    let widths = [...start];
    const move = (m) => {
      const pair = start[index - 1] + start[index];
      const left = Math.max(MIN_COLUMN, Math.min(pair - MIN_COLUMN, start[index - 1] + (m.clientX - startX)));
      widths = [...start];
      widths[index - 1] = left;
      widths[index] = pair - left;
      columns.forEach((c, i) => (c.style.flexBasis = `${((widths[i] / total) * 100).toFixed(3)}%`));
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('lostpointercapture', end);
      el.classList.remove('dragging');
      api.chatWidths(widths.map((w) => w / total));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('lostpointercapture', end);
  });
  return el;
}

// --- Dragging a tab ----------------------------------------------------------------------------
// A press that moves more than DRAG_START is a drag: the tab follows the pointer (a ghost), and
// what's under it says where it would land (dropTarget), shown in blue (an insertion line on a row;
// a wash with a ring over the column, or the half of it a split would take). A press that doesn't
// move is a click, showing the chat.
function startDrag(event, tab, chatId, column) {
  if (event.button !== 0 || event.target.closest('.chat-tab-close')) return;
  const startX = event.clientX;
  const startY = event.clientY;
  try {
    tab.setPointerCapture(event.pointerId);
  } catch {}
  const move = (m) => {
    if (!dragging) {
      if (Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_START) return;
      dragging = { chatId, from: column, ghost: ghostOf(tab), target: null };
      tab.classList.add('dragged');
    }
    dragging.ghost.style.transform = `translate(${m.clientX - 20}px, ${m.clientY - 14}px)`;
    showTarget((dragging.target = dropTarget(m.clientX, m.clientY)));
  };
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    tab.removeEventListener('lostpointercapture', end);
    if (!dragging) {
      api.chatShow(chatId);
      return;
    }
    const { target } = dragging;
    dragging.ghost.remove();
    tab.classList.remove('dragged');
    showTarget(null);
    dragging = null;
    drop(chatId, target);
  };
  // The pointer is followed wherever it goes, and the drag ends however it's let go.
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  tab.addEventListener('lostpointercapture', end);
}

function ghostOf(tab) {
  const ghost = tab.cloneNode(true);
  ghost.classList.add('chat-tab-ghost');
  ghost.style.width = `${tab.getBoundingClientRect().width}px`;
  document.body.append(ghost);
  return ghost;
}

// Where a tab dropped at (x, y) lands: { kind: 'row', column, index } on a row of tabs (before the
// tab whose middle is past the pointer); { kind: 'split', column, side } at a column's edge;
// { kind: 'move', column } in the rest of a column; or null.
function dropTarget(x, y) {
  const under = document.elementFromPoint(x, y);
  const row = under?.closest('.chat-tab-row');
  if (row) {
    const column = Number(row.dataset.column);
    const tabs = [...row.querySelectorAll('.chat-tab:not(.dragged)')];
    let index = tabs.findIndex((t) => {
      const r = t.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    if (index < 0) index = tabs.length;
    return { kind: 'row', column, index, tabs };
  }
  const body = under?.closest('.chat-column-body');
  if (!body) return null;
  const column = Number(body.dataset.column);
  const r = body.getBoundingClientRect();
  const at = (x - r.left) / r.width;
  if (at < EDGE) return { kind: 'split', column, side: 'left' };
  if (at > 1 - EDGE) return { kind: 'split', column, side: 'right' };
  return { kind: 'move', column };
}

// The drop, done by the main process (chat-layout.js).
function drop(chatId, target) {
  if (!target) return;
  if (target.kind === 'split') return api.chatSplit(chatId, target.column, target.side);
  if (target.kind === 'move') return api.chatMove(chatId, target.column, null);
  // On a row: its index among the tabs as they'd be without the one dragged.
  return api.chatMove(chatId, target.column, target.index);
}

const overlay = Object.assign(div('chat-drop-overlay'), { hidden: true });
const insertLine = Object.assign(div('chat-drop-line'), { hidden: true });
document.body.append(overlay, insertLine);
function showTarget(target) {
  overlay.hidden = true;
  insertLine.hidden = true;
  if (!target) return;
  if (target.kind === 'row') {
    const row = gridEl.querySelector(`.chat-tab-row[data-column="${target.column}"]`);
    const rowBox = row.getBoundingClientRect();
    const before = target.tabs[target.index];
    const after = target.tabs[target.index - 1];
    const x = before ? before.getBoundingClientRect().left - 3 : after ? after.getBoundingClientRect().right + 3 : rowBox.left + 8;
    Object.assign(insertLine.style, { left: `${x - 1.5}px`, top: `${rowBox.top + 7}px`, height: `${rowBox.height - 14}px` });
    insertLine.hidden = false;
    return;
  }
  const body = gridEl.querySelector(`.chat-column-body[data-column="${target.column}"]`);
  const r = body.getBoundingClientRect();
  const half = target.kind === 'split' ? r.width / 2 : r.width;
  const left = target.kind === 'split' && target.side === 'right' ? r.left + r.width / 2 : r.left;
  Object.assign(overlay.style, { left: `${left}px`, top: `${r.top}px`, width: `${half}px`, height: `${r.height}px` });
  overlay.hidden = false;
}

// --- Keys --------------------------------------------------------------------------------------
// The focused chat's message box takes the typing (the user's choice): it has the focus whenever
// the window comes forward or its tab is clicked, and anything typed with the focus elsewhere in the
// window (not in a box of its own, such as a tab being renamed) goes to it.
const typingBox = (node) => node instanceof Element && node.closest('textarea, input, [contenteditable="true"]');
const focusTyping = () => state.focused && panels.get(state.focused)?.focus();
addEventListener('keydown', (event) => {
  // (Printable keys, and Backspace and Delete to take text out of it.)
  if (event.metaKey || event.ctrlKey || event.altKey || typingBox(event.target)) return;
  if (event.key.length !== 1 && event.key !== 'Backspace' && event.key !== 'Delete') return;
  focusTyping(); // the key then lands in the box
}, true);
addEventListener('focus', () => {
  if (!typingBox(document.activeElement)) focusTyping();
});
addEventListener('click', (event) => {
  if (event.target.closest?.('.chat-tab') && !typingBox(event.target) && !event.target.closest('.chat-tab-close')) setTimeout(focusTyping);
});

// ⌘T a new chat in the column with the focus; ⌘W closes the focused chat's tab.
addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  const key = event.key.toLowerCase();
  const column = Math.max(0, state.layout.columns.findIndex((c) => c.chats.includes(state.focused)));
  if (key === 't') {
    event.preventDefault();
    api.chatNew(column);
  } else if (key === 'w' && state.focused) {
    event.preventDefault();
    api.chatCloseTab(state.focused);
  }
});

// --- The main process's side ------------------------------------------------------------------
function setState(next) {
  const focusedBefore = state.focused;
  state = next;
  if (!dragging) render();
  // A chat newly given the focus (a new one, say) takes the typing.
  if (state.focused && state.focused !== focusedBefore) panels.get(state.focused)?.focus();
}
api.onChatState(setState);
api.onAgentEvent((event) => panels.get(event.chatId)?.agentEvent(event));
// A request for a chat's AI from an app (a shortcut there): that chat sends it.
api.onChatAsk(({ chatId, text }) => {
  const send = () => panelFor(chatId).ask(text);
  if (panels.has(chatId)) send();
  else setTimeout(send);
});
api.chatReady().then(setState);

function div(className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
