import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell, WebContentsView } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from './desktop.js';
import { guessIcon, isIcon } from './icons.js';
import { createItemIcons } from './item-icons.js';
import { createTabDrag } from './tab-drag.js';
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
// A window holds tabs (the user's choice: working in tabs rather than in many windows, though more
// windows are still allowed), as SmartDoc's and SmartSpec's do. The first is Home, pinned: it can't
// be closed, and only it shows home. Each other tab shows one board, and never home:
// opening a board from Home (or an AI's cards there) opens it in a tab, the one already showing it
// if there is one. Each tab is what a window was: its own history and AI session (`ctx`, with the tab's id,
// which a copied prompt names so an AI can take it over). The window says where each tab is as it
// moves (`chat-shows`: `where`, and the board's `name`).
//
// The window's own page is the top bar across it (tabs.html: the traffic lights, back and forward,
// the tabs and the app's status, see tab-strip.js); each tab's page (index.html) is a view below it,
// only the active one showing. The window is frameless: macOS keeps its traffic lights, placed in
// the top bar; Windows and Linux get the system window controls drawn over it.
const hosts = new Set(); // { win, tabs: [home, …], active }
const strips = new Map(); // the top bar's webContents id → its window
const tabBounds = (host) => {
  const { width, height } = host.win.getContentBounds();
  return { x: 0, y: TOP_BAR_HEIGHT, width, height: Math.max(0, height - TOP_BAR_HEIGHT) };
};
const layoutTabs = (host) => {
  for (const tab of host.tabs) tab.view.setBounds(tabBounds(host));
};

// `bounds`, where to put it (a tab dragged out of a window makes one where it's dropped).
function createWindow({ focus = true, bounds = null } = {}) {
  const colours = windowColours();
  const frame = process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: (TOP_BAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT } };
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    ...bounds,
    minWidth: 760,
    minHeight: 480,
    title: WINDOW_TITLE,
    backgroundColor: colours.bar,
    show: focus,
    ...frame,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Placed again once made: macOS fits a new window on the screen, which would move a tab dragged
  // out from under the pointer.
  if (bounds) win.setBounds(bounds);
  // The window's name, not the page's (see WINDOW_TITLE).
  win.on('page-title-updated', (event) => event.preventDefault());
  const host = { win, tabs: [], active: null };
  hosts.add(host);
  strips.set(win.webContents.id, host);
  win.webContents.on('did-finish-load', () => sendTabs(host));
  win.loadFile(path.join(dirname, '../../build/renderer/tabs.html'));
  win.on('resize', () => layoutTabs(host));
  // The window has the focus: its active tab does, for the menu, the AI chat (SmartDesktop shows the
  // chat while a window of the apps has the focus) and the keyboard.
  win.on('focus', () => {
    host.focusedAt = Date.now(); // the window in front, for where a dragged tab is dropped
    const ctx = host.active;
    if (!ctx) return;
    lastFocused = ctx;
    ctx.contents.focus();
    desktop.focus(ctx.id, win.getBounds());
    updateMenu();
  });
  const away = () => host.active && desktop.blur(host.active.id);
  win.on('blur', away);
  win.on('minimize', away);
  win.on('hide', away);
  // In full screen macOS moves the traffic lights out of the top bar, so the interface can reclaim
  // the space reserved for them.
  const fullScreen = (on) => {
    win.webContents.send('full-screen', on);
    for (const tab of host.tabs) tab.contents.send('full-screen', on);
  };
  win.on('enter-full-screen', () => fullScreen(true));
  win.on('leave-full-screen', () => fullScreen(false));
  win.on('closed', () => {
    hosts.delete(host);
    for (const tab of [...host.tabs]) disposeTab(tab);
    host.tabs = [];
    if (lastFocused?.host === host) lastFocused = [...windows.values()].at(-1) ?? null;
    updateMenu();
  });
  const home = createTab(host, { home: true, focus });
  activateTab(home);
  return home;
}

function createTab(host, { home = false } = {}) {
  const id = `w-${randomUUID().slice(0, 4)}`;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--smartplan-window=${id}`, `--smartplan-tab=${home ? 'home' : 'document'}`],
    },
  });
  view.setBackgroundColor(windowColours().background);
  const contents = view.webContents;
  const ctx = { id, host, home, view, contents, get win() { return this.host.win; }, ready: null, session: null, untouched: true, where: null, name: null, hadBoard: false, history: { back: false, forward: false } };
  windows.set(contents.id, ctx);
  if (home) host.tabs.unshift(ctx);
  else host.tabs.push(ctx);
  // SmartDesktop is told which tab is Home: what happens there goes to no chat.
  if (home) desktop.window(id, { home: true, title: 'Home' });
  view.setVisible(false);
  host.win.contentView.addChildView(view);
  view.setBounds(tabBounds(host));
  // A card's description is written by an AI, and its links must never replace the interface:
  // they open in the browser, if they're web links at all.
  const openLink = (url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  };
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openLink(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });
  ctx.ready = new Promise((resolve) => contents.once('did-finish-load', resolve));
  ctx.ready.then(() => ctx.host.active === ctx && ctx.contents.send('tab-lines', ctx.host.lines ?? null));
  ctx.ready.then(() => {
    contents.send('mcp-status', mcpStatus());
    if (ctx.session) contents.send('ai-control', clientLabel(ctx.session.client));
  });
  contents.loadFile(path.join(dirname, '../../build/renderer/index.html'));
  updateMenu();
  sendTabs(host);
  return ctx;
}

// Shows a tab, the others hidden behind it.
function activateTab(ctx) {
  const { host } = ctx;
  const before = host.active;
  host.active = ctx;
  for (const tab of host.tabs) {
    tab.view.setVisible(tab === ctx);
    // The lower halves of the top bar's pills are drawn by the tab showing (see tab-lines).
    tab.contents.send('tab-lines', tab === ctx ? host.lines ?? null : null);
  }
  if (host.win.isFocused()) {
    if (before && before !== ctx) desktop.blur(before.id);
    desktop.focus(ctx.id, host.win.getBounds());
    ctx.contents.focus();
  }
  if (host.win.isFocused() || !lastFocused || lastFocused.host === host) lastFocused = ctx;
  updateMenu();
  sendTabs(host);
}

// Closes a tab: a board's (Home only closes with its window). The tab beside it shows instead.
function closeTab(ctx) {
  const { host } = ctx;
  if (ctx.home) return host.win.close();
  const at = host.tabs.indexOf(ctx);
  if (at < 0) return;
  host.tabs.splice(at, 1);
  if (host.active === ctx) activateTab(host.tabs[at] ?? host.tabs[at - 1] ?? host.tabs[0]);
  disposeTab(ctx);
  host.win.contentView.removeChildView(ctx.view);
  ctx.contents.close();
  sendTabs(host);
}

function disposeTab(ctx) {
  if (!windows.has(ctx.contents.id)) return;
  windows.delete(ctx.contents.id);
  if (lastFocused === ctx) lastFocused = ctx.host.active !== ctx ? ctx.host.active : [...windows.values()].at(-1) ?? null;
  // The AI gets a new tab, the next time it needs one.
  if (ctx.session) ctx.session.ctx = null;
  desktop.closed(ctx.id);
  updateMenu();
}

// Moves a tab to `index` among a window's tabs (never before Home): in its own window, or into
// another (its page, and all it holds, go with it: the board, its history, an AI working in it),
// where it shows.
function moveTab(ctx, to, index) {
  const from = ctx.host;
  const at = from.tabs.indexOf(ctx);
  if (ctx.home || at < 0 || to.win.isDestroyed()) return;
  from.tabs.splice(at, 1);
  if (from !== to) {
    if (from.active === ctx) {
      from.active = null;
      activateTab(from.tabs[at] ?? from.tabs[at - 1] ?? from.tabs[0]);
    }
    from.win.contentView.removeChildView(ctx.view);
    ctx.host = to;
    to.win.contentView.addChildView(ctx.view);
    ctx.view.setBounds(tabBounds(to));
    ctx.contents.send('full-screen', to.win.isFullScreen());
    sendTabs(from);
  }
  to.tabs.splice(Math.max(1, Math.min(index, to.tabs.length)), 0, ctx);
  activateTab(ctx);
  if (from !== to) to.win.focus();
}

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

// The top bar's state for each window: its tabs (Home first; each board's by its name and icon, with
// the AI working in it), back and forward for the active tab, and the app's status.
function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  if (ctx.name) return ctx.name;
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a board…` : 'Opening…';
}
function sendTabs(host) {
  if (!host || host.win.isDestroyed()) return;
  const state = {
    tabs: host.tabs.map((t) => ({ id: t.id, home: t.home, title: tabTitle(t), icon: t.home ? null : tabIcon(t), active: t === host.active, ai: t.session ? clientLabel(t.session.client) : null, chat: t.chat ?? null })),
    back: Boolean(host.active?.history.back),
    forward: Boolean(host.active?.history.forward),
    status: appStatus(),
  };
  host.win.webContents.send('tabs', state);
}
const sendAllTabs = () => {
  for (const host of hosts) sendTabs(host);
};
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
// Home, of the window a tab is in.
const homeOf = (ctx) => ctx?.host?.tabs[0] ?? null;

// The next or previous tab in the window (the menu's Show Next Tab and Show Previous Tab).
function stepTab(delta) {
  const host = lastFocused?.host;
  if (!host) return;
  const at = host.tabs.indexOf(host.active);
  activateTab(host.tabs[(at + delta + host.tabs.length) % host.tabs.length]);
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
// The top bar (tab-strip.js): its state, choosing and closing tabs, back and forward (done by the
// active tab, whose history it is, which says when they change), and the status pill, which opens
// the panel in the active tab.
handle('tabs-state', (ctx) => {
  if (ctx?.host) setTimeout(() => sendTabs(ctx.host));
  return null;
});
handle('tab-activate', (ctx, id) => {
  const tab = ctx?.host.tabs.find((t) => t.id === id);
  if (tab) activateTab(tab);
});
// A tab by its id, or the tab asking (its board gone, say).
handle('tab-close', (ctx, id = null) => {
  const tab = id ? ctx?.host.tabs.find((t) => t.id === id) : ctx;
  if (tab) closeTab(tab);
});
handle('history-step', (ctx, delta) => ctx?.contents.send('history-step', delta));
// A tab's right-click menu: choosing its icon (in a card the tab showing draws, under the tab: `box`
// is the tab's place in the top bar), and closing it.
handle('tab-menu', (ctx, id, box) => {
  const host = ctx?.host;
  const tab = host?.tabs.find((t) => t.id === id);
  if (!tab) return;
  const boardId = boardOf(tab);
  Menu.buildFromTemplate([
    // The chat that owns it, if one does; and Open Chat (only with SmartDesktop installed: the user's
    // choice), as its chat button: this tab's chat, or a new one for it (from Home, the chat last
    // used), brought forward ready to type in.
    ...(tab.chat ? [{ label: `Chat: ${tab.chat.title}`, enabled: false }] : []),
    ...(desktop.installed() ? [{ label: 'Open Chat', click: () => openChatFor(tab) }, { type: 'separator' }] : tab.chat ? [{ type: 'separator' }] : []),
    { label: 'Change Icon…', enabled: Boolean(boardId), click: () => host.active.contents.send('icon-picker', { docId: boardId, current: tabIcon(tab), name: tab.name, at: { left: box.left, top: 6 } }) },
    ...(tab.home ? [] : [{ type: 'separator' }, { label: 'Close Tab', click: () => closeTab(tab) }]),
  ]).popup({ window: host.win });
});
// A tab's chat button: shows that tab, and its chat in SmartDesktop, brought forward ready to type in.
function openChatFor(tab) {
  activateTab(tab);
  return desktop.chat(tab.id, true);
}
handle('tab-chat', (_ctx, id) => {
  const tab = [...windows.values()].find((t) => t.id === id);
  if (tab) return openChatFor(tab);
});
// The user's choice of a board's icon, which the AI never replaces.
handle('set-icon', (_ctx, boardId, icon) => itemIcons.set(boardId, icon, 'user'));
handle('history-state', (ctx, state) => {
  ctx.history = { back: Boolean(state?.back), forward: Boolean(state?.forward) };
  if (ctx.host.active === ctx) sendTabs(ctx.host);
});
handle('show-status', (ctx) => ctx?.contents.send('toggle-status'));
// The pills under the tab showing and the tab pointed at in the top bar: their lower halves are over
// the tab showing's page, which draws them there (see tab-strip.js).
handle('tab-lines', (ctx, lines) => {
  const host = ctx?.host;
  if (!host) return;
  host.lines = lines;
  for (const tab of host.tabs) tab.contents.send('tab-lines', tab === host.active ? lines : null);
});
// A tooltip of the top bar's, drawn by the tab showing (the top bar's page is behind it there), its
// box moved into the tab's page, which starts below the top bar.
handle('strip-tip', (ctx, tip) => {
  const host = ctx?.host;
  if (!host) return;
  for (const tab of host.tabs) {
    if (tab === host.active && tip) tab.contents.send('strip-tip', { text: tip.text, plain: Boolean(tip.plain), box: { ...tip.box, top: tip.box.top - TOP_BAR_HEIGHT, bottom: tip.box.bottom - TOP_BAR_HEIGHT } });
    else tab.contents.send('strip-tip', null);
  }
});
// Dragging a tab (tab-strip.js, tab-drag.js): to another place in its top bar, into another
// window's, or anywhere else to make a new window of it, its picture following the pointer meanwhile.
// The top bar says where its tabs are (`tab-boxes`), and the one the pointer is over shows where the
// tab would go (`tab-drop`: { id, index, x }, or null). As SmartDoc's and SmartSpec's.
const tabDrag = createTabDrag({ topBar: TOP_BAR_HEIGHT });
let dragging = null; // { tab, offset, chip, point, target }
handle('tab-boxes', (ctx, boxes) => {
  if (ctx?.host) ctx.host.tabBoxes = Array.isArray(boxes) ? boxes : [];
});
const hostsInFront = () => [...hosts].sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0));
function dragOver(point) {
  const target = tabDrag.targetAt(point, hostsInFront(), dragging.tab.id);
  const before = dragging.target;
  dragging.target = target;
  if (before && before.host !== target?.host && !before.host.win.isDestroyed()) before.host.win.webContents.send('tab-drop', null);
  if (target && (target.host !== before?.host || target.index !== before.index || target.x !== before.x)) target.host.win.webContents.send('tab-drop', { id: dragging.tab.id, index: target.index, x: target.x });
  tabDrag.move(point, Boolean(target));
}
handle('tab-drag-start', async (ctx, id, { chip, offset, point } = {}) => {
  const host = ctx?.host;
  const tab = host?.tabs.find((t) => t.id === id);
  if (!tab || tab.home || dragging || !chip || !offset || !point) return false;
  const drag = { tab, offset, chip, point, target: null };
  dragging = drag;
  const box = { x: Math.round(chip.x), y: Math.round(chip.y), width: Math.max(1, Math.round(chip.width)), height: Math.max(1, Math.round(chip.height)) };
  const [chipImage, pageImage] = await Promise.all([
    host.win.webContents.capturePage(box),
    tab.contents.capturePage().catch(() => null), // a tab not showing gives its last picture
  ]);
  if (dragging !== drag) return false; // let go meanwhile
  await tabDrag.show({ chip: chipImage, chipSize: box, page: pageImage, pageSize: tab.view.getBounds(), offset, point: drag.point, colours: windowColours() });
  if (dragging === drag) dragOver(drag.point);
  return true;
});
handle('tab-drag-move', (_ctx, point) => {
  if (!dragging || !point) return;
  dragging.point = point;
  dragOver(point);
});
handle('tab-drag-end', (_ctx, point) => {
  const drag = dragging;
  if (!drag) return;
  if (point) {
    drag.point = point;
    dragOver(point);
  }
  dragging = null;
  tabDrag.hide();
  const { tab, target } = drag;
  if (target && !target.host.win.isDestroyed()) target.host.win.webContents.send('tab-drop', null);
  if (!windows.has(tab.contents.id)) return; // closed meanwhile
  if (target) return moveTab(tab, target.host, target.index);
  // Over no top bar: a new window, the size of the one it came from, its tab under the pointer where
  // it was let go (the window may run off the screen, but never its top bar).
  const from = tab.host;
  const { width, height } = from.win.getBounds();
  const first = from.tabBoxes?.[1]?.left ?? 120; // where a window's first tab after Home starts
  const area = screen.getDisplayNearestPoint({ x: Math.round(drag.point.x), y: Math.round(drag.point.y) }).workArea;
  const KEEP = 160; // of the window, kept on the screen across
  const x = Math.round(Math.min(Math.max(drag.point.x - first - drag.offset.x, area.x + KEEP - width), area.x + area.width - KEEP));
  const y = Math.round(Math.min(Math.max(drag.point.y - drag.chip.y - drag.offset.y, area.y), area.y + area.height - 2 * TOP_BAR_HEIGHT));
  const home = createWindow({ bounds: { x, y, width, height } });
  moveTab(tab, home.host, 1);
});

// Home is a tab of its own: going home shows it.
handle('go-home', (ctx) => {
  const home = homeOf(ctx);
  if (home && home !== ctx) activateTab(home);
});
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
