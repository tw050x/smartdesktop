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
  openRecent: (docId) => call('open-recent', docId),
  readRecent: (docId) => call('read-recent', docId),
  stepDraft: (delta) => call('step-draft', delta),
  reportPageTexts: (docId, draftId, texts) => call('page-texts', docId, draftId, texts),
  addRequest: (request) => call('add-request', request),
  updateRequest: (id, changes) => call('update-request', id, changes),
  removeRequest: (id) => call('remove-request', id),
  decide: (itemId, decision) => call('decide', itemId, decision),
  addChange: (text) => call('add-change', text),
  updateChange: (id, text) => call('update-change', id, text),
  removeChange: (id) => call('remove-change', id),
  resetToStep: (step) => call('reset-to-step', step),
  copyText: (text) => call('copy-text', text),
  mcpSetup: (target) => call('mcp-setup', target),
  copyMcpSetup: (target) => call('copy-mcp-setup', target),
  openWebsite: () => call('open-website'),
  onRecentDocuments: on('recent-documents'),
  onDraftOpened: on('draft-opened'),
  onDocumentClosed: on('document-closed'),
  onReview: on('review'),
  onMcpStatus: on('mcp-status'),
  onFullScreenChange: on('full-screen'),
});
