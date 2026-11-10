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
  checkForUpdates: () => call('check-updates'),
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
  // The chat with the user's own AI, run by the app (see agent.js). Each draft of a schematic has
  // its own chat, and home one of its own: the window says which (chatId).
  agentStatus: () => call('agent-status'),
  agentSignIn: (id) => call('agent-sign-in', id),
  agentInstall: (id) => call('agent-install', id),
  agentChats: (chatId) => call('agent-chats', chatId),
  agentSend: (provider, conversation, text, chatId, options) => call('agent-send', provider, conversation, text, chatId, options),
  agentStop: (conversation, chatId) => call('agent-stop', conversation, chatId),
  agentNewSession: (provider, conversation, chatId) => call('agent-new-session', provider, conversation, chatId),
  agentInstallHelp: (id) => call('agent-install-help', id),
  onAgentEvent: on('agent-event'),
  onAgentProgress: on('agent-progress'),
  // The chat floating in a window of its own (see chat-window.js), and what the app's window shows.
  chatFloat: (view) => call('chat-float', view),
  chatDock: (view) => call('chat-dock', view),
  chatClose: () => call('chat-close'),
  chatState: (state) => call('chat-state', state),
  chatReady: () => call('chat-ready'),
  // A line of context for the chat, for the AI with the user's next message (see note in agent.js).
  chatNote: (chatId, note) => call('chat-note', chatId, note),
  // A button over the floating chat's message box, done by the app's window (see app-shell.js).
  chatAction: (id) => call('chat-action', id),
  onChatAction: on('chat-action'),
  chatAsk: (text) => call('chat-ask', text),
  onChatAsk: on('chat-ask'),
  onChatMode: on('chat-mode'),
  onChatState: on('chat-state'),
});
