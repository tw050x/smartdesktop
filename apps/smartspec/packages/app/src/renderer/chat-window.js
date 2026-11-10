import { NO_REVIEW, createChatPanel } from './chat-panel.js';
import { installTooltips } from './tooltips.js';

// The chat floating in a window of its own, attached to an app window (see main.js): the app's
// window sends what it shows (`onChatState`: which chat, home's or a schematic draft's, what to say
// while the chat is empty, and the shortcuts of what to ask the AI, which that window acts on when asked:
// `chatAction`), and everything here acts on that window, as if done there.

export function startChatWindow(api) {
  document.body.classList.add(`platform-${api.platform}`);
  installTooltips();
  let shown = { chatId: null, hint: null };
  const chat = createChatPanel({
    el: document.getElementById('chat-panel'),
    api,
    review: NO_REVIEW,
    windowed: true,
    chatId: () => shown.chatId,
    emptyHint: () => shown.hint,
    shortcuts: () => shown.shortcuts ?? [],
    onAction: (action) => api.chatAction(action.id),
    onDock: (view) => api.chatDock(view),
    onClose: () => api.chatClose(),
  });
  api.onChatState((state) => {
    const changed = state.chatId !== shown.chatId;
    shown = state;
    if (changed) chat.documentChanged();
    chat.refresh();
  });
  // A request for the AI from the app's window (see `ask` in app-shell.js).
  api.onChatAsk?.((text) => chat.ask(text));
  chat.openItem(null);
  api.chatReady();
  return chat;
}

if (window.smartspec) startChatWindow(window.smartspec);
