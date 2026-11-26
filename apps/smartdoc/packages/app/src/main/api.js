// SmartDoc's page API as data: every call a page can make (name → the channel its handler answers)
// and every event it can hear (name → channel). The family's preload (@smartdesktop/ui's
// main/preload.cjs) builds `window.smartdoc` from it; a guest tab, or later a web client, builds the same
// from the same list. A page talks to its app only through these (with `platform`, `windowId`,
// `tabKind` and `pathForFile`, which the preload adds).
export const API = {
  id: 'smartdoc',
  calls: {
    // A file dropped on the page, opened from its place on this Mac (the preload's `pathForFile`).
    openPath: 'open-path',
    tabsState: 'tabs-state',
    tabActivate: 'tab-activate',
    tabClose: 'tab-close',
    // A tab's right-click menu (`box`: its place in the top bar), and a document's icon: the user's
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
    releaseAiControl: 'ai-control-release',
    stepDraft: 'step-draft',
    draftLine: 'draft-line',
    draftPdf: 'draft-pdf',
    goToDraft: 'go-to-draft',
    sendToAi: 'send-to-ai',
    aiWaiting: 'ai-waiting',
    variationsOf: 'variations-of',
    focusesFor: 'focuses-for',
    prepareDraft: 'prepare-draft',
    // `{ preview: true }` opens its draft preview too, in the tab it opens in.
    openDraft: 'open-draft',
    showDraftMenu: 'draft-menu',
    // The preview of the next draft (the AI writes it; only the user makes it a draft).
    openPreview: 'open-preview',
    closePreview: 'close-preview',
    previewComparison: 'preview-comparison',
    acceptPreview: 'accept-preview',
    discardPreview: 'discard-preview',
    showVariationMenu: 'variation-menu',
    goHome: 'go-home',
    showHomeMenu: 'home-menu',
    folders: 'folders',
    labels: 'labels',
    addLabel: 'add-label',
    removeLabel: 'remove-label',
    setLabelColor: 'set-label-color',
    setHomeFolder: 'set-home-folder',
    createFolder: 'create-folder',
    createDocument: 'create-document',
    renameFolder: 'rename-folder',
    renameDocument: 'rename-document',
    renameVariation: 'rename-variation',
    deleteFolder: 'delete-folder',
    moveFolder: 'move-folder',
    moveDocument: 'move-document',
    deleteDocument: 'delete-document',
    reportPageTexts: 'page-texts',
    picturesDrawn: 'pictures-drawn',
    addRequest: 'add-request',
    updateRequest: 'update-request',
    setNoFurtherAction: 'set-no-further-action',
    removeRequest: 'remove-request',
    decide: 'decide',
    mcpSetup: 'mcp-setup',
    listFocuses: 'list-focuses',
    setFocus: 'set-focus',
    setTool: 'set-tool',
    copyText: 'copy-text',
    copyMcpSetup: 'copy-mcp-setup',
    openWebsite: 'open-website',
    // Claude Desktop's setup: { state, extension }, and adding SmartDoc to it (after asking).
    claudeDesktopStatus: 'claude-desktop-status',
    addToClaudeDesktop: 'add-to-claude-desktop',
    // Updates (see updates.js): where they stand, checking now, and restarting into a downloaded one.
    getUpdates: 'get-updates',
    installUpdate: 'install-update',
    // Light, dark or as the system is ('light', 'dark' or 'system'), from Settings.
    getAppearance: 'get-appearance',
    setAppearance: 'set-appearance',
    getExperimental: 'get-experimental',
    setExperimental: 'set-experimental',
    // A bundled font's bytes (packages/pdf/fonts), for SmartDoc's own reader.
    readerFont: 'reader-font',
    mcpStatus: 'mcp-status',
    // The chat, in SmartDesktop (see main/desktop.js): the window's chat button (`chatToggle`, and
    // `onChatOpen` as it opens and closes), what to offer there (`chatShortcuts`: { hint, shortcuts })
    // and the actions it asks of this window (`onChatAction`), lines of context (`chatNote`), and
    // requests for the AI (`chatAsk`); and where SmartDesktop stands ('connected', 'starting', 'off' or 'missing').
    chatToggle: 'chat-toggle',
    chatShortcuts: 'chat-shortcuts',
    chatNote: 'chat-note',
    chatAsk: 'chat-ask',
    // The bottom bar's menu of requests for the AI, the request sent to the AI working on what the
    // tab shows, and who's working on it now (`onAiAtWork`: [{ who, step, chat, here }]).
    aiActionsMenu: 'ai-actions-menu',
    askAi: 'ask-ai',
    aiAtWork: 'ai-at-work',
    openChat: 'open-chat',
    desktopInstalled: 'desktop-installed',
    desktopStatus: 'desktop-status',
    getDesktop: 'get-desktop',
    retryMcp: 'mcp-retry',
  },
  events: {
    // The top bar (tab-strip.js): the window's tabs, back and forward, and the app's status
    // (`onTabs`), choosing and closing a tab, stepping back or forward in the active tab, and opening
    // the status panel there. A tab says when back and forward change (`historyState`), and hears
    // the top bar's (`onHistoryStep`) and its status pill (`onToggleStatus`).
    onTabs: 'tabs',
    onTabDrop: 'tab-drop',
    onIconPicker: 'icon-picker',
    onHistoryStep: 'history-step',
    onStripTip: 'strip-tip',
    onTabLines: 'tab-lines',
    onToggleStatus: 'toggle-status',
    onAiControl: 'ai-control',
    // Find: the Edit menu's commands, and the drafts on the line to search as well.
    onFind: 'find',
    onAiWaiting: 'ai-waiting',
    onVariationRequested: 'variation-requested',
    onDocumentMade: 'document-made',
    onFolders: 'folders',
    onLabels: 'labels',
    onLabelRequested: 'label-requested',
    onRenameVariation: 'rename-variation',
    onNames: 'names',
    // Pictures of a PDF's pages for the AI (view_pages): asked for by the main process, answered
    // with PNGs or an error.
    onDrawPictures: 'draw-pictures',
    // The experiments' state, whenever it changes ({ convert, reader }).
    onExperimental: 'experimental',
    onRecentDocuments: 'recent-documents',
    onDraftOpened: 'draft-opened',
    onDocumentClosed: 'document-closed',
    onReview: 'review',
    onTool: 'tool',
    onMcpStatus: 'mcp-status',
    onChatOpen: 'chat-open',
    onChatAction: 'chat-action',
    onAiAtWork: 'ai-at-work',
    onDesktopStatus: 'desktop-status',
    onShowConnect: 'show-connect',
    onUpdates: 'updates',
    // The SmartDoc menu's Settings….
    onShowSettings: 'show-settings',
    onFullScreenChange: 'full-screen',
  },
};
