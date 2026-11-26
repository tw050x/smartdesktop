import { iconSvg } from '../main/icons.js';
import { renderMarkdown } from './markdown.js';
import { rubberBand } from './rubber-band.js';

// The tab's content: home (the user's boards, in one column), or one board: its lists side by
// side, each a column of cards, as Trello's are. The main process owns the boards; this asks for
// what it shows, again whenever they change. The AI writes the cards; the user opens them to read
// (which marks them read: what the AI adds or changes shows as New or Updated until then) and
// drags them between lists as the work moves on. The user never edits a card's words: they ask
// their AI in the chat.

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (key === 'className') element.className = value;
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}
const svg = (markup, className = 'kanban-icon') => {
  const span = h('span', { className, 'aria-hidden': 'true' });
  span.innerHTML = markup;
  return span;
};
const pill = (text, kind = '') => h('span', { className: `pill ${kind}` }, text);
// Status pills come from the app, for what needs the user's attention: here, what's unread.
const statusPills = (...pills) => (pills.some(Boolean) ? h('span', { className: 'status-pills' }, ...pills) : null);
const UNREAD = { new: 'New', updated: 'Updated' };
const unreadPill = (unread) => (unread ? pill(UNREAD[unread] ?? 'New', `item-change ${unread === 'updated' ? 'changed' : 'added'}`) : null);
const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

const ICON_TEXT = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// A due date as it reads (today and tomorrow by name), and whether it's passed or near.
function dueOf(due) {
  if (!due) return null;
  const [y, m, d] = due.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((day - today) / 86_400_000);
  const text = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(y !== today.getFullYear() && { year: 'numeric' }) });
  return { text, state: days < 0 ? 'overdue' : days <= 1 ? 'soon' : '' };
}

// `onShown({ chatId, name, line, opened })` hears where the tab is, for the chat (see app-shell.js),
// with the chat's line of context for going there: home ('home', name null), or a board (its id),
// with the card open, if one is. `onCards(cards, shortcuts)` hears what there is to decide about
// what it shows (none yet) and what to ask the AI about it, as the chat's shortcuts; `onNote(note)`
// gives the chat a line of context for the AI, about what the user did; and
// `onChooseIcon(request)` opens the icon picker for a board.
export function createBoards({ el, bottomBar, goal: goalEl, api, onShown = () => {}, onCards = () => {}, onNote = () => {}, onChooseIcon = () => {} }) {
  // What the tab shows: null for home, else { boardId, name, card (the card open, or null) }.
  let here = null;
  let rendering = 0;
  let naming = null; // the board being renamed on home
  let homeShowing = false; // home's column rises in only as it arrives, not each time it's drawn again
  let dragging = null; // { cardId, title, fromList } while the user drags a card

  // Which tab this is (see main.js): Home, the only one showing home, which opens a board in a tab
  // of its own; or a board's, which never shows home (going home shows the Home tab).
  const inHome = api.tabKind === 'home';
  const inTab = api.tabKind === 'document';
  let hadBoard = false; // a board's tab has shown its board (and closes once it's gone)

  // Back and forward: where this tab has been, as a browser keeps it: each stop is the board and
  // the card open on it (dragging isn't a step). The buttons are in the window's top bar
  // (tab-strip.js), which asks this tab to go back or forward and is told when it can.
  const HISTORY_LIMIT = 200;
  const stop = () => JSON.stringify(here && { boardId: here.boardId, name: here.name, card: here.card ?? null });
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
    const now = stop();
    if (visited[visiting] === now) return;
    visited = [...visited.slice(0, visiting + 1), now].slice(-HISTORY_LIMIT);
    visiting = visited.length - 1;
    showHistory();
  }
  function travel(delta) {
    const next = visiting + delta;
    if (next < 0 || next >= visited.length) return;
    visiting = next;
    here = JSON.parse(visited[next]);
    showHistory();
    render();
  }
  api.onHistoryStep?.((delta) => travel(delta));
  showHistory();
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (event.key === '[') travel(-1);
    else if (event.key === ']') travel(1);
  });

  // Shows a board: from Home, in a tab of its own (the one already showing it, unless `newTab`); in
  // a board's tab, here. `card` is opened.
  function open(next, { newTab = false } = {}) {
    if (inHome) {
      api.openInTab({ ...next, newTab });
      return;
    }
    here = { boardId: next.boardId, name: next.name ?? '', card: next.card ?? null };
    remember();
    render();
  }

  async function render() {
    const ticket = ++rendering;
    const view = here ? await boardView(here) : inTab ? h('div', { className: 'tab-waiting-view' }) : await homeView();
    if (ticket !== rendering) return;
    // Each list keeps where it was scrolled, and the board where it was scrolled across.
    const across = el.querySelector('.kanban')?.scrollLeft ?? 0;
    const downs = new Map([...el.querySelectorAll('.kanban-cards')].map((list) => [list.dataset.list, list.scrollTop]));
    const listTop = el.querySelector('.browser-list')?.scrollTop ?? 0;
    const showingBoard = Boolean(here && view.board);
    document.body.classList.toggle('has-board', showingBoard);
    if (!showingBoard) {
      if (!homeShowing && !inTab) view.classList.add('arriving');
      homeShowing = !inTab;
    } else homeShowing = false;
    el.replaceChildren(view);
    const kanban = el.querySelector('.kanban');
    if (kanban) {
      kanban.scrollLeft = across;
      for (const list of el.querySelectorAll('.kanban-cards')) list.scrollTop = downs.get(list.dataset.list) ?? 0;
    }
    const list = el.querySelector('.browser-list');
    if (list) {
      list.scrollTop = listTop;
      rubberBand(list);
    }
    goalEl.textContent = view.board?.description ?? '';
    goalEl.title = view.board?.description ?? '';
    showBar(view.said ?? null);
    onCards([], view.shortcuts ?? []);
    showCard(view.board ?? null);
  }

  // --- Home ---------------------------------------------------------------------------------

  // Home: the user's boards, one column, most recently changed first. Each row is the board's icon
  // and name, what it's for, its lists and how many cards. Clicking one opens it in its tab; its
  // right-click menu opens it in a new tab, renames it, changes its icon or deletes it.
  async function homeView() {
    onShown({ chatId: 'home', name: null, line: { text: 'Went home', detail: 'The window shows SmartPlan\'s home.' } });
    const boards = await api.listBoards();
    if (naming && !boards.some((board) => board.id === naming)) naming = null;
    const rows = boards.map((board) => (naming === board.id ? namingRow(board) : boardRow(board)));
    const view = h('div', { className: 'browser home-boards' }, column('Boards', rows));
    return view;
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function boardRow(board) {
    const mark = h('span', { className: 'home-doc-icon', 'aria-hidden': 'true' });
    mark.innerHTML = iconSvg(board.icon, 15);
    const lists = board.lists.map((list) => `${list.name} ${list.cards}`).join(' · ');
    const button = h('button', { className: 'browser-row', type: 'button', 'data-board': board.id, title: board.name, onclick: () => open({ boardId: board.id, name: board.name }) },
      h('span', { className: 'title-row' }, h('strong', {}, mark, board.name), statusPills(board.unread > 0 && pill(`${board.unread} unread`, 'proposed'))),
      board.description && h('span', { className: 'browser-row-text' }, board.description),
      h('span', { className: 'browser-row-meta' }, `${lists || 'No lists yet'} · ${when(board.updatedAt)}`));
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      const box = button.getBoundingClientRect();
      const chosen = await api.showHomeMenu([
        { id: 'open', label: 'Open in New Tab' },
        { separator: true },
        { id: 'rename', label: 'Rename…' },
        { id: 'icon', label: 'Change Icon…' },
        { separator: true },
        { id: 'delete', label: 'Delete Board…' },
      ]);
      if (chosen === 'open') open({ boardId: board.id, name: board.name }, { newTab: true });
      else if (chosen === 'rename') {
        naming = board.id;
        render();
      } else if (chosen === 'icon') onChooseIcon({ docId: board.id, current: board.icon, name: board.name, at: { left: box.left + 24, top: box.bottom + 4 } });
      else if (chosen === 'delete' && await api.deleteBoard(board.id)) render();
    });
    return button;
  }

  // A board's name being written over its row. Enter or leaving it saves, Escape doesn't, and a name
  // that's refused says why, keeping what was typed.
  function namingRow(board) {
    const field = h('input', { className: 'name-input', type: 'text', value: board.name, 'aria-label': 'Board name', maxlength: '200' });
    const said = h('span', { className: 'name-error', role: 'alert' });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      const named = field.value.trim();
      done = true;
      if (!save || !named || named === board.name) {
        naming = null;
        return render();
      }
      try {
        await api.renameBoard(board.id, named);
        onNote({ text: `Renamed “${board.name}” to “${named}”`, detail: `Renamed the board “${board.name}” (board_id ${board.id}) to “${named}”` });
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
    return h('div', { className: 'naming' }, field, said);
  }

  // A column of rows. With none, it shows placeholder rows instead, fading out, with no text and no
  // buttons, as the family's homes do.
  const SKELETON = [[44, 82, 30], [58, 70, 26], [36, 88, 32]];
  function column(title, rows) {
    const placeholder = (widths) => h('div', { className: 'browser-row' }, ...widths.map((width) => h('span', { className: 'skeleton-bar', style: `width: ${width}%` })));
    return h('section', { className: `browser-column${rows.length ? '' : ' browser-column-unused'}`, 'aria-label': title },
      h('div', { className: 'browser-head' }, h('h2', {}, title)),
      rows.length
        ? h('ul', { className: 'browser-list' }, ...rows.map((one) => h('li', {}, one)))
        : h('div', { className: 'browser-list browser-skeleton', 'aria-hidden': 'true' }, ...SKELETON.map(placeholder)));
  }

  // A new board: what it's for, and a prompt asking the AI to start it, from the File menu.
  function newBoard() {
    if (document.querySelector('.prompt-dialog')) return;
    const field = h('textarea', { className: 'prompt-input', rows: 3, 'aria-label': 'What it’s for', placeholder: 'What are you planning? For example: relaunching our website by March, or moving house' });
    const copy = h('button', { className: 'primary-button', type: 'button' }, 'Copy the prompt');
    let reset;
    copy.addEventListener('click', async () => {
      await api.copyText([
        field.value.trim() ? `Start a new board in SmartPlan: ${field.value.trim()}. Ask me what you need to know first.` : 'Ask me what I’m planning, then start a new board in SmartPlan.',
        api.windowId && `Take over SmartPlan window ${api.windowId} with use_window first.`,
      ].filter(Boolean).join(' '));
      copy.textContent = 'Copied';
      clearTimeout(reset);
      reset = setTimeout(() => { copy.textContent = 'Copy the prompt'; }, 1500);
    });
    const dialog = h('dialog', { className: 'prompt-dialog', 'aria-labelledby': 'prompt-title' },
      h('h2', { id: 'prompt-title' }, 'New board'),
      h('p', {}, 'Your AI asks what it’s for, then sets up its lists and first cards for you.'),
      field,
      h('div', { className: 'prompt-buttons' },
        h('button', { className: 'secondary-button', type: 'button', onclick: () => dialog.close() }, 'Close'),
        copy));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    field.focus();
  }

  // --- One board ----------------------------------------------------------------------------

  async function boardView(at) {
    const board = await api.getBoard(at.boardId).catch(() => null);
    if (!board) {
      // It's gone (deleted): a board's tab with nothing left in it closes.
      if (inTab && hadBoard) api.tabClose();
      here = null;
      return inTab ? h('div', { className: 'tab-waiting-view' }) : homeView();
    }
    hadBoard = true;
    at.name = board.name;
    const cards = board.lists.flatMap((list) => list.cards);
    if (at.card && !cards.some((card) => card.id === at.card)) at.card = null;
    const view = h('div', { className: 'kanban' }, ...board.lists.map((list) => listView(at, list)));
    if (!board.lists.length) view.append(h('p', { className: 'kanban-empty' }, 'No lists yet. Ask your AI in the chat to set the board up.'));
    view.board = board;
    const unread = cards.filter((card) => card.unread).length;
    const news = unread ? ` ${unread === 1 ? 'One card is' : `${unread} cards are`} new or updated.` : '';
    view.said = cards.length
      ? `${many(cards.length, 'card')} across ${many(board.lists.length, 'list')}. Drag a card to move it; ask your AI in the chat to add or change cards.${news}`
      : `${board.name} has no cards yet. Ask your AI in the chat to add the first ones.`;
    const opened = `Opened “${board.name}”`;
    onShown({ chatId: at.boardId, name: board.name, opened: at.card, line: { text: opened, detail: `${opened} (board_id ${at.boardId})` } });
    return view;
  }

  function listView(at, list) {
    const cards = h('div', { className: 'kanban-cards', 'data-list': list.id }, ...list.cards.map((card) => cardView(at, list, card)));
    watchDrop(at, list, cards);
    return h('section', { className: 'kanban-list', 'aria-label': list.name },
      h('header', { className: 'kanban-list-head' }, h('h2', {}, list.name), h('span', { className: 'kanban-count' }, String(list.cards.length))),
      cards);
  }

  function cardView(at, list, card) {
    const due = dueOf(card.due);
    const done = card.checklist?.filter((item) => item.done).length ?? 0;
    const badges = [
      due && h('span', { className: `kanban-badge ${due.state}`, title: `Due ${card.due}` }, svg(ICON_CLOCK), due.text),
      card.description && h('span', { className: 'kanban-badge', title: 'It has a description' }, svg(ICON_TEXT)),
      card.checklist?.length > 0 && h('span', { className: `kanban-badge${done === card.checklist.length ? ' complete' : ''}`, title: 'Checklist' }, svg(ICON_CHECK), `${done}/${card.checklist.length}`),
    ].filter(Boolean);
    const button = h('button', { className: 'kanban-card', type: 'button', draggable: 'true', 'data-card': card.id, ...(card.unread && { 'data-unread': card.unread }), onclick: () => openCard(card.id) },
      card.labels?.length > 0 && h('span', { className: 'kanban-labels' }, ...card.labels.map((label) => h('span', { className: `kanban-label ${label.color}`, title: label.name }, label.name))),
      h('span', { className: 'kanban-title' }, card.title),
      (badges.length > 0 || card.unread) && h('span', { className: 'kanban-badges' }, unreadPill(card.unread), ...badges));
    button.addEventListener('dragstart', (event) => {
      dragging = { cardId: card.id, title: card.title, fromList: list.id };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.title);
      requestAnimationFrame(() => button.classList.add('dragged'));
    });
    button.addEventListener('dragend', () => {
      button.classList.remove('dragged');
      dragging = null;
      for (const marker of el.querySelectorAll('.kanban-drop')) marker.remove();
    });
    return button;
  }

  // Where a card dragged over a list would go: before the first card whose middle is below the
  // pointer, counted among the cards that stay (the one dragged left out), with a line showing it.
  function dropIndex(cardsEl, y) {
    const others = [...cardsEl.querySelectorAll('.kanban-card')].filter((one) => one.dataset.card !== dragging?.cardId);
    const index = others.findIndex((one) => {
      const box = one.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    return { index: index < 0 ? others.length : index, before: index < 0 ? null : others[index] };
  }
  function watchDrop(at, list, cardsEl) {
    cardsEl.addEventListener('dragover', (event) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const { before } = dropIndex(cardsEl, event.clientY);
      let marker = el.querySelector('.kanban-drop');
      if (!marker) marker = h('div', { className: 'kanban-drop', 'aria-hidden': 'true' });
      if (marker.parentElement !== cardsEl || marker.nextElementSibling !== before) cardsEl.insertBefore(marker, before);
    });
    cardsEl.addEventListener('dragleave', (event) => {
      if (!cardsEl.contains(event.relatedTarget)) cardsEl.querySelector('.kanban-drop')?.remove();
    });
    cardsEl.addEventListener('drop', async (event) => {
      if (!dragging) return;
      event.preventDefault();
      const moved = dragging;
      const { index } = dropIndex(cardsEl, event.clientY);
      dragging = null;
      cardsEl.querySelector('.kanban-drop')?.remove();
      await api.moveCard(at.boardId, moved.cardId, list.id, index).catch(() => {});
      if (moved.fromList !== list.id) onNote({ text: `Moved “${moved.title}” to ${list.name}`, detail: `Moved the card “${moved.title}” (${moved.cardId}) to the list “${list.name}” (${list.id}) on the board “${at.name}” (board_id ${at.boardId})` });
    });
  }

  // --- A card, open ---------------------------------------------------------------------------

  function openCard(cardId) {
    if (!here) return;
    here.card = cardId;
    remember();
    render();
  }
  function closeCard() {
    if (!here?.card) return;
    here.card = null;
    remember();
    render();
  }

  // The card open, in a dialog over the board: its labels, title, list, due date, description and
  // checklist, all to read. Opening it marks it read.
  let cardDialog = null;
  function showCard(board) {
    const found = board && here?.card && board.lists.map((list) => ({ list, card: list.cards.find((one) => one.id === here.card) })).find((one) => one.card);
    if (!found) {
      if (cardDialog?.open) {
        cardDialog.dataset.closing = '1';
        cardDialog.close();
      }
      cardDialog?.remove();
      cardDialog = null;
      return;
    }
    const { list, card } = found;
    if (card.unread) api.markRead(here.boardId, card.id).catch(() => {});
    const due = dueOf(card.due);
    const description = h('div', { className: 'card-description' });
    if (card.description) renderMarkdown(description, card.description);
    else description.append(h('p', { className: 'muted' }, 'No description.'));
    const done = card.checklist?.filter((item) => item.done).length ?? 0;
    const body = h('div', { className: 'card-dialog-body' },
      h('div', { className: 'card-dialog-head' },
        h('div', { className: 'card-dialog-title' },
          card.labels?.length > 0 && h('span', { className: 'kanban-labels' }, ...card.labels.map((label) => h('span', { className: `kanban-label ${label.color}` }, label.name))),
          h('h2', { id: 'card-dialog-title' }, card.title),
          h('p', { className: 'muted' }, `In ${list.name}`, due && ` · Due ${due.text}`))),
      h('section', {}, h('h3', {}, 'Description'), description),
      card.checklist?.length > 0 && h('section', {},
        h('h3', {}, `Checklist · ${done}/${card.checklist.length}`),
        h('ul', { className: 'card-checklist' }, ...card.checklist.map((item) => h('li', { className: item.done ? 'done' : '' }, h('input', { type: 'checkbox', disabled: true, ...(item.done && { checked: true }) }), h('span', {}, item.text))))));
    if (!cardDialog) {
      cardDialog = h('dialog', { className: 'card-dialog', 'aria-labelledby': 'card-dialog-title' });
      cardDialog.addEventListener('close', () => {
        if (!cardDialog?.dataset.closing) closeCard();
      });
      cardDialog.addEventListener('click', (event) => {
        if (event.target === cardDialog) closeCard();
      });
      document.body.append(cardDialog);
    }
    // The close button is the dialog's, outside what scrolls, so it stays in the top right corner.
    const close = h('button', { className: 'icon-button card-dialog-close', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: closeCard }, svg(ICON_CLOSE, 'icon'));
    cardDialog.replaceChildren(close, body);
    if (!cardDialog.open) cardDialog.showModal();
  }

  // --- The bottom bar -------------------------------------------------------------------------

  // The bottom bar is the actions bar: with nothing to decide (as yet), a sentence on what's going on.
  function showBar(said) {
    bottomBar.hidden = !said;
    bottomBar.replaceChildren(...(said ? [h('p', { className: 'review-bar-text', title: said }, said)] : []));
  }

  api.onBoardsChanged(() => render());
  api.onNewBoard(newBoard);
  // A board opened from Home, or an AI's cards, in this tab (see main.js's openInTab).
  api.onOpenBoard?.((request) => {
    if (!request?.boardId) return;
    if (inHome) return open(request);
    here = { boardId: request.boardId, name: request.name ?? '', card: request.card ?? null };
    remember();
    render();
  });
  // A card the AI shows the user (show_card), opened.
  api.onShowCard?.(({ boardId, card } = {}) => {
    if (here?.boardId === boardId && card) openCard(card);
  });
  render();
}
