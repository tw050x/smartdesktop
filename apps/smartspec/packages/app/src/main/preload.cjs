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
  sendComments: (id) => call('send-comments', id),
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
  onShowConnect: on('show-connect'),
  onUpdates: on('updates'),
  // The SmartSpec menu's Settings….
  onShowSettings: on('show-settings'),
  onFullScreenChange: on('full-screen'),
});
