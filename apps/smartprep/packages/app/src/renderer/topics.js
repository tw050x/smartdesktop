import { iconSvg } from '../main/icons.js';
import { isInternalLink, linksOf, parseLink } from '../main/cards.js';
import { bringToMiddle, cleanLayout, defaultLayout, emptyLayout, isCard, layoutToSave, placeNew } from './board.js';
import { focusWidth, watchBoard } from './board-view.js';
import { watchPage } from './page-view.js';
import { commentCard, keyOf, onOpenCard, targetAt, watchComments } from './comments.js';
import { closeThread, openThread, refreshThread } from './comment-overlay.js';
import { shadeScrolling } from './scroll-shade.js';
import { watchLongPress } from './long-press.js';
import { plainText, renderMarkdown } from './markdown.js';
import { rubberBand } from './rubber-band.js';

// The tab's content: home (the user's topics, in one column), or one topic's board of cards, as
// SmartSpec's Focus board is (board.js and board-view.js, the same as SmartSpec's): every card has
// a place the user drags it to, open at full size in the middle, smaller out to the sides, and at
// the edges a compact card. Each card is one question and its answer, written as a page
// (page-view.js). The main process owns the topics; this asks for what it shows, again whenever they
// change. The AI writes the cards straight onto the board (the user's choice: no proposals), and
// what it adds or changes is marked New or Updated until the user has read it. The user never edits
// a card: a long press on words picked in one asks about them, and the AI answers with a new card,
// the words becoming a link to it (comments.js, comment-overlay.js, long-press.js).

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
const pill = (text, kind = '') => h('span', { className: `pill ${kind}` }, text);
// Status pills come from the app, for what needs the user's attention: here, questions waiting for
// the AI. They sit on the title row if they all fit, else beneath it.
const statusPills = (...pills) => (pills.some(Boolean) ? h('span', { className: 'status-pills' }, ...pills) : null);
// What the AI has added or changed that the user hasn't read yet: on the card's face and its title bar.
const UNREAD = { new: 'New', updated: 'Updated' };
const unreadPill = (unread) => (unread ? pill(UNREAD[unread] ?? 'New', `item-change ${unread === 'updated' ? 'changed' : 'added'}`) : null);
const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
const smoothly = () => typeof document.startViewTransition === 'function' && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

// A card's face: a card with a question mark, every card answering one question.
const CARD_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/></svg>';
const FULL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/></svg>';
const LEAVE_FULL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59z"/></svg>';
const kindIcon = () => {
  const icon = h('span', { className: 'kind-icon', 'aria-hidden': 'true' });
  icon.innerHTML = CARD_ICON;
  return icon;
};

// How long a card has to be open, not a card at the edge, in the tab showing, to count as read.
const READ_AFTER_MS = 1000;
const READ_TICK_MS = 250;
// A question on the whole topic has a place on the board like a card's, under this and its id.
const WHOLE = 'comment:';

// `onShown({ chatId, name, line, middle })` hears where the tab is, for the chat (see app-shell.js),
// with the chat's line of context for going there: home ('home', name null), or a topic (its id),
// with the cards open in the middle. `onCards(cards, shortcuts)` hears what there is to decide about
// what it shows (drawn in the bottom bar: see showBar) and what to ask the AI about it, as the
// chat's shortcuts; `onAsk(text)` sends the chat's AI a request; `onNote(note)` gives the chat a
// line of context for the AI, about what the user did; and `onChooseIcon(request)` opens the icon
// picker for a topic.
export function createTopics({ el, bottomBar, goal: goalEl, api, onShown = () => {}, onCards = () => {}, onAsk = () => {}, onNote = () => {}, onChooseIcon = () => {} }) {
  // What the tab shows: null for home, else { topicId, name, item (the card last brought to the
  // middle), full (that card full screen), bring (bring it to the middle when next drawn), focus (a
  // heading in it to bring into view) }.
  let here = null;
  let rendering = 0;
  let naming = null; // the topic being renamed on home
  let homeShowing = false; // home's column rises in only as it arrives, not each time it's drawn again
  let moving = false; // the next drawing animates, as the browser can, to what it shows next
  let desktopStatus = 'off'; // where SmartDesktop stands: 'missing' means a request is copied instead

  // Which tab this is (see main.js): Home, the only one showing home, which opens a topic in a tab
  // of its own; or a topic's, which never shows home (going home shows the Home tab).
  const inHome = api.tabKind === 'home';
  const inTab = api.tabKind === 'document';
  let hadTopic = false; // a topic's tab has shown its topic (and closes once it's gone)

  // Back and forward: where this tab has been, as a browser keeps it: each stop is the card brought
  // to the middle and whether it was full screen (dragging isn't a step). Choosing somewhere new drops
  // what was ahead. The buttons are in the window's top bar (tab-strip.js), which asks this tab to go
  // back or forward (`onHistoryStep`) and is told when it can (`historyState`).
  const HISTORY_LIMIT = 200;
  const stop = () => JSON.stringify(here && { topicId: here.topicId, name: here.name, item: here.item ?? null, full: Boolean(here.full) });
  // (A topic's tab starts with nothing: its first stop is its topic, never home.)
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
    const was = here;
    visiting = next;
    const stopped = JSON.parse(visited[next]);
    here = stopped && { ...stopped, focus: null };
    showHistory();
    // A card stepped back or on to comes to the middle again; full screen opening or closing glides.
    if (was && here && was.topicId === here.topicId) {
      if (was.item !== here.item && !here.full && here.item) here.bring = true;
      moving = Boolean(was.full) !== Boolean(here.full);
    }
    render();
  }
  api.onHistoryStep?.((delta) => travel(delta));
  showHistory();
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.key === '[') travel(-1);
    else if (event.key === ']') travel(1);
  });

  // Shows a topic: from Home, in a tab of its own (the one already showing it, unless `newTab`); in
  // a topic's tab, here. `card` is brought to the middle.
  function open(next, { newTab = false } = {}) {
    if (inHome) {
      api.openInTab({ ...next, newTab });
      return;
    }
    here = { topicId: next.topicId, name: next.name ?? '', item: next.card ?? null, full: false, bring: Boolean(next.card), focus: null };
    remember();
    render();
  }

  // The same thing drawn again keeps what's scrolled in each card where it was.
  let showingPlace = null;
  const placeShowing = () => (here ? `${here.topicId}:${here.full ? here.item : 'board'}` : 'home');
  const SCROLLERS = '.focus-body';
  const scrollKey = (scroller) => scroller.closest('[data-item]')?.dataset.item ?? 'full';
  function itemScrolls() {
    const kept = new Map();
    for (const scroller of el.querySelectorAll(SCROLLERS)) {
      if (scroller.scrollTop || scroller.scrollLeft) kept.set(scrollKey(scroller), [scroller.scrollLeft, scroller.scrollTop]);
    }
    return kept;
  }
  function restoreItemScrolls(kept) {
    if (!kept.size) return;
    const put = () => {
      for (const scroller of el.querySelectorAll(SCROLLERS)) {
        const at = kept.get(scrollKey(scroller));
        if (at) [scroller.scrollLeft, scroller.scrollTop] = at;
      }
    };
    put();
    // Again once pages are fitted to their cards' sizes, which can change how far they scroll.
    requestAnimationFrame(() => requestAnimationFrame(put));
  }

  async function render() {
    const ticket = ++rendering;
    const place = placeShowing();
    const view = here ? await topicView(here) : inTab ? waitingView() : await homeView();
    if (ticket !== rendering) return;
    const show = () => {
      // Home's list keeps its place when it's drawn again.
      const listTop = el.querySelector('.browser-list')?.scrollTop ?? 0;
      const focused = document.activeElement?.dataset?.topic && `[data-topic="${CSS.escape(document.activeElement.dataset.topic)}"]`;
      const scrolled = place === showingPlace ? itemScrolls() : new Map();
      const showingTopic = Boolean(here && view.topic);
      document.body.classList.toggle('has-topic', showingTopic);
      if (!showingTopic) {
        // Home arriving (at launch): its column rises in, as SmartDoc's and SmartSpec's do.
        if (!homeShowing && !inTab) view.classList.add('arriving');
        homeShowing = !inTab;
      } else homeShowing = false;
      el.replaceChildren(view);
      showingPlace = place;
      const list = el.querySelector('.browser-list');
      if (list) {
        list.scrollTop = listTop;
        if (!list.dataset.banded) {
          rubberBand(list);
          list.dataset.banded = '1';
        }
      }
      if (focused) el.querySelector(focused)?.focus({ preventScroll: true });
      // What the topic is for, at the toolbar's start.
      goalEl.textContent = view.topic?.goal ?? '';
      goalEl.title = view.topic?.goal ?? '';
      // The board first: it sets each card's size, which a page is fitted to.
      const board = el.querySelector('.board');
      if (board) showBoard(board);
      restoreItemScrolls(scrolled);
      const full = el.querySelector('.focus-full[data-item]');
      if (full?.comments) watchComments(full, full.comments);
      const fullPage = el.querySelector('.focus-full .sheet-body');
      if (fullPage) watchPage(fullPage);
      // A box of questions open before the page was drawn again opens again on the same thing.
      const threads = (board ?? full)?.threads;
      if (threads) refreshThread(threads);
      else closeThread();
      bringFocusIntoView();
      showBar(view.bottomBar);
      onCards(view.bottomBar?.cards ?? [], view.bottomBar?.shortcuts ?? []);
    };
    // Opening or closing full screen, the browser carries the card between its two places, as each
    // has the same name (see moves). A move that can't be animated, as in a hidden window, still
    // happens: only the animation is lost.
    const animate = moving && smoothly();
    moving = false;
    if (animate) {
      const transition = document.startViewTransition(show);
      transition.ready.catch(() => {});
      transition.finished.catch(() => {});
    } else show();
  }

  // A heading a link went to, brought into view in its card and lit for a moment.
  function bringFocusIntoView() {
    if (!here?.focus) return;
    const within = el.querySelector(`.board-item[data-item="${CSS.escape(here.item ?? '')}"], .focus-full`) ?? el;
    const part = [...within.querySelectorAll('[data-part]')].find((element) => element.dataset.part === here.focus);
    here.focus = null;
    if (!part) return;
    part.scrollIntoView({ block: 'center' });
    part.classList.add('part-focus');
    setTimeout(() => part.classList.remove('part-focus'), 2000);
  }

  // A topic's tab with no topic yet (an AI's, opening one): nothing, under the line saying so
  // (#tab-waiting).
  const waitingView = () => h('div', { className: 'tab-waiting-view' });

  // --- Home ---------------------------------------------------------------------------------

  // Home: the user's topics, one column, most recently changed first (the user's choice for now, as
  // SmartAd's). Each row is the topic's icon and name, what it's for, how many cards it has, and how
  // many of the user's questions wait for the AI. Clicking one opens it in its tab; its right-click
  // menu opens it in a new tab, renames it, changes its icon or deletes it.
  async function homeView() {
    onShown({ chatId: 'home', name: null, line: { text: 'Went home', detail: 'The window shows SmartPrep\'s home.' } });
    const topics = await api.listTopics();
    if (naming && !topics.some((topic) => topic.id === naming)) naming = null;
    const rows = topics.map((topic) => (naming === topic.id ? namingRow(topic) : topicRow(topic)));
    const view = h('div', { className: 'browser home-topics' }, column('Topics', rows));
    view.bottomBar = null;
    return view;
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function topicRow(topic) {
    const mark = h('span', { className: 'home-doc-icon', 'aria-hidden': 'true' });
    mark.innerHTML = iconSvg(topic.icon, 15);
    const waiting = topic.questions?.waiting ?? 0;
    const counted = topic.cards ? many(topic.cards, 'card') : 'No cards yet';
    const button = h('button', { className: 'browser-row', type: 'button', 'data-topic': topic.id, title: topic.name, onclick: () => open({ topicId: topic.id, name: topic.name }) },
      h('span', { className: 'title-row' }, h('strong', {}, mark, topic.name), statusPills(
        waiting > 0 && pill(waiting === 1 ? '1 question' : `${waiting} questions`, 'proposed'),
        topic.unread > 0 && pill(`${topic.unread} unread`),
      )),
      topic.goal && h('span', { className: 'browser-row-text' }, topic.goal),
      h('span', { className: 'browser-row-meta' }, `${counted} · ${when(topic.updatedAt)}`));
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      const box = button.getBoundingClientRect();
      const chosen = await api.showHomeMenu([
        { id: 'open', label: 'Open in New Tab' },
        { separator: true },
        { id: 'rename', label: 'Rename…' },
        { id: 'icon', label: 'Change Icon…' },
        { separator: true },
        { id: 'delete', label: 'Delete Topic…' },
      ]);
      if (chosen === 'open') open({ topicId: topic.id, name: topic.name }, { newTab: true });
      else if (chosen === 'rename') {
        naming = topic.id;
        render();
      } else if (chosen === 'icon') onChooseIcon({ docId: topic.id, current: topic.icon, name: topic.name, at: { left: box.left + 24, top: box.bottom + 4 } });
      else if (chosen === 'delete' && await api.deleteTopic(topic.id)) render();
    });
    return button;
  }

  // A topic's name being written over its row. Enter or leaving it saves, Escape doesn't, and a name
  // that's refused says why, keeping what was typed.
  function namingRow(topic) {
    const field = h('input', { className: 'name-input', type: 'text', value: topic.name, 'aria-label': 'Topic name', maxlength: '200' });
    const said = h('span', { className: 'name-error', role: 'alert' });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      const named = field.value.trim();
      done = true;
      if (!save || !named || named === topic.name) {
        naming = null;
        return render();
      }
      try {
        await api.renameTopic(topic.id, named);
        onNote({ text: `Renamed “${topic.name}” to “${named}”`, detail: `Renamed the topic “${topic.name}” (topic_id ${topic.id}) to “${named}”` });
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
  // buttons, as the family's homes do: each placeholder is a row's line widths, in percent (a
  // topic's name, then its lines).
  const SKELETON = [[44, 82, 30], [58, 70, 26], [36, 88, 32]];
  function column(title, rows) {
    const placeholder = (widths) => h('div', { className: 'browser-row' }, ...widths.map((width) => h('span', { className: 'skeleton-bar', style: `width: ${width}%` })));
    return h('section', { className: `browser-column${rows.length ? '' : ' browser-column-unused'}`, 'aria-label': title },
      h('div', { className: 'browser-head' }, h('h2', {}, title)),
      rows.length
        ? h('ul', { className: 'browser-list' }, ...rows.map((one) => h('li', {}, one)))
        : h('div', { className: 'browser-list browser-skeleton', 'aria-hidden': 'true' }, ...SKELETON.map(placeholder)));
  }

  // A new topic: what it's for, and a prompt asking the AI to start it, from the File menu (as
  // SmartSpec's New Schematic).
  function newTopic() {
    if (document.querySelector('.prompt-dialog')) return;
    const field = h('textarea', { className: 'prompt-input', id: 'new-topic-goal', rows: 3, 'aria-label': 'What you’re preparing for', placeholder: 'What are you preparing for? For example: an interview for a platform engineer role at Acme, or learning Kubernetes' });
    const copy = h('button', { className: 'primary-button', type: 'button', id: 'new-topic-copy' }, 'Copy the prompt');
    let reset;
    copy.addEventListener('click', async () => {
      await api.copyText([
        field.value.trim() ? `Start a new topic in SmartPrep: ${field.value.trim()}. Ask me what you need to know first.` : 'Ask me what I’m preparing for, then start a new topic in SmartPrep.',
        api.windowId && `Take over SmartPrep window ${api.windowId} with use_window first.`,
      ].filter(Boolean).join(' '));
      copy.textContent = 'Copied';
      clearTimeout(reset);
      reset = setTimeout(() => { copy.textContent = 'Copy the prompt'; }, 1500);
    });
    const dialog = h('dialog', { className: 'prompt-dialog', 'aria-labelledby': 'prompt-title' },
      h('h2', { id: 'prompt-title' }, 'New topic'),
      h('p', {}, 'Your AI asks what it’s for, then writes its first cards onto a board for you.'),
      field,
      h('div', { className: 'prompt-buttons' },
        h('button', { className: 'secondary-button', type: 'button', id: 'new-topic-close', onclick: () => dialog.close() }, 'Close'),
        copy));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    field.focus();
  }

  // --- One topic ----------------------------------------------------------------------------

  // A topic's page: its board (or one card full screen), and its bottom bar. Refreshes overlap (a
  // change arrives as the user reads), so each works out for itself what to show.
  async function topicView(at) {
    const [topic, cards, questions] = await Promise.all([
      api.getTopic(at.topicId).catch(() => null),
      api.getCards(at.topicId).catch(() => null),
      api.listQuestions(at.topicId).catch(() => []),
    ]);
    if (!topic || !cards) {
      // It's gone (deleted): a topic's tab with nothing left in it closes.
      if (inTab && hadTopic) api.tabClose();
      here = null;
      return inTab ? waitingView() : homeView();
    }
    hadTopic = true;
    at.name = topic.name;
    if (at.item && !cards.some((card) => card.id === at.item)) {
      at.item = null;
      at.full = false;
    }
    if (at.full && !at.item) at.full = false;
    const shown = { topic, cards, questions };
    const view = h('div', { className: `page topic-page${at.full ? ' full' : ' board-page'}` }, await boardView(at, shown));
    view.topic = topic;
    view.bottomBar = reviewBar(at, shown);
    const middle = view.querySelector('.board') ? middleOf(at.topicId, cards) : at.full ? [at.item] : [];
    const opened = `Opened “${topic.name}”`;
    onShown({ chatId: at.topicId, name: topic.name, middle, line: { text: opened, detail: `${opened} (topic_id ${at.topicId})` } });
    return view;
  }

  // The cards open in the middle of the board, by the layout kept (for what the AI is told).
  const middleOf = (topicId, cards) => {
    const layout = layouts.get(topicId);
    if (!layout) return [];
    return cards.map((card) => card.id).filter((id) => layout.boxes[id] && !layout.boxes[id].choice && !isCard(layout.boxes[id]) && layout.boxes[id].cx > 0.3 && layout.boxes[id].cx < 0.7);
  };

  // The bottom bar is the actions bar: what there is to decide about the view (a card), what it is
  // and a line on what's happening now, on the left, with its buttons on the right; with nothing to
  // decide, its sentence on what's going on. It explains, and no more: what's in the cards is on the
  // board, and what the AI says is in the chat (the family's rule).
  const reviewLine = (said) => h('p', { className: 'review-bar-text', title: said }, said);
  function showBar(view) {
    bottomBar.hidden = !view;
    if (!view) return bottomBar.replaceChildren();
    const card = view.cards?.[0];
    if (!card) return bottomBar.replaceChildren(reviewLine(view.said));
    const line = [...(card.lines ?? []), card.decide].filter(Boolean).join(' ');
    bottomBar.replaceChildren(
      h('div', { className: 'review-bar-card' },
        h('div', { className: 'review-bar-title' }, card.title),
        line && h('div', { className: 'review-bar-line', title: line }, line),
      ),
      h('div', { className: 'review-bar-actions' }, ...(card.actions ?? []).map((action) => {
        const button = h('button', {
          className: action.kind === 'primary' ? 'primary-button' : 'secondary-button',
          type: 'button',
          'data-action': action.id,
          title: action.title ?? null,
        }, action.label);
        button.addEventListener('click', () => action.run?.(button));
        return button;
      })));
  }
  const bar = (said, card = null, shortcuts = []) => ({ said, cards: card ? [card] : [], shortcuts: shortcuts.filter(Boolean) });

  // A request for the AI, from the bar: sent to the chat's AI in SmartDesktop, or, without
  // SmartDesktop, copied for the user to paste to theirs, the button saying so for a moment.
  function askAi(text, button) {
    if (desktopStatus !== 'missing') return onAsk(text);
    api.copyText(text);
    const was = button.textContent;
    button.textContent = 'Copied: paste it to your AI';
    setTimeout(() => { button.textContent = was; }, 2000);
  }

  // What the bar says: questions waiting for the AI, with the request to answer them (Answer my
  // questions, also offered in the chat as a shortcut); else what the user is doing.
  function reviewBar(at, { topic, cards }) {
    const name = topic.name;
    const waiting = topic.questions?.waiting ?? 0;
    const unread = cards.filter((card) => card.unread).length;
    if (at.full) {
      const card = cards.find((one) => one.id === at.item);
      return bar(`You're reading ${card?.title ?? 'a card'}, full screen. Hold on words you pick in it to ask about them.`);
    }
    if (waiting > 0) {
      const text = `Answer my ${waiting === 1 ? 'question' : 'questions'} on the topic “${name}” in SmartPrep (topic_id ${at.topicId}): read ${waiting === 1 ? 'it' : 'them'} with get_questions, and answer each with answer_question, a new card for each.`;
      return bar(`You have ${many(waiting, 'question')} for your AI.`, {
        id: `questions-${at.topicId}`,
        title: `${many(waiting, 'question')} waiting for your AI`,
        lines: ['Your AI answers each with a new card, and the words you asked about become a link to it.'],
        actions: [{ id: 'answer-questions', label: waiting === 1 ? 'Answer my question' : 'Answer my questions', kind: 'primary', title: 'Asks your AI to answer your questions with new cards', run: (button) => askAi(text, button) }],
      }, [{ id: 'answer-questions', key: `answer-questions:${at.topicId}:${waiting}`, label: waiting === 1 ? 'Answer my question' : 'Answer my questions', title: 'Asks the AI to answer your questions with new cards', text }]);
    }
    if (!cards.length) return bar(`${name} has no cards yet. Ask your AI in the chat to write the first ones.`);
    const news = unread ? ` ${unread === 1 ? 'One card is' : `${unread} cards are`} new or updated.` : '';
    return bar(`You're working on ${name}. Hold on words you pick in a card to ask about them.${news}`);
  }

  // Each card keeps its own name through a move, so the browser can carry it to its new place.
  const moves = (id) => `view-transition-name: item-${id}`;

  // Where the user has placed each topic's cards on the board, as loaded, or as changed here since
  // (see board.js). Kept on this computer a moment after the user stops moving things, never with
  // the topic.
  const layouts = new Map();
  async function layoutOf(topicId) {
    if (!layouts.has(topicId)) layouts.set(topicId, cleanLayout(await api.getLayout(topicId).catch(() => null)));
    return layouts.get(topicId);
  }
  const saving = new Map();
  function keepLayout(topicId, layout) {
    layouts.set(topicId, layout);
    clearTimeout(saving.get(topicId));
    saving.set(topicId, setTimeout(() => api.saveLayout(topicId, layoutToSave(layout, Object.keys(layout.boxes))).catch(() => {}), 400));
  }

  // The card linked with the most others: what a topic with no layout yet starts on.
  const mostLinked = (cards) => {
    const counts = new Map();
    for (const card of cards) {
      for (const { to } of linksOf(card)) {
        const target = parseLink(to).target;
        if (target === card.id) continue;
        counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    }
    return [...cards].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0]?.id ?? null;
  };

  const titleOf = (cards, id) => cards.find((card) => card.id === id)?.title ?? id;

  // The board: every card in the topic, where the user has placed it (see board-view.js). The middle
  // is for reading; out to the sides they're smaller, and at the edges they're cards. Full screen,
  // one card has the whole window.
  async function boardView(at, shown) {
    const { topic, cards, questions } = shown;
    const ids = cards.map((card) => card.id);
    const follow = (link, from = at.item) => {
      const { target, part } = parseLink(link, from);
      if (!ids.includes(target)) return undefined;
      at.item = target;
      at.focus = part;
      at.bring = true;
      at.full = false;
      remember();
      return render();
    };

    // Full screen, one card has the whole window, with its questions as on the board: marked where
    // they are, and a long press asks about what was pressed.
    if (at.full) {
      const groups = groupComments(questions.filter((question) => !question.target.topic && !question.target.missing && question.target.item === at.item));
      const threads = threadsFor(at, shown, groups);
      const unread = cards.find((card) => card.id === at.item)?.unread;
      const holder = h('div', { className: 'focus-full', 'data-item': at.item, ...(unread && { 'data-unread': unread }) }, fullView(at, at.item, shown, follow, { full: true }));
      Object.assign(holder, { threads: threads.find, comments: { groups, open: (group, x, y) => threads.open(group.target, x, y) } });
      watchLongPress(holder, {
        accept: (event) => !event.target.closest('button, input, textarea, .comment-marker, .comment-thread, .canvas-controls') && Boolean(event.target.closest('.focus-card')),
        fire: (event) => {
          const target = targetAt(holder, event);
          if (target) threads.open(target, event.clientX, event.clientY, true);
        },
      });
      return holder;
    }

    // The questions on a card gather by what they're on, each lot with a marker there (see
    // comments.js); those on the topic as a whole are cards on the board, placed like cards.
    const groups = groupComments(questions.filter((question) => !question.target.topic && !question.target.missing && ids.includes(question.target.item)));
    const onWhole = questions.filter((question) => question.target.topic);

    let layout = await layoutOf(at.topicId);
    const fresh = !Object.keys(layout.boxes).length;
    // Brought to the middle (with no layout yet, it starts there anyway).
    if (at.bring && !fresh && at.item) {
      layout = bringToMiddle(layout, at.item, { width: el.clientWidth, height: el.clientHeight, focus: focusWidth() });
      keepLayout(at.topicId, layout);
    }
    at.bring = false;
    // With no layout yet: the card asked for (or the most linked) in the middle, what links to it
    // down the left edge, and the rest down the right.
    const centre = at.item ?? mostLinked(cards);
    const into = cards.filter((card) => card.id !== centre && linksOf(card).some(({ to }) => parseLink(to).target === centre)).map((card) => card.id);
    const showsFull = (id) => (fresh ? id === centre : layout.boxes[id] && !isCard(layout.boxes[id]));

    const build = (id) => (id.startsWith(WHOLE) ? null : fullView(at, id, shown, follow));
    const items = cards.map((card) => {
      const element = h('article', { className: 'board-item', 'data-item': card.id, style: moves(card.id), 'aria-label': card.title, ...(card.unread && { 'data-unread': card.unread }) }, boardCard(card));
      // What shows at full size is drawn now, so it doesn't arrive a moment after.
      if (showsFull(card.id)) {
        const full = build(card.id);
        full.classList.add('board-full');
        element.prepend(full);
      }
      return element;
    });
    // Questions on the whole topic, as cards on the board.
    const wholeCards = onWhole.map((question) => h('article', { className: 'board-item board-comment', 'data-item': `${WHOLE}${question.id}`, 'aria-label': 'Question on the whole topic' },
      h('div', { className: 'board-card comment-board-card' }, commentCard(question, { onNoFurtherAction: flagQuestion(at) }))));
    const board = h('div', { className: 'board' }, ...items, ...wholeCards);
    if (!cards.length) board.append(h('p', { className: 'board-empty' }, 'No cards yet. Ask your AI in the chat to start this topic: it writes its first cards here.'));
    const threads = threadsFor(at, shown, groups);
    board.watch = { topicId: at.topicId, ids: [...ids, ...onWhole.map((question) => `${WHOLE}${question.id}`)], centre, left: into, right: ids.filter((id) => id !== centre && !into.includes(id)), build, groups, threads, name: topic.name, title: (id) => titleOf(cards, id), unread: new Set(cards.filter((card) => card.unread).map((card) => card.id)) };
    board.threads = threads.find;
    // A long press on an open card asks about what was pressed; on empty space, about the whole
    // topic, its card put where it was pressed.
    watchLongPress(board, {
      accept: (event) => {
        if (event.target.closest('.board-grip, .comment-marker, button, input, textarea, .comment-thread')) return false;
        const element = event.target.closest('.board-item');
        if (!element) return event.target === board;
        return !element.classList.contains('is-card') && !element.classList.contains('board-comment') && Boolean(element.querySelector(':scope > .board-full'));
      },
      fire: (event) => {
        const element = event.target.closest('.board-item');
        if (!element) return askAboutTopic(at, shown, event, (made) => {
          const rect = board.getBoundingClientRect();
          const kept = layouts.get(at.topicId) ?? emptyLayout();
          const z = Math.max(0, ...Object.values(kept.boxes).map((box) => box.z ?? 0)) + 1;
          keepLayout(at.topicId, { boxes: { ...kept.boxes, [`${WHOLE}${made.id}`]: { cx: (event.clientX - rect.left) / rect.width, cy: (event.clientY - rect.top) / rect.height, w: 0.2, h: 0.2, z, sized: false } } });
        });
        const target = targetAt(element, event);
        if (!target) return;
        threads.open(target, event.clientX, event.clientY, true);
      },
    });
    return board;
  }

  // Once the board is on the page: anything without a place yet is given one, now its card can be
  // measured (a card the AI has just written goes down the side with fewer cards, as SmartSpec's
  // placeNew does), and the board is watched for the user moving things.
  function showBoard(board) {
    const { topicId, ids, centre, left, right, build, groups, threads } = board.watch;
    let layout = layouts.get(topicId) ?? emptyLayout();
    if (ids.some((id) => !layout.boxes[id])) {
      const heights = Object.fromEntries([...board.querySelectorAll(':scope > .board-item')].map((one) => [one.dataset.item, one.querySelector(':scope > .board-card')?.offsetHeight || 80]));
      const size = { width: board.clientWidth, height: board.clientHeight };
      if (!Object.keys(layout.boxes).length) layout = { boxes: defaultLayout({ centre, left, right }, heights, size).boxes };
      layout = placeNew(layout, ids, heights, size);
      keepLayout(topicId, layout);
    }
    let remark = () => {};
    watchBoard(board, {
      layout,
      // Something dragged in from the edge is drawn in full, and its questions marked.
      build: async (id) => {
        const built = await build(id);
        setTimeout(() => remark());
        return built;
      },
      onChange: (next) => {
        keepLayout(topicId, next);
        tellMiddle();
      },
      // A card brought to the middle is a step back and forward go through, and what the user is
      // looking at: a line of context for the chat. It's read, too.
      onBring: (id) => {
        if (!here || here.topicId !== topicId || id.startsWith(WHOLE)) return;
        here.item = id;
        remember();
        if (board.watch.unread.has(id)) markRead(topicId, id);
        const title = board.watch.title(id);
        onNote({ text: `Looking at “${title}”`, detail: `Looking at the card “${title}” (${id}) of ${board.watch.name}`, focus: true, about: title });
        tellMiddle();
      },
    });
    remark = watchComments(board, { groups, open: (group, x, y) => threads.open(group.target, x, y) });
  }

  // The chat's AI is told which cards are in the middle as that changes (see chatWhere in main.js).
  let telling = 0;
  function tellMiddle() {
    clearTimeout(telling);
    telling = setTimeout(async () => {
      if (!here || here.full) return;
      const cards = await api.getCards(here.topicId).catch(() => null);
      if (!cards || !here) return;
      onShown({ chatId: here.topicId, name: here.name, middle: middleOf(here.topicId, cards), line: { text: `Opened “${here.name}”`, detail: `Opened “${here.name}” (topic_id ${here.topicId})` } });
    }, 600);
  }

  // A card at full size: its title along the top, which it's dragged by, and its page: the question
  // it answers, then the answer. Full screen, the same with the window to itself.
  function fullView(at, id, { cards, questions }, follow, { full = false } = {}) {
    const card = cards.find((one) => one.id === id);
    const middle = h('article', { className: 'focus-card', ...(full && { style: moves(id) }), 'aria-label': card?.title ?? id });
    // Links in the answer are followed here: the card they go to comes to the middle.
    middle.addEventListener('click', (event) => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!isInternalLink(href)) return; // the main process opens web links in the browser
      event.preventDefault();
      follow(href, id);
    });
    // Back to the card a question was asked on, from the line saying so.
    middle.addEventListener('click', (event) => {
      const back = event.target.closest?.('[data-asked-on]');
      if (!back) return;
      event.preventDefault();
      follow(back.dataset.askedOn, id);
    });
    const body = h('div', { className: 'focus-body' });
    if (!card) {
      middle.append(paneHead(id, null, null), body);
      body.append(h('p', { className: 'muted' }, 'This card couldn’t be read.'));
      return middle;
    }
    middle.append(paneHead(card.title, card.description, card.unread));
    // The question it answers, as the card's own, above the answer (not a heading of the answer's,
    // so nothing links to it); and, for a card written for one of the user's questions, what they
    // asked about and where.
    const asked = card.answers && questions.find((question) => question.id === card.answers);
    const where = asked?.target?.item && !asked.target.missing && cards.find((one) => one.id === asked.target.item);
    const answer = h('div', {});
    renderMarkdown(answer, card.content);
    const askedLine = asked && h('p', { className: 'card-asked' }, `You asked${asked.target.quote ? ` about “${asked.target.quote}”` : asked.target.topic ? ' about the topic' : ''}`);
    if (askedLine && where) askedLine.append(' in ', h('a', { href: where.id, 'data-asked-on': where.id, className: 'card-asked-link' }, where.title));
    const sheet = h('div', { className: 'document-sheet' }, h('p', { className: 'card-question' }, card.question), askedLine, answer);
    body.append(sheet);
    body.classList.add('sheet-body');
    body.dataset.page = `${at.topicId}:${id}`; // its zoom in a card is kept by this (page-view.js)
    middle.append(body);
    actionsOf(middle).append(fullButton(at, id));
    if (full) {
      middle.classList.add('embeds');
      // The card's title stays apart from the writing, above the page.
      body.prepend(h('div', { className: 'sheet-head' }, middle.querySelector('.pane-title')));
      // No bar across the top: its buttons float over the content.
      const head = middle.querySelector('.pane-head');
      middle.append(h('div', { className: 'full-actions' }, ...actionsOf(head).children));
      head.remove();
    }
    // Where its content goes on out of sight, an inner shadow says so.
    shadeScrolling(body);
    return middle;
  }

  // A card's compact face, for the edges of the board: its icon, title and whether it's new or
  // updated; under them, where there's room, the question it answers.
  function boardCard(card) {
    return h('div', { className: 'focus-neighbour board-card' },
      kindIcon(),
      h('span', { className: 'title-row' }, h('strong', {}, card.title), statusPills(unreadPill(card.unread))),
      h('span', { className: 'card-face-question' }, card.question),
      card.description && h('span', { className: 'focus-meta' }, card.description),
      h('span', { className: 'focus-preview text' }, plainText(card.content)));
  }

  const actionsOf = (card) => card.querySelector('.pane-actions');

  // Full screen for one card, from its title bar on the board, and back.
  function setFull(at, full) {
    at.full = full;
    moving = true;
    remember();
    return render();
  }
  function fullButton(at, id) {
    const name = at.full ? 'Leave full screen' : 'Full screen';
    const button = h('button', { className: 'icon-button', type: 'button', ...(at.full && { id: 'full-toggle' }), title: name, 'aria-label': name, onclick: () => {
      at.item = id;
      if (!at.full) markReadIfUnread(at.topicId, id);
      setFull(at, !at.full);
    } });
    button.innerHTML = at.full ? LEAVE_FULL_ICON : FULL_ICON;
    return button;
  }

  // The title alone along the top, and whether it's new or updated. Its description is on a card
  // while pointing at the title, or with it focused from the keyboard.
  const paneHead = (title, detail, unread) => {
    const about = detail && h('div', { className: 'title-card', role: 'tooltip', id: 'title-card' }, h('span', { className: 'title-card-detail' }, detail));
    return h('div', { className: 'pane-head' },
      h('div', { className: 'pane-title' },
        h('div', { className: 'title-row' }, h('h2', about ? { tabIndex: 0, 'aria-describedby': 'title-card' } : {}, title), statusPills(unreadPill(unread))),
        about),
      h('div', { className: 'pane-actions' }));
  };

  // --- Questions ------------------------------------------------------------------------------

  // What a question is on, without what the store adds to describe it, to ask another on the same.
  const bareTarget = (target) => {
    if (target.topic) return { topic: true, ...(target.at && { at: target.at }) };
    if (target.point && !target.part && !target.quote) return { item: target.item, point: target.point };
    return { item: target.item, ...(target.part && !target.partMissing && { part: target.part }), ...(target.quote && { quote: target.quote }), ...(target.quotes && { quotes: target.quotes }) };
  };

  // Questions gathered by what they're on (see keyOf).
  function groupComments(questions) {
    const groups = new Map();
    for (const question of questions) {
      const key = keyOf(question.target);
      if (!groups.has(key)) groups.set(key, { key, target: question.target, comments: [] });
      groups.get(key).comments.push(question);
    }
    return [...groups.values()];
  }

  // The boxes of questions for the board: `open(target, x, y, writing)` opens the box on what
  // `target` is on, with the questions already there; `find(key)` gives what opens it again after
  // the page is drawn again (see comment-overlay.js).
  function threadsFor(at, { cards }, groups) {
    const titleFor = (id) => titleOf(cards, id);
    const heading = (target) => (target.quote || target.part || target.point ? `Ask about ${target.title ?? titleFor(target.item)}` : `Ask about the card ${target.title ?? titleFor(target.item)}`);
    const options = (target, questions = []) => ({
      heading: heading(target),
      target,
      comments: questions,
      send: async (text) => {
        await api.addQuestion(at.topicId, { target: bareTarget(target), text });
        // What the user asked is context for the chat too.
        const title = target.title ?? titleFor(target.item);
        onNote({ text: `Asked about “${target.quote ?? title}”`, detail: `Asked about ${target.quote ? `the words “${target.quote}” in ` : ''}the card “${title}” (${target.item}): “${text}”` });
        render();
      },
      flag: flagQuestion(at),
    });
    const find = (key) => {
      const group = groups.find((one) => one.key === key);
      return group && options(group.target, group.comments);
    };
    const open = (target, x, y, writing = false) => {
      const key = keyOf(target);
      const group = groups.find((one) => one.key === key);
      openThread({ key, x, y, writing, ...options(group?.target ?? target, group?.comments ?? []) });
    };
    return { find, open };
  }

  // A long press on empty space: a box to ask about the topic as a whole. `placed(question)` is
  // called once it's asked, to put its card where it was pressed on the board.
  function askAboutTopic(at, { topic }, event, placed) {
    openThread({
      key: 'whole-new',
      x: event.clientX,
      y: event.clientY,
      writing: true,
      heading: `Ask about ${topic.name}`,
      target: null,
      send: async (text) => {
        const made = await api.addQuestion(at.topicId, { target: { topic: true }, text });
        placed?.(made);
        onNote({ text: `Asked about “${topic.name}”`, detail: `Asked about the topic “${topic.name}” as a whole: “${text}”` });
        closeThread();
        render();
      },
    });
  }

  // The user marks a question as needing no further action, or opens it again.
  const flagQuestion = (at) => async (question, flag) => {
    await api.setNoFurtherAction(at.topicId, question.id, flag);
    render();
  };

  // --- Read and unread ------------------------------------------------------------------------

  // A card is read once it has been open (not a card at the edge) in the tab showing for about a
  // second, or brought to the middle, or full screen: then it's no longer marked New or Updated.
  const reading = new Set(); // cards being marked read, so each is asked once
  function markRead(topicId, cardId) {
    const key = `${topicId}/${cardId}`;
    if (reading.has(key)) return;
    reading.add(key);
    api.markRead(topicId, cardId).catch(() => {}).finally(() => setTimeout(() => reading.delete(key), 2000));
  }
  const markReadIfUnread = (topicId, cardId) => {
    if (el.querySelector(`[data-item="${CSS.escape(cardId)}"][data-unread]`)) markRead(topicId, cardId);
  };
  const openFor = new Map(); // card id → how long it has been open, in ms
  setInterval(() => {
    if (!here || document.visibilityState !== 'visible') return openFor.clear();
    const open = here.full
      ? [...el.querySelectorAll('.focus-full[data-unread]')].map((one) => one.dataset.item)
      : [...el.querySelectorAll('.board > .board-item[data-unread]:not(.is-card)')].filter((one) => one.querySelector(':scope > .board-full')).map((one) => one.dataset.item);
    for (const id of [...openFor.keys()]) if (!open.includes(id)) openFor.delete(id);
    for (const id of open) {
      const time = (openFor.get(id) ?? 0) + READ_TICK_MS;
      openFor.set(id, time);
      if (time >= READ_AFTER_MS) {
        openFor.delete(id);
        markRead(here.topicId, id);
      }
    }
  }, READ_TICK_MS);

  // A reply's card, from a question's thread: brought to the middle.
  onOpenCard((cardId) => {
    if (!here) return;
    closeThread();
    here.item = cardId;
    here.bring = true;
    here.full = false;
    remember();
    render();
  });

  // Escape leaves full screen.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && here?.full && el.querySelector('.focus-full') && !document.querySelector('dialog[open]') && !document.querySelector('.comment-thread')) setFull(here, false);
  });

  api.onTopicsChanged(render);
  const heardDesktop = (status) => {
    desktopStatus = status ?? 'off';
  };
  api.desktopStatus?.().then(heardDesktop, () => {});
  api.onDesktopStatus?.(heardDesktop);
  api.onNewTopic(newTopic);
  // A topic opened from Home, or an AI's cards, in this tab (see main.js's openInTab).
  api.onOpenTopic?.((request) => {
    if (!request?.topicId) return;
    if (inHome) return open(request);
    const same = here?.topicId === request.topicId;
    here = { topicId: request.topicId, name: request.name ?? '', item: request.card ?? (same ? here.item : null), full: false, bring: Boolean(request.card), focus: null };
    remember();
    render();
  });
  // A card the AI shows the user (show_card), brought to the middle.
  api.onShowCard?.(({ topicId, card } = {}) => {
    if (!here || here.topicId !== topicId || !card) return;
    here.item = card;
    here.bring = true;
    here.full = false;
    remember();
    render();
  });
  render();
}
