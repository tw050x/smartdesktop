import { period, when } from '../main/chat-history.js';
import { customScrollbar } from './scrollbar.js';
import { rubberBand } from './rubber-band.js';

// The chat history (the user's choice: a chat whose tab was closed couldn't be had back). A panel
// sliding in over the right of the chat window, under its top bar, as the apps' status panel does,
// from the history button at the top bar's right end or Window › Chat History (⌘Y). It lists every
// chat anything was said in, and any open, most recently used first, grouped by when (Today,
// Yesterday, Previous 7 Days, Previous 30 Days, then by month), each with its name, when, and the
// last thing said in it; a chat open in this window or another says so, and one whose AI is working
// has the blue dot. The search at its top finds chats by name and by what was said (each word),
// showing where. Clicking a chat opens it: where it's open (its window brought forward), else here,
// in the column with the focus, and the panel closes; its right-click menu also moves it here or
// opens it in a window of its own. Arrow keys move through the list from the search, and Return
// opens the one picked. Escape, the button again, or a click outside closes it.
const REFRESH_MS = 400;

export function createHistoryPanel({ api, button, onOpened = () => {} }) {
  const el = document.createElement('aside');
  el.className = 'history-panel';
  el.setAttribute('aria-label', 'Chat history');
  el.hidden = true;

  const head = div('history-head');
  const heading = Object.assign(document.createElement('h2'), { className: 'history-title', textContent: 'Chat History' });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button history-close';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  close.addEventListener('click', () => setOpen(false));
  head.append(heading, close);

  const searchBox = div('history-search');
  searchBox.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search chats';
  input.setAttribute('aria-label', 'Search chats');
  input.spellcheck = false;
  searchBox.append(input);

  const scrollArea = div('history-scroll');
  const list = div('history-list');
  list.setAttribute('role', 'listbox');
  const scrollbar = div('scrollbar history-scrollbar');
  scrollbar.setAttribute('aria-hidden', 'true');
  scrollbar.append(div('scrollbar-thumb'));
  scrollArea.append(list, scrollbar);
  customScrollbar({ scrollbarEl: scrollbar, scrollers: [list], scroller: () => list, watch: [list] });
  rubberBand(list);

  el.append(head, searchBox, scrollArea);
  document.body.append(el);

  let open = false;
  let chats = [];
  let picked = null; // the chat the arrow keys are on
  let asked = 0; // the last list asked for (an older answer arriving late is dropped)
  let refreshing = null;

  async function refresh() {
    const ask = ++asked;
    let found;
    try {
      found = await api.chatHistory(input.value);
    } catch {
      return;
    }
    if (ask !== asked || !open) return;
    chats = found;
    if (!chats.some((c) => c.id === picked)) picked = input.value.trim() ? chats[0]?.id ?? null : null;
    draw();
  }
  // Something changed (a chat's name, a new message, a chat moved): the list again, shortly.
  function changed() {
    if (!open) return;
    clearTimeout(refreshing);
    refreshing = setTimeout(refresh, REFRESH_MS);
  }

  function draw() {
    const parts = [];
    if (!chats.length) {
      parts.push(div('history-empty', input.value.trim() ? 'No chats match.' : 'No chats yet.'));
    }
    const now = new Date();
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let group = null;
    for (const chat of chats) {
      const g = period(chat.usedAt, now);
      if (g !== group) {
        group = g;
        parts.push(div('history-group', g));
      }
      parts.push(row(chat, now, words));
    }
    list.replaceChildren(...parts);
  }

  function row(chat, now, words) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'history-row';
    node.dataset.chat = chat.id;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', String(chat.id === picked));
    node.tabIndex = -1;
    const top = div('history-row-top');
    if (chat.running) top.append(Object.assign(div('history-working'), { title: 'The AI is working in this chat' }));
    top.append(marked(div('history-row-title'), chat.title, words));
    if (chat.open) top.append(div('history-tag', chat.open === 'here' ? 'Open' : 'In another window'));
    top.append(div('history-when', when(chat.usedAt, now)));
    node.append(top);
    if (chat.preview) node.append(marked(div('history-preview'), chat.preview, words));
    node.addEventListener('click', () => choose(chat.id, 'open'));
    node.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      const how = await api.chatHistoryMenu(chat.id);
      if (how) choose(chat.id, how);
    });
    return node;
  }

  async function choose(chatId, how) {
    setOpen(false);
    try {
      await api.chatHistoryOpen(chatId, how);
    } catch {}
    onOpened(chatId);
  }

  function pick(step) {
    if (!chats.length) return;
    const at = chats.findIndex((c) => c.id === picked);
    const next = at < 0 ? (step > 0 ? 0 : chats.length - 1) : Math.max(0, Math.min(chats.length - 1, at + step));
    picked = chats[next].id;
    for (const node of list.querySelectorAll('.history-row')) node.setAttribute('aria-selected', String(node.dataset.chat === picked));
    list.querySelector(`.history-row[aria-selected="true"]`)?.scrollIntoView({ block: 'nearest' });
  }

  let searching = null;
  input.addEventListener('input', () => {
    clearTimeout(searching);
    searching = setTimeout(refresh, 120);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      pick(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chatId = picked ?? chats[0]?.id;
      if (chatId) choose(chatId, 'open');
    }
  });
  addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (input.value) {
        input.value = '';
        refresh();
      } else setOpen(false);
    }
  }, true);
  // A click anywhere else closes it (not the button, which toggles it, nor a menu it opened).
  addEventListener('pointerdown', (event) => {
    if (open && !el.contains(event.target) && !button.contains(event.target)) setOpen(false);
  }, true);
  button.addEventListener('click', () => setOpen(!open));

  function setOpen(next) {
    if (next === open) {
      if (next) input.focus();
      return;
    }
    open = next;
    button.setAttribute('aria-expanded', String(open));
    clearTimeout(refreshing);
    if (open) {
      el.hidden = false;
      el.getBoundingClientRect(); // so it slides in
      el.classList.add('open');
      input.value = '';
      picked = null;
      list.scrollTop = 0;
      refresh();
      input.focus();
    } else {
      el.classList.remove('open');
      setTimeout(() => !open && (el.hidden = true), 200);
      input.blur();
    }
  }

  api.onHistoryToggle(({ open: wanted } = {}) => setOpen(wanted ?? !open));

  return {
    changed,
    isOpen: () => open,
    focus: () => input.focus(),
  };
}

// `text` in `node`, each of `words` in it marked.
function marked(node, text, words) {
  if (!words.length) {
    node.textContent = text;
    return node;
  }
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    let next = -1;
    let length = 0;
    for (const word of words) {
      const found = lower.indexOf(word, at);
      if (found >= 0 && (next < 0 || found < next || (found === next && word.length > length))) {
        next = found;
        length = word.length;
      }
    }
    if (next < 0) break;
    node.append(text.slice(at, next), Object.assign(document.createElement('mark'), { textContent: text.slice(next, next + length) }));
    at = next + length;
  }
  node.append(text.slice(at));
  return node;
}

function div(className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
