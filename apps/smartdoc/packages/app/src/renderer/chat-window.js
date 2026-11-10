import { createChatPanel } from './chat-panel.js';
import { createMarginReview } from './margin-review.js';
import { installTooltips } from './tooltips.js';

// The chat floating in a window of its own, attached to an app window (see main/chat-window.js).
// It shows the same review as that window: the app's window sends what its review shows
// (`onChatState`), and this one lays it out with the same code, only with no pages or margins,
// for the chat's list and cards. Choosing an item brings its text forward in the app's window,
// and everything the user decides acts on that window's review, as if done there. The website's
// demo starts it too (demo-chat.html), with its stand-in API.

export function startChatWindow(api) {
  document.body.classList.add(`platform-${api.platform}`);
  installTooltips();
  const offPage = () => document.createElement('div');
  let chat = null;
  const review = createMarginReview({
    layer: offPage(),
    pagesEl: offPage(),
    bar: offPage(),
    api,
    onMarks: () => {},
    onCompare: () => {},
    pagesResized: () => false,
    onReveal: () => {},
    onOpenItem: (id) => chat?.openItem(id),
    onSuggestion: (next) => chat?.setSuggestion(next),
    onChange: () => chat?.refresh(),
    onClearFilter: () => {},
  });

  chat = createChatPanel({
    el: document.getElementById('chat-panel'),
    api,
    windowed: true,
    // Its item stands out in the app's window, not here.
    review: { ...review, focus: (id) => api.chatFocus(id) },
    onDock: (view) => api.chatDock(view),
    onClose: () => api.chatClose(),
  });

  // What it should show first waits for the review to arrive, as an item opened in the tray needs it.
  let docId = null;
  let first;
  api.onChatState((state) => {
    review.update(state);
    // Each draft has its own chat: another draft, variation or document shows that one's.
    const showing = state.chatDraft ?? null;
    if (showing !== docId) {
      docId = showing;
      chat.documentChanged();
    }
    if (first !== undefined) {
      chat.openItem(first);
      first = undefined;
    }
    chat.refresh();
  });
  api.onChatOpenItem((id) => chat.openItem(id));
  chat.openItem(null);
  api.chatReady().then(({ view } = {}) => {
    first = view && view !== 'main' ? view : null;
  });
  return chat;
}

if (window.smartdoc) startChatWindow(window.smartdoc);
