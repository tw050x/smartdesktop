// SmartStudio's page API as data: every call a page can make (name → the channel its handler answers)
// and every event it can hear (name → channel). The family's preload (@smartdesktop/ui's
// main/preload.cjs) builds `window.smartstudio` from it; a guest tab, or later a web client, builds the same
// from the same list. A page talks to its app only through these (with `platform`, `windowId`,
// `tabKind` and `pathForFile`, which the preload adds).
export const API = {
  id: 'smartstudio',
  calls: {
    tabsState: 'tabs-state',
    tabActivate: 'tab-activate',
    tabClose: 'tab-close',
    // A tab's right-click menu (`box`: its place in the top bar), and a project's icon: the user's
    // choice (`setIcon`), from the card the tab showing draws (`onIconPicker`).
    tabMenu: 'tab-menu',
    // A tab's chat button: that chat, brought forward in SmartDesktop.
    tabChat: 'tab-chat',
    // Dragging a tab (points on the screen): to another place in the top bar, another window's, or
    // out of them all to a new window. The top bar says where its tabs are (`tabBoxes`), and hears
    // where a tab dragged over it would go (`onTabDrop`).
    tabBoxes: 'tab-boxes',
    tabDragStart: 'tab-drag-start',
    tabDragMove: 'tab-drag-move',
    tabDragEnd: 'tab-drag-end',
    setIcon: 'set-icon',
    historyStep: 'history-step',
    historyState: 'history-state',
    showStatus: 'show-status',
    // A tooltip of the top bar's ({ text, box }, or null to put it away), drawn by the tab showing.
    stripTip: 'strip-tip',
    // The pills under the tab showing and the tab pointed at in the top bar ({ active, hover }, each
    // { left, width } or null), drawn by the tab showing too, as their lower halves are over its page.
    tabLines: 'tab-lines',
    openInTab: 'open-in-tab',
    goHome: 'go-home',
    newTab: 'tab-new',
    releaseAiControl: 'ai-control-release',
    // The projects (see store.js): home's list and a project in full (its takes, each with how far
    // along it is while it's made), and a new one. Asking for a take (`generate`: { kind, prompt,
    // lyrics, seconds, seed }), stopping one, saying the user has seen one the AI asked for, and
    // showing a take's file in Finder. How far along each take is comes as it changes
    // (`onTakeProgress`: { projectId, takeId, value, max }); its file plays from
    // studio-media://take/<project id>/<file>.
    listProjects: 'list-projects',
    getProject: 'get-project',
    createProject: 'create-project',
    generate: 'generate',
    stopTake: 'stop-take',
    markSeen: 'mark-seen',
    showTakeFile: 'show-take-file',
    // Stretches of takes, on their timelines: what this tab has selected (`setSelection`: { projectId,
    // takeId, start, end, frames }, or null), for the AI; notes on stretches ({ start, end, text });
    // a part of a song made again ({ start, end, prompt, lyrics, seed }), the rest kept; and how loud
    // a take is over time ({ rate, peak, rms }), measured here as it's drawn and kept with it.
    setSelection: 'set-selection',
    addNote: 'add-note',
    removeNote: 'remove-note',
    remakePart: 'remake-part',
    getLevels: 'get-levels',
    setLevels: 'set-levels',
    // Home's right-click menu on a project: renaming it, and deleting it (asked first, in the main process).
    renameProject: 'rename-project',
    deleteProject: 'delete-project',
    showHomeMenu: 'home-menu',
    copyText: 'copy-text',
    // The generation server (ComfyUI, see main/comfy.js): its address, from Settings, and how it is
    // ({ reachable, url, version, device, kinds: { music, video: { ready, missing } }, error }),
    // asked for again with `checkServer` and heard as it changes (`onServerCheck`).
    getServer: 'get-server',
    setServer: 'set-server',
    checkServer: 'check-server',
    mcpSetup: 'mcp-setup',
    copyMcpSetup: 'copy-mcp-setup',
    // Claude Desktop's setup: { state }, and adding SmartStudio to it (after asking).
    claudeDesktopStatus: 'claude-desktop-status',
    addToClaudeDesktop: 'add-to-claude-desktop',
    // Updates (see updates.js): where they stand, checking now, and restarting into a downloaded one.
    getUpdates: 'get-updates',
    installUpdate: 'install-update',
    // Light, dark or as the system is ('light', 'dark' or 'system'), from Settings.
    getAppearance: 'get-appearance',
    setAppearance: 'set-appearance',
    mcpStatus: 'mcp-status',
    retryMcp: 'mcp-retry',
    // The chat, in SmartDesktop (see main/desktop.js): the window's chat button (`chatToggle`, and
    // `onChatOpen` as it opens and closes), where the window is ('home', or a project's id,
    // with the chat's line for it and the project's name), what to offer there
    // (`chatShortcuts`: { hint, shortcuts }) and the actions it asks of this window (`onChatAction`),
    // lines of context (`chatNote`), and requests for the AI (`chatAsk`); and where SmartDesktop
    // stands ('connected', 'starting', 'off' or 'missing').
    chatToggle: 'chat-toggle',
    chatShows: 'chat-shows',
    chatShortcuts: 'chat-shortcuts',
    chatNote: 'chat-note',
    chatAsk: 'chat-ask',
    desktopStatus: 'desktop-status',
    getDesktop: 'get-desktop',
  },
  events: {
    // The top bar (tab-strip.js): the window's tabs, back and forward, and the app's status
    // (`onTabs`), choosing and closing a tab (the tab asking, without an id), stepping back or forward
    // in the active tab, and opening the status panel there. A tab says when back and forward change
    // (`historyState`), and hears the top bar's (`onHistoryStep`) and its status pill
    // (`onToggleStatus`). A project opened in a new tab (`openInTab`: { projectId, name }), which hears
    // it (`onOpenProject`), as it does an AI's takes; the Home button (`goHome`, heard by the active tab
    // as `onGoHome`) and + (`newTab`).
    onTabs: 'tabs',
    onTabDrop: 'tab-drop',
    onIconPicker: 'icon-picker',
    onHistoryStep: 'history-step',
    onStripTip: 'strip-tip',
    onTabLines: 'tab-lines',
    onToggleStatus: 'toggle-status',
    onOpenProject: 'open-project',
    onGoHome: 'go-home',
    onAiControl: 'ai-control',
    onTakeProgress: 'take-progress',
    onProjectsChanged: 'projects-changed',
    onServerCheck: 'server-check',
    onMcpStatus: 'mcp-status',
    onShowConnect: 'show-connect',
    onUpdates: 'updates',
    // The SmartStudio menu's Settings….
    onShowSettings: 'show-settings',
    onFullScreenChange: 'full-screen',
    onChatOpen: 'chat-open',
    onChatAction: 'chat-action',
    onDesktopStatus: 'desktop-status',
  },
};
