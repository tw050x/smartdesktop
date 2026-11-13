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
import { confirm } from './confirm.js';
import { createStore } from './store.js';
import { createLayouts } from './layouts.js';
import { createUpdates } from './updates.js';
import { WaitRefused, createWaits } from './waits.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_MS = 15 * 1000;
const TOP_BAR_HEIGHT = 44;
// Height of the area macOS reserves for the traffic lights (the circles sit centred in it).
const TRAFFIC_LIGHTS_HEIGHT = 16;

// A development copy keeps its data in a folder of its own, SmartSpec Dev (and its MCP server on a
// port of its own, see mcp-server.js), so it never reads or overwrites the installed app's data,
// and the two can run side by side: the app allows one copy per data folder. Automated tests
// point it at a separate folder again (SMARTSPEC_USER_DATA) and port (SMARTSPEC_PORT), so a test
// copy can run beside both. Set before the app is ready so Chromium's own storage moves too. The
// packaged app ignores both.
if (!app.isPackaged) {
  app.setPath('userData', process.env.SMARTSPEC_USER_DATA ? path.resolve(process.env.SMARTSPEC_USER_DATA) : path.join(app.getPath('appData'), 'SmartSpec Dev'));
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
const WINDOW_TITLE = app.isPackaged ? 'SmartSpec' : 'SmartSpec Development';

const windows = new Map(); // a tab's webContents id → its tab: { id, host, home, view, contents, win, ready, session, untouched, where, name }
let lastFocused = null;
let mcp = null; // { url, token } once the MCP server is listening
let mcpStarting = true;
let mcpProblem = null; // why it isn't running: { reason: 'port-in-use', port, holder } or { reason: 'error', message }
let lastMcpStatus = null;
let mcpRetry = null;
const MCP_RETRY_MS = 5000; // while the port is taken, how often to try again, so it starts once it's free
const store = createStore(app.getPath('userData'));
// Where the user has placed things in each schematic's focus view, on this computer only.
const layouts = createLayouts(path.join(app.getPath('userData'), 'layouts'));
const waits = createWaits({ store, onChange: () => broadcast('ai-waiting', waits.active()) });

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
// windows are still allowed), as SmartDoc's do. The first is Home, pinned: it can't be closed, and
// only it shows home. Each other tab shows one schematic, and never home: opening a schematic from
// Home (or an AI's proposal there) opens it in a tab, the one already showing it if there is one.
// Each tab is what a window was: its own history and AI session (`ctx`, with the tab's id, which a
// copied prompt names so an AI can take it over). The window says where each tab is as it moves
// (`chat-shows`: `where`, and the schematic's `name`).
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
      additionalArguments: [`--smartspec-window=${id}`, `--smartspec-tab=${home ? 'home' : 'document'}`],
    },
  });
  view.setBackgroundColor(windowColours().background);
  const contents = view.webContents;
  const ctx = { id, host, home, view, contents, get win() { return this.host.win; }, ready: null, session: null, untouched: true, where: null, name: null, hadSchema: false, history: { back: false, forward: false } };
  windows.set(contents.id, ctx);
  if (home) host.tabs.unshift(ctx);
  else host.tabs.push(ctx);
  // SmartDesktop is told which tab is Home: what happens there goes to no chat.
  if (home) desktop.window(id, { home: true, title: 'Home' });
  view.setVisible(false);
  host.win.contentView.addChildView(view);
  view.setBounds(tabBounds(host));
  // A schema's content is written by an AI, and its links must never replace the interface: they
  // open in the browser, if they're web links at all.
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

// Closes a tab: a schematic's (Home only closes with its window). The tab beside it shows instead.
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
// another (its page, and all it holds, go with it: the schematic, its history, an AI working in it),
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

// The tab showing a schematic (in the window of `host`) that no chat owns, if one does.
const tabShowing = (host, schemaId) => host.tabs.find((t) => !t.home && !t.chat && t.where?.split('/')[0] === schemaId);

// A schematic opened from Home goes to its own tab (the one already showing it, if one is), with
// what to open there (`request`: the message for that tab, 'open-level' with the levels to show, or
// 'show-schema' with an AI's proposal); an AI working in Home goes with it.
async function openInTab(home, schemaId, channel, request) {
  // A chat's AI gets a tab of its own, even with the schematic open in another (the same schematic
  // can be open in several tabs, each a different chat's); the user, the tab showing it that no
  // chat owns, if there is one.
  const reuse = !fromDesktop(home.session) && tabShowing(home.host, schemaId);
  const tab = reuse || createTab(home.host);
  await tab.ready;
  tab.contents.send(channel, request);
  const { session } = home;
  if (session && session.ctx === home) {
    releaseWindow(session);
    if (!tab.session) setSessionWindow(session, tab);
  }
  activateTab(tab);
  return tab;
}

// The top bar's state for each window: its tabs (Home first; each schematic's by its name, with the
// AI working in it), back and forward for the active tab, and the app's status.
// Each schematic's icon, set by the user or the AI (see item-icons.js), on its tab and on home: its
// own, or the guess from its name, or failing that its summary (the name counts first: a word in the
// summary shouldn't outweigh it).
const itemIcons = createItemIcons(app.getPath('userData'), {
  onChange: () => {
    sendAllTabs();
    broadcast('schemas-changed');
  },
});
const schemaOf = (ctx) => (ctx.where && ctx.where !== 'home' ? ctx.where.split('/')[0] : null);
const iconOfSchema = (id, name, summary) => {
  const own = itemIcons.get(id)?.icon;
  return isIcon(own) ? own : guessIcon(name, null) ?? guessIcon(summary, 'layers');
};
const tabIcon = (ctx) => (schemaOf(ctx) ? iconOfSchema(schemaOf(ctx), ctx.name, ctx.summary) : 'layers');
const withIcons = (list) => list.map((one) => ({ ...one, icon: iconOfSchema(one.id, one.name, one.summary) }));

function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  if (ctx.name) return ctx.name;
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a schematic…` : 'Opening…';
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
    ? (server.holder?.kind === 'smartspec' ? 'Another copy of SmartSpec is running the server' : 'SmartSpec’s server port is in use by another app')
    : { starting: 'SmartSpec is starting', running: 'SmartSpec is ready to work with your AI', setup: 'SmartSpec’s server is running, but SmartDesktop, which runs the AI chat, isn’t installed', off: 'SmartSpec’s server isn’t running' }[state];
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
      // A schematic's tab, or the window from Home (its pinned tab can't close).
      close: () => lastFocused && closeTab(lastFocused),
      nextTab: (delta) => stepTab(delta),
      showChat: () => lastFocused && desktop.chat(lastFocused.id, true),
      newSchema: async () => {
        const ctx = lastFocused ?? createWindow();
        await ctx.ready;
        ctx.contents.send('new-schema');
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
// Each AI session has a window of its own, opened by its first tool call, whatever windows the user
// has open: theirs are left alone. The one exception is the window SmartSpec opened on launch, when
// the AI's launcher is what started it. A window closed is opened again by the session's next call.

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
    if (strict) throw new Error(`${clientLabel(ctx.session.client)} is working in this SmartSpec window. Tell the user: they can release it from the status pill's panel.`);
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
    if (!ctx.home && !ctx.hadSchema) closeTab(ctx);
  }
}

// An AI session's first call opens a tab of its own, in the window last used (or a new window), behind
// the one showing unless the AI started SmartSpec. It shows nothing until the AI proposes something.
async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  const launched = startedApp && [...hosts].find((h) => h.tabs.length === 1 && h.tabs[0].untouched && !h.tabs[0].session);
  const host = launched || (lastFocused?.host ?? createWindow({ focus: false }).host);
  const ctx = createTab(host);
  // A chat's AI gets a tab of its own, shown: the user is working with it.
  if (launched || fromDesktop(session)) activateTab(ctx);
  await ctx.ready;
  setSessionWindow(session, ctx);
  if (!ctx.win.isVisible()) ctx.win.showInactive();
  return ctx;
}

// A prompt copied from a window names it, so the AI that gets it takes that window over.
function takeOverWindow(session, windowId) {
  const ctx = [...windows.values()].find((one) => one.id === windowId);
  if (!ctx) throw new Error(`There's no SmartSpec window ${windowId} open now. Carry on without it: your first tool call opens a window of your own.`);
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

const schemaClaim = (schemaId) => `schema:${schemaId}`;

// The schemas as an AI session may use them. Its proposals show in its own window.
// The session's tab is opened only when a call shows something in it (a proposal): reading and
// organising schematics need none, and a tab opened for them waited for a schematic that never came,
// which looked frozen. `tab()` opens it (windowForSession).
const schemasFor = (session, tab) => ({
  list: async () => (await store.list()).map((one) => ({ ...one, icon: itemIcons.get(one.id)?.icon ?? null })),
  getSchema: async (id, options) => {
    const shown = await store.getSchema(id, options);
    return shown && { ...shown, icon: itemIcons.get(id)?.icon ?? null };
  },
  // Setting the icon of the schematic the window shows (set_icon): the user's choice is kept over
  // the AI's.
  setIcon(icon) {
    const id = session.ctx && schemaOf(session.ctx);
    if (!id) throw new Error('This window shows no schematic. Open one, or propose one, first; then give it an icon.');
    const { icon: shown, kept } = itemIcons.set(id, icon, 'ai');
    return kept ? { icon: shown, note: 'The user chose this schematic\'s icon, so it stays.' } : { icon: shown };
  },
  getItem: (id, itemId, options) => store.getItem(id, itemId, options),
  getProposal: (id, options) => store.getProposal(id, options),
  listComments: (id, options) => store.listComments(id, options),
  listGroups: () => store.listGroups(),
  createGroup: (name, folderId) => store.createGroup(name, folderId),
  renameGroup: (id, name) => store.renameGroup(id, name),
  moveSchema: (schemaId, groupId) => store.moveSchema(schemaId, groupId),
  listFolders: () => store.listFolders(),
  createFolder: (name, parentId) => store.createFolder(name, parentId),
  renameFolder: (id, name) => store.renameFolder(id, name),
  moveGroup: (groupId, folderId) => store.moveGroup(groupId, folderId),
  replyToComment: (id, commentId, reply) => store.replyToComment(id, commentId, { ...reply, author: clientLabel(session.client) }),
  async propose(proposal) {
    if (proposal.schemaId) {
      const holder = sessions.claim(session, schemaClaim(proposal.schemaId));
      if (holder) throw new Error(`${clientLabel(holder.client)} is already proposing a change to this schematic, so this one wasn't made. You can still read it. Tell the user: they can answer its proposal, or release its window from the status pill's panel.`);
    }
    // A new schematic's icon (propose_schematic's icon) isn't part of it: it's kept apart, as the AI's.
    const { icon, ...rest } = proposal;
    const made = await store.propose(rest);
    sessions.claim(session, schemaClaim(made.schema));
    if (icon && !itemIcons.get(made.schema)) itemIcons.set(made.schema, icon, 'ai');
    // In the AI's tab; or, from Home (SmartDesktop's chat, the user being there), in a tab of its own.
    const request = { schemaId: made.schema, name: proposal.name ?? '' };
    const ctx = await tab();
    if (ctx.home) await openInTab(ctx, made.schema, 'show-schema', request);
    else ctx.contents.send('show-schema', request);
    if (!ctx.win.isVisible()) ctx.win.showInactive();
    return {
      ...made,
      status: 'waiting_for_user',
      wait: waitCommand('proposal', '--id', made.proposal),
      message: 'Nothing has changed yet. Tell the user straight away to switch to the SmartSpec app and accept or discard this: only they can. To hear their answer, run the wait command in the background if you can, or call get_schematic later. The wait also ends if the user sends you their comments to deal with first: answer them, revise if they need it, and wait again.',
    };
  },
});

const aiForServer = {
  // SmartDesktop's chat says which window its AI works in (the one the user was last in) as each of
  // its messages starts, and keeps the session alive while the AI thinks.
  alive: ({ session, client, window, turn }) => {
    const touched = sessions.touch(session, client);
    // Only as a message starts (`turn`), or with no window yet: within a message the AI stays where
    // it went (into a tab of its own, say), though the window it was sent from is still named.
    if (window && (turn || !touched.ctx)) bindWindow(touched, window, { turn });
  },
  wait({ what, proposal } = {}) {
    if (what !== 'proposal') throw new WaitRefused(`Can't wait for "${what}".`, 400);
    return waits.forProposal(proposal);
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
    return run(schemasFor(session, () => windowForSession(session, startedApp)));
  },
};

function sweepSessions() {
  for (const { session } of windows.values()) {
    if (session && !sessions.alive(session)) releaseWindow(session);
  }
  sessions.sweep();
}

// --- Connecting an AI --------------------------------------------------------------------
// AI apps start SmartSpec's MCP launcher, which is inside the app (see connect.js). The MCP panel
// (opened from the server pill, or Connect an AI in the menu) shows how to set up each AI app,
// and can add SmartSpec to Claude Desktop itself.

const { setups, claudeDesktopStatus, addToClaudeDesktop, waitCommand } = createConnect({
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
    message: status.state === 'different' ? 'Update SmartSpec in Claude Desktop?' : 'Add SmartSpec to Claude Desktop?',
    detail: 'SmartSpec adds itself to Claude Desktop’s settings file (claude_desktop_config.json), and keeps a copy of the file as it was. Then quit Claude Desktop and open it again to connect.',
    buttons: [status.state === 'different' ? 'Update' : 'Add', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return status;
  return addToClaudeDesktop();
}

// macOS: AI apps start SmartSpec from where it's installed, so a copy run from the disk image or
// Downloads is offered a move to Applications (which opens it again from there).
async function offerMoveToApplications(ctx) {
  if (!app.isPackaged || process.platform !== 'darwin' || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox(ctx.win, {
    type: 'question',
    message: 'Move SmartSpec to your Applications folder?',
    detail: 'Your agent opens SmartSpec from where it’s installed, so it works best in Applications.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox('SmartSpec couldn’t be moved', `${error.message}\n\nDrag SmartSpec into your Applications folder in Finder instead.`);
  }
}

// --- Updates -----------------------------------------------------------------------------

const updates = createUpdates({ report: (status) => broadcast('updates', status) });

// --- The chat, in SmartDesktop (see desktop.js) -----------------------------------------------
// The AI chat is SmartDesktop's, an app of its own, for SmartDoc and SmartSpec both: one chat
// window floating over the apps' windows, and one conversation across them (the user's choice: it
// was a chat for each window, docked or floating, in each app). SmartSpec tells it about each
// window (what it shows, when it has the focus, lines of context, the shortcuts to offer), and its
// AI uses SmartSpec's tools through the MCP server, on the window the user was last in (see
// aiForServer).

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


// What the window shows, for the AI: home, or a schematic (by name and id), and whether it's a
// new one still waiting to be accepted. `chatId` is where, as the window says: 'home', or
// `<schematic>/<draft>`, or `<schematic>/new`.
async function chatWhere(chatId = 'home') {
  if (chatId === 'home') return 'The window shows SmartSpec\'s home: the user\'s domains and schematics. To make a new schematic, propose one.';
  const [schemaId, draft] = chatId.split('/');
  const schema = await store.getSchema(schemaId).catch(() => null) ?? await store.getProposal(schemaId).catch(() => null);
  const name = schema?.name ? `“${schema.name}”` : 'a schematic';
  return draft === 'new'
    ? `The window shows ${name} (schematic_id ${schemaId}), a new schematic proposed and waiting for the user to accept it.`
    : `The window shows the schematic ${name} (schematic_id ${schemaId}). “This schematic” means this one.`;
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

store.events.on('changed', () => broadcast('schemas-changed'));

// Asks first when there's no way back: the AI would have to write the proposal again.
async function discardProposal(ctx, schemaId) {
  const proposal = await store.getProposal(schemaId);
  if (!proposal) return;
  const { response } = await dialog.showMessageBox(ctx?.win ?? undefined, {
    type: 'warning',
    message: proposal.total ? 'Discard this proposed change?' : `Discard “${proposal.name}”?`,
    detail: proposal.total ? 'The schematic stays as it is. Your AI would have to propose the change again.' : 'It has no accepted draft, so the schematic goes with it. Your AI would have to propose it again.',
    buttons: ['Cancel', 'Discard'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;
  await store.discard(schemaId);
  sessions.release(schemaClaim(schemaId));
}

// Asks first, in a window of its own (confirm.js), as a draft can't be taken back. Comments the AI
// hasn't answered are raised there, with the offer to send them to it before accepting (see
// store.sendComments), or to ask the chat's AI to answer them. Says what was done: 'accepted',
// 'sent', 'ask' (the window asks its chat's AI) or 'cancel'.
const MOST_LISTED = 4;
const QUOTE = 90;
async function acceptProposal(ctx, schemaId) {
  const proposal = await store.getProposal(schemaId);
  if (!proposal) return 'cancel';
  const what = proposal.total ? `these changes to ${proposal.name}` : proposal.name;
  const becomes = proposal.total ? `They become draft ${proposal.total + 1} of ${proposal.name}.` : `It becomes ${proposal.name}’s first draft.`;
  const { waiting, sent } = proposal.forTheAi ?? { waiting: 0, sent: 0 };
  const open = waiting ? (await store.listComments(schemaId, { proposal: true })).filter((comment) => !comment.noFurtherAction && !comment.replies?.length) : [];
  const quoted = open.slice(0, MOST_LISTED).map((comment) => {
    const said = comment.text.replace(/\s+/g, ' ');
    return said.length > QUOTE ? `${said.slice(0, QUOTE - 1)}…` : said;
  });
  if (open.length > MOST_LISTED) quoted.push(`and ${open.length - MOST_LISTED} more`);
  const many = (n) => (n === 1 ? '1 comment' : `${n} comments`);
  // Ask: the chat's AI is asked to answer them, straight away (the window sends it the request).
  const ask = { label: `Ask the AI to answer ${waiting === 1 ? 'it' : 'them'}`, choice: 'ask' };
  const aiWaits = waits.active().includes(proposal.proposalId);
  // Changes the user hasn't approved are accepted as proposed, as a SmartDoc review goes on with
  // sensible defaults: said, never in the way (the user's choice).
  const changes = proposal.changes;
  const keys = [...Object.keys(changes.items), ...changes.removed.map((one) => one.id), ...(changes.contract ? ['contract'] : [])];
  const unapproved = keys.filter((key) => !proposal.approved?.includes(key));
  const titleOf = (key) => (key === 'contract' ? 'the contract' : proposal.items.find((item) => item.id === key)?.title ?? changes.removed.find((one) => one.id === key)?.title ?? key);
  const named = unapproved.slice(0, MOST_LISTED).map((key) => `“${titleOf(key)}”`.replace('“the contract”', 'the contract'));
  if (unapproved.length > MOST_LISTED) named.push(`${unapproved.length - MOST_LISTED} more`);
  const list = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
  const notApproved = !unapproved.length ? ''
    : unapproved.length === keys.length ? `You haven’t approved any of the ${keys.length === 1 ? 'change' : `${keys.length} changes`}: ${unapproved.length === 1 ? 'it is' : 'they are'} accepted as proposed. `
      : `You haven’t approved ${unapproved.length === 1 ? 'the change to' : `${unapproved.length} of the ${keys.length} changes:`} ${list(named)}${unapproved.length === 1 ? ', which is' : ', which are'} accepted as proposed. `;
  const question = !waiting
    ? { title: `Accept ${what}?`, message: `${notApproved}${becomes}`, buttons: [{ label: 'Cancel', choice: 'cancel' }, { label: 'Accept', choice: 'accept', kind: 'primary' }] }
    : sent === waiting
      // Sent to an AI in another app, which may be at work on them, or may have stopped.
      ? {
        title: `Accept ${what}?`,
        message: `The AI hasn’t answered the ${many(sent)} you sent it yet. If it isn’t working on ${sent === 1 ? 'it' : 'them'}, ask the AI here.`,
        points: quoted,
        after: `${notApproved}${becomes}`,
        buttons: [{ label: 'Accept anyway', choice: 'accept', apart: true }, ask, { label: 'Keep waiting', choice: 'cancel', kind: 'primary' }],
      }
      : aiWaits
        ? {
          title: `Accept ${what}?`,
          message: `You have ${many(waiting)} the AI hasn’t answered. Send ${waiting === 1 ? 'it' : 'them'} to the AI, to deal with before you accept?`,
          points: quoted,
          after: notApproved.trim() || null,
          buttons: [{ label: 'Cancel', choice: 'cancel', apart: true }, { label: 'Accept anyway', choice: 'accept' }, { label: 'Send to AI', choice: 'send', kind: 'primary' }],
        }
        // No AI in another app is waiting to be sent them: the chat's AI is asked.
        : {
          title: `Accept ${what}?`,
          message: `You have ${many(waiting)} the AI hasn’t answered.`,
          points: quoted,
          after: `${notApproved}${becomes}`,
          buttons: [{ label: 'Accept anyway', choice: 'accept', apart: true }, { label: 'Cancel', choice: 'cancel' }, { ...ask, kind: 'primary' }],
        };
  const choice = await confirm(ctx?.win, question);
  if (choice === 'send') {
    await store.sendComments(schemaId);
    return 'sent';
  }
  if (choice === 'ask') return 'ask';
  if (choice !== 'accept') return 'cancel';
  await store.accept(schemaId);
  sessions.release(schemaClaim(schemaId));
  return 'accepted';
}

// A domain (a group in the store) goes, asked first, as it can't be had back. With schematics in it,
// the choice is to delete them with it, or not yet, to move them elsewhere first (the user's choice:
// moving them is cancelling, and done by hand; they used to go to No domain).
async function deleteGroup(ctx, id) {
  const { groups } = await store.listGroups();
  const group = groups.find((one) => one.id === id);
  if (!group) return false;
  const inside = (await store.list()).filter((row) => row.group === id);
  if (!inside.length) {
    const { response } = await dialog.showMessageBox(ctx?.win ?? undefined, {
      type: 'warning',
      message: `Delete the domain “${group.name}”?`,
      detail: 'It has no schematics in it.',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return false;
    await store.deleteGroup(id);
    return true;
  }
  const count = inside.length === 1 ? 'its schematic' : `its ${inside.length} schematics`;
  const names = inside.map((row) => `“${row.name}”`);
  const and = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
  const listed = names.length <= 5 ? and(names) : `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`;
  // Schematics elsewhere that embed these show them as no longer available afterwards.
  const embedders = await store.embeddersOf(inside.map((row) => row.id)).catch(() => []);
  const embedded = embedders.length
    ? ` ${and(embedders.map((one) => `“${one.name}”`))} ${embedders.length === 1 ? 'embeds' : 'embed'} ${inside.length === 1 ? 'it' : 'some of them'}, and will show ${inside.length === 1 ? 'it' : 'them'} as no longer available.`
    : '';
  const { response } = await dialog.showMessageBox(ctx?.win ?? undefined, {
    type: 'warning',
    message: `Delete the domain “${group.name}” and ${count}?`,
    detail: `${listed} ${inside.length === 1 ? 'is' : 'are'} deleted with it: drafts, proposals and comments too. This can't be undone.${embedded} To keep ${inside.length === 1 ? 'it' : 'them'}, move ${inside.length === 1 ? 'it' : 'them'} to another domain first.`,
    buttons: ['Move Schematics Elsewhere', 'Delete Domain and Schematics'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  for (const row of inside) await store.deleteSchema(row.id);
  await store.deleteGroup(id);
  return true;
}

handle('list-schemas', async () => withIcons(await store.list()));
handle('get-layout', (_ctx, schemaId) => layouts.get(schemaId));
handle('save-layout', (_ctx, schemaId, layout) => layouts.save(schemaId, layout));
handle('list-groups', () => store.listGroups());
handle('create-group', (_ctx, name, folderId) => store.createGroup(name, folderId ?? null));
handle('rename-group', (_ctx, id, name) => store.renameGroup(id, name));
handle('delete-group', (ctx, id) => deleteGroup(ctx, id));
handle('move-schema', (_ctx, schemaId, groupId) => store.moveSchema(schemaId, groupId ?? null));
// Home's folders, organising the domains (see folders.js).
handle('folders', () => store.folders());
handle('create-folder', (_ctx, name, parentId) => store.createFolder(name, parentId ?? null));
handle('rename-folder', (_ctx, id, name) => store.renameFolder(id, name));
handle('delete-folder', (_ctx, id) => store.deleteFolder(id));
handle('move-folder', (_ctx, id, parentId) => store.moveFolder(id, parentId ?? null));
handle('move-group', (_ctx, groupId, folderId) => store.moveGroup(groupId, folderId ?? null));
// A right-click menu on home, as SmartDoc's: the chosen item's id, or null if none was chosen.
handle('home-menu', (ctx, items) => new Promise((resolve) => {
  Menu.buildFromTemplate(items.map((item) => (item.separator ? { type: 'separator' } : { label: item.label, enabled: item.enabled !== false, click: () => resolve(item.id) }))).popup({
    window: ctx?.win ?? undefined,
    callback: () => setTimeout(() => resolve(null), 100),
  });
}));
handle('list-focuses', (_ctx, id, options) => store.listFocuses(id, options));
handle('copy-text', (_ctx, text) => clipboard.writeText(String(text)));
handle('list-drafts', (_ctx, id) => store.listDrafts(id));
handle('get-schema', (_ctx, id, draftId) => store.getSchema(id, { draftId: draftId ?? undefined }));
handle('get-proposal', (_ctx, id) => store.getProposal(id));
handle('get-item', (_ctx, id, itemId, options) => store.getItem(id, itemId, options));
handle('get-connections', (_ctx, id, options) => store.getConnections(id, options));
handle('list-comments', (_ctx, id, options) => store.listComments(id, options));
handle('list-earlier-comments', (_ctx, id, options) => store.listEarlierComments(id, options));
handle('add-comment', (_ctx, id, comment) => store.addComment(id, comment));
handle('delete-comment', (_ctx, id, commentId) => store.deleteComment(id, commentId));
handle('approve-change', (_ctx, id, key, flag) => store.approveChange(id, key, flag));
handle('set-no-further-action', (_ctx, id, commentId, flag) => store.setNoFurtherAction(id, commentId, flag));
handle('accept-proposal', (ctx, id) => acceptProposal(ctx, id));
handle('send-comments', (_ctx, id) => store.sendComments(id));
handle('ai-waiting', () => waits.active());
handle('discard-proposal', (ctx, id) => discardProposal(ctx, id));
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
handle('chat-shows', async (ctx, where, line, name = null) => {
  // Where the tab is, for its name in the top bar (and to find the tab showing a schematic).
  ctx.where = where;
  ctx.name = where === 'home' ? null : name;
  if (!ctx.home && where !== 'home') ctx.hadSchema = true;
  sendTabs(ctx.host);
  // Its summary, for the icon guessed while it has none of its own (see icons.js).
  const id = schemaOf(ctx);
  if (id) {
    const shown = (await store.getSchema(id).catch(() => null)) ?? (await store.getProposal(id).catch(() => null));
    if (ctx.where === where && shown?.summary !== ctx.summary) {
      ctx.summary = shown?.summary ?? null;
      sendTabs(ctx.host);
    }
  }
  const detail = await chatWhere(where);
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
// A tab by its id, or the tab asking (its schematic gone, say).
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
  const schemaId = schemaOf(tab);
  Menu.buildFromTemplate([
    // The chat that owns it, if one does; and Open Chat (only with SmartDesktop installed: the user's
    // choice), as its chat button: this tab's chat, or a new one for it (from Home, the chat last
    // used), brought forward ready to type in.
    ...(tab.chat ? [{ label: `Chat: ${tab.chat.title}`, enabled: false }] : []),
    ...(desktop.installed() ? [{ label: 'Open Chat', click: () => openChatFor(tab) }, { type: 'separator' }] : tab.chat ? [{ type: 'separator' }] : []),
    { label: 'Change Icon…', enabled: Boolean(schemaId), click: () => host.active.contents.send('icon-picker', { docId: schemaId, current: tabIcon(tab), name: tab.name, at: { left: box.left, top: 6 } }) },
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
// The user's choice of a schematic's icon, which the AI never replaces.
handle('set-icon', (_ctx, schemaId, icon) => itemIcons.set(schemaId, icon, 'user'));
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
// tab would go (`tab-drop`: { id, index, x }, or null). As SmartDoc's.
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
// A schematic opened in Home, in a tab of its own (see openInTab): `request` is { path, layout }.
handle('open-in-tab', (ctx, request) => {
  const schemaId = request?.path?.[0]?.schemaId;
  if (!schemaId) return null;
  openInTab(homeOf(ctx), schemaId, 'open-level', request);
  return null;
});
// Opens SmartDesktop's page, to download it.
handle('get-desktop', () => shell.openExternal('https://github.com/tw050x/smartdesktop/releases/latest'));
handle('get-appearance', () => nativeTheme.themeSource);
handle('set-appearance', (_ctx, appearance) => setAppearance(appearance));

// --- App lifecycle -----------------------------------------------------------------------

app.whenReady().then(async () => {
  // The app is in beta, and its About panel says so (as Settings does).
  app.setAboutPanelOptions({ credits: 'SmartSpec is in beta, so it may change significantly from one version to the next.' });
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
