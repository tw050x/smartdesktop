// SmartPlan's page API as data: every call a page can make (name → the channel its handler answers)
// and every event it can hear (name → channel). The family's preload (@smartdesktop/ui's
// main/preload.cjs) builds `window.smartplan` from it; a guest tab, or later a web client, builds the
// same from the same list. A page talks to its app only through these (with `platform`, `windowId`,
// `tabKind` and `pathForFile`, which the preload adds), so it can work with Electron behind it now
// and a web server later.
export const API = {
  id: 'smartplan',
  calls: {
    // The top bar (tab-strip.js): the window's tabs, back and forward, and the app's status
    // (`onTabs`), choosing and closing a tab (the tab asking, without an id), stepping back or forward
    // in the active tab, and opening the status panel there. A tab says when back and forward change
    // (`historyState`). A board opened in a new tab (`openInTab`: { boardId, name, card }); the Home
    // button (`goHome`, heard by the active tab as `onGoHome`) and + (`newTab`).
    tabsState: 'tabs-state',
    tabActivate: 'tab-activate',
    tabClose: 'tab-close',
    // A tab's right-click menu (`box`: its place in the top bar), and a board's icon: the user's
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
    // The boards (see store.js): home's list, a board in full (its lists and their cards), a card
    // the user has opened, and a card the user dragged to a list (`position` among the cards that
    // stay there).
    listBoards: 'list-boards',
    getBoard: 'get-board',
    markRead: 'mark-read',
    moveCard: 'move-card',
    // Home's right-click menu on a board: renaming it, and deleting it (asked first, in the main process).
    renameBoard: 'rename-board',
    deleteBoard: 'delete-board',
    showHomeMenu: 'home-menu',
    copyText: 'copy-text',
    mcpSetup: 'mcp-setup',
    copyMcpSetup: 'copy-mcp-setup',
    // Claude Desktop's setup: { state }, and adding SmartPlan to it (after asking).
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
    // The chat, in SmartDesktop (see main/desktop.js): the window's chat button (`chatToggle`), where
    // the window is (`chatShows`: 'home', or a board's id, with the chat's line for it, the board's
    // name and the card open), what to offer there (`chatShortcuts`: { hint, shortcuts }), lines of
    // context (`chatNote`), requests for the AI (`chatAsk`), and where SmartDesktop stands
    // ('connected', 'starting', 'off' or 'missing').
    chatToggle: 'chat-toggle',
    chatShows: 'chat-shows',
    chatShortcuts: 'chat-shortcuts',
    chatNote: 'chat-note',
    chatAsk: 'chat-ask',
    desktopStatus: 'desktop-status',
    getDesktop: 'get-desktop',
  },
  events: {
    onTabs: 'tabs',
    onTabDrop: 'tab-drop',
    onIconPicker: 'icon-picker',
    onGoHome: 'go-home',
    // The top bar's back and forward, and its status pill, heard by the active tab.
    onHistoryStep: 'history-step',
    onStripTip: 'strip-tip',
    onTabLines: 'tab-lines',
    onToggleStatus: 'toggle-status',
    // A board opened in this tab, from Home or an AI's cards.
    onOpenBoard: 'open-board',
    // A card the AI shows the user, opened on its board ({ boardId, card }).
    onShowCard: 'show-card',
    onAiControl: 'ai-control',
    onBoardsChanged: 'boards-changed',
    onNewBoard: 'new-board',
    onMcpStatus: 'mcp-status',
    onShowConnect: 'show-connect',
    onUpdates: 'updates',
    // The SmartPlan menu's Settings….
    onShowSettings: 'show-settings',
    onFullScreenChange: 'full-screen',
    // The chat's window opening and closing, and the actions it asks of this window.
    onChatOpen: 'chat-open',
    onChatAction: 'chat-action',
    onDesktopStatus: 'desktop-status',
  },
};
