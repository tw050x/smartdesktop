import { kindIcon } from './kind-icons.js';
import { customScrollbar } from './scrollbar.js';
import { rubberBand } from './rubber-band.js';
import { clearAiProgress, failureText, progressLine, progressMark, trackAiProgress } from './ai-progress.js';

// The chat: where the user works with Claude, run by the app (see main/agent.js). It opens as a
// sidebar on the right that moves the document aside, or floats in a window of its own (`windowed`,
// chat.html and chat-window.js) attached to the app's window: it moves with it, can sit anywhere,
// even outside it, and is on top of it alone (see main/chat-window.js). It replaced the bottom bar's
// Copy the prompt buttons (copying a prompt for another AI app is in the focus card), and its
// Confirm button, shown above the message box while an AI in another app waits for the go-ahead.
//
// Its main conversation is with Claude about the document. Below the conversation's header, a card
// lists everything in the review as rows, in the order to work through it; a row opens that item's
// thread: the item in full, to read and decide, and, once the user writes something there, a
// conversation of its own with Claude about it (branched from the main one), in which Claude can
// improve that item. Without Claude Code, or signed out, it says how to set it up.

const DOCK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/></svg>';
const FLOAT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><rect x="11" y="10" width="7" height="7" rx="1"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
// The send button's icons: an up arrow with a chevron head to send, a square to stop Claude.
const SEND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
const BACK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
// Docked (in the app's window): `onDock(on)` makes room for it, `onFloat(view)` floats it instead,
// and `onResize()` says its width changed. Windowed (the floating window): `onDock(view)` docks it
// back and `onClose()` closes it.
const WIDTH_KEY = 'chat-width';
const MIN_WIDTH = 300;

export function createChatPanel({ el, api, review, windowed = false, onDock, onFloat, onClose, onResize }) {
  let open = false;
  let view = 'main'; // or the id of the item whose thread shows
  let chats = null; // the draft's: { chatId, main: { messages }, threads: { id: { messages } }, running: [] }
  // The AIs it can run (see main/agent.js), where each stands, and the one chosen (kept for next time).
  let statuses = null; // { claude: { name, tool, installed, loggedIn, installers, … }, codex: … }
  let provider = readChoice();
  let busy = null; // 'install' or 'sign-in' while one is under way
  let suggestion = null;
  let drawnKey = null; // what the body was drawn from, so it's only redrawn when that changes
  let toEnd = true; // the next drawing starts at the end: on opening, on a new view, on sending

  // --- Structure ------------------------------------------------------------------------------
  el.className = 'chat-panel';
  trackAiProgress(api);
  el.hidden = true;
  el.setAttribute('aria-label', 'Chat');
  const head = div('chat-head');
  // In a thread, the way back floats at the top left of the chat; the thread's title is its first
  // entry, so the thread has no bar of its own.
  const back = iconButton(BACK, 'Back to the conversation', () => showThread(null));
  back.classList.add('chat-back');
  const title = div('chat-title', 'Chat');
  const status = div('chat-status'); // a space, keeping the AI picker at the right
  const dock = windowed
    ? iconButton(DOCK_ICON, 'Dock the chat at the side', () => onDock(view))
    : iconButton(FLOAT_ICON, 'Float the chat in a window of its own', () => onFloat(view));
  const close = iconButton(CROSS, 'Close the chat', () => (windowed ? onClose() : setOpen(false)));
  // In its own window, one header row, its buttons at the end. Docked, it runs the window's full
  // height: its top row is level with the top bar, its close and float buttons at the left (the
  // server's status shows over its right end).
  const aiButton = button('chat-ai', null, () => openChoices());
  aiButton.setAttribute('aria-haspopup', 'menu');
  aiButton.setAttribute('aria-expanded', 'false');
  aiButton.append(Object.assign(document.createElement('span'), { className: 'chat-ai-name' }));
  aiButton.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');
  const aiMenu = div('chat-ai-menu');
  aiMenu.setAttribute('role', 'menu');
  aiMenu.hidden = true;
  // The AI picker sits at the right. In its own window, dock and close end the header after it, at
  // the right; docked, close and float lead the header at the left.
  if (windowed) head.append(status, aiButton, dock, close);
  else head.append(close, dock, status, aiButton);
  const body = div('chat-body');
  const foot = div('chat-foot');
  const chips = div('chat-chips');
  const form = document.createElement('form');
  form.className = 'chat-compose';
  const input = document.createElement('textarea');
  input.rows = 1;
  const sendButton = document.createElement('button');
  sendButton.type = 'submit';
  sendButton.className = 'chat-send';
  form.append(input, sendButton);
  // The message box (with the Confirm button over it when there is one) floats over the bottom of
  // the conversation, with no bar or line of its own: the conversation scrolls on behind it, fading
  // out as it goes under, and can be scrolled until its end is clear of it (`--chat-foot`).
  foot.append(chips, form);
  // The conversation scrolls with the app's own scrollbar, over its right edge.
  const scrollArea = div('chat-scroll');
  const scrollbar = div('scrollbar chat-scrollbar');
  scrollbar.setAttribute('aria-hidden', 'true');
  scrollbar.append(div('scrollbar-thumb'));
  scrollArea.append(body, scrollbar, back);
  el.append(head, aiMenu, scrollArea, foot);
  new ResizeObserver(() => el.style.setProperty('--chat-foot', `${foot.offsetHeight}px`)).observe(foot);

  // Docked, its left edge resizes it, up to half the window (the CSS holds it to that as the window
  // changes size too); the width is kept for next time. Double-clicking the edge forgets it.
  if (!windowed) {
    const setWidth = (px) => {
      if (px == null) document.documentElement.style.removeProperty('--chat-chosen');
      else document.documentElement.style.setProperty('--chat-chosen', `${Math.round(px)}px`);
      onResize?.();
    };
    try {
      const kept = Number(localStorage.getItem(WIDTH_KEY));
      if (kept >= MIN_WIDTH) document.documentElement.style.setProperty('--chat-chosen', `${kept}px`);
    } catch {}
    const resizer = div('chat-resizer');
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', 'Resize the chat');
    resizer.title = 'Drag to resize the chat. Double-click to reset.';
    el.append(resizer);
    let queued = null;
    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add('chat-resizing');
      let width = el.getBoundingClientRect().width;
      const move = (m) => {
        width = Math.max(MIN_WIDTH, Math.min(innerWidth / 2, innerWidth - m.clientX));
        if (queued) return;
        queued = requestAnimationFrame(() => {
          queued = null;
          setWidth(width);
        });
      };
      const end = () => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('lostpointercapture', end);
        document.body.classList.remove('chat-resizing');
        setWidth(width);
        try {
          localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
        } catch {}
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('lostpointercapture', end);
    });
    resizer.addEventListener('dblclick', () => {
      try {
        localStorage.removeItem(WIDTH_KEY);
      } catch {}
      setWidth(null);
    });
  }
  customScrollbar({ scrollbarEl: scrollbar, scrollers: [body], scroller: () => body, watch: [body] });
  // Scrolled on past either end, the conversation gives a little and springs back.
  rubberBand(body);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (isRunning()) return stop();
    send(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => renderCompose());

  // --- Talking to Claude ------------------------------------------------------------------------
  const conversation = () => (view === 'main' ? 'main' : view);
  const messagesOf = (key) => (key === 'main' ? chats?.main.messages : chats?.threads[key]?.messages) ?? [];
  const isRunning = (key = conversation()) => Boolean(chats?.running?.includes(key));
  // Working, at the end of the conversation, whenever the AI is busy, except while its reply is
  // coming in (the user's choice: the reply shows it). A reply arrives whole, and the AI often
  // finishes a moment after, so it's hidden for a few seconds after one arrives; still busy after
  // that, it's at work on something more (the user missed it while ChatGPT went on thinking after
  // saying something), and it shows again. A reply still being written out (`streaming`, the
  // website's demo) hides it throughout.
  const REPLY_SETTLES = 3000;
  const replyArriving = (key = conversation()) => {
    const last = messagesOf(key).at(-1);
    if (last?.role !== 'assistant') return false;
    return Boolean(last.streaming) || Date.now() - Date.parse(last.at ?? 0) < REPLY_SETTLES;
  };
  const working = (key = conversation()) => isRunning(key) && !replyArriving(key);
  let settleTimer = null;
  const setup = () => statuses?.[provider] ?? null;
  const ready = () => Boolean(setup()?.installed && setup()?.loggedIn);
  const aiName = () => setup()?.name ?? (provider === 'codex' ? 'ChatGPT' : 'Claude');

  async function send(text, key = conversation()) {
    text = text.trim();
    if (!text || isRunning(key)) return;
    if (!ready()) return;
    if (key === conversation()) input.value = '';
    toEnd = true;
    try {
      await api.agentSend(provider, key, text);
    } catch (error) {
      addLocal(key, { role: 'error', text: error.message });
    }
    renderCompose();
  }
  const stop = () => api.agentStop(conversation());

  // A message only this window knows of (an error before Claude ran), shown until the next load.
  function addLocal(key, message) {
    if (!chats) return;
    const convo = key === 'main' ? chats.main : (chats.threads[key] ??= { messages: [] });
    convo.messages = [...convo.messages, { id: `local-${Date.now()}`, ...message }];
    draw(true);
  }

  api.onAgentEvent?.((event) => {
    if (!chats || event.chatId !== chats.chatId) return; // another draft's chat
    if (event.type === 'messages') {
      if (event.conversation === 'main') chats.main.messages = event.messages;
      else (chats.threads[event.conversation] ??= {}).messages = event.messages;
    } else if (event.type === 'running') {
      chats.running = event.running ? [...new Set([...(chats.running ?? []), event.conversation])] : (chats.running ?? []).filter((c) => c !== event.conversation);
    } else if (event.type === 'error') {
      addLocal(event.conversation, { role: 'error', text: event.error });
      return;
    }
    draw(event.type === 'running'); // a new message redraws; following the end only if the user is at it
  });

  async function load() {
    toEnd = true;
    try {
      chats = await api.agentChats?.();
    } catch {
      chats = null;
    }
    draw(true);
  }

  async function checkSetup() {
    try {
      statuses = await api.agentStatus?.() ?? {};
    } catch {
      statuses = {};
    }
    // With nothing chosen yet, the first AI that's ready.
    if (!storedChoice() && !ready()) {
      const first = Object.values(statuses).find((s) => s.installed && s.loggedIn);
      if (first) provider = first.id;
    }
    showChoice();
    draw(true);
  }

  // --- Which AI ----------------------------------------------------------------------------------
  function storedChoice() {
    try {
      return localStorage.getItem('chat-ai');
    } catch {
      return null;
    }
  }
  function readChoice() {
    return storedChoice() ?? 'claude';
  }
  function choose(id) {
    provider = id;
    try {
      localStorage.setItem('chat-ai', id);
    } catch {}
    showChoice();
    draw(true);
  }
  const standing = (s) => (!s ? '' : s.installed && s.loggedIn ? 'Ready' : s.installed ? 'Not signed in' : 'Not installed');
  function showChoice() {
    aiButton.querySelector('.chat-ai-name').textContent = aiName();
    aiButton.title = `Working with ${aiName()}. Choose another AI.`;
  }
  // A small menu of the AIs, each with where it stands.
  function openChoices() {
    if (!aiMenu.hidden) return closeChoices();
    aiMenu.replaceChildren();
    for (const s of Object.values(statuses ?? {})) {
      const option = button(`chat-ai-option${s.id === provider ? ' chosen' : ''}`, null, () => {
        closeChoices();
        choose(s.id);
      });
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(s.id === provider));
      option.append(div('chat-ai-option-name', s.name), div('chat-ai-option-state', `${s.tool} · ${standing(s)}`));
      aiMenu.append(option);
    }
    if (!aiMenu.children.length) aiMenu.append(div('chat-ai-option-state', 'Checking…'));
    const at = aiButton.getBoundingClientRect();
    const panel = el.getBoundingClientRect();
    aiMenu.style.left = '';
    aiMenu.style.right = `${panel.right - at.right}px`;
    aiMenu.style.top = `${at.bottom - panel.top + 4}px`;
    aiMenu.hidden = false;
    aiButton.setAttribute('aria-expanded', 'true');
  }
  function closeChoices() {
    aiMenu.hidden = true;
    aiButton.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('pointerdown', (event) => {
    if (!aiMenu.hidden && !aiMenu.contains(event.target) && !aiButton.contains(event.target)) closeChoices();
  });

  // --- Drawing ----------------------------------------------------------------------------------
  function draw(force = false) {
    if (!open) return;
    const items = review.items();
    const item = view !== 'main' ? items.find((i) => i.id === view) : null;
    if (view !== 'main' && !item) view = 'main'; // its item has gone (a new review, To do)
    // Redrawn only when something it shows changed, so typing in the card's boxes isn't lost.
    const key = JSON.stringify([view, provider, setup(), busy, isRunning(), working(), messagesOf(conversation()).length, messagesOf(conversation()).at(-1)?.id, messagesOf(conversation()).at(-1)?.text?.length,
      view === 'main' ? items.map((i) => [i.id, i.title, i.decided]) : [item.status, item.title, item.decided, item.item?.decision, item.item?.revisedAt, item.request?.replies?.length]]);
    if (!force && key === drawnKey) return;
    // The conversation is read from its end: it opens at the bottom and stays there as things
    // arrive, unless the user has scrolled up to read, when it stays where they are.
    const sameView = drawnKey && JSON.parse(drawnKey)[0] === view;
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    const keepScroll = !toEnd && sameView && !atEnd ? body.scrollTop : null;
    toEnd = false;
    drawnKey = key;

    back.hidden = view === 'main';
    // (The header no longer says it's working: the user found the conversation's line enough.)
    // Once a reply has settled, if the AI's still busy, the line comes back.
    clearTimeout(settleTimer);
    if (isRunning() && replyArriving() && !messagesOf(conversation()).at(-1)?.streaming) {
      const since = Date.now() - Date.parse(messagesOf(conversation()).at(-1).at);
      settleTimer = setTimeout(() => draw(), Math.max(0, REPLY_SETTLES - since) + 50);
    }
    body.replaceChildren();

    // The conversation opens with a line saying when it started, drawn as the notes of what the
    // window opened are.
    if (view === 'main') body.append(div('chat-message event chat-start', startedLine(messagesOf('main'))));
    if (setup() && !ready()) body.append(setupNotice());
    if (view === 'main') {
      // The review's list is a card in the conversation where the review was finished, scrolling
      // with the messages either side of it. While it's still being written there's none: its
      // findings come in beside the pages, and the steps here say so (the user found a card at
      // the end, with the steps arriving above it, confusing).
      const messages = messagesOf('main');
      const at = review.finishedAt?.();
      const split = at ? messages.findIndex((m) => m.at && m.at > at) : -1;
      const before = split === -1 ? messages : messages.slice(0, split);
      body.append(...messageElements(before));
      if (at && items.length) body.append(listCard(items, at));
      body.append(...messageElements(split === -1 ? [] : messages.slice(split)));
      if (!messagesOf('main').length && ready()) body.append(div('chat-empty', 'Ask about this document, or ask for a review. Each step shows here as it’s done.'));
    } else {
      body.append(div('chat-thread-title', item.title));
      const card = review.cardFor(view);
      if (card) body.append(card);
      const thread = messagesOf(view);
      if (!thread.length && ready()) body.append(div('chat-empty', 'Ask about this, or ask for it to be improved.'));
      body.append(...messageElements(thread));
    }
    if (working()) body.append(div('chat-working', 'Working'));
    if (keepScroll === null) body.scrollTop = body.scrollHeight;
    else body.scrollTop = keepScroll;
    renderChips();
    renderCompose();
  }

  // The chosen AI isn't ready: what to do about it, a click each. The install runs its maker's own
  // installer; the sign-in opens the maker's page in the browser, and SmartDoc never sees it.
  function setupNotice() {
    const s = setup();
    const box = div('chat-setup');
    const act = (label, kind, run) => {
      // While it runs, how it's getting on takes the button's place: the step, and the percentage
      // done (or a spinner).
      if (busy === kind) {
        const strip = div('chat-setup-progress');
        strip.append(progressLine(s.id, kind === 'install' ? `Getting ready to install ${s.tool}…` : 'Waiting for you to sign in in your browser…'), progressMark(s.id));
        return strip;
      }
      const b = button('primary-button', label, async () => {
        busy = kind;
        draw(true);
        try {
          statuses = await run();
        } catch (error) {
          addLocal('main', { role: 'error', text: failureText(error) });
        }
        busy = null;
        clearAiProgress(s.id);
        showChoice();
        draw(true);
      });
      b.disabled = Boolean(busy);
      return b;
    };
    if (!s.installed) {
      box.append(div('chat-setup-text', `To work with ${s.name} here, SmartDoc installs ${s.tool}, ${s.name}’s own app for this, then you sign in with your ${s.name} account in your browser.`));
      if (s.installers?.length) box.append(act(`Install ${s.tool}`, 'install', () => api.agentInstall(s.id)));
      else box.append(button('primary-button', `Get ${s.tool}`, () => api.agentInstallHelp(s.id)), button('secondary-button', 'Check again', checkSetup));
    } else {
      box.append(div('chat-setup-text', `Sign in to ${s.name} to work with it here. Your browser opens ${s.name}’s own sign-in page; SmartDoc never sees your sign-in.`));
      box.append(act(`Sign in to ${s.name}`, 'sign-in', () => api.agentSignIn(s.id)));
    }
    const other = Object.values(statuses ?? {}).find((o) => o.id !== s.id && o.installed && o.loggedIn);
    if (other) box.append(button('secondary-button', `Use ${other.name} instead`, () => choose(other.id)));
    box.append(div('chat-setup-note', 'Or use another AI app: the focus card in the top bar copies a prompt for it.'));
    return box;
  }

  // Every item of the review as a row: its kind's icon, title and where it stands.
  // Folded to its header row (what it is and how many are left to decide) unless the user has
  // opened it: the cards beside the pages are the way in, the list a summary. Kept open or folded,
  // for each review (by when it was finished), while the chat is open.
  const openLists = new Set();
  function listCard(items, key) {
    const open = openLists.has(key);
    const card = div(`chat-list${open ? ' open' : ''}`);
    const decidable = items.filter((i) => i.decidable);
    const left = decidable.filter((i) => !i.decided).length;
    const headRow = button('chat-list-head', null, () => {
      if (open) openLists.delete(key);
      else openLists.add(key);
      draw(true);
    });
    headRow.setAttribute('aria-expanded', String(open));
    headRow.insertAdjacentHTML('afterbegin', '<svg class="chat-list-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>');
    headRow.append(div('chat-list-title', items.some((i) => i.type === 'highlight') ? 'Key information' : 'Findings'),
      div('chat-list-count', decidable.length ? (left ? `${left} of ${decidable.length} to decide` : `All ${decidable.length} decided`) : `${items.length}`));
    card.append(headRow);
    if (!open) return card;
    for (const item of items) {
      const row = button(`chat-row${item.decided ? ' decided' : ''}${item.type === 'earlier' ? ' earlier' : ''}`, null, () => showThread(item.id));
      row.style.setProperty('--item-color', item.color);
      const icon = div('chat-row-icon');
      icon.innerHTML = kindIcon(item);
      const thread = messagesOf(item.id).length;
      row.append(icon, div('chat-row-title', item.title), div('chat-row-state', item.decidable ? (item.decided ? '✓' : 'To decide') : thread ? `${thread}` : ''));
      row.title = `${item.label}: ${item.title}`;
      card.append(row);
    }
    return card;
  }

  // When the conversation started: today with the time, else the day (and the year if not this one).
  function startedLine(messages) {
    const first = messages.find((m) => m.at);
    if (!first) return 'New chat';
    const at = new Date(first.at);
    const now = new Date();
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (at.toDateString() === now.toDateString()) return `Chat started today, ${time}`;
    const day = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
    return `Chat started ${day}, ${time}`;
  }

  function messageElements(messages, key = conversation()) {
    const latest = messagesOf(key).at(-1)?.id;
    return messages.map((message) => {
      const node = div(`chat-message ${message.role}${message.kind ? ` ${message.kind}` : ''}`);
      if (message.role === 'assistant') node.append(...formatted(message.text));
      else if (message.role === 'step' || message.role === 'event') node.textContent = message.text;
      else for (const paragraph of message.text.split(/\n{2,}/)) node.append(div('chat-paragraph', paragraph));
      // The AI's session for the conversation has gone: while that's the latest thing, a way to
      // start a new one (the user may fix it instead, and send again).
      if (message.kind === 'session-gone' && message.id === latest && !isRunning(key)) {
        const start = button('secondary-button chat-new-session', 'Start a new session', async () => {
          start.disabled = true;
          try {
            await api.agentNewSession(message.provider, key);
          } catch (error) {
            start.disabled = false;
            addLocal(key, { role: 'error', text: failureText(error) });
          }
        });
        node.append(start);
      }
      return node;
    });
  }

  // No shortcuts for what to ask (the user took out "Review this draft" and the like): the one
  // button above the message box is the go-ahead an AI in another app (with `smartdoc wait`) is
  // waiting for, from the review's state (see margin-review.js).
  function renderChips() {
    chips.replaceChildren();
    if (view !== 'main' || !suggestion?.waiting || suggestion.sent) return;
    chips.append(button('chat-chip primary', suggestion.what === 'preview' ? 'Confirm comments to your AI' : 'Confirm changes to your AI', () => api.sendToAi(suggestion.what)));
  }

  function renderCompose() {
    const running = isRunning();
    input.disabled = !ready();
    input.placeholder = !setup() ? 'Connecting…' : !ready() ? `Set up ${aiName()} to chat here` : view === 'main' ? 'Ask…' : 'Ask about this…';
    // In the box, at its bottom right corner however tall what's written makes it.
    sendButton.innerHTML = running ? STOP_ICON : SEND_ICON;
    const name = running ? 'Stop' : 'Send';
    sendButton.title = name;
    sendButton.setAttribute('aria-label', name);
    sendButton.classList.toggle('stop', running);
    sendButton.disabled = !ready() || (!running && !input.value.trim());
  }

  // A thread fades in as it slides in from the right over the conversation, and fades out as it
  // slides back out to the right to go back
  // (unless the Mac is set to reduce motion).
  const SLIDE = { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
  const IN = [{ transform: 'translateX(48px)', opacity: 0 }, { transform: 'none', opacity: 1 }];
  const OUT = [{ transform: 'none', opacity: 1 }, { transform: 'translateX(48px)', opacity: 0 }];
  function showThread(id) {
    const next = id ?? 'main';
    const animate = open && next !== view && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Going back: what the thread showed is kept as a picture over the conversation, to slide away.
    let leaving = null;
    if (animate && next === 'main') {
      leaving = body.cloneNode(true);
      leaving.classList.add('chat-leaving');
      leaving.setAttribute('aria-hidden', 'true');
      leaving.inert = true;
      leaving.style.translate = '';
      scrollArea.append(leaving);
      leaving.scrollTop = body.scrollTop;
    }
    view = next;
    toEnd = true;
    review.focus(id);
    draw(true);
    if (leaving) {
      leaving.animate(OUT, SLIDE).finished.finally(() => leaving.remove());
    } else if (animate) {
      body.animate(IN, SLIDE);
    }
    input.focus();
  }

  // --- Docked or in a window of its own ------------------------------------------------------------
  function layout() {
    el.hidden = !open;
    el.classList.toggle('windowed', windowed);
    if (!windowed) onDock(open);
  }

  function setOpen(next) {
    if (open === next) return;
    open = next;
    toEnd = true;
    if (!open) review.focus(null);
    layout();
    if (open) {
      checkSetup();
      load();
      draw(true);
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open && view !== 'main' && el.contains(document.activeElement) && !event.target.closest('textarea:not(.chat-compose textarea), input')) showThread(null);
  });

  showChoice();

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    // Opens the chat on an item's thread (from its card beside the pages), or on the conversation.
    openItem(id) {
      setOpen(true);
      showThread(id);
    },
    view: () => view,
    // The review redrew: rows, cards and the suggestion may have changed.
    refresh: () => draw(),
    setSuggestion(next) {
      suggestion = next;
      if (open) renderChips();
    },
    // The window opened another document, variation or draft: each draft has its own chat, so it
    // shows that one's (a preview is its draft's).
    documentChanged() {
      drawnKey = null;
      if (open) load();
    },
  };
}

// Claude's replies in the light Markdown it writes: paragraphs, bullet and numbered lists, bold,
// italics and code. Everything is text: nothing it writes becomes markup of its own.
function formatted(text) {
  const blocks = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const listed = lines.every((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line));
    if (listed) {
      const list = document.createElement(/^\s*\d/.test(lines[0]) ? 'ol' : 'ul');
      list.className = 'chat-list-block';
      for (const line of lines) {
        const li = document.createElement('li');
        li.append(...inline(line.replace(/^\s*([-*•]|\d+[.)])\s+/, '')));
        list.append(li);
      }
      blocks.push(list);
    } else {
      const p = div('chat-paragraph');
      p.append(...inline(block));
      blocks.push(p);
    }
  }
  return blocks;
}

function inline(text) {
  const nodes = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) nodes.push(document.createTextNode(text.slice(at, match.index)));
    const token = match[0];
    const tag = token.startsWith('**') ? 'strong' : token.startsWith('`') ? 'code' : 'em';
    const node = document.createElement(tag);
    node.textContent = token.slice(tag === 'strong' ? 2 : 1, tag === 'strong' ? -2 : -1);
    nodes.push(node);
    at = match.index + token.length;
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  return nodes;
}

function div(className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onclick) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  if (text != null) node.textContent = text;
  node.addEventListener('click', onclick);
  return node;
}

function iconButton(icon, name, onclick) {
  const node = button('icon-button', null, onclick);
  node.innerHTML = icon;
  node.title = name;
  node.setAttribute('aria-label', name);
  return node;
}
