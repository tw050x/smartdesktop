// SmartSpec's page API as data: every call a page can make (name → the channel its handler answers)
// and every event it can hear (name → channel). The family's preload (@smartdesktop/ui's
// main/preload.cjs) builds `window.smartspec` from it; a guest tab, or later a web client, builds the same
// from the same list. A page talks to its app only through these (with `platform`, `windowId`,
// `tabKind` and `pathForFile`, which the preload adds).
export const API = {
  id: 'smartspec',
  calls: {
    tabsState: 'tabs-state',
    tabActivate: 'tab-activate',
    tabClose: 'tab-close',
    // A tab's right-click menu (`box`: its place in the top bar), and a schematic's icon: the user's
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
    openSchematicTab: 'open-schematic-tab',
    goHome: 'go-home',
    releaseAiControl: 'ai-control-release',
    // The schemas (see store.js): what there is, and the user's answer to a proposal.
    listSchemas: 'list-schemas',
    listFocuses: 'list-focuses',
    copyText: 'copy-text',
    listDrafts: 'list-drafts',
    getSchema: 'get-schema',
    getProposal: 'get-proposal',
    getItem: 'get-item',
    getConnections: 'get-connections',
    listComments: 'list-comments',
    listEarlierComments: 'list-earlier-comments',
    // Where the user has placed things in a schematic's focus view, kept on this computer only.
    getLayout: 'get-layout',
    saveLayout: 'save-layout',
    listGroups: 'list-groups',
    createGroup: 'create-group',
    renameGroup: 'rename-group',
    deleteGroup: 'delete-group',
    moveSchema: 'move-schema',
    folders: 'folders',
    createFolder: 'create-folder',
    renameFolder: 'rename-folder',
    deleteFolder: 'delete-folder',
    moveFolder: 'move-folder',
    moveGroup: 'move-group',
    showHomeMenu: 'home-menu',
    addComment: 'add-comment',
    setNoFurtherAction: 'set-no-further-action',
    acceptProposal: 'accept-proposal',
    // The user's approval of one change in the proposal (an item's id, or 'contract'), or taking it back.
    approveChange: 'approve-change',
    decisionLog: 'decision-log',
    discardedProposal: 'discarded-proposal',
    sendComments: 'send-comments',
    // The proposals an AI in another app is waiting on (`smartspec wait`), and when that changes.
    aiWaiting: 'ai-waiting',
    discardProposal: 'discard-proposal',
    // A schematic's contract checks (see test-runs.js, test-history.js): running them on a draft or
    // the proposal (`version`: its draft id, or 'proposal'), all or a branch's or clause's (`only`),
    // against some code (`target`); stopping a run; every run of a schematic; and each run as it
    // changes ({ schemaId, run }).
    testRun: 'test-run',
    testStop: 'test-stop',
    testState: 'test-state',
    // The branches and tags its code can be run at, and its default branch (null when nothing says).
    testBranches: 'test-branches',
    // A schematic's workspace, a clone of its code on this Mac to work on (see workspaces.js): where
    // it is and how it stands ({ dir, label, cloned, branch, commit, changes }), and showing it.
    workspace: 'workspace',
    showWorkspace: 'workspace-show',
    startWorkspaceAgain: 'workspace-start-again',
    // A schematic's secrets on this Mac (see secrets.js): how each of a draft's or the proposal's
    // stands (never a value), entering one, having one made at random, clearing one, and hearing when
    // a schematic's change (its id).
    secrets: 'secrets',
    setSecret: 'secret-set',
    generateSecret: 'secret-generate',
    clearSecret: 'secret-clear',
    useSharedSecret: 'secret-use-shared',
    shareSecret: 'secret-share',
    // Shared secrets, named values several schematics' secrets use (Settings › Shared Secrets).
    sharedSecrets: 'shared-secrets',
    createSharedSecret: 'shared-secret-create',
    setSharedSecret: 'shared-secret-set',
    generateSharedSecret: 'shared-secret-generate',
    renameSharedSecret: 'shared-secret-rename',
    deleteSharedSecret: 'shared-secret-delete',
    mcpSetup: 'mcp-setup',
    copyMcpSetup: 'copy-mcp-setup',
    // Claude Desktop's setup: { state }, and adding SmartSpec to it (after asking).
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
    // `onChatOpen` as it opens and closes), where the window is ('home', or a schematic's draft or
    // proposal, with the chat's line for it and the schematic's name), what to offer there
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
    // (`onToggleStatus`). A schematic opened in a new tab (`openInTab`: { path, layout }), which hears
    // it (`onOpenLevel`); going home (`goHome`, showing the window's Home tab).
    onTabs: 'tabs',
    onTabDrop: 'tab-drop',
    onIconPicker: 'icon-picker',
    onHistoryStep: 'history-step',
    onStripTip: 'strip-tip',
    onTabLines: 'tab-lines',
    onToggleStatus: 'toggle-status',
    onOpenLevel: 'open-level',
    onGoHome: 'go-home',
    onAiControl: 'ai-control',
    onAiWaiting: 'ai-waiting',
    onSchemasChanged: 'schemas-changed',
    onTestRun: 'test-run',
    onTestStatus: 'test-status',
    onWorkspaceChanged: 'workspace-changed',
    onSecretsChanged: 'secrets-changed',
    onSharedSecretsChanged: 'shared-secrets-changed',
    onShowSchema: 'show-schema',
    onNewSchema: 'new-schema',
    onMcpStatus: 'mcp-status',
    onShowConnect: 'show-connect',
    onUpdates: 'updates',
    // The SmartSpec menu's Settings….
    onShowSettings: 'show-settings',
    onFullScreenChange: 'full-screen',
    onChatOpen: 'chat-open',
    onChatAction: 'chat-action',
    onDesktopStatus: 'desktop-status',
  },
};
