const { contextBridge, ipcRenderer } = require('electron');

// Requests resolve with their value, or reject with the main process's error message.
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));

contextBridge.exposeInMainWorld('smartdesktop', {
  platform: process.platform,
  // The AIs the chat runs (see agent.js): where each stands, installing and signing in.
  agentStatus: () => call('agent-status'),
  agentSignIn: (id) => call('agent-sign-in', id),
  agentInstall: (id) => call('agent-install', id),
  agentInstallHelp: (id) => call('agent-install-help', id),
  onAgentProgress: on('agent-progress'),
  // The chats, each in a tab of the chat window (see main.js and chat-layout.js): one chat's
  // conversation, sending to its AI, stopping it, and a new session.
  chatLoad: (chatId) => call('chat-load', chatId),
  agentSend: (chatId, provider, text, options) => call('agent-send', chatId, provider, text, options),
  agentStop: (chatId) => call('agent-stop', chatId),
  agentNewSession: (chatId, provider) => call('agent-new-session', chatId, provider),
  onAgentEvent: on('agent-event'),
  // A chat window: its layout, the chats in it, and the one with the focus (`onChatState`); a
  // shortcut that's an action in an app (`chatAction`); a request for a chat's AI from an app
  // (`onChatAsk`: { chatId, text }); and its tabs: a new chat in a column, showing, moving,
  // splitting off and closing a chat's tab, the columns' widths, the focus, a chat's name, and a
  // tab's right-click menu.
  chatReady: () => call('chat-ready'),
  onChatState: on('chat-state'),
  chatAction: (chip) => call('chat-action', chip),
  onChatAsk: on('chat-ask'),
  chatClose: () => call('chat-close'),
  chatNew: (column) => call('chat-new', column),
  chatShow: (chatId) => call('chat-show', chatId),
  chatMove: (chatId, column, index) => call('chat-move', chatId, column, index),
  chatSplit: (chatId, column, side) => call('chat-split', chatId, column, side),
  chatCloseTab: (chatId) => call('chat-close-tab', chatId),
  chatWidths: (widths) => call('chat-widths', widths),
  chatEven: () => call('chat-even'),
  chatFocus: (chatId) => call('chat-focus', chatId),
  chatRename: (chatId, title) => call('chat-rename', chatId, title),
  chatTabMenu: (chatId) => call('chat-tab-menu', chatId),
  // The history panel: every chat (or those a search finds), opening one (`how`: 'open' where it
  // is, else here; 'here', moved here; 'window', a window of its own), a chat's right-click menu,
  // and Window › Chat History (`onHistoryToggle`: { open: true }, or { open: null } to toggle).
  chatHistory: (query) => call('chat-history', query),
  chatHistoryOpen: (chatId, how) => call('chat-history-open', chatId, how),
  chatHistoryMenu: (chatId) => call('chat-history-menu', chatId),
  onHistoryToggle: on('chat-history-toggle'),
  // A tab dragged out of its window (see main.js): its picture taken as it starts (`box`, its place
  // in the page; `offset`, where the pointer has it), then the pointer on the screen and whether
  // it's inside its own window, and where it was let go outside it (or null inside). The window it's
  // over is told where (`onChatDragOver`: a point in it, or null), and says where it would land.
  chatDragStart: (chatId, drag) => call('chat-drag-start', chatId, drag),
  chatDragMove: (point, inside) => call('chat-drag-move', point, inside),
  chatDragEnd: (point) => call('chat-drag-end', point),
  chatDragTarget: (target) => call('chat-drag-target', target),
  onChatDragOver: on('chat-drag-over'),
  openSetup: () => call('open-setup'),
  openSettings: () => call('open-settings'),
  // Settings: light, dark or as the system is; and updates.
  getAppearance: () => call('get-appearance'),
  setAppearance: (appearance) => call('set-appearance', appearance),
  getUpdates: () => call('get-updates'),
  installUpdate: () => call('install-update'),
  onUpdates: on('updates'),
});
