const { contextBridge, ipcRenderer } = require('electron');

// Requests resolve with their value, or reject with the main process's error message.
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));

contextBridge.exposeInMainWorld('smartprep', {
  platform: process.platform,
  // This window's id, which a copied prompt names so the AI can take it over.
  windowId: process.argv.find((arg) => arg.startsWith('--smartprep-window='))?.split('=')[1],
  // Which kind of tab this is: 'home' (the pinned first tab, the only one showing home) or
  // 'document' (a topic's); none for the top bar's own page (see main.js).
  tabKind: process.argv.find((arg) => arg.startsWith('--smartprep-tab='))?.split('=')[1] ?? null,
  // The top bar (tab-strip.js): the window's tabs, back and forward, and the app's status
  // (`onTabs`), choosing and closing a tab (the tab asking, without an id), stepping back or forward
  // in the active tab, and opening the status panel there. A tab says when back and forward change
  // (`historyState`), and hears the top bar's (`onHistoryStep`) and its status pill
  // (`onToggleStatus`). Home opens a topic in a tab of its own (`openInTab`: { topicId, name, card }),
  // which hears it (`onOpenTopic`), as it does an AI's cards; going home shows the Home tab.
  onTabs: on('tabs'),
  tabsState: () => call('tabs-state'),
  tabActivate: (id) => call('tab-activate', id),
  tabClose: (id) => call('tab-close', id),
  // A tab's right-click menu (`box`: its place in the top bar), and a topic's icon: the user's
  // choice (`setIcon`), from the card the tab showing draws (`onIconPicker`).
  tabMenu: (id, box) => call('tab-menu', id, box),
  // A tab's chat button: that chat, brought forward in SmartDesktop.
  tabChat: (id) => call('tab-chat', id),
  // Dragging a tab (points on the screen): to another place in the top bar, another window's, or
  // out of them all to a new window. The top bar says where its tabs are (`tabBoxes`), and hears
  // where a tab dragged over it would go (`onTabDrop`).
  tabBoxes: (boxes) => call('tab-boxes', boxes),
  tabDragStart: (id, drag) => call('tab-drag-start', id, drag),
  tabDragMove: (point) => call('tab-drag-move', point),
  tabDragEnd: (point) => call('tab-drag-end', point),
  onTabDrop: on('tab-drop'),
  setIcon: (topicId, icon) => call('set-icon', topicId, icon),
  onIconPicker: on('icon-picker'),
  historyStep: (delta) => call('history-step', delta),
  historyState: (state) => call('history-state', state),
  onHistoryStep: on('history-step'),
  showStatus: () => call('show-status'),
  // A tooltip of the top bar's ({ text, box }, or null to put it away), drawn by the tab showing.
  stripTip: (tip) => call('strip-tip', tip),
  onStripTip: on('strip-tip'),
  // The pills under the tab showing and the tab pointed at in the top bar ({ active, hover }, each
  // { left, width } or null), drawn by the tab showing too, as their lower halves are over its page.
  tabLines: (lines) => call('tab-lines', lines),
  onTabLines: on('tab-lines'),
  onToggleStatus: on('toggle-status'),
  openInTab: (request) => call('open-in-tab', request),
  onOpenTopic: on('open-topic'),
  // A card the AI shows the user, brought to the middle of the board ({ topicId, card }).
  onShowCard: on('show-card'),
  goHome: () => call('go-home'),
  onAiControl: on('ai-control'),
  releaseAiControl: () => call('ai-control-release'),
  // The topics (see store.js): home's list, a topic's board and its cards in full, a card the user
  // has read, the user's questions (asked, and marked as needing nothing more), and where each
  // card is on the board, kept on this Mac (see layouts.js).
  listTopics: () => call('list-topics'),
  getTopic: (id) => call('get-topic', id),
  getCards: (id) => call('get-cards', id),
  markRead: (id, cardId) => call('mark-read', id, cardId),
  listQuestions: (id) => call('list-questions', id),
  addQuestion: (id, question) => call('add-question', id, question),
  setNoFurtherAction: (id, questionId, flag) => call('set-no-further-action', id, questionId, flag),
  getLayout: (id) => call('get-layout', id),
  saveLayout: (id, layout) => call('save-layout', id, layout),
  // Home's right-click menu on a topic: renaming it, and deleting it (asked first, in the main process).
  renameTopic: (id, name) => call('rename-topic', id, name),
  deleteTopic: (id) => call('delete-topic', id),
  showHomeMenu: (items) => call('home-menu', items),
  copyText: (text) => call('copy-text', text),
  onTopicsChanged: on('topics-changed'),
  onNewTopic: on('new-topic'),
  mcpSetup: (target) => call('mcp-setup', target),
  copyMcpSetup: (target) => call('copy-mcp-setup', target),
  // Claude Desktop's setup: { state }, and adding SmartPrep to it (after asking).
  claudeDesktopStatus: () => call('claude-desktop-status'),
  addToClaudeDesktop: () => call('add-to-claude-desktop'),
  // Updates (see updates.js): where they stand, checking now, and restarting into a downloaded one.
  getUpdates: () => call('get-updates'),
  installUpdate: () => call('install-update'),
  // Light, dark or as the system is ('light', 'dark' or 'system'), from Settings.
  getAppearance: () => call('get-appearance'),
  setAppearance: (appearance) => call('set-appearance', appearance),
  onMcpStatus: on('mcp-status'),
  mcpStatus: () => call('mcp-status'),
  retryMcp: () => call('mcp-retry'),
  onShowConnect: on('show-connect'),
  onUpdates: on('updates'),
  // The SmartPrep menu's Settings….
  onShowSettings: on('show-settings'),
  onFullScreenChange: on('full-screen'),
  // The chat, in SmartDesktop (see main/desktop.js): the window's chat button (`chatToggle`, and
  // `onChatOpen` as it opens and closes), where the window is ('home', or a topic's id,
  // with the chat's line for it, the topic's name and the cards in the middle), what to offer there
  // (`chatShortcuts`: { hint, shortcuts }) and the actions it asks of this window (`onChatAction`),
  // lines of context (`chatNote`), and requests for the AI (`chatAsk`); and where SmartDesktop
  // stands ('connected', 'starting', 'off' or 'missing').
  chatToggle: () => call('chat-toggle'),
  onChatOpen: on('chat-open'),
  chatShows: (where, line, name, middle) => call('chat-shows', where, line, name, middle),
  chatShortcuts: (state) => call('chat-shortcuts', state),
  onChatAction: on('chat-action'),
  chatNote: (note) => call('chat-note', note),
  chatAsk: (text) => call('chat-ask', text),
  desktopStatus: () => call('desktop-status'),
  onDesktopStatus: on('desktop-status'),
  getDesktop: () => call('get-desktop'),
});
