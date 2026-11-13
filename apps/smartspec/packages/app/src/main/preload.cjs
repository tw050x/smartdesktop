const { contextBridge, ipcRenderer } = require('electron');

// Requests resolve with their value, or reject with the main process's error message.
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));

contextBridge.exposeInMainWorld('smartspec', {
  platform: process.platform,
  // This window's id, which a copied prompt names so the AI can take it over.
  windowId: process.argv.find((arg) => arg.startsWith('--smartspec-window='))?.split('=')[1],
  // Which kind of tab this is: 'home' (the pinned first tab, the only one showing home) or
  // 'document' (a schematic's); none for the top bar's own page (see main.js).
  tabKind: process.argv.find((arg) => arg.startsWith('--smartspec-tab='))?.split('=')[1] ?? null,
  // The top bar (tab-strip.js): the window's tabs, back and forward, and the app's status
  // (`onTabs`), choosing and closing a tab (the tab asking, without an id), stepping back or forward
  // in the active tab, and opening the status panel there. A tab says when back and forward change
  // (`historyState`), and hears the top bar's (`onHistoryStep`) and its status pill
  // (`onToggleStatus`). Home opens a schematic in a tab of its own (`openInTab`: { path, layout }),
  // which hears it (`onOpenLevel`); going home shows the Home tab.
  onTabs: on('tabs'),
  tabsState: () => call('tabs-state'),
  tabActivate: (id) => call('tab-activate', id),
  tabClose: (id) => call('tab-close', id),
  // A tab's right-click menu (`box`: its place in the top bar), and a schematic's icon: the user's
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
  setIcon: (schemaId, icon) => call('set-icon', schemaId, icon),
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
  onOpenLevel: on('open-level'),
  goHome: () => call('go-home'),
  onAiControl: on('ai-control'),
  releaseAiControl: () => call('ai-control-release'),
  // The schemas (see store.js): what there is, and the user's answer to a proposal.
  listSchemas: () => call('list-schemas'),
  listFocuses: (id, options) => call('list-focuses', id, options),
  copyText: (text) => call('copy-text', text),
  listDrafts: (id) => call('list-drafts', id),
  getSchema: (id, draftId) => call('get-schema', id, draftId),
  getProposal: (id) => call('get-proposal', id),
  getItem: (id, itemId, options) => call('get-item', id, itemId, options),
  getConnections: (id, options) => call('get-connections', id, options),
  listComments: (id, options) => call('list-comments', id, options),
  listEarlierComments: (id, options) => call('list-earlier-comments', id, options),
  // Where the user has placed things in a schematic's focus view, kept on this computer only.
  getLayout: (id) => call('get-layout', id),
  saveLayout: (id, layout) => call('save-layout', id, layout),
  listGroups: () => call('list-groups'),
  createGroup: (name, folderId) => call('create-group', name, folderId),
  renameGroup: (id, name) => call('rename-group', id, name),
  deleteGroup: (id) => call('delete-group', id),
  moveSchema: (schemaId, groupId) => call('move-schema', schemaId, groupId),
  folders: () => call('folders'),
  createFolder: (name, parentId) => call('create-folder', name, parentId),
  renameFolder: (id, name) => call('rename-folder', id, name),
  deleteFolder: (id) => call('delete-folder', id),
  moveFolder: (id, parentId) => call('move-folder', id, parentId),
  moveGroup: (groupId, folderId) => call('move-group', groupId, folderId),
  showHomeMenu: (items) => call('home-menu', items),
  addComment: (id, comment) => call('add-comment', id, comment),
  deleteComment: (id, commentId) => call('delete-comment', id, commentId),
  setNoFurtherAction: (id, commentId, flag) => call('set-no-further-action', id, commentId, flag),
  acceptProposal: (id) => call('accept-proposal', id),
  // The user's approval of one change in the proposal (an item's id, or 'contract'), or taking it back.
  approveChange: (id, key, flag) => call('approve-change', id, key, flag),
  sendComments: (id) => call('send-comments', id),
  // The proposals an AI in another app is waiting on (`smartspec wait`), and when that changes.
  aiWaiting: () => call('ai-waiting'),
  onAiWaiting: on('ai-waiting'),
  discardProposal: (id) => call('discard-proposal', id),
  onSchemasChanged: on('schemas-changed'),
  onShowSchema: on('show-schema'),
  onNewSchema: on('new-schema'),
  mcpSetup: (target) => call('mcp-setup', target),
  copyMcpSetup: (target) => call('copy-mcp-setup', target),
  // Claude Desktop's setup: { state }, and adding SmartSpec to it (after asking).
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
  // The SmartSpec menu's Settings….
  onShowSettings: on('show-settings'),
  onFullScreenChange: on('full-screen'),
  // The chat, in SmartDesktop (see main/desktop.js): the window's chat button (`chatToggle`, and
  // `onChatOpen` as it opens and closes), where the window is ('home', or a schematic's draft or
  // proposal, with the chat's line for it and the schematic's name), what to offer there
  // (`chatShortcuts`: { hint, shortcuts }) and the actions it asks of this window (`onChatAction`),
  // lines of context (`chatNote`), and requests for the AI (`chatAsk`); and where SmartDesktop
  // stands ('connected', 'starting', 'off' or 'missing').
  chatToggle: () => call('chat-toggle'),
  onChatOpen: on('chat-open'),
  chatShows: (where, line, name) => call('chat-shows', where, line, name),
  chatShortcuts: (state) => call('chat-shortcuts', state),
  onChatAction: on('chat-action'),
  chatNote: (note) => call('chat-note', note),
  chatAsk: (text) => call('chat-ask', text),
  desktopStatus: () => call('desktop-status'),
  onDesktopStatus: on('desktop-status'),
  getDesktop: () => call('get-desktop'),
});
