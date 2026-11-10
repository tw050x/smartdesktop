import { APP_MARKUP } from './app-markup.js';
import { watchArrowKeys } from './arrow-nav.js';
import { NO_REVIEW, createChatPanel } from './chat-panel.js';
import { installTooltips } from './tooltips.js';
import { createSchemas } from './schemas.js';
import { createServerStatus } from './server-status.js';
import { createSettings } from './settings.js';
import './selection.js';

// The window's interface, given the API it works through (window.smartspec, from the preload
// script, talking to the main process). It fills the empty body with the window's markup first.
export function startApp(api) {
  document.body.innerHTML = APP_MARKUP;
  document.body.classList.add(`platform-${api.platform}`);
  api.onFullScreenChange((isFullScreen) => document.body.classList.toggle('full-screen', isFullScreen));
  installTooltips();
  const serverStatus = createServerStatus({ api });
  api.onAiControl((name) => serverStatus.setAiControl(name));
  createSettings({ dialog: document.getElementById('settings-dialog'), api });
  const chat = startChat(api);
  createSchemas({ el: document.getElementById('content'), bottomBar: document.getElementById('review-bar'), crumbs: document.getElementById('breadcrumb'), draftNav: document.getElementById('draft-nav'), modeCard: document.getElementById('mode-card'), focusMenu: document.getElementById('focus-menu'), viewSwitch: document.getElementById('view-switch'), api, onShown: chat.shown, onCards: chat.cards, onAsk: chat.ask, onNote: chat.note });
  watchArrowKeys();
}

// The chat with the user's own AI (see chat-panel.js), as SmartDoc's: docked, a column at the
// right the window makes room for; or floating in a window of its own (chat.html), opening again
// the way it was last. Each draft of a schematic has its own chat, and home one of its own: the
// window says which (`shown`, from schemas.js), to the docked chat and to the floating one.
const HINTS = {
  home: 'Ask your AI for a new schematic, or about the ones you have. Each step it takes shows here as it’s done.',
  schematic: 'Ask about this schematic, or ask for a change. Each step your AI takes shows here as it’s done.',
};
function startChat(api) {
  let showing = { chatId: null, hint: null };
  let floating = false;
  const CHAT_WINDOW_KEY = 'chat-in-window';
  const prefersWindow = () => {
    try {
      return localStorage.getItem(CHAT_WINDOW_KEY) === '1';
    } catch {
      return false;
    }
  };
  const rememberWindow = (inWindow) => {
    try {
      localStorage.setItem(CHAT_WINDOW_KEY, inWindow ? '1' : '0');
    } catch {}
  };
  // What to ask the AI about what the window shows (see reviewBar in schemas.js), as shortcuts over
  // the chat's message box; the floating window is sent them without their `run`, and asks for one
  // by id. (What there is to decide is in the bottom bar, not in the chat.)
  let shortcuts = [];
  const bare = ({ run, ...rest }) => rest;
  const plainShortcuts = () => shortcuts.map(bare);
  const sendState = () => {
    if (floating) api.chatState?.({ ...showing, shortcuts: plainShortcuts() });
  };
  const runAction = (id) => shortcuts.find((one) => one.id === id)?.run?.();
  api.onChatAction?.(runAction);
  const button = document.getElementById('chat-button');
  let panel = null;
  panel = createChatPanel({
    el: document.getElementById('chat-panel'),
    api,
    review: NO_REVIEW,
    chatId: () => showing.chatId,
    emptyHint: () => showing.hint,
    shortcuts: plainShortcuts,
    onAction: (action) => runAction(action.id),
    onDock: (on) => {
      document.body.classList.toggle('chat-docked', on);
      if (panel) showButton();
    },
    onFloat: (view) => api.chatFloat?.(view),
  });
  function showButton() {
    const on = panel.isOpen() || floating;
    button.setAttribute('aria-pressed', String(on));
    const name = on ? 'Close the chat' : 'Open the chat';
    button.title = name;
    button.setAttribute('aria-label', name);
  }
  button.addEventListener('click', () => {
    if (floating) api.chatClose?.();
    else if (panel.isOpen()) panel.setOpen(false);
    else if (prefersWindow() && api.chatFloat) api.chatFloat('main');
    else panel.setOpen(true);
    showButton();
  });
  // The chat's own window opened, docked back or closed.
  api.onChatMode?.(({ mode }) => {
    floating = mode === 'floating';
    if (mode !== 'closed') rememberWindow(floating);
    if (floating) {
      panel.setOpen(false);
      sendState();
    } else if (mode === 'docked') {
      panel.setOpen(true);
    }
    showButton();
  });
  showButton();
  return {
    shown({ chatId, name }) {
      const next = { chatId, hint: chatId === 'home' ? HINTS.home : HINTS.schematic, name };
      if (next.chatId === showing.chatId) return;
      showing = next;
      panel.documentChanged();
      sendState();
    },
    // A request for the AI, sent from the chat, docked or floating (opening it if it's closed).
    ask(text) {
      if (floating) return api.chatAsk?.(text);
      if (!panel.isOpen() && prefersWindow() && api.chatFloat) {
        // The request follows the floating chat as it starts (main.js holds it till it's ready).
        return api.chatFloat('main').then(() => api.chatAsk?.(text));
      }
      panel.ask(text);
      showButton();
    },
    // A line of context for the chat (what the user looked at or did), for the AI with their next
    // message, in the chat of what the window shows.
    note(next) {
      if (showing.chatId) api.chatNote?.(showing.chatId, next);
    },
    cards(_cards, nextShortcuts = []) {
      shortcuts = nextShortcuts;
      panel.shortcutsChanged();
        sendState();
    },
  };
}
