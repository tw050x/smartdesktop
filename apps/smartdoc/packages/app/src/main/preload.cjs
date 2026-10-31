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
  // Dropped files are imported by path, as a new document.
  openDroppedFile: (file) => call('open-path', webUtils.getPathForFile(file)),
  stepDraft: (delta) => call('step-draft', delta),
  openRecent: (docId, tool) => call('open-recent', docId, tool),
  goHome: () => call('go-home'),
  readRecent: (docId) => call('read-recent', docId),
  reportPageTexts: (docId, draftId, texts, details) => call('page-texts', docId, draftId, texts, details),
  addRequest: (request) => call('add-request', request),
  updateRequest: (id, changes) => call('update-request', id, changes),
  removeRequest: (id) => call('remove-request', id),
  decide: (itemId, decision) => call('decide', itemId, decision),
  rateHighlight: (id, feedback) => call('rate-highlight', id, feedback),
  mcpSetup: (target) => call('mcp-setup', target),
  listFocuses: (type) => call('list-focuses', type),
  setFocus: (reviewId) => call('set-focus', reviewId),
  setTool: (tool) => call('set-tool', tool),
  copyText: (text) => call('copy-text', text),
  copyMcpSetup: (target) => call('copy-mcp-setup', target),
  openWebsite: () => call('open-website'),
  onRecentDocuments: on('recent-documents'),
  onDraftOpened: on('draft-opened'),
  onDocumentClosed: on('document-closed'),
  onReview: on('review'),
  onTool: on('tool'),
  onMcpStatus: on('mcp-status'),
  onFullScreenChange: on('full-screen'),
});
