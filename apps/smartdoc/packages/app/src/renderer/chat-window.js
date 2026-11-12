import { createChatPanel } from './chat-panel.js';
import { clearAiProgress, failureText, progressLine, progressMark, trackAiProgress } from './ai-progress.js';
import { installTooltips } from './tooltips.js';
import { CHAT_TITLE } from './demo/scenario.js';

// The website demo's chat window, standing in for SmartDesktop's (its chat.html and chat.js), the
// app the chat is: its top bar, a column with the chat's tab (named by the AI after its first reply,
// "New chat" till then) and `+`, and the chat itself, SmartDesktop's own: chat-panel.js and the
// demo's desktop.css are copies of SmartDesktop's chat-panel.js and styles.css, as they are (keep
// them the same). It also shows SmartDesktop's setup window, in its place (`onChatSetup`), for the
// scene setting an AI up.
//
// The demo's stand-in API drives it, as SmartDesktop's main process drives its chat: what's said and
// whether the AI's at work (`onAgentEvent`, its window's one conversation, 'main'), what the app's
// window offers (`onChatState`: the empty chat's hint and the shortcuts, which that window acts on
// when asked: `chatAction`), and the app's tab the chat works in (`onTabs`). The same in SmartDoc
// and SmartSpec apart from the app's name.
const APP = { id: 'smartdoc', name: 'SmartDoc' };
const CHAT = 'demo';

export function startChatWindow(api) {
  document.body.classList.add(`platform-${api.platform}`);
  installTooltips();
  trackAiProgress(api);

  // What SmartDesktop's chat asks of its main process, answered by the demo's API.
  const desktop = {
    agentStatus: () => api.agentStatus(),
    chatLoad: async () => {
      const chats = await api.agentChats();
      return { messages: chats.main?.messages ?? [], running: (chats.running ?? []).includes('main') };
    },
    agentSend: async () => api.agentSend(),
    agentStop: async () => api.agentStop(),
    agentNewSession: async () => api.agentNewSession?.(),
    chatAction: (chip) => api.chatAction(chip.id),
    openSetup: () => showSetup(true),
  };

  // --- The chat window: its top bar, then a column with the chat's tab and the chat ------------
  const head = el('header', 'chat-head');
  const grid = el('main', 'chat-grid');
  const column = el('div', 'chat-column');
  const row = el('div', 'chat-tab-row');
  const tab = el('div', 'chat-tab focused');
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'true');
  const title = el('div', 'chat-tab-title');
  const close = el('button', 'chat-tab-close');
  close.type = 'button';
  close.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  tab.append(title, close);
  const plus = el('button', 'chat-tab-new');
  plus.type = 'button';
  plus.setAttribute('aria-label', 'New chat');
  plus.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  row.append(tab, plus);
  const body = el('div', 'chat-column-body');
  const section = el('section', 'chat-panel');
  body.append(section);
  column.append(row, body);
  grid.append(column);

  // SmartDesktop's setup window, shown in the chat's place for the setup scene.
  const setup = el('div', 'demo-setup panel-window');
  setup.hidden = true;
  setup.innerHTML = `<header class="panel-window-head"><h1>Set up your AI</h1></header>
    <main class="panel-window-body">
      <p class="panel-intro">SmartDesktop is the chat for SmartDoc and SmartSpec. It runs your own AI on this Mac, signed in with your own account on its maker’s site, and gives it the apps’ tools, so it can work on what you have open. SmartDesktop never sees your sign-in.</p>
      <p class="panel-intro">Set up one or both. You choose which to talk to under the chat’s message box.</p>
      <div class="ai-list" id="ai-list"></div>
    </main>
    <footer class="panel-window-foot"><button class="primary-button" type="button">Done</button></footer>`;
  const chatEl = document.getElementById('chat-panel');
  chatEl.replaceWith(head, grid, setup);

  const panel = createChatPanel({ el: section, api: desktop, chatId: CHAT });

  // The chat's tab is named after the AI's first reply.
  let named = false;
  const nameTab = () => {
    title.textContent = named ? CHAT_TITLE : 'New chat';
    tab.title = title.textContent;
    close.setAttribute('aria-label', `Close ${title.textContent}`);
  };
  nameTab();
  // The app's tab the chat works in, named at the top of its conversation ("Working in …").
  let shown = { hint: null, shortcuts: [] };
  let appTab = null;
  const tell = () => panel.setState({ tabs: appTab ? [{ app: APP.id, name: APP.name, title: appTab }] : [], hint: shown.hint ?? null, shortcuts: shown.shortcuts ?? [], connected: [APP.id] });
  api.onAgentEvent((event) => {
    if (event.conversation && event.conversation !== 'main') return;
    if (event.type === 'messages') {
      named = event.messages.some((m) => m.role === 'assistant' && m.text?.trim());
      nameTab();
    }
    panel.agentEvent(event);
  });
  api.onChatState((state) => {
    shown = state ?? {};
    tell();
  });
  api.onTabs?.((state) => {
    appTab = state.tabs.find((t) => !t.home)?.title ?? null;
    tell();
  });
  tell();
  // Shown again (for another scene), it's what the demo has now.
  api.onChatShown?.(async (on) => {
    if (!on) return;
    const now = await desktop.chatLoad();
    named = now.messages.some((m) => m.role === 'assistant' && m.text?.trim());
    nameTab();
    panel.agentEvent({ type: 'messages', messages: now.messages });
    panel.agentEvent({ type: 'running', running: now.running });
  });
  // A request for the AI from the app's window (a shortcut there): the chat sends it.
  api.onChatAsk?.((text) => panel.ask(text));
  api.onChatSetup?.((on) => showSetup(on));
  api.chatReady?.();

  // --- The setup window (SmartDesktop's setup.js, the same rows) --------------------------------
  const list = setup.querySelector('#ai-list');
  const busy = new Set();
  const failed = {};
  function showSetup(on) {
    setup.hidden = !on;
    head.hidden = on;
    grid.hidden = on;
    if (on) drawSetup();
  }
  async function drawSetup(statuses) {
    statuses ??= await api.agentStatus();
    list.replaceChildren();
    for (const s of Object.values(statuses)) {
      const row = el('div', 'ai-row');
      const text = el('div', 'ai-row-text');
      const name = el('strong');
      name.textContent = `${s.name} (${s.tool})`;
      let state = el('span');
      const ready = s.installed && s.loggedIn;
      state.textContent = ready ? `Signed in${s.account ? ` with your ${s.account}` : ''}` : s.installed ? 'Not signed in' : 'Not installed';
      if (failed[s.id] && !busy.has(s.id)) {
        state.textContent = failed[s.id];
        delete failed[s.id];
      }
      if (busy.has(s.id)) state = progressLine(s.id, s.installed ? 'Waiting for you to sign in in your browser…' : `Getting ready to install ${s.tool}…`);
      text.append(name, state);
      const maker = s.id === 'codex' ? 'OpenAI' : 'Anthropic';
      const how = !s.installed ? `Install sets up ${s.tool} with ${maker}’s own installer, then you sign in.` : !s.loggedIn ? `Sign in opens ${s.name}’s sign-in page in your browser. Sign in there, then come back.` : null;
      if (how) text.append(Object.assign(el('span', 'ai-row-how'), { textContent: how }));
      row.append(text);
      if (ready) row.append(Object.assign(el('span', 'ai-ready'), { textContent: 'Ready' }));
      else if (busy.has(s.id)) row.append(progressMark(s.id));
      else {
        const button = Object.assign(el('button', 'secondary-button'), { type: 'button', textContent: s.installed ? 'Sign in' : 'Install' });
        button.addEventListener('click', async () => {
          busy.add(s.id);
          drawSetup(statuses);
          let next = null;
          try {
            next = await (s.installed ? api.agentSignIn(s.id) : api.agentInstall(s.id));
          } catch (error) {
            failed[s.id] = failureText(error);
          }
          busy.delete(s.id);
          clearAiProgress(s.id);
          if (!setup.hidden) drawSetup(next ?? undefined);
        });
        row.append(button);
      }
      list.append(row);
    }
  }

  return panel;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
