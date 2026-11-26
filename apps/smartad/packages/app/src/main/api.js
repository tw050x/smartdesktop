// SmartAd's page API as data: every call a page can make (name → the channel its handler answers)
// and every event it can hear (name → channel). The family's preload (@smartdesktop/ui's
// main/preload.cjs) builds `window.smartad` from it; a guest tab, or later a web client, builds the same
// from the same list. A page talks to its app only through these (with `platform`, `windowId`,
// `tabKind` and `pathForFile`, which the preload adds).
export const API = {
  id: 'smartad',
  calls: {
    tabsState: 'tabs-state',
    tabActivate: 'tab-activate',
    tabClose: 'tab-close',
    // A tab's right-click menu (`box`: its place in the top bar), and an ad's icon: the user's
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
    // The ads (see store.js): what there is, and the user's answer to a proposal.
    listAds: 'list-ads',
    listDrafts: 'list-drafts',
    getAd: 'get-ad',
    getProposal: 'get-proposal',
    acceptProposal: 'accept-proposal',
    discardProposal: 'discard-proposal',
    // Home's right-click menu on an ad: renaming it, and deleting it (asked first, in the main process).
    renameAd: 'rename-ad',
    deleteAd: 'delete-ad',
    showHomeMenu: 'home-menu',
    copyText: 'copy-text',
    // The proposals an AI in another app is waiting on (`smartad wait`), and when that changes.
    aiWaiting: 'ai-waiting',
    mcpSetup: 'mcp-setup',
    copyMcpSetup: 'copy-mcp-setup',
    // Claude Desktop's setup: { state }, and adding SmartAd to it (after asking).
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
    // `onChatOpen` as it opens and closes), where the window is ('home', or an ad's draft or
    // proposal, with the chat's line for it and the ad's name), what to offer there
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
    // (`onToggleStatus`). An ad opened in a new tab (`openInTab`: { adId, draftId, proposal, name }),
    // which hears it (`onOpenAd`), as it does an AI's proposal; the Home button (`goHome`, heard by
    // the active tab as `onGoHome`) and + (`newTab`).
    onTabs: 'tabs',
    onTabDrop: 'tab-drop',
    onIconPicker: 'icon-picker',
    onHistoryStep: 'history-step',
    onStripTip: 'strip-tip',
    onTabLines: 'tab-lines',
    onToggleStatus: 'toggle-status',
    onOpenAd: 'open-ad',
    onGoHome: 'go-home',
    onAiControl: 'ai-control',
    onAiWaiting: 'ai-waiting',
    onAdsChanged: 'ads-changed',
    onNewAd: 'new-ad',
    onMcpStatus: 'mcp-status',
    onShowConnect: 'show-connect',
    onUpdates: 'updates',
    // The SmartAd menu's Settings….
    onShowSettings: 'show-settings',
    onFullScreenChange: 'full-screen',
    onChatOpen: 'chat-open',
    onChatAction: 'chat-action',
    onDesktopStatus: 'desktop-status',
  },
};
