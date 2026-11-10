import { customScrollbar } from './scrollbar.js';
import { rubberBand } from './rubber-band.js';
import { clearAiProgress, failureText, progressLine, progressMark, trackAiProgress } from './ai-progress.js';

// The chat: where the user works with their own Claude or ChatGPT, run by the app (see
// main/agent.js), on the document showing. It opens as a sidebar on the right that moves the
// document aside, or floats in a window of its own (`windowed`, chat.html and chat-window.js)
// attached to the app's window: it moves with it, can sit anywhere, even outside it, and is on top
// of it alone (see main/chat-window.js). Each draft has its own chat. Without Claude Code or Codex,
// or signed out, it says how to set them up.
//
// The same in both apps (SmartSpec's chat-panel.js; keep the two alike): only these first lines differ.
const APP_NAME = 'SmartDoc';
const DEFAULT_HINT = 'Ask about this document, or ask for a review. Each step shows here as it’s done.';
const CHATLESS_HINT = 'Open a document to chat about it';
const OTHER_APP_NOTE = 'Or use another AI app: the focus card in the top bar copies a prompt for it.';

const DOCK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/></svg>';
const FLOAT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><rect x="11" y="10" width="7" height="7" rx="1"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
// The send button's icons: an up arrow with a chevron head to send, a square to stop the AI.
const SEND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
const BACK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
// Docked (in the app's window): `onDock(on)` makes room for it, `onFloat(view)` floats it instead,
// and `onResize()` says its width changed. Windowed (the floating window): `onDock(view)` docks it
// back and `onClose()` closes it.
const WIDTH_KEY = 'chat-width';
const MIN_WIDTH = 300;

// One conversation, no threads (the user found them hard to find and unclear), and nothing to decide
// in it: that's done in the window, where what's decided is. What the user does there is posted to
// the conversation as quiet lines of context (see note in main/agent.js), which go to the AI with
// their next message, so it knows what they mean; the message box says what a question would be
// about. Above it, `shortcuts()` are things to ask the AI ({ id, label, text } sends `text`; without
// it, `onAction`), with the follow-up questions the AI suggested at the end of its last reply:
// passing, each showing until it's used or the user sends something, and back only once what
// brought it has gone and come again (`key` says which it is). Plain data, so the floating window
// can be sent them. `review` gives the next step of a review to ask for (`setSuggestion`).
export function createChatPanel({ el, api, review, chatId = () => null, emptyHint = () => DEFAULT_HINT, shortcuts = () => [], onAction = () => {}, windowed = false, onDock, onFloat, onClose, onResize }) {
  let open = false;
  let chats = null; // the draft's: { chatId, main: { messages }, running: [] }
  // The AIs it can run (see main/agent.js), where each stands, and the one chosen (kept for next time).
  let statuses = null; // { claude: { name, tool, installed, loggedIn, installers, … }, codex: … }
  let provider = readChoice();
  let busy = null; // 'install' or 'sign-in' while one is under way
  let suggestion = null; // what to ask the AI next, from the review (see margin-review.js)
  let loaded = false; // the chat has been asked for at least once (see load)
  let drawnKey = null; // what the conversation was drawn from, so it's only redrawn when that changes
  let toEnd = true; // the next drawing starts at the end: on opening, on sending

  // --- Structure ------------------------------------------------------------------------------
  el.className = 'chat-panel';
  trackAiProgress(api);
  el.hidden = true;
  el.setAttribute('aria-label', 'Chat');
  const head = div('chat-head');
  const status = div('chat-status'); // a space, between the buttons at either end
  const dock = windowed
    ? iconButton(DOCK_ICON, 'Dock the chat at the side', () => onDock('main'))
    : iconButton(FLOAT_ICON, 'Float the chat in a window of its own', () => onFloat('main'));
  const close = iconButton(CROSS, 'Close the chat', () => (windowed ? onClose() : setOpen(false)));
  // In its own window, one header row, its buttons at the end. Docked, it runs the window's full
  // height: its top row is level with the top bar, its close and float buttons at the left (the
  // server's status shows over its right end).
  if (windowed) head.append(status, dock, close);
  else head.append(close, dock, status);
  // Under the message box (the user's choice), which AI it talks to and which of its models, each
  // opening a small menu above it.
  const picker = (className, onclick) => {
    const pick = button(`chat-pick ${className}`, null, onclick);
    pick.setAttribute('aria-haspopup', 'menu');
    pick.setAttribute('aria-expanded', 'false');
    pick.append(Object.assign(document.createElement('span'), { className: 'chat-pick-name' }));
    pick.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>');
    return pick;
  };
  const aiButton = picker('chat-ai', () => openChoices(aiButton, aiOptions));
  const modelButton = picker('chat-model', () => openChoices(modelButton, modelOptions));
  const pickers = div('chat-pickers');
  pickers.append(aiButton, modelButton);
  const aiMenu = div('chat-ai-menu');
  aiMenu.setAttribute('role', 'menu');
  aiMenu.hidden = true;
  let menuFor = null; // the picker whose menu is open
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
  // The shortcuts and the message box float over the bottom of the conversation, with no bar or line
  // of their own: the conversation scrolls on behind them, fading out as it goes under, and can be
  // scrolled until its end is clear of them (`--chat-foot`).
  foot.append(chips, form, pickers);
  // The conversation scrolls with the app's own scrollbar, over its right edge.
  const scrollArea = div('chat-scroll');
  const scrollbar = div('scrollbar chat-scrollbar');
  scrollbar.setAttribute('aria-hidden', 'true');
  scrollbar.append(div('scrollbar-thumb'));
  scrollArea.append(body, scrollbar);
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

  // --- Talking to the AI ------------------------------------------------------------------------
  const messages = () => chats?.main.messages ?? [];
  const isRunning = () => Boolean(chats?.running?.includes('main'));
  // Working, at the end of the conversation, whenever the AI is busy, except while its reply is
  // coming in (the user's choice: the reply shows it). A reply arrives whole, and the AI often
  // finishes a moment after, so it's hidden for a few seconds after one arrives; still busy after
  // that, it's at work on something more (the user missed it while ChatGPT went on thinking after
  // saying something), and it shows again. A reply still being written out (`streaming`, the
  // website's demo) hides it throughout.
  const REPLY_SETTLES = 3000;
  const replyArriving = () => {
    const last = messages().at(-1);
    if (last?.role !== 'assistant') return false;
    return Boolean(last.streaming) || Date.now() - Date.parse(last.at ?? 0) < REPLY_SETTLES;
  };
  const working = () => isRunning() && !replyArriving();
  let settleTimer = null;
  const setup = () => statuses?.[provider] ?? null;
  const ready = () => Boolean(setup()?.installed && setup()?.loggedIn);
  const aiName = () => setup()?.name ?? (provider === 'codex' ? 'ChatGPT' : 'Claude');
  // Nothing open behind it (its window gone home, say): nothing can be sent, and it says why.
  const chatless = () => loaded && (!chats || chats.local);

  async function send(text) {
    text = text.trim();
    if (!text || isRunning() || !ready() || chatless()) return;
    input.value = '';
    toEnd = true;
    // Sending anything puts away the shortcuts showing.
    for (const chip of chipsShown) dismissed.add(chip.key);
    renderChips();
    try {
      await api.agentSend(provider, 'main', text, chatId(), { model: model() });
    } catch (error) {
      addLocal({ role: 'error', text: error.message });
    }
    renderCompose();
  }
  const stop = () => api.agentStop('main', chatId());

  // Sends the AI a request, opening the chat on it (the user wanted a button asking the AI to do
  // something to do it, not fill the message box); if it can't go now (no AI set up, or the AI
  // busy), it's put in the message box instead, to send when it can.
  async function ask(text) {
    setOpen(true);
    if (!statuses) await checkSetup();
    if (ready() && !isRunning() && !chatless()) send(text);
    else putInBox(text);
  }

  // A prompt put in the message box, to send as it is or change first.
  function putInBox(text) {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }

  // A message only this window knows of (an error before the AI ran), shown until the next load.
  // With no chat loaded (nothing open behind it), it's shown on a stand-in, so an error is never
  // lost: the user found their message gone and nothing said.
  function addLocal(message) {
    chats ??= { chatId: null, local: true, main: { messages: [] }, running: [] };
    chats.main.messages = [...chats.main.messages, { id: `local-${Date.now()}`, ...message }];
    draw(true);
  }

  api.onAgentEvent?.((event) => {
    if (!chats || event.chatId !== chats.chatId || event.conversation !== 'main') return; // another chat
    if (event.type === 'messages') {
      chats.main.messages = event.messages;
    } else if (event.type === 'running') {
      chats.running = event.running ? ['main'] : [];
    } else if (event.type === 'error') {
      addLocal({ role: 'error', text: event.error });
      return;
    }
    draw(event.type === 'running'); // a new message redraws; following the end only if the user is at it
  });

  async function load() {
    toEnd = true;
    try {
      chats = await api.agentChats?.(chatId());
    } catch {
      chats = null;
    }
    loaded = true;
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
  // The model chosen for each AI (kept for next time), if it still offers it; else its own default.
  const modelKey = () => `chat-model-${provider}`;
  function model() {
    let chosen = null;
    try {
      chosen = localStorage.getItem(modelKey());
    } catch {}
    return chosen && (setup()?.models ?? []).some((m) => m.id === chosen) ? chosen : null;
  }
  function chooseModel(id) {
    try {
      if (id) localStorage.setItem(modelKey(), id);
      else localStorage.removeItem(modelKey());
    } catch {}
    showChoice();
  }
  const standing = (s) => (!s ? '' : s.installed && s.loggedIn ? 'Ready' : s.installed ? 'Not signed in' : 'Not installed');
  function showChoice() {
    aiButton.querySelector('.chat-pick-name').textContent = aiName();
    aiButton.title = `Working with ${aiName()}. Choose another AI.`;
    const models = setup()?.models ?? [];
    const chosen = models.find((m) => m.id === model());
    modelButton.querySelector('.chat-pick-name').textContent = chosen?.name ?? 'Default model';
    modelButton.title = chosen ? `Using ${chosen.name}. Choose another model.` : `Using ${aiName()}’s own default model. Choose another.`;
    modelButton.hidden = !ready() || !models.length;
  }
  // The menus' options: the AIs, each with where it stands; the chosen AI's models, its default first.
  function aiOptions() {
    return Object.values(statuses ?? {}).map((s) => ({ chosen: s.id === provider, name: s.name, about: `${s.tool} · ${standing(s)}`, pick: () => choose(s.id) }));
  }
  function modelOptions() {
    const now = model();
    return [
      { chosen: !now, name: 'Default', about: `${aiName()}’s own choice`, pick: () => chooseModel(null) },
      ...(setup()?.models ?? []).map((m) => ({ chosen: m.id === now, name: m.name, about: m.about, pick: () => chooseModel(m.id) })),
    ];
  }
  // A small menu above a picker, from its left edge.
  function openChoices(from, options) {
    if (!aiMenu.hidden && menuFor === from) return closeChoices();
    closeChoices();
    menuFor = from;
    aiMenu.replaceChildren();
    for (const option of options()) {
      const row = button(`chat-ai-option${option.chosen ? ' chosen' : ''}`, null, () => {
        closeChoices();
        option.pick();
      });
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(option.chosen));
      row.append(div('chat-ai-option-name', option.name));
      if (option.about) row.append(div('chat-ai-option-state', option.about));
      aiMenu.append(row);
    }
    if (!aiMenu.children.length) aiMenu.append(div('chat-ai-option-state', 'Checking…'));
    const at = from.getBoundingClientRect();
    const panel = el.getBoundingClientRect();
    aiMenu.style.right = '';
    aiMenu.style.top = '';
    aiMenu.style.left = `${at.left - panel.left}px`;
    aiMenu.style.bottom = `${panel.bottom - at.top + 4}px`;
    aiMenu.hidden = false;
    from.setAttribute('aria-expanded', 'true');
  }
  function closeChoices() {
    aiMenu.hidden = true;
    menuFor?.setAttribute('aria-expanded', 'false');
    menuFor = null;
  }
  document.addEventListener('pointerdown', (event) => {
    if (!aiMenu.hidden && !aiMenu.contains(event.target) && !menuFor?.contains(event.target)) closeChoices();
  });

  // --- Drawing ----------------------------------------------------------------------------------
  function draw(force = false) {
    if (!open) return;
    renderChips();
    renderCompose();
    const list = messages();
    const key = JSON.stringify([provider, setup(), busy, isRunning(), working(), list.length, list.at(-1)?.id, list.at(-1)?.text?.length]);
    if (!force && key === drawnKey) return;
    // The conversation is read from its end: it opens at the bottom and stays there as things
    // arrive, unless the user has scrolled up to read, when it stays where they are.
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    const keepScroll = !toEnd && drawnKey && !atEnd ? body.scrollTop : null;
    toEnd = false;
    drawnKey = key;

    // (The header doesn't say it's working: the user found the conversation's line enough.)
    // Once a reply has settled, if the AI's still busy, the line comes back.
    clearTimeout(settleTimer);
    if (isRunning() && replyArriving() && !list.at(-1)?.streaming) {
      const since = Date.now() - Date.parse(list.at(-1).at);
      settleTimer = setTimeout(() => draw(), Math.max(0, REPLY_SETTLES - since) + 50);
    }
    body.replaceChildren();
    // The conversation opens with a line saying when it started, drawn as the notes of what the
    // window opened are.
    body.append(div('chat-message event chat-start', startedLine(list)));
    if (setup() && !ready()) body.append(setupNotice());
    body.append(...messageElements(list));
    if (!list.length && ready()) body.append(div('chat-empty', emptyHint() ?? DEFAULT_HINT));
    if (working()) body.append(div('chat-working', 'Working'));
    if (keepScroll === null) body.scrollTop = body.scrollHeight;
    else body.scrollTop = keepScroll;
  }

  // The chosen AI isn't ready: what to do about it, a click each. The install runs its maker's own
  // installer; the sign-in opens the maker's page in the browser, and the app never sees it.
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
          addLocal({ role: 'error', text: failureText(error) });
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
      box.append(div('chat-setup-text', `To work with ${s.name} here, ${APP_NAME} installs ${s.tool}, ${s.name}’s own app for this, then you sign in with your ${s.name} account in your browser.`));
      if (s.installers?.length) box.append(act(`Install ${s.tool}`, 'install', () => api.agentInstall(s.id)));
      else box.append(button('primary-button', `Get ${s.tool}`, () => api.agentInstallHelp(s.id)), button('secondary-button', 'Check again', checkSetup));
    } else {
      box.append(div('chat-setup-text', `Sign in to ${s.name} to work with it here. Your browser opens ${s.name}’s own sign-in page; ${APP_NAME} never sees your sign-in.`));
      box.append(act(`Sign in to ${s.name}`, 'sign-in', () => api.agentSignIn(s.id)));
    }
    const other = Object.values(statuses ?? {}).find((o) => o.id !== s.id && o.installed && o.loggedIn);
    if (other) box.append(button('secondary-button', `Use ${other.name} instead`, () => choose(other.id)));
    box.append(div('chat-setup-note', OTHER_APP_NOTE));
    return box;
  }

  // --- Shortcuts ----------------------------------------------------------------------------------
  // Passing (see above): each shows until it's used or the user sends something, and comes back only
  // once what brought it has gone and come again. The review's next step is one too: the go-ahead an
  // AI in another app (with `wait`) is waiting for, or else what to ask the AI (but not to start a
  // review: the user took that out). Then the questions the AI suggested at the end of its last
  // reply, while nothing has been said since.
  const dismissed = new Set();
  let chipsShown = [];
  function chipsNow() {
    const all = [...shortcuts()];
    if (suggestion && !suggestion.sent && suggestion.what !== 'start') {
      all.push(suggestion.waiting
        ? { id: `confirm-${suggestion.what}`, label: suggestion.what === 'preview' ? 'Confirm comments to your AI' : 'Confirm changes to your AI', kind: 'primary', run: () => api.sendToAi(suggestion.what) }
        : { id: `ask-${suggestion.what}`, label: suggestion.label, text: suggestion.prompt });
    }
    const list = messages();
    const reply = list.findLast((m) => m.role === 'assistant' || m.role === 'user');
    if (reply?.role === 'assistant') {
      reply.suggestions?.forEach((question, n) => all.push({ id: `suggested-${n}`, key: `suggested:${reply.id}:${n}`, label: question, text: question, kind: 'suggested' }));
    }
    return all.map((chip) => ({ ...chip, key: chip.key ?? `${chip.id}:${chip.label}` }));
  }
  function renderChips() {
    const all = chipsNow();
    for (const key of [...dismissed]) if (!all.some((chip) => chip.key === key)) dismissed.delete(key);
    chipsShown = all.filter((chip) => !dismissed.has(chip.key));
    chips.replaceChildren(...chipsShown.map((chip) => {
      const press = button(`chat-chip${chip.kind ? ` ${chip.kind}` : ''}`, chip.label, () => {
        dismissed.add(chip.key);
        renderChips();
        if (chip.text) ask(chip.text);
        else if (chip.run) chip.run();
        else onAction(chip);
      });
      press.dataset.action = chip.id;
      if (chip.title) press.title = chip.title;
      press.disabled = Boolean(chip.text) && (!ready() || chatless());
      return press;
    }));
  }

  function renderCompose() {
    const running = isRunning();
    input.disabled = !ready() || chatless();
    input.placeholder = !setup() ? 'Connecting…' : !ready() ? `Set up ${aiName()} to chat here` : chatless() ? CHATLESS_HINT : askingAbout() ? `Ask about ${askingAbout()}…` : 'Ask…';
    // In the box, at its bottom right corner however tall what's written makes it.
    sendButton.innerHTML = running ? STOP_ICON : SEND_ICON;
    const name = running ? 'Stop' : 'Send';
    sendButton.title = name;
    sendButton.setAttribute('aria-label', name);
    sendButton.classList.toggle('stop', running);
    sendButton.disabled = !ready() || (!running && (chatless() || !input.value.trim()));
  }

  // What the user is looking at in the window, if they've looked at something since they last wrote
  // (a context line with `about`): what a question would be about, which the message box says.
  function askingAbout() {
    const list = messages();
    const since = list.slice(list.findLastIndex((m) => m.role === 'user') + 1);
    const about = since.findLast((m) => m.kind === 'context' && m.focus)?.about;
    return about ? (about.length > 40 ? `“${about.slice(0, 39)}…”` : `“${about}”`) : null;
  }

  // When the conversation started: today with the time, else the day (and the year if not this one).
  function startedLine(list) {
    const first = list.find((m) => m.at);
    if (!first) return 'New chat';
    const at = new Date(first.at);
    const now = new Date();
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (at.toDateString() === now.toDateString()) return `Chat started today, ${time}`;
    const day = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
    return `Chat started ${day}, ${time}`;
  }

  function messageElements(list) {
    const latest = list.at(-1)?.id;
    // A reply that was only suggested questions shows as them alone (see shortcuts).
    return list.filter((message) => message.role !== 'assistant' || message.text?.trim()).map((message) => {
      const node = div(`chat-message ${message.role}${message.kind ? ` ${message.kind}` : ''}`);
      if (message.role === 'assistant') node.append(...formatted(message.text));
      else if (message.role === 'step' || message.role === 'event') node.textContent = message.text;
      else for (const paragraph of message.text.split(/\n{2,}/)) node.append(div('chat-paragraph', paragraph));
      // The AI's session for the conversation has gone: while that's the latest thing, a way to
      // start a new one (the user may fix it instead, and send again).
      if (message.kind === 'session-gone' && message.id === latest && !isRunning()) {
        const start = button('secondary-button chat-new-session', 'Start a new session', async () => {
          start.disabled = true;
          try {
            await api.agentNewSession(message.provider, 'main', chatId());
          } catch (error) {
            start.disabled = false;
            addLocal({ role: 'error', text: failureText(error) });
          }
        });
        node.append(start);
      }
      return node;
    });
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
    layout();
    if (open) {
      checkSetup();
      load();
      draw(true);
    }
  }

  showChoice();

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    // Opens the chat (as something is chosen in the window, which it gets a line of context about).
    openItem() {
      setOpen(true);
    },
    view: () => 'main',
    // The review redrew: the suggestion may have changed.
    refresh: () => draw(),
    setSuggestion(next) {
      suggestion = next;
      if (open) renderChips();
    },
    // What there is to ask changed (see `shortcuts`).
    shortcutsChanged: () => draw(),
    // Sends the AI a request (see `ask`).
    ask: (text) => ask(text),
    // The window shows another draft (or schematic, or home): each has its own chat, so it shows
    // that one's.
    documentChanged() {
      drawnKey = null;
      if (open) load();
    },
  };
}

// The AI's replies in the light Markdown it writes: paragraphs, bullet and numbered lists, bold,
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
