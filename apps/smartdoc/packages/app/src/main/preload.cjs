const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Requests resolve with their value, or reject with the main process's error message.
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));

contextBridge.exposeInMainWorld('smartdoc', {
  platform: process.platform,
  // This window's id, which a copied prompt names so the AI can take it over.
  windowId: process.argv.find((arg) => arg.startsWith('--smartdoc-window='))?.split('=')[1],
  // Which kind of tab this is: 'home' (the pinned first tab, the only one showing home) or
  // 'document'; none for the top bar's own page (see main.js).
  tabKind: process.argv.find((arg) => arg.startsWith('--smartdoc-tab='))?.split('=')[1] ?? null,
  // The top bar (tab-strip.js): the window's tabs, back and forward, and the app's status
  // (`onTabs`), choosing and closing a tab, stepping back or forward in the active tab, and opening
  // the status panel there. A tab says when back and forward change (`historyState`), and hears
  // the top bar's (`onHistoryStep`) and its status pill (`onToggleStatus`).
  onTabs: on('tabs'),
  tabsState: () => call('tabs-state'),
  tabActivate: (id) => call('tab-activate', id),
  tabClose: (id) => call('tab-close', id),
  // A tab's right-click menu (`box`: its place in the top bar), and a document's icon: the user's
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
  setIcon: (docId, icon) => call('set-icon', docId, icon),
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
  onAiControl: on('ai-control'),
  releaseAiControl: () => call('ai-control-release'),
  // Dropped files are imported by path, as a new document.
  openDroppedFile: (file) => call('open-path', webUtils.getPathForFile(file)),
  stepDraft: (delta) => call('step-draft', delta),
  // Find: the Edit menu's commands, and the drafts on the line to search as well.
  onFind: on('find'),
  draftLine: () => call('draft-line'),
  draftPdf: (draftId) => call('draft-pdf', draftId),
  goToDraft: (draftId) => call('go-to-draft', draftId),
  sendToAi: (what) => call('send-to-ai', what),
  aiWaiting: () => call('ai-waiting'),
  onAiWaiting: on('ai-waiting'),
  onVariationRequested: on('variation-requested'),
  onDocumentMade: on('document-made'),
  variationsOf: (docId) => call('variations-of', docId),
  focusesFor: (docId, variationId, draftId, type) => call('focuses-for', docId, variationId, draftId, type),
  prepareDraft: (docId, variationId, draftId, tool) => call('prepare-draft', docId, variationId, draftId, tool),
  openDraft: (docId, variationId, draftId, tool) => call('open-draft', docId, variationId, draftId, tool),
  showDraftMenu: (draft) => call('draft-menu', draft),
  // The preview of the next draft (the AI writes it; only the user makes it a draft).
  openPreview: () => call('open-preview'),
  closePreview: () => call('close-preview'),
  previewComparison: () => call('preview-comparison'),
  acceptPreview: () => call('accept-preview'),
  discardPreview: () => call('discard-preview'),
  showVariationMenu: (variation) => call('variation-menu', variation),
  goHome: () => call('go-home'),
  showHomeMenu: (items) => call('home-menu', items),
  folders: () => call('folders'),
  onFolders: on('folders'),
  labels: () => call('labels'),
  onLabels: on('labels'),
  onLabelRequested: on('label-requested'),
  addLabel: (item, name) => call('add-label', item, name),
  removeLabel: (item, labelId) => call('remove-label', item, labelId),
  setLabelColor: (labelId, color) => call('set-label-color', labelId, color),
  setHomeFolder: (id) => call('set-home-folder', id),
  createFolder: (name, parentId) => call('create-folder', name, parentId),
  createDocument: (name, folderId) => call('create-document', name, folderId),
  renameFolder: (id, name) => call('rename-folder', id, name),
  renameDocument: (docId, name) => call('rename-document', docId, name),
  renameVariation: (docId, variationId, name) => call('rename-variation', docId, variationId, name),
  onRenameVariation: on('rename-variation'),
  onNames: on('names'),
  deleteFolder: (id) => call('delete-folder', id),
  moveFolder: (id, parentId) => call('move-folder', id, parentId),
  moveDocument: (docId, folderId) => call('move-document', docId, folderId),
  deleteDocument: (docId) => call('delete-document', docId),
  reportPageTexts: (docId, draftId, texts, details) => call('page-texts', docId, draftId, texts, details),
  addRequest: (request) => call('add-request', request),
  updateRequest: (id, changes) => call('update-request', id, changes),
  setNoFurtherAction: (id, on) => call('set-no-further-action', id, on),
  removeRequest: (id) => call('remove-request', id),
  decide: (itemId, decision) => call('decide', itemId, decision),
  mcpSetup: (target) => call('mcp-setup', target),
  listFocuses: (type) => call('list-focuses', type),
  setFocus: (reviewId) => call('set-focus', reviewId),
  setTool: (tool) => call('set-tool', tool),
  copyText: (text) => call('copy-text', text),
  copyMcpSetup: (target) => call('copy-mcp-setup', target),
  openWebsite: () => call('open-website'),
  // Claude Desktop's setup: { state, extension }, and adding SmartDoc to it (after asking).
  claudeDesktopStatus: () => call('claude-desktop-status'),
  addToClaudeDesktop: () => call('add-to-claude-desktop'),
  // Updates (see updates.js): where they stand, checking now, and restarting into a downloaded one.
  getUpdates: () => call('get-updates'),
  installUpdate: () => call('install-update'),
  // Light, dark or as the system is ('light', 'dark' or 'system'), from Settings.
  getAppearance: () => call('get-appearance'),
  setAppearance: (appearance) => call('set-appearance', appearance),
  getExperimental: () => call('get-experimental'),
  setExperimental: (name, on) => call('set-experimental', name, on),
  // The experiments' state, whenever it changes ({ convert, reader }).
  onExperimental: on('experimental'),
  // A bundled font's bytes (packages/pdf/fonts), for SmartDoc's own reader.
  readerFont: (file) => call('reader-font', file),
  onRecentDocuments: on('recent-documents'),
  onDraftOpened: on('draft-opened'),
  onDocumentClosed: on('document-closed'),
  onReview: on('review'),
  onTool: on('tool'),
  onMcpStatus: on('mcp-status'),
  mcpStatus: () => call('mcp-status'),
  // The chat, in SmartDesktop (see main/desktop.js): the window's chat button (`chatToggle`, and
  // `onChatOpen` as it opens and closes), what to offer there (`chatShortcuts`: { hint, shortcuts })
  // and the actions it asks of this window (`onChatAction`), lines of context (`chatNote`), and
  // requests for the AI (`chatAsk`); and where SmartDesktop stands ('connected', 'starting', 'off' or 'missing').
  chatToggle: () => call('chat-toggle'),
  onChatOpen: on('chat-open'),
  chatShortcuts: (state) => call('chat-shortcuts', state),
  onChatAction: on('chat-action'),
  chatNote: (note) => call('chat-note', note),
  chatAsk: (text) => call('chat-ask', text),
  desktopStatus: () => call('desktop-status'),
  onDesktopStatus: on('desktop-status'),
  getDesktop: () => call('get-desktop'),
  retryMcp: () => call('mcp-retry'),
  onShowConnect: on('show-connect'),
  onUpdates: on('updates'),
  // The SmartDoc menu's Settings….
  onShowSettings: on('show-settings'),
  onFullScreenChange: on('full-screen'),
});
