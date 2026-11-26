// SmartPrep's page API as data: every call a page can make (name → the channel its handler answers)
// and every event it can hear (name → channel). The family's preload (@smartdesktop/ui's
// main/preload.cjs) builds `window.smartprep` from it; a guest tab, or later a web client, builds the same
// from the same list. A page talks to its app only through these (with `platform`, `windowId`,
// `tabKind` and `pathForFile`, which the preload adds).
export const API = {
  id: 'smartprep',
  calls: {
    tabsState: 'tabs-state',
    tabActivate: 'tab-activate',
    tabClose: 'tab-close',
    // A tab's right-click menu (`box`: its place in the top bar), and a topic's icon: the user's
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
    releaseAiControl: 'ai-control-release',
    // The topics (see store.js): home's list, a topic's board and its cards in full, a card the user
    // has read, the user's questions (asked, and marked as needing nothing more), and where each
    // card is on the board, kept on this Mac (see layouts.js).
    listTopics: 'list-topics',
    getTopic: 'get-topic',
    getCards: 'get-cards',
    markRead: 'mark-read',
    listQuestions: 'list-questions',
    addQuestion: 'add-question',
    setNoFurtherAction: 'set-no-further-action',
    getLayout: 'get-layout',
    saveLayout: 'save-layout',
    // Home's right-click menu on a topic: renaming it, and deleting it (asked first, in the main process).
    renameTopic: 'rename-topic',
    deleteTopic: 'delete-topic',
    showHomeMenu: 'home-menu',
    copyText: 'copy-text',
    mcpSetup: 'mcp-setup',
    copyMcpSetup: 'copy-mcp-setup',
    // Claude Desktop's setup: { state }, and adding SmartPrep to it (after asking).
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
    // `onChatOpen` as it opens and closes), where the window is ('home', or a topic's id,
    // with the chat's line for it, the topic's name and the cards in the middle), what to offer there
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
    // (`onToggleStatus`). A topic opened in a new tab (`openInTab`: { topicId, name, card }), which
    // hears it (`onOpenTopic`), as it does an AI's cards; going home (`goHome`, showing the window's
    // Home tab).
    onTabs: 'tabs',
    onTabDrop: 'tab-drop',
    onIconPicker: 'icon-picker',
    onHistoryStep: 'history-step',
    onStripTip: 'strip-tip',
    onTabLines: 'tab-lines',
    onToggleStatus: 'toggle-status',
    onOpenTopic: 'open-topic',
    // A card the AI shows the user, brought to the middle of the board ({ topicId, card }).
    onShowCard: 'show-card',
    onAiControl: 'ai-control',
    onTopicsChanged: 'topics-changed',
    onNewTopic: 'new-topic',
    onMcpStatus: 'mcp-status',
    onShowConnect: 'show-connect',
    onUpdates: 'updates',
    // The SmartPrep menu's Settings….
    onShowSettings: 'show-settings',
    onFullScreenChange: 'full-screen',
    onChatOpen: 'chat-open',
    onChatAction: 'chat-action',
    onDesktopStatus: 'desktop-status',
  },
};
