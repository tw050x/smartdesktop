import { customScrollbar } from './scrollbar.js';
import { rubberBand } from './rubber-band.js';
import { failureText } from './ai-progress.js';

// A chat: where the user works with their own Claude or ChatGPT (see main/agent.js) on what's open
// in its own tabs in SmartDoc and SmartSpec (each chat owns at most one tab in each). The chat
// window holds several, each in a tab, in columns side by side (chat.js); this is one of them, the
// one its column shows. A quiet line at the top of its conversation names its tabs in the apps, the
// empty chat says what to ask there, and the shortcuts over the message box are theirs. Without an
// AI set up, it says so, and the setup window does the rest.
//
// It came from the chat SmartDoc and SmartSpec each had (chat-panel.js, before SmartDesktop): one
// conversation, no threads (the user found them hard to find and unclear), and nothing to decide in
// it: that's done in the apps, where what's decided is. What the user does there is posted to the
// conversation as quiet lines of context (see note in main/agent.js), which go to the AI with their
// next message, so it knows what they mean; the message box says what a question would be about.
// Above it are shortcuts, things to ask the AI ({ id, label, text } sends `text`; without it, the
// app does the action, `chatAction`), with the follow-up questions the AI suggested at the end of
// its last reply: passing, each showing until it's used or the user sends something, and back only
// once what brought it has gone and come again (`key` says which it is).
const DEFAULT_HINT = 'Ask about what’s open in SmartDoc or SmartSpec, or ask your AI to work on it. Each step shows here as it’s done.';
const CHATLESS_HINT = 'Open SmartDoc or SmartSpec to chat';

// The send button's icons: an up arrow with a chevron head to send, a square to stop the AI.
const SEND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';

export function createChatPanel({ el, api, chatId }) {
  let chat = null; // { messages, running }
  // What its tabs in the apps say (see main.js's chatState): { tabs, hint, shortcuts }, and which
  // apps are connected.
  let state = { tabs: [], hint: null, shortcuts: [], connected: [] };
  // The AIs it can run (see main/agent.js), where each stands, and the one chosen: each chat keeps
  // its own (two chats side by side can talk to different AIs), a new one starting with the AI
  // chosen last.
  let statuses = null; // { claude: { name, tool, installed, loggedIn, … }, codex: … }
  let provider = readChoice();
  let loaded = false; // the conversation has been asked for at least once (see load)
  let drawnKey = null; // what the conversation was drawn from, so it's only redrawn when that changes
  let toEnd = true; // the next drawing starts at the end: on opening, on sending

  // --- Structure ------------------------------------------------------------------------------
  el.className = 'chat-panel';
  el.setAttribute('aria-label', 'Chat');
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
  // The conversation scrolls with the apps' own scrollbar, over its right edge.
  const scrollArea = div('chat-scroll');
  const scrollbar = div('scrollbar chat-scrollbar');
  scrollbar.setAttribute('aria-hidden', 'true');
  scrollbar.append(div('scrollbar-thumb'));
  scrollArea.append(body, scrollbar);
  el.append(aiMenu, scrollArea, foot);
  new ResizeObserver(() => el.style.setProperty('--chat-foot', `${foot.offsetHeight}px`)).observe(foot);

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
  const messages = () => chat?.messages ?? [];
  const isRunning = () => Boolean(chat?.running);
  // Working, at the end of the conversation, whenever the AI is busy, except while its reply is
  // coming in (the user's choice: the reply shows it). A reply arrives whole, and the AI often
  // finishes a moment after, so it's hidden for a few seconds after one arrives; still busy after
  // that, it's at work on something more, and it shows again.
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
  // Neither app open: the AI would have no tools, so nothing can be sent, and it says why.
  const chatless = () => !state.connected?.length;

  async function send(text) {
    text = text.trim();
    if (!text || isRunning() || !ready() || chatless()) return;
    input.value = '';
    toEnd = true;
    // Sending anything puts away the shortcuts showing.
    for (const chip of chipsShown) dismissed.add(chip.key);
    renderChips();
    try {
      await api.agentSend(chatId, provider, text, { model: model() });
    } catch (error) {
      addLocal({ role: 'error', text: failureText(error) });
    }
    renderCompose();
  }
  const stop = () => api.agentStop(chatId);

  // Sends the AI a request (the user wanted a button asking the AI to do something to do it, not fill
  // the message box); if it can't go now (no AI set up, or the AI busy), it's put in the message box
  // instead, to send when it can.
  async function ask(text) {
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

  // A message only this window knows of (an error before the AI ran), shown until the next load, so
  // an error is never lost: the user found their message gone and nothing said.
  function addLocal(message) {
    chat ??= { messages: [], running: false };
    chat.messages = [...chat.messages, { id: `local-${Date.now()}`, ...message }];
    draw(true);
  }

  // What its AI does (chat.js passes on this chat's events).
  function agentEvent(event) {
    chat ??= { messages: [], running: false };
    if (event.type === 'messages') chat.messages = event.messages;
    else if (event.type === 'running') chat.running = event.running;
    else if (event.type === 'error') return addLocal({ role: 'error', text: event.error });
    draw(event.type === 'running'); // a new message redraws; following the end only if the user is at it
  }

  async function load() {
    toEnd = true;
    try {
      chat = await api.chatLoad(chatId);
    } catch {
      chat = null;
    }
    loaded = true;
    draw(true);
  }

  // Where each AI stands. Asked again whenever the chat gets the focus, as it may have been set up
  // in the meantime, and every few seconds while the chosen one isn't ready.
  let checking = null;
  async function checkSetup() {
    try {
      statuses = (await api.agentStatus()) ?? {};
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
    clearTimeout(checking);
    if (!ready()) checking = setTimeout(checkSetup, 5000);
  }
  window.addEventListener('focus', () => checkSetup());

  // --- Which AI ----------------------------------------------------------------------------------
  function storedChoice() {
    try {
      return localStorage.getItem(`chat-ai:${chatId}`) ?? localStorage.getItem('chat-ai');
    } catch {
      return null;
    }
  }
  // A chat with no choice of its own takes the one chosen last, and keeps it: choosing in another
  // chat later doesn't change it.
  function readChoice() {
    const id = storedChoice() ?? 'claude';
    try {
      if (localStorage.getItem('chat-ai')) localStorage.setItem(`chat-ai:${chatId}`, id);
    } catch {}
    return id;
  }
  // Choosing an AI that isn't set up opens the setup (the user's choice).
  function choose(id) {
    provider = id;
    try {
      localStorage.setItem(`chat-ai:${chatId}`, id);
      localStorage.setItem('chat-ai', id);
    } catch {}
    showChoice();
    draw(true);
    if (statuses && !ready()) api.openSetup();
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
    renderChips();
    renderCompose();
    const list = messages();
    const key = JSON.stringify([provider, setup(), isRunning(), working(), chatless(), workingIn(), list.length, list.at(-1)?.id, list.at(-1)?.text?.length]);
    if (!force && key === drawnKey) return;
    // The conversation is read from its end: it opens at the bottom and stays there as things
    // arrive, unless the user has scrolled up to read, when it stays where they are.
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    const keepScroll = !toEnd && drawnKey && !atEnd ? body.scrollTop : null;
    toEnd = false;
    drawnKey = key;

    // Once a reply has settled, if the AI's still busy, the working line comes back.
    clearTimeout(settleTimer);
    if (isRunning() && replyArriving() && !list.at(-1)?.streaming) {
      const since = Date.now() - Date.parse(list.at(-1).at);
      settleTimer = setTimeout(() => draw(), Math.max(0, REPLY_SETTLES - since) + 50);
    }
    body.replaceChildren();
    // The conversation opens with a line saying when it started.
    body.append(div('chat-message event chat-start', startedLine(list)));
    if (workingIn()) body.append(div('chat-working-in', workingIn()));
    if (setup() && !ready()) body.append(setupNotice());
    body.append(...messageElements(list));
    if (!list.length && ready()) body.append(div('chat-empty', chatless() ? CHATLESS_HINT : state.hint ?? DEFAULT_HINT));
    if (working()) body.append(div('chat-working', 'Working'));
    if (keepScroll === null) body.scrollTop = body.scrollHeight;
    else body.scrollTop = keepScroll;
  }

  // Its tabs in the apps, quietly, at the top of the conversation ("Working in SmartDoc · CV and
  // SmartSpec · Checkout").
  function workingIn() {
    const tabs = (state.tabs ?? []).map((t) => (t.title ? `${t.name} · ${t.title}` : t.name));
    if (!tabs.length) return null;
    return `Working in ${tabs.length > 1 ? `${tabs.slice(0, -1).join(', ')} and ${tabs.at(-1)}` : tabs[0]}`;
  }

  // The chosen AI isn't ready: a card saying so, opening the setup (the user's choice: installing
  // and signing in are done there), or offering an AI that is ready.
  function setupNotice() {
    const s = setup();
    const box = div('chat-setup');
    box.append(div('chat-setup-text', s.installed
      ? `Sign in to ${s.name} to work with it here: the setup opens ${s.name}’s own sign-in page in your browser.`
      : `To work with ${s.name} here, set up ${s.tool}, ${s.name}’s own app for this, and sign in with your ${s.name} account.`));
    const actions = div('chat-setup-actions');
    actions.append(button('primary-button', `Set Up ${s.name}`, () => api.openSetup()));
    const other = Object.values(statuses ?? {}).find((o) => o.id !== s.id && o.installed && o.loggedIn);
    if (other) actions.append(button('secondary-button', `Use ${other.name} instead`, () => choose(other.id)));
    box.append(actions);
    return box;
  }

  // --- Shortcuts ----------------------------------------------------------------------------------
  // Passing (see above): each shows until it's used or the user sends something, and comes back only
  // once what brought it has gone and come again. The app window's own (what to ask the AI there, or
  // the go-ahead an AI in another app is waiting for), then the questions the AI suggested at the
  // end of its last reply, while nothing has been said since.
  const dismissed = new Set();
  let chipsShown = [];
  function chipsNow() {
    const all = [...(state.shortcuts ?? [])];
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
        else api.chatAction(chip);
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

  // What the user is looking at in an app, if they've looked at something since they last wrote (a
  // context line with `about`): what a question would be about, which the message box says.
  function askingAbout() {
    const list = messages();
    const since = list.slice(list.findLastIndex((m) => m.role === 'user') + 1);
    const thing = since.findLast((m) => m.kind === 'context' && m.focus)?.about;
    return thing ? (thing.length > 40 ? `“${thing.slice(0, 39)}…”` : `“${thing}”`) : null;
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
      else if (message.role === 'event') eventLine(node, message);
      else if (message.role === 'step') node.textContent = message.text;
      else for (const paragraph of message.text.split(/\n{2,}/)) node.append(div('chat-paragraph', paragraph));
      // The AI's session for the conversation has gone: while that's the latest thing, a way to
      // start a new one (the user may fix it instead, and send again).
      if (message.kind === 'session-gone' && message.id === latest && !isRunning()) {
        const start = button('secondary-button chat-new-session', 'Start a new session', async () => {
          start.disabled = true;
          try {
            await api.agentNewSession(chatId, message.provider);
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

  // A line of context or where things went, always one line: what doesn't fit ends in "…", whole
  // on hover. Where a tab went (or a new session) is drawn across the conversation, between rules;
  // what the user did in it is a plain line with its verb's icon (see ACTION_ICONS).
  function eventLine(node, message) {
    const text = div('chat-event-text', message.text);
    node.title = message.text;
    if (message.kind === 'context' && !isMove(message)) {
      node.classList.add('action');
      const icon = div('chat-event-icon');
      icon.innerHTML = actionIcon(message.text);
      node.append(icon, text);
    } else node.append(text);
  }

  showChoice();
  checkSetup();
  load();

  return {
    el,
    agentEvent,
    // Typing goes to its message box.
    focus() {
      // With the cursor at the end of what's written, so typing adds to it and Backspace takes from it.
      if (document.activeElement === input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    // What its tabs in the apps say changed.
    setState(next) {
      const before = JSON.stringify(state.shortcuts);
      state = next;
      if (JSON.stringify(state.shortcuts) !== before || !loaded) renderChips();
      draw();
    },
    // Sends the AI a request (see `ask`).
    ask: (text) => ask(text),
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

// Lines saved before moves were marked as such (`move`), known by how they start.
const isMove = (message) => message.move || /^(Opened |Went home|Reviewing the proposed)/.test(message.text);

// The icon for what the user did, by the verb its line starts with (Lucide's, ISC); a dot otherwise.
const ICON = (paths) => `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ACTION_ICONS = [
  [/^(Accepted|Approved|Answered|Acknowledged|Chose|Decided)\b/, ICON('<path d="M20 6 9 17l-5-5"/>')],
  [/^(Rejected|Discarded)\b/, ICON('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')],
  [/^Skipped\b/, ICON('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>')],
  [/^Looking at\b/, ICON('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>')],
  [/^Commented on\b/, ICON('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')],
  [/^Took back\b/, ICON('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>')],
];
const actionIcon = (text) => ACTION_ICONS.find(([verb]) => verb.test(text))?.[1] ?? ICON('<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>');

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
