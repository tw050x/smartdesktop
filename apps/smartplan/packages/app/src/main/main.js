import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from './desktop.js';
import { guessIcon, isIcon } from '@smartdesktop/ui/main/icons.js';
import { createItemIcons } from './item-icons.js';
import { createTabs } from '@smartdesktop/ui/main/tabs.js';
import { createConnect } from './connect.js';
import { MCP_PORT, portHolder, startMcpServer } from './mcp-server.js';
import { clientLabel, createSessions } from './sessions.js';
import { buildMenu } from './menu.js';
import { createStore } from './store.js';
import { createUpdates } from './updates.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_MS = 15 * 1000;
const TOP_BAR_HEIGHT = 44;
// Height of the area macOS reserves for the traffic lights (the circles sit centred in it).
const TRAFFIC_LIGHTS_HEIGHT = 16;

// A development copy keeps its data in a folder of its own, SmartPlan Dev (and its MCP server on a
// port of its own, see mcp-server.js), so it never reads or overwrites the installed app's data,
// and the two can run side by side: the app allows one copy per data folder. Automated tests
// point it at a separate folder again (SMARTPLAN_USER_DATA) and port (SMARTPLAN_PORT), so a test
// copy can run beside both. Set before the app is ready so Chromium's own storage moves too. The
// packaged app ignores both.
if (!app.isPackaged) {
  app.setPath('userData', process.env.SMARTPLAN_USER_DATA ? path.resolve(process.env.SMARTPLAN_USER_DATA) : path.join(app.getPath('appData'), 'SmartPlan Dev'));
}

// One copy of the app runs at a time (per data folder). Every AI app connects to it, and opening
// it again just brings its window forward.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!app.isReady()) return;
  if (!lastFocused) return createWindow();
  if (lastFocused.win.isMinimized()) lastFocused.win.restore();
  lastFocused.win.focus();
});

// The window's name, which Mission Control shows over it: a development copy says so, so it can be
// told from the installed app when both are open. The page's own title doesn't replace it.
const WINDOW_TITLE = app.isPackaged ? 'SmartPlan' : 'SmartPlan Development';

const windows = new Map(); // a tab's webContents id → its tab: { id, host, home, view, contents, win, ready, session, untouched, where, name }
let lastFocused = null;
let mcp = null; // { url, token } once the MCP server is listening
let mcpStarting = true;
let mcpProblem = null; // why it isn't running: { reason: 'port-in-use', port, holder } or { reason: 'error', message }
let lastMcpStatus = null;
let mcpRetry = null;
const MCP_RETRY_MS = 5000; // while the port is taken, how often to try again, so it starts once it's free
// The boards, their lists and cards (see store.js).
const store = createStore(app.getPath('userData'));

// For every window: what's the same in all of them.
const broadcast = (channel, value) => {
  for (const { contents } of windows.values()) contents.send(channel, value);
};

// --- Appearance ----------------------------------------------------------------------------

// Light, dark, or as the system is: chosen in Settings and kept in settings.json, with the app's
// data. Electron's theme then has the interface's styles follow it (their light-dark() colours,
// see styles.css), and its native menus and dialogs too.
const APPEARANCES = ['system', 'light', 'dark'];
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}
function setAppearance(appearance) {
  if (!APPEARANCES.includes(appearance)) return;
  nativeTheme.themeSource = appearance;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), appearance }, null, 2));
}
nativeTheme.themeSource = APPEARANCES.includes(readSettings().appearance) ? readSettings().appearance : 'system';

// The window's own colours, which the interface can't set: its background (showing as it opens
// or resizes) and, on Windows and Linux, the title bar's (the top bar's, see styles.css).
const windowColours = () => (nativeTheme.shouldUseDarkColors
  ? { background: '#161618', bar: '#1f1f22', symbols: '#d1d1d6' }
  : { background: '#ebebef', bar: '#dcdce1', symbols: '#3c3c43' });
nativeTheme.on('updated', () => {
  const colours = windowColours();
  for (const host of hosts) {
    host.win.setBackgroundColor(colours.bar);
    for (const tab of host.tabs) tab.view.setBackgroundColor(colours.background);
    if (process.platform !== 'darwin') host.win.setTitleBarOverlay({ color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT });
  }
});

// --- Windows and their tabs ------------------------------------------------------------------
// The family's windows of tabs (@smartdesktop/ui's main/tabs.js): Home first, pinned, and each other
// tab showing one board, opened from Home (or an AI's cards there) in a tab, the one already showing
// it if there is one. The window says where each tab is as it moves (`chat-shows`: `where`, and the
// board's `name`). What's SmartPlan's own is given here.
const hosts = new Set(); // { win, tabs: [home, …], active }
const tabs = createTabs({
  id: 'smartplan',
  title: WINDOW_TITLE,
  pages: {
    preload: path.join(dirname, 'preload.cjs'),
    tabs: path.join(dirname, '../../build/renderer/tabs.html'),
    index: path.join(dirname, '../../build/renderer/index.html'),
  },
  topBar: TOP_BAR_HEIGHT,
  trafficLights: TRAFFIC_LIGHTS_HEIGHT,
  windows,
  hosts,
  colours: windowColours,
  desktop: () => desktop,
  onFocused: (ctx) => {
    lastFocused = ctx;
  },
  changed: () => updateMenu(),
  tabReady: (ctx) => {
    ctx.contents.send('mcp-status', mcpStatus());
    if (ctx.session) ctx.contents.send('ai-control', clientLabel(ctx.session.client));
  },
  tabState: (ctx) => ({ title: tabTitle(ctx), icon: tabIcon(ctx), ai: ctx.session ? clientLabel(ctx.session.client) : null }),
  status: () => appStatus(),
  docOf: (ctx) => boardOf(ctx),
  // The AI gets a new tab, the next time it needs one.
  release: (ctx) => {
    if (ctx.session) ctx.session.ctx = null;
  },
});
const { createWindow, createTab, activateTab, closeTab, moveTab, sendTabs, sendAllTabs, homeOf, stepTab, openChatFor, strips } = tabs;

// Where a tab is: 'home', or the id of the board it shows, as the tab says (chat-shows).
const boardOf = (ctx) => (ctx.where && ctx.where !== 'home' ? ctx.where : null);
// The tab showing a board (in the window of `host`) that no chat owns, if one does.
const tabShowing = (host, boardId) => host.tabs.find((t) => !t.home && !t.chat && boardOf(t) === boardId);
const tabsShowing = (boardId) => [...windows.values()].filter((t) => !t.home && boardOf(t) === boardId);

// A board opened from Home goes to its own tab (the one already showing it, if one is, unless the
// user asked for a new tab), with what to open there (`request`: { boardId, name, card, newTab }:
// `card` to open); an AI working in Home goes with it.
async function openInTab(home, { newTab = false, ...request }) {
  // A chat's AI gets a tab of its own, even with the board open in another (the same board can be
  // open in several tabs, each a different chat's); the user, the tab showing it that no chat owns,
  // if there is one.
  const reuse = !newTab && !fromDesktop(home.session) && tabShowing(home.host, request.boardId);
  const tab = reuse || createTab(home.host);
  await tab.ready;
  tab.contents.send('open-board', request);
  const { session } = home;
  if (session && session.ctx === home) {
    releaseWindow(session);
    if (!tab.session) setSessionWindow(session, tab);
  }
  activateTab(tab);
  return tab;
}

// Each board's icon, set by the user or the AI (see item-icons.js), on its tab and on home: its
// own, or the guess from its name.
const FALLBACK_ICON = 'clipboard-list';
const itemIcons = createItemIcons(app.getPath('userData'), {
  onChange: () => {
    sendAllTabs();
    broadcast('boards-changed');
  },
});
const iconOfBoard = (id, name) => {
  const own = itemIcons.get(id)?.icon;
  return isIcon(own) ? own : guessIcon(name, FALLBACK_ICON);
};
const tabIcon = (ctx) => (boardOf(ctx) ? iconOfBoard(boardOf(ctx), ctx.name) : FALLBACK_ICON);
const withIcons = (list) => list.map((one) => ({ ...one, icon: iconOfBoard(one.id, one.name) }));

// A tab's name in the top bar (each board's by its name and icon, with the AI working in it).
function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  if (ctx.name) return ctx.name;
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a board…` : 'Opening…';
}
// The app's status, for the pill at the end of the top bar (see server-status.js for the panel it
// opens): the server's, and once it's running, whether SmartDesktop, which runs the chat, is there.
function appStatus() {
  const server = mcpStatus();
  const state = server.state !== 'running' ? server.state : desktop.status === 'missing' ? 'setup' : 'running';
  const label = { starting: 'Starting…', running: 'Ready', setup: 'Get SmartDesktop', off: 'Not running' }[state];
  const title = server.state === 'off' && server.reason === 'port-in-use'
    ? (server.holder?.kind === 'smartplan' ? 'Another copy of SmartPlan is running the server' : 'SmartPlan’s server port is in use by another app')
    : { starting: 'SmartPlan is starting', running: 'SmartPlan is ready to work with your AI', setup: 'SmartPlan’s server is running, but SmartDesktop, which runs the AI chat, isn’t installed', off: 'SmartPlan’s server isn’t running' }[state];
  return { state, label, title };
}
const mcpStatus = () => (mcp ? { state: 'running', url: mcp.url } : mcpStarting ? { state: 'starting' } : { state: 'off', ...mcpProblem });

// Starts the MCP server, or says why it couldn't. A taken port is tried again every few seconds
// (another copy of the app may be quitting); anything else waits for the user's Try again.
async function startMcp() {
  clearTimeout(mcpRetry);
  if (mcp) return mcpStatus();
  try {
    mcp = await startMcpServer(aiForServer, app.getPath('userData'));
    mcpProblem = null;
    desktop.connect();
    setInterval(sweepSessions, SWEEP_MS).unref();
  } catch (error) {
    mcp = null;
    mcpProblem = error?.code === 'EADDRINUSE'
      ? { reason: 'port-in-use', port: MCP_PORT, holder: await portHolder(MCP_PORT) }
      : { reason: 'error', message: error?.message ?? String(error) };
    if (error?.code === 'EADDRINUSE') mcpRetry = setTimeout(startMcp, MCP_RETRY_MS);
  }
  const changed = mcpStarting || JSON.stringify(mcpStatus()) !== lastMcpStatus;
  mcpStarting = false;
  if (changed) {
    lastMcpStatus = JSON.stringify(mcpStatus());
    broadcast('mcp-status', mcpStatus());
    sendAllTabs();
  }
  return mcpStatus();
}

function updateMenu() {
  Menu.setApplicationMenu(buildMenu({
    hasWindow: windows.size > 0,
    inHome: Boolean(lastFocused?.home),
    actions: {
      newWindow: () => createWindow(),
      // A board's tab, or the window from Home (its pinned tab can't close).
      close: () => lastFocused && closeTab(lastFocused),
      nextTab: (delta) => stepTab(delta),
      showChat: () => lastFocused && desktop.chat(lastFocused.id, true),
      newBoard: async () => {
        const ctx = lastFocused ?? createWindow();
        await ctx.ready;
        ctx.contents.send('new-board');
      },
      showConnectAi,
      showSettings: () => lastFocused?.contents.send('show-settings'),
      // Its answer shows in the update toast, in a window (one is opened if none is).
      checkForUpdates: async () => {
        if (!lastFocused) await createWindow().ready;
        updates.check({ byUser: true });
      },
    },
  }));
}

// --- AI sessions ---------------------------------------------------------------------------
// Each AI session works in a tab of its own, whatever tabs the user has open: theirs are left
// alone. The one exception is the window SmartPlan opened on launch, when the AI's launcher is what
// started it. The tab is opened only once there's something for the user to see (cards written onto
// a board), and a tab closed is opened again the next time there is.

const sessions = createSessions();

// A chat's AI in SmartDesktop (its session `smartdesktop-<chat id>`, its client `smartdesktop-<AI>`).
const fromDesktop = (session) => Boolean(session?.client?.startsWith('smartdesktop-'));

function setSessionWindow(session, ctx) {
  session.ctx = ctx;
  ctx.session = session;
  ctx.untouched = false;
  ctx.ready.then(() => ctx.contents.send('ai-control', clientLabel(session.client)));
  // A chat's AI taking a tab makes it that chat's (SmartDesktop says so back: `owners`).
  if (fromDesktop(session) && !ctx.home) desktop.sessionTab(ctx.id, session.id);
  sendTabs(ctx.host);
}

// SmartDesktop's chat works in the window the user was last in, which it names: the session takes that
// window over, unless another AI is working in it.
function bindWindow(session, windowId, { strict = false } = {}) {
  const ctx = [...windows.values()].find((c) => c.id === windowId);
  if (!ctx) return;
  if (ctx.session && ctx.session !== session && sessions.alive(ctx.session)) {
    if (strict) throw new Error(`${clientLabel(ctx.session.client)} is working in this SmartPlan window. Tell the user: they can release it from the status pill's panel.`);
    return;
  }
  if (session.ctx === ctx) return;
  if (session.ctx) releaseWindow(session);
  setSessionWindow(session, ctx);
}

// Gives a window back to the user, whichever way the session stopped.
function releaseWindow(session) {
  sessions.releaseClaims(session);
  const { ctx } = session;
  session.ctx = null;
  if (ctx) {
    ctx.session = null;
    ctx.contents.send('ai-control', null);
    sendTabs(ctx.host);
    // An AI's tab it left with nothing in it isn't worth keeping.
    if (!ctx.home && !ctx.hadBoard) closeTab(ctx);
  }
}

// An AI session's tab, opened when it first has something to show: in the window last used (or a
// new window), behind the one showing unless the AI started SmartPlan or is a chat's (the user is
// working with it).
async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  const launched = startedApp && [...hosts].find((h) => h.tabs.length === 1 && h.tabs[0].untouched && !h.tabs[0].session);
  const host = launched || (lastFocused?.host ?? createWindow({ focus: false }).host);
  const ctx = createTab(host);
  if (launched || fromDesktop(session)) activateTab(ctx);
  await ctx.ready;
  setSessionWindow(session, ctx);
  if (!ctx.win.isVisible()) ctx.win.showInactive();
  return ctx;
}

// A prompt copied from a window names it, so the AI that gets it takes that window over.
function takeOverWindow(session, windowId) {
  const ctx = [...windows.values()].find((one) => one.id === windowId);
  if (!ctx) throw new Error(`There's no SmartPlan window ${windowId} open now. Carry on without it: SmartPlan opens a tab of your own when you write cards.`);
  if (ctx.session && ctx.session !== session && sessions.alive(ctx.session)) {
    throw new Error(`${clientLabel(ctx.session.client)} is already working in window ${windowId}. Tell the user: they can release it from the status pill's panel.`);
  }
  if (ctx.session && ctx.session !== session) releaseWindow(ctx.session);
  const old = session.ctx;
  if (old && old !== ctx) {
    releaseWindow(session);
    if (!old.home && !old.where) closeTab(old); // a tab the session opened for itself, with nothing in it, isn't worth leaving behind
  }
  setSessionWindow(session, ctx);
  return { window: windowId };
}

// The boards as an AI session may use them. What it writes shows in its own tab, which is opened
// only when there's something for the user to see (cards on a board): reading needs none, and a
// tab opened for it waited for what might never come, which looked frozen (the user found it so in
// SmartDoc and SmartSpec). `tab()` opens it (windowForSession). A board not named is the one the
// session's tab shows.
const boardsFor = (session, tab) => {
  const boardHere = (boardId) => {
    const id = boardId ?? (session.ctx && boardOf(session.ctx));
    if (!id) throw new Error('This window shows no board. Name the board with board_id (list_boards shows them).');
    return id;
  };
  const nameOf = async (id) => (await store.list()).find((one) => one.id === id)?.name ?? '';
  // Shows the board to the user, once there's something on it for them: in the session's tab, a tab
  // showing it already (the user's own, which the session then takes, rather than opening another,
  // if no other AI works there), or a tab of its own. `card` is opened.
  async function show(boardId, card = null) {
    const request = { boardId, name: await nameOf(boardId), card };
    if (session.ctx && boardOf(session.ctx) === boardId) {
      if (card) session.ctx.contents.send('show-card', { boardId, card });
      return session.ctx;
    }
    if (!session.ctx) {
      const theirs = tabsShowing(boardId).find((t) => !t.chat && (!t.session || !sessions.alive(t.session)));
      if (theirs) {
        if (theirs.session) releaseWindow(theirs.session);
        setSessionWindow(session, theirs);
        if (card) theirs.contents.send('show-card', { boardId, card });
        return theirs;
      }
    }
    const ctx = await tab();
    if (ctx.home) return openInTab(ctx, request);
    ctx.contents.send('open-board', request);
    if (!ctx.win.isVisible()) ctx.win.showInactive();
    return ctx;
  }
  const withIcon = (board) => ({ ...board, icon: itemIcons.get(board.id)?.icon ?? null });
  return {
    list: async () => (await store.list()).map(withIcon),
    async create({ icon, ...board }) {
      const made = await store.create(board);
      // Its icon isn't part of it: it's kept apart, as the AI's.
      if (icon && !itemIcons.get(made.board)) itemIcons.set(made.board, icon, 'ai');
      await show(made.board);
      return { ...made, message: 'The board is open in SmartPlan for the user.' };
    },
    get: async (boardId) => withIcon(await store.get(boardHere(boardId))),
    async addLists(boardId, lists, options) {
      const id = boardHere(boardId);
      const made = await store.addLists(id, lists, options);
      await show(id);
      return made;
    },
    updateList: (boardId, listId, change) => store.updateList(boardHere(boardId), listId, change),
    removeList: (boardId, listId) => store.removeList(boardHere(boardId), listId),
    async addCards(boardId, listId, cards, options) {
      const id = boardHere(boardId);
      const made = await store.addCards(id, listId, cards, options);
      await show(id);
      return made;
    },
    async updateCard(boardId, cardId, changes) {
      const id = boardHere(boardId);
      const changed = await store.updateCard(id, cardId, changes);
      await show(id);
      return changed;
    },
    async moveCards(boardId, cardIds, listId, options) {
      const id = boardHere(boardId);
      const moved = await store.moveCards(id, cardIds, listId, options);
      await show(id);
      return moved;
    },
    removeCards: (boardId, ids) => store.removeCards(boardHere(boardId), ids),
    rename: (boardId, change) => store.rename(boardHere(boardId), change),
    // A board's icon (set_icon), the one named or the one the window shows: the user's choice is
    // kept over the AI's.
    async setIcon(icon, boardId = null) {
      const id = boardHere(boardId);
      await store.get(id);
      const { icon: shown, kept } = itemIcons.set(id, icon, 'ai');
      return kept ? { icon: shown, note: 'The user chose this board\'s icon, so it stays.' } : { icon: shown };
    },
    // A card opened on its board, in the session's tab (the user asked to see it).
    async showCard(boardId, cardId) {
      const id = boardHere(boardId);
      const board = await store.get(id);
      if (!board.lists.some((list) => list.cards.some((card) => card.id === cardId))) throw new Error(`No card ${cardId} on this board.`);
      await show(id, cardId);
      return { board: id, card: cardId, shown: true };
    },
  };
};

const aiForServer = {
  // SmartDesktop's chat says which window its AI works in (the one the user was last in) as each of
  // its messages starts, and keeps the session alive while the AI thinks.
  alive: ({ session, client, window, turn }) => {
    const touched = sessions.touch(session, client);
    // Only as a message starts (`turn`), or with no window yet: within a message the AI stays where
    // it went (into a tab of its own, say), though the window it was sent from is still named.
    if (window && (turn || !touched.ctx)) bindWindow(touched, window, { turn });
  },
  ended({ session }) {
    const ended = session && sessions.get(session);
    if (!ended) return;
    releaseWindow(ended);
    sessions.end(session);
  },
  async call({ session: id, client, startedApp, window }, name, _args, run) {
    const session = sessions.touch(id, client);
    if (window && !session.ctx) bindWindow(session, window, { strict: true });
    // Taking a window over is the one call that mustn't open one of its own.
    if (name === 'use_window') return run({ useWindow: (windowId) => takeOverWindow(session, windowId) });
    return run(boardsFor(session, () => windowForSession(session, startedApp)));
  },
};

function sweepSessions() {
  for (const { session } of windows.values()) {
    if (session && !sessions.alive(session)) releaseWindow(session);
  }
  sessions.sweep();
}

// --- Connecting an AI --------------------------------------------------------------------
// AI apps start SmartPlan's MCP launcher, which is inside the app (see connect.js). The MCP panel
// (opened from the status pill, or Connect an AI in the menu) shows how to set up each AI app,
// and can add SmartPlan to Claude Desktop itself.

const { setups, claudeDesktopStatus, addToClaudeDesktop } = createConnect({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  userData: app.getPath('userData'),
  port: MCP_PORT,
});

async function showConnectAi() {
  const ctx = lastFocused ?? createWindow();
  await ctx.ready;
  ctx.contents.send('show-connect');
}

async function confirmAddToClaudeDesktop(ctx) {
  const status = await claudeDesktopStatus();
  const { response } = await dialog.showMessageBox(ctx?.win ?? undefined, {
    type: 'question',
    message: status.state === 'different' ? 'Update SmartPlan in Claude Desktop?' : 'Add SmartPlan to Claude Desktop?',
    detail: 'SmartPlan adds itself to Claude Desktop’s settings file (claude_desktop_config.json), and keeps a copy of the file as it was. Then quit Claude Desktop and open it again to connect.',
    buttons: [status.state === 'different' ? 'Update' : 'Add', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return status;
  return addToClaudeDesktop();
}

// macOS: AI apps start SmartPlan from where it's installed, so a copy run from the disk image or
// Downloads is offered a move to Applications (which opens it again from there).
async function offerMoveToApplications(ctx) {
  if (!app.isPackaged || process.platform !== 'darwin' || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox(ctx.win, {
    type: 'question',
    message: 'Move SmartPlan to your Applications folder?',
    detail: 'Your agent opens SmartPlan from where it’s installed, so it works best in Applications.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox('SmartPlan couldn’t be moved', `${error.message}\n\nDrag SmartPlan into your Applications folder in Finder instead.`);
  }
}

// --- Updates -----------------------------------------------------------------------------

// (Nothing in SmartPlan waits on the user, as the AI's cards go straight onto the board, so there's no
// `wait` to tell as the app quits, as SmartSpec's and SmartAd's tell theirs.)
const updates = createUpdates({ report: (status) => broadcast('updates', status) });

// --- The chat, in SmartDesktop (see desktop.js) -----------------------------------------------
// The AI chat is SmartDesktop's, an app of its own, for the family's apps: chat windows over the
// apps' windows, and one conversation across them (the user's choice). SmartPlan tells it about each
// tab (what it shows, when it has the focus, lines of context, the shortcuts to offer), and its AI
// uses SmartPlan's tools through the MCP server, on the tab the user was last in (see aiForServer).

const desktop = createDesktop({
  appData: app.getPath('appData'),
  packaged: app.isPackaged,
  version: app.getVersion(),
  mcp: () => mcp,
  onEvent(event) {
    // A shortcut in the chat that's an action here (the go-ahead to an AI waiting in another app).
    if (event.type === 'action') [...windows.values()].find((c) => c.id === event.windowId)?.contents.send('chat-action', event.id);
    // The chat opened or closed: each window's chat button says so.
    if (event.type === 'chat-open') broadcast('chat-open', event.open);
    // Which chat owns which tab (each tab at most one chat's): marked on the tab.
    if (event.type === 'owners') {
      for (const ctx of windows.values()) {
        const owner = event.tabs?.[ctx.id];
        ctx.chat = owner ? { id: owner.chat, title: owner.title ?? 'New chat' } : null;
      }
      sendAllTabs();
    }
  },
  onStatus: (status) => {
    broadcast('desktop-status', status);
    sendAllTabs();
  },
});

// What the tab shows, for the AI: home, or a board (by name and id), with its lists and how many
// cards each has, and the card the user has open, if one is. `where` is as the tab says (see
// boardOf); `opened`, the id of the card open.
async function chatWhere(where = 'home', opened = null) {
  if (where === 'home') return 'The window shows SmartPlan\'s home: the user\'s boards. To start a new one, ask the user what it\'s for, then create_board.';
  const board = await store.get(where).catch(() => null);
  if (!board) return 'The window shows a board that is no longer there.';
  const lists = board.lists.map((list) => `${list.name} (${list.cards.length})`).join(', ');
  const card = opened && board.lists.flatMap((list) => list.cards).find((one) => one.id === opened);
  return `The window shows the board “${board.name}” (board_id ${where}), with the lists ${lists || 'none yet'}${card ? `, and the user has the card “${card.title}” (${card.id}) open` : ''}. “This board” means this one.`;
}

// --- Window requests ---------------------------------------------------------------------

// Whatever a window asks for, it asks about itself: each handler gets that window first.
const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  try {
    return { ok: true, value: await fn(windows.get(event.sender.id) ?? strips.get(event.sender.id)?.active ?? lastFocused, ...args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Setup for each AI app, shown and copied for pasting (see connect.js).
async function mcpSetup(target) {
  const all = await setups();
  if (!all[target]) throw new Error(`Unknown AI app: ${target}`);
  return all[target];
}

store.events.on('changed', () => broadcast('boards-changed'));

// The user deletes a board from home, asked first, as it can't be had back: its lists and cards
// go with it, and the tabs showing it close (each sees it's gone). The AI has no tool for
// this, as in SmartDoc and SmartSpec.
async function deleteBoard(ctx, boardId) {
  const board = (await store.list()).find((one) => one.id === boardId);
  if (!board) return false;
  const cards = board.cards === 1 ? 'its card' : board.cards ? `its ${board.cards} cards` : null;
  const { response } = await dialog.showMessageBox(ctx?.win ?? undefined, {
    type: 'warning',
    message: `Delete “${board.name}”?`,
    detail: `${cards ? `${cards.charAt(0).toUpperCase()}${cards.slice(1)} go${board.cards === 1 ? 'es' : ''} with it. ` : ''}This can't be undone.`,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  await store.delete(boardId);
  return true;
}

// The boards, as the tabs show them (see boards.js): home's list, a board in full, a card the user
// has opened, and a card the user dragged to another place (their own arranging, which marks
// nothing unread, and the AI hears of as a line of context).
handle('list-boards', async () => withIcons(await store.list()));
handle('get-board', (_ctx, id) => store.get(id));
handle('mark-read', (_ctx, id, cardId) => store.markRead(id, cardId));
handle('move-card', (_ctx, id, cardId, listId, position) => store.moveCards(id, [cardId], listId, { position, by: 'user' }));
handle('rename-board', (_ctx, id, name) => store.rename(id, { name }));
handle('delete-board', (ctx, id) => deleteBoard(ctx, id));
// A right-click menu on home, as SmartDoc's: the chosen item's id, or null if none was chosen.
handle('home-menu', (ctx, items) => new Promise((resolve) => {
  Menu.buildFromTemplate(items.map((item) => (item.separator ? { type: 'separator' } : { label: item.label, enabled: item.enabled !== false, click: () => resolve(item.id) }))).popup({
    window: ctx?.win ?? undefined,
    callback: () => setTimeout(() => resolve(null), 100),
  });
}));
handle('copy-text', (_ctx, text) => clipboard.writeText(String(text)));
// The user can always take a window back from an AI, in the MCP panel.
handle('ai-control-release', ({ session }) => {
  if (session) releaseWindow(session);
});
handle('mcp-setup', (_ctx, target) => mcpSetup(target));
// Asked for by the window as it starts, so it never waits on a status sent before it was listening.
handle('mcp-status', () => mcpStatus());
handle('mcp-retry', () => startMcp());
handle('copy-mcp-setup', async (_ctx, target) => clipboard.writeText(await mcpSetup(target)));
handle('claude-desktop-status', () => claudeDesktopStatus());
handle('add-to-claude-desktop', (ctx) => confirmAddToClaudeDesktop(ctx));
handle('get-updates', () => updates.status);
handle('install-update', () => updates.install());
// The chat, in SmartDesktop (see desktop.js): the window's chat button, where the window is (the line
// for the chat when that changes, and what the AI is told), the shortcuts and the hint it offers,
// lines of context, and requests for the AI.
handle('chat-toggle', (ctx) => desktop.chat(ctx.id, 'toggle'));
// `opened`: the card the user has open, for what the AI is told.
handle('chat-shows', async (ctx, where, line, name = null, opened = null) => {
  // Where the tab is, for its name and icon in the top bar (and to find the tab showing a board).
  ctx.where = where;
  ctx.name = where === 'home' ? null : name;
  if (!ctx.home && where !== 'home') ctx.hadBoard = true;
  sendTabs(ctx.host);
  const detail = await chatWhere(where, typeof opened === 'string' ? opened : null);
  return desktop.window(ctx.id, { shows: { key: where, text: line, detail }, title: where === 'home' ? 'Home' : name, home: Boolean(ctx.home) });
});
handle('chat-shortcuts', (ctx, { hint = null, shortcuts = [] } = {}) => desktop.window(ctx.id, { hint, shortcuts }));
handle('chat-note', (ctx, note) => desktop.note(ctx.id, note));
handle('chat-ask', (ctx, text) => desktop.ask(ctx.id, text));
handle('desktop-status', () => desktop.status);
// The top bar's requests (choosing, closing and dragging tabs, back and forward, the status pill,
// going home), the family's (@smartdesktop/ui's main/tabs.js).
tabs.handlers(handle);
// The user's choice of a board's icon, which the AI never replaces.
handle('set-icon', (_ctx, boardId, icon) => itemIcons.set(boardId, icon, 'user'));
// A board opened from Home, in a tab of its own (see openInTab): `request` is { boardId, name,
// card, newTab }.
handle('open-in-tab', (ctx, request) => {
  if (!request?.boardId) return null;
  openInTab(homeOf(ctx), request);
  return null;
});
// Opens SmartDesktop's page, to download it.
handle('get-desktop', () => shell.openExternal('https://github.com/tw050x/smartdesktop/releases/latest'));
handle('get-appearance', () => nativeTheme.themeSource);
handle('set-appearance', (_ctx, appearance) => setAppearance(appearance));

// --- App lifecycle -----------------------------------------------------------------------

app.whenReady().then(async () => {
  // The app is in beta, and its About panel says so (as Settings does).
  app.setAboutPanelOptions({ credits: 'SmartPlan is in beta, so it may change significantly from one version to the next.' });
  const first = createWindow();
  await startMcp();
  updates.start();
  await first.ready;
  offerMoveToApplications(first);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
