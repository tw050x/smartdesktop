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
  onAiControl: on('ai-control'),
  showAiControlMenu: () => call('ai-control-menu'),
  // Dropped files are imported by path, as a new document.
  openDroppedFile: (file) => call('open-path', webUtils.getPathForFile(file)),
  stepDraft: (delta) => call('step-draft', delta),
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
  showDocumentMenu: (docId) => call('document-menu', docId),
  reportPageTexts: (docId, draftId, texts, details) => call('page-texts', docId, draftId, texts, details),
  addRequest: (request) => call('add-request', request),
  updateRequest: (id, changes) => call('update-request', id, changes),
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
  checkForUpdates: () => call('check-updates'),
  installUpdate: () => call('install-update'),
  // Light, dark or as the system is ('light', 'dark' or 'system'), from Settings.
  getAppearance: () => call('get-appearance'),
  setAppearance: (appearance) => call('set-appearance', appearance),
  onRecentDocuments: on('recent-documents'),
  onDraftOpened: on('draft-opened'),
  onDocumentClosed: on('document-closed'),
  onReview: on('review'),
  onTool: on('tool'),
  onMcpStatus: on('mcp-status'),
  onShowConnect: on('show-connect'),
  onUpdates: on('updates'),
  onFullScreenChange: on('full-screen'),
});
