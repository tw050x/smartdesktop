// The page API of SmartDesktop's app windows (app-windows.js) as data: only their top bar's, as every
// tab in them is another app's page, with that app's own API (a guest tab, see @smartdesktop/ui's
// main/guests.js). The family's preload builds `window.smartdesktop` from it for the top bar's page.
export const API = {
  id: 'smartdesktop',
  calls: {
    // The top bar (@smartdesktop/ui's tab-strip.js): the window's tabs, back and forward and the
    // status (`onTabs`), choosing and closing a tab, stepping back or forward in the tab showing,
    // opening its status panel, and going home (the window's Home tab).
    tabsState: 'tabs-state',
    tabActivate: 'tab-activate',
    tabClose: 'tab-close',
    // A tab's right-click menu (`box`: its place in the top bar).
    tabMenu: 'tab-menu',
    // A tab's chat button or its AI's pill: that chat, brought forward.
    tabChat: 'tab-chat',
    // Dragging a tab (points on the screen): to another place in the top bar, another window's, or
    // out of them all to a new window. The top bar says where its tabs are (`tabBoxes`), and hears
    // where a tab dragged over it would go (`onTabDrop`).
    tabBoxes: 'tab-boxes',
    tabDragStart: 'tab-drag-start',
    tabDragMove: 'tab-drag-move',
    tabDragEnd: 'tab-drag-end',
    historyStep: 'history-step',
    showStatus: 'show-status',
    // The top bar's tooltips and the pills under its tabs, drawn by the tab showing (their lower
    // halves are over its page).
    stripTip: 'strip-tip',
    tabLines: 'tab-lines',
    goHome: 'go-home',
  },
  events: {
    onTabs: 'tabs',
    onTabDrop: 'tab-drop',
    onFullScreenChange: 'full-screen',
  },
};
