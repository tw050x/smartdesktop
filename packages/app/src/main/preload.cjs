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
  // The chat window: its layout, the chats in it, and the one with the focus (`onChatState`); a
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
  openSetup: () => call('open-setup'),
  openSettings: () => call('open-settings'),
  // Settings: light, dark or as the system is; and updates.
  getAppearance: () => call('get-appearance'),
  setAppearance: (appearance) => call('set-appearance', appearance),
  getUpdates: () => call('get-updates'),
  checkForUpdates: () => call('check-updates'),
  installUpdate: () => call('install-update'),
  onUpdates: on('updates'),
});
