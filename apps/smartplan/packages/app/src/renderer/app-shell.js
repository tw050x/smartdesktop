import { APP_MARKUP } from './app-markup.js';
import { watchArrowKeys } from './arrow-nav.js';
import { createTabStrip } from './tab-strip.js';
import { installTooltips } from './tooltips.js';
import { createIconPicker } from './icon-picker.js';
import { createBoards } from './boards.js';
import { createServerStatus } from './server-status.js';
import { createSettings } from './settings.js';
import { createUpdateToast } from './update-toast.js';

// The window's interface, given the API it works through (window.smartplan, from the preload
// script, talking to the main process). It fills the empty body with the window's markup first.
export function startApp(api) {
  document.body.innerHTML = APP_MARKUP;
  document.body.classList.add(`platform-${api.platform}`);
  // Which tab this is: Home (the only one showing home) or a board's (see main.js). A page that's
  // neither (a website's demo, one day) is a whole window, and draws the window's top bar itself
  // (tab-strip.js).
  if (api.tabKind) document.body.classList.add(`${api.tabKind}-tab`);
  else {
    const stripEl = document.getElementById('tab-strip');
    if (stripEl) {
      stripEl.hidden = false;
      const strip = createTabStrip({ el: stripEl, api });
      api.onTabs?.((state) => strip.render(state));
    }
  }
  api.onFullScreenChange((isFullScreen) => document.body.classList.toggle('full-screen', isFullScreen));
  const tooltips = installTooltips();
  // The window's top bar's tooltips, drawn here, over this page (see tooltips.js).
  api.onStripTip?.((tip) => (tip ? tooltips.showAt(tip.text, tip.box, { plain: tip.plain }) : tooltips.hide()));
  // Choosing a board's icon, from its tab's right-click menu (or its home row's: see boards.js).
  const iconPicker = createIconPicker({ api });
  api.onIconPicker?.((request) => iconPicker.open(request));
  // The lower halves of the pills under the tab showing and the tab pointed at in the window's top
  // bar (see tab-strip.js).
  const tabLines = ['active', 'hover'].map(() => Object.assign(document.createElement('div'), { className: 'tab-hover-pill below', hidden: true }));
  document.body.append(...tabLines);
  api.onTabLines?.((lines) => {
    [lines?.active, lines?.hover].forEach((box, i) => {
      tabLines[i].hidden = !box;
      if (box) Object.assign(tabLines[i].style, { left: `${box.left}px`, width: `${box.width}px` });
    });
  });
  const serverStatus = createServerStatus({ api });
  api.onAiControl((name) => serverStatus.setAiControl(name));
  createSettings({ dialog: document.getElementById('settings-dialog'), api });
  createUpdateToast({ api, name: 'SmartPlan' });
  const chat = startChat(api);
  createBoards({ el: document.getElementById('content'), bottomBar: document.getElementById('review-bar'), goal: document.getElementById('board-goal'), api, onShown: chat.shown, onCards: chat.cards, onNote: chat.note, onChooseIcon: (request) => iconPicker.open(request) });
  watchArrowKeys();
}

// The chat is SmartDesktop's (see main/desktop.js), in windows of its own over the apps', as
// SmartDoc's and SmartSpec's is. This tab tells it where it is (`shown`, from boards.js: the line for
// the chat when that changes, and what the AI is told), what to offer while it's about this tab
// (the shortcuts of what to ask the AI, an action one done here when asked, and what to say while
// the chat is empty), lines of context, and requests for the AI.
const HINTS = {
  home: 'Tell your AI what you’re planning, and it starts a board with its lists and first cards. Each step it takes shows here as it’s done.',
  board: 'Ask your AI to add, change or move cards on this board, or to plan what’s next. Each step it takes shows here as it’s done.',
};
function startChat(api) {
  let showing = { where: null, hint: null };
  // What to ask the AI about what the tab shows (see reviewBar in boards.js), sent without their
  // `run`: the chat asks for an action one by id. (What there is to decide is in the bottom bar.)
  let shortcuts = [];
  const bare = ({ run, ...rest }) => rest;
  let sent = null;
  const send = () => {
    const next = JSON.stringify({ hint: showing.hint, shortcuts: shortcuts.map(bare) });
    if (next === sent) return;
    sent = next;
    api.chatShortcuts?.(JSON.parse(next));
  };
  api.onChatAction?.((id) => shortcuts.find((one) => one.id === id)?.run?.());
  return {
    // Where the tab went: said in the chat, as a line of context, and to the AI. Said again when the
    // board is renamed, so the tab's name follows, and as the card open changes, for what the AI is
    // told (the chat's line is keyed by where, so isn't repeated).
    shown({ chatId: where, name, line, opened = null }) {
      if (where === showing.where && name === showing.name && opened === showing.opened) return;
      showing = { where, name, opened, hint: where === 'home' ? HINTS.home : HINTS.board };
      api.chatShows?.(where, line, name, opened);
      send();
    },
    // A request for the AI: the chat sends it (opening, and starting SmartDesktop, if need be).
    ask: (text) => api.chatAsk?.(text),
    // A line of context for the chat (what the user looked at or did), for the AI with their next
    // message.
    note: (next) => api.chatNote?.(next),
    cards(_cards, nextShortcuts = []) {
      shortcuts = nextShortcuts;
      send();
    },
  };
}
