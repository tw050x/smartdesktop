const { contextBridge, ipcRenderer } = require('electron');

// Requests resolve with their value, or reject with the main process's error message.
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));

contextBridge.exposeInMainWorld('smartstudio', {
  platform: process.platform,
  // This window's id, which a copied prompt names so the AI can take it over.
  windowId: process.argv.find((arg) => arg.startsWith('--smartstudio-window='))?.split('=')[1],
  // Which kind of tab this is: 'home' (the pinned first tab, the only one showing home) or
  // 'document' (a project's); none for the top bar's own page (see main.js).
  tabKind: process.argv.find((arg) => arg.startsWith('--smartstudio-tab='))?.split('=')[1] ?? null,
  // The top bar (tab-strip.js): the window's tabs, back and forward, and the app's status
  // (`onTabs`), choosing and closing a tab (the tab asking, without an id), stepping back or forward
  // in the active tab, and opening the status panel there. A tab says when back and forward change
  // (`historyState`), and hears the top bar's (`onHistoryStep`) and its status pill
  // (`onToggleStatus`). Home opens a project in a tab of its own (`openInTab`: { projectId, name }),
  // which hears it (`onOpenProject`), as it does an AI's takes; going home shows the Home tab.
  onTabs: on('tabs'),
  tabsState: () => call('tabs-state'),
  tabActivate: (id) => call('tab-activate', id),
  tabClose: (id) => call('tab-close', id),
  // A tab's right-click menu (`box`: its place in the top bar), and a project's icon: the user's
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
  setIcon: (projectId, icon) => call('set-icon', projectId, icon),
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
  onOpenProject: on('open-project'),
  goHome: () => call('go-home'),
  onAiControl: on('ai-control'),
  releaseAiControl: () => call('ai-control-release'),
  // The projects (see store.js): home's list and a project in full (its takes, each with how far
  // along it is while it's made), and a new one. Asking for a take (`generate`: { kind, prompt,
  // lyrics, seconds, seed }), stopping one, saying the user has seen one the AI asked for, and
  // showing a take's file in Finder. How far along each take is comes as it changes
  // (`onTakeProgress`: { projectId, takeId, value, max }); its file plays from
  // studio-media://take/<project id>/<file>.
  listProjects: () => call('list-projects'),
  getProject: (id) => call('get-project', id),
  createProject: (fields) => call('create-project', fields),
  generate: (projectId, fields) => call('generate', projectId, fields),
  stopTake: (projectId, takeId) => call('stop-take', projectId, takeId),
  markSeen: (projectId, takeId) => call('mark-seen', projectId, takeId),
  showTakeFile: (projectId, file) => call('show-take-file', projectId, file),
  onTakeProgress: on('take-progress'),
  // Stretches of takes, on their timelines: what this tab has selected (`setSelection`: { projectId,
  // takeId, start, end, frames }, or null), for the AI; notes on stretches ({ start, end, text });
  // a part of a song made again ({ start, end, prompt, lyrics, seed }), the rest kept; and how loud
  // a take is over time ({ rate, peak, rms }), measured here as it's drawn and kept with it.
  setSelection: (selection) => call('set-selection', selection),
  addNote: (projectId, takeId, note) => call('add-note', projectId, takeId, note),
  removeNote: (projectId, takeId, noteId) => call('remove-note', projectId, takeId, noteId),
  remakePart: (projectId, takeId, part) => call('remake-part', projectId, takeId, part),
  getLevels: (projectId, takeId) => call('get-levels', projectId, takeId),
  setLevels: (projectId, takeId, levels) => call('set-levels', projectId, takeId, levels),
  // Home's right-click menu on a project: renaming it, and deleting it (asked first, in the main process).
  renameProject: (id, name) => call('rename-project', id, name),
  deleteProject: (id) => call('delete-project', id),
  showHomeMenu: (items) => call('home-menu', items),
  copyText: (text) => call('copy-text', text),
  onProjectsChanged: on('projects-changed'),
  // The generation server (ComfyUI, see main/comfy.js): its address, from Settings, and how it is
  // ({ reachable, url, version, device, kinds: { music, video: { ready, missing } }, error }),
  // asked for again with `checkServer` and heard as it changes (`onServerCheck`).
  getServer: () => call('get-server'),
  setServer: (url) => call('set-server', url),
  checkServer: () => call('check-server'),
  onServerCheck: on('server-check'),
  mcpSetup: (target) => call('mcp-setup', target),
  copyMcpSetup: (target) => call('copy-mcp-setup', target),
  // Claude Desktop's setup: { state }, and adding SmartStudio to it (after asking).
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
  // The SmartStudio menu's Settings….
  onShowSettings: on('show-settings'),
  onFullScreenChange: on('full-screen'),
  // The chat, in SmartDesktop (see main/desktop.js): the window's chat button (`chatToggle`, and
  // `onChatOpen` as it opens and closes), where the window is ('home', or a project's id,
  // with the chat's line for it and the project's name), what to offer there
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
