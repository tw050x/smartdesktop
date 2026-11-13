import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell, WebContentsView } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmReplace } from './confirm-replace.js';
import { CONVERTED, convertFile, EXTENSIONS, inspect } from './convert.js';
import { createConnect } from './connect.js';
import { MCP_PORT, portHolder, startMcpServer } from './mcp-server.js';
import { createDesktop } from './desktop.js';
import { iconFor } from './icons.js';
import { createItemIcons } from './item-icons.js';
import { readPdfText } from './pdf-text.js';
import { createTabDrag } from './tab-drag.js';
import { READ_ONLY } from './mcp-tools.js';
import { clientLabel, createSessions } from './sessions.js';
import { buildMenu } from './menu.js';
import { createUpdates } from './updates.js';
import { WaitRefused, createWaits } from './waits.js';
import { createShared, createWorkspace } from './workspace.js';
import { acceptWarning } from './comments.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_MS = 15 * 1000;
const TOP_BAR_HEIGHT = 44;
// Height of the area macOS reserves for the traffic lights (the circles sit centred in it).
const TRAFFIC_LIGHTS_HEIGHT = 16;

// The app used to be called Shortlist Dock, and before that Employment Short List App, and its
// data lived in a folder of each name. The first time it runs as SmartDoc, everything in the old
// folders moves across, newest name first (anything already in the new folder is left alone), so
// documents, drafts, recent files and the AI connection's token carry over. An old folder is
// removed once it's empty. (Defined before the move below runs.)
const LEGACY_NAMES = ['Shortlist Dock', 'Employment Short List App'];

// A development copy keeps its data in a folder of its own, SmartDoc Dev (and its MCP server on a
// port of its own, see mcp-server.js), so it never reads or overwrites the installed app's data,
// and the two can run side by side: the app allows one copy per data folder. Automated tests
// point it at a separate folder again (SMARTDOC_USER_DATA) and port (SMARTDOC_PORT), so a test
// copy can run beside both. Set before the app is ready so Chromium's own storage moves too. The
// packaged app ignores both, and is the only one to move data from the app's old names.
if (!app.isPackaged) {
  app.setPath('userData', process.env.SMARTDOC_USER_DATA ? path.resolve(process.env.SMARTDOC_USER_DATA) : path.join(app.getPath('appData'), 'SmartDoc Dev'));
} else {
  moveLegacyUserData();
}

function moveLegacyUserData() {
  const current = app.getPath('userData');
  for (const name of LEGACY_NAMES) {
    const legacy = path.join(app.getPath('appData'), name);
    if (legacy === current || !fs.existsSync(legacy)) continue;
    try {
      fs.mkdirSync(current, { recursive: true });
      for (const entry of fs.readdirSync(legacy)) {
        const target = path.join(current, entry);
        if (!fs.existsSync(target)) fs.renameSync(path.join(legacy, entry), target);
      }
      if (!fs.readdirSync(legacy).length) fs.rmdirSync(legacy);
    } catch (error) {
      console.error(`Couldn’t move the data from ${name}:`, error);
    }
  }
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

// Each window has its own workspace, kept in a context with it. Whatever a window asks for, and
// whatever an AI session does in its window, runs inside that window's context, which everything
// below reaches through win() and workspace; outside any (the menu, a file opened from Finder) that
// means the window last used.
const context = new AsyncLocalStorage();
const windows = new Map(); // webContents id → { id, win, workspace, ready, session, aiOpen, untouched }
let lastFocused = null;
const current = () => context.getStore() ?? lastFocused;
const win = () => current()?.win ?? null;
// Page texts are read here too, so the AI needn't wait for a window to draw them (pdf-text.js).
const readDir = app.isPackaged ? path.join(process.resourcesPath, 'pdf', 'read') : path.join(dirname, '../../../pdf/read');
const shared = createShared(app.getPath('userData'), { readText: (file) => readPdfText(file, readDir) });
const waits = createWaits({ store: shared.store, events: shared.events, onChange: () => broadcast('ai-waiting', waits.active()) });
const workspace = new Proxy({}, {
  get(_, key) {
    const target = current()?.workspace;
    // With no window at all, what's shared still answers (the recent documents for the menu).
    if (!target) return key === 'recent' ? shared.recent : undefined;
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
let mcp = null; // { url, token } once the MCP server is listening
let mcpStarting = true;
let mcpProblem = null; // why it isn't running: { reason: 'port-in-use', port, holder } or { reason: 'error', message }
const MCP_RETRY_MS = 5000; // while the port is taken, how often to try again, so it starts once it's free

// --- Appearance ----------------------------------------------------------------------------

// Light, dark, or as the system is: chosen in Settings and kept in settings.json, beside the
// documents. Electron's theme then has the interface's styles follow it (their light-dark()
// colours, see styles.css), and its native menus and dialogs too.
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

// Experimental features, off until the user turns them on (kept in settings.json): `convert`,
// opening Word, Excel and PowerPoint files (and Markdown, text and pictures) by turning them into
// PDFs (convert.js), in Settings › Experimental; `reader`, drawing PDFs with SmartDoc's own reader
// (packages/pdf/read) rather than pdf.js, switched at will from the top bar (the user's choice: it
// replaces pdf.js once they're happy with it). Every window hears of a change (`experimental`).
const EXPERIMENTS = ['convert', 'reader'];
const experimental = () => ({ convert: readSettings().experimental?.convert === true, reader: readSettings().experimental?.reader === true });
function setExperimental(name, on) {
  if (!EXPERIMENTS.includes(name)) return;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const settings = readSettings();
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, experimental: { ...settings.experimental, [name]: Boolean(on) } }, null, 2));
  broadcast('experimental', experimental());
  sendAllTabs();
}

// The bundled fonts (packages/pdf/fonts), which SmartDoc's reader draws fonts a PDF doesn't
// embed with when the Mac hasn't the font itself.
function readerFont(file) {
  if (typeof file !== 'string' || !/^[A-Za-z]+-[A-Za-z]+\.ttf$/.test(file)) return null;
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'pdf', 'fonts') : path.join(dirname, '../../../pdf/fonts');
  try {
    return fs.readFileSync(path.join(dir, file));
  } catch {
    return null;
  }
}

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

// The windows' title, which Mission Control shows: a development build's says so, to tell it
// apart from the installed app.
const WINDOW_TITLE = app.isPackaged ? 'SmartDoc' : 'SmartDoc Development';

// --- Windows and their tabs ------------------------------------------------------------------
// A window holds tabs (the user's choice: working in tabs rather than in many windows, though more
// windows are still allowed). The first is Home, pinned: it can't be closed, and only it shows the
// home screen. Each other tab shows one document, and never home: opening a document from Home (or
// the menu, a dropped file, an AI) opens it in a tab, the one already showing it if there is one.
// Each tab is what a window was: its own workspace, history and AI session (`ctx`, with the tab's
// id, which a copied prompt names so an AI can take it over).
//
// The window's own page is the top bar across it (tabs.html: the traffic lights, back and forward,
// the tabs and the app's status, see tab-strip.js); each tab's page (index.html) is a view below it,
// only the active one showing. The window is frameless: macOS keeps its traffic lights, placed in
// the top bar; Windows and Linux get the system window controls drawn over it.
const hosts = new Set(); // { win, tabs: [home, …], active }
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
  const browser = new BrowserWindow({
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
  if (bounds) browser.setBounds(bounds);
  // The window keeps its own title, not the page's, so a development build's is told apart.
  browser.on('page-title-updated', (e) => e.preventDefault());
  const host = { win: browser, tabs: [], active: null, history: { back: false, forward: false } };
  hosts.add(host);
  strips.set(browser.webContents.id, host);
  browser.webContents.on('did-finish-load', () => sendTabs(host));
  browser.loadFile(path.join(dirname, '../../build/renderer/tabs.html'));
  browser.on('resize', () => layoutTabs(host));
  // The window has the focus: its active tab does, for the menu, the AI chat (SmartDesktop shows the
  // chat while a window of the apps has the focus) and the keyboard.
  browser.on('focus', () => {
    host.focusedAt = Date.now(); // the window in front, for where a dragged tab is dropped
    const ctx = host.active;
    if (!ctx) return;
    lastFocused = ctx;
    ctx.contents.focus();
    desktop.focus(ctx.id, browser.getBounds());
    context.run(ctx, updateMenu);
  });
  const away = () => host.active && desktop.blur(host.active.id);
  browser.on('blur', away);
  browser.on('minimize', away);
  browser.on('hide', away);
  // In full screen macOS moves the traffic lights out of the top bar, so the interface can reclaim
  // the space reserved for them.
  const fullScreen = (on) => {
    browser.webContents.send('full-screen', on);
    for (const tab of host.tabs) tab.contents.send('full-screen', on);
  };
  browser.on('enter-full-screen', () => fullScreen(true));
  browser.on('leave-full-screen', () => fullScreen(false));
  browser.on('closed', () => {
    hosts.delete(host);
    for (const tab of [...host.tabs]) disposeTab(tab);
    host.tabs = [];
    if (lastFocused?.host === host) lastFocused = [...windows.values()].at(-1) ?? null;
    updateMenuFor(lastFocused);
  });
  const home = createTab(host, { home: true });
  activateTab(home);
  return home;
}
const strips = new Map(); // the top bar's webContents id → its window

function createTab(host, { home = false } = {}) {
  const id = `w-${randomUUID().slice(0, 4)}`;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--smartdoc-window=${id}`, `--smartdoc-tab=${home ? 'home' : 'document'}`],
    },
  });
  view.setBackgroundColor(windowColours().background);
  const ctx = { id, host, home, view, contents: view.webContents, get win() { return this.host.win; }, workspace: createWorkspace(shared), ready: null, session: null, aiOpen: null, untouched: true, hadDocument: false, history: { back: false, forward: false } };
  windows.set(view.webContents.id, ctx);
  if (home) host.tabs.unshift(ctx);
  else host.tabs.push(ctx);
  // SmartDesktop is told which tab is Home: what happens there goes to no chat.
  if (home) desktop.window(id, { home: true, title: 'Home' });
  view.setVisible(false);
  host.win.contentView.addChildView(view);
  view.setBounds(tabBounds(host));
  const inTab = (fn) => (...args) => context.run(ctx, () => fn(...args));
  ctx.workspace.events.on('draft', inTab(() => {
    ctx.untouched = false;
    const doc = ctx.workspace.document;
    // Home never shows a document: it goes to a tab of its own.
    if (ctx.home && doc) return moveToTab(ctx);
    // A tab whose document has closed (deleted, say) closes too.
    if (!ctx.home && !doc && ctx.hadDocument) return closeTab(ctx);
    if (doc) ctx.hadDocument = true;
    sendTabs(ctx.host);
    return sendDraft();
  }));
  ctx.workspace.events.on('tool', inTab((tool) => !(ctx.home && ctx.workspace.document) && send('tool', tool)));
  ctx.workspace.events.on('review', inTab((review) => {
    if (ctx.home && ctx.workspace.document) return;
    send('review', review);
    updateMenu();
  }));
  ctx.ready = new Promise((resolve) => view.webContents.once('did-finish-load', resolve));
  ctx.ready.then(inTab(sendEverything));
  ctx.ready.then(() => ctx.host.active === ctx && ctx.contents.send('tab-lines', ctx.host.lines ?? null));
  view.webContents.loadFile(path.join(dirname, '../../build/renderer/index.html'));
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
  context.run(ctx, () => {
    host.win.setRepresentedFilename?.(ctx.workspace.document ? ctx.workspace.currentDraftPdfPath() : '');
    updateMenu();
  });
  sendTabs(host);
}

// Closes a tab: a document's (Home only closes with its window). The tab beside it shows instead.
function closeTab(ctx) {
  const { host } = ctx;
  if (ctx.home) return host.win.close();
  const at = host.tabs.indexOf(ctx);
  if (at < 0) return;
  host.tabs.splice(at, 1);
  if (host.active === ctx) activateTab(host.tabs[at] ?? host.tabs[at - 1] ?? host.tabs[0]);
  disposeTab(ctx);
  host.win.contentView.removeChildView(ctx.view);
  ctx.view.webContents.close();
  sendTabs(host);
}

function disposeTab(ctx) {
  if (!windows.has(ctx.contents.id)) return;
  windows.delete(ctx.contents.id);
  if (lastFocused === ctx) lastFocused = ctx.host.active !== ctx ? ctx.host.active : [...windows.values()].at(-1) ?? null;
  // An AI's tab comes back as it was, the next time the AI needs it.
  if (ctx.session) {
    const doc = ctx.workspace.document;
    ctx.session.restore = doc && { docId: doc.id, variationId: doc.variationId, draftId: doc.workingDraftId ?? doc.currentDraftId, tool: ctx.workspace.tool };
    ctx.session.ctx = null;
  }
  desktop.closed(ctx.id);
  ctx.workspace.dispose();
  ctx.workspace.events.removeAllListeners(); // nothing left to tell
  ctx.workspace.close();
  updateMenuFor(lastFocused);
}

// Moves a tab to `index` among a window's tabs (never before Home): in its own window, or into
// another (its page, and all it holds, go with it: the document, its history, an AI working in it),
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

// A document opened in Home goes to its own tab (the one already showing it, if one is), and Home
// goes back to home. An AI working in Home goes with it.
async function moveToTab(home) {
  if (home.moving) return home.moving;
  const doc = home.workspace.document;
  if (!doc) return;
  home.moving = (async () => {
    const at = { docId: doc.id, variationId: doc.variationId, draftId: doc.workingDraftId ?? doc.currentDraftId, tool: home.workspace.tool, preview: home.workspace.previewing };
    const { session } = home;
    // A chat's AI gets a tab of its own, even with the document open in another (the same document
    // can be open in several tabs, each a different chat's); the user, the tab showing it that no
    // chat owns, if there is one.
    const reuse = !fromDesktop(session) && home.host.tabs.find((t) => !t.home && !t.chat && t.workspace.document?.id === at.docId);
    const tab = reuse || createTab(home.host);
    await tab.ready;
    await context.run(tab, async () => {
      await tab.workspace.openDraft(at.docId, at.variationId, at.draftId, at.tool);
      if (at.preview) await tab.workspace.openPreview().catch(() => {});
    });
    // Home keeps it until the tab has it, so whatever opened it (an AI's open_document, say) can still
    // read it meanwhile; then Home goes back to home.
    home.workspace.close();
    if (session && session.ctx === home) {
      releaseWindow(session);
      if (!tab.session) setSessionWindow(session, tab);
    }
    activateTab(tab);
    return tab;
  })().finally(() => (home.moving = null));
  return home.moving;
}

// The top bar's state for each window: its tabs (Home first; each document's by its name, with the
// AI working in it), back and forward for the active tab, and the app's status.
// Each document's icon, set by the user or the AI (see item-icons.js), on its tab and on home.
const itemIcons = createItemIcons(app.getPath('userData'), {
  onChange: () => {
    sendAllTabs();
    broadcast('recent-documents', withIcons(shared.recent));
  },
});
const tabIcon = (ctx) => {
  const doc = ctx.workspace.document;
  return doc ? iconFor(itemIcons.get(doc.id), doc.name, 'file-text') : 'file-text';
};

function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  const doc = ctx.workspace.document;
  if (doc) return doc.name.replace(/\.pdf$/i, '');
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a document…` : 'Opening…';
}
function sendTabs(host) {
  if (!host || host.win.isDestroyed()) return;
  const state = {
    tabs: host.tabs.map((t) => ({ id: t.id, home: t.home, title: tabTitle(t), icon: t.home ? null : tabIcon(t), active: t === host.active, ai: t.session ? clientLabel(t.session.client) : null, chat: t.chat ?? null })),
    back: Boolean(host.active?.history.back),
    forward: Boolean(host.active?.history.forward),
    status: appStatus(),
    // The switch between pdf.js and SmartDoc's own reader (experimental).
    reader: experimental().reader,
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
    ? (server.holder?.kind === 'smartdoc' ? 'Another copy of SmartDoc is running the server' : 'SmartDoc’s server port is in use by another app')
    : { starting: 'SmartDoc is starting', running: 'SmartDoc is ready to work with your AI', setup: 'SmartDoc’s server is running, but SmartDesktop, which runs the AI chat, isn’t installed', off: 'SmartDoc’s server isn’t running' }[state];
  return { state, label, title };
}
// Home, of the window a tab is in (where documents are opened from).
const homeOf = (ctx = current()) => ctx?.host?.tabs[0] ?? null;

// --- Keeping the window and menu in step with the workspace -----------------------------

const send = (channel, value) => current()?.contents?.send(channel, value);
// For every window: what's the same in all of them.
const broadcast = (channel, value) => {
  for (const { contents } of windows.values()) contents.send(channel, value);
};
// The home screen's documents, each with where it stands in each tool.
// Each with its icon (see icons.js): its own, or the guess from its name.
const withIcons = (list) => list.map((r) => ({ ...r, icon: iconFor(itemIcons.get(r.id), r.name, 'file-text') }));
const recentForWindow = async () => withIcons(shared.recent);
const MENU_RECENT = 10; // File › Open Recent; the home screen lists them all

// What the window shows, for the chat in SmartDesktop: what it moves to (a document, another draft or
// variation, a preview, home) goes into the conversation as a line of context, so the AI knows, and
// the conversation reads in the order things happened; and the AI is told what each window shows.
const draftWords = (view) => (view.draft.isPreview ? `the preview of draft ${view.draft.number + 1}` : view.draft.isOriginal ? 'the original' : `draft ${view.draft.number}`);
function whatShows(view) {
  if (!view) return { key: 'home', text: 'Went home', detail: 'The window shows SmartDoc\'s home: the user\'s documents.' };
  const variation = view.variation.isOriginal ? '' : `, the variation “${view.variation.name}”`;
  return {
    key: `${view.document.id}/${view.variation.id}/${view.draft.id}`,
    text: `Opened “${view.document.name}”${variation}, ${draftWords(view)}`,
    detail: `The window shows the document “${view.document.name}” (document_id ${view.document.id})${variation}, ${draftWords(view)} of ${view.draft.total + 1}.`,
  };
}
function noteWhatShows(ctx, view) {
  // (SmartDesktop puts the line in the chat when it changes: the first thing a window shows isn't news.)
  desktop.window(ctx.id, { shows: whatShows(view), title: view ? view.document.name : 'Home', home: Boolean(ctx.home) });
}

async function sendDraft() {
  // Only the newest of this window's sends goes out. Opening a draft and then its preview straight
  // away starts two, and the draft's PDF can take longer to read than the preview's, so without this
  // it would arrive last and cover the preview.
  const ctx = current();
  const ticket = (ctx.draftTicket = (ctx.draftTicket ?? 0) + 1);
  const view = await workspace.draftView();
  if (ctx.draftTicket !== ticket) return;
  noteWhatShows(ctx, view);
  // The draft's review comes with it, so the window never shows a draft with another draft's review.
  send(view ? 'draft-opened' : 'document-closed', view && { ...view, review: workspace.review, tool: workspace.tool });
  // Back on the home screen, its cards show where each document now stands.
  if (!view) send('recent-documents', await recentForWindow());
  if (current()?.host?.active === current()) win()?.setRepresentedFilename?.(view ? workspace.currentDraftPdfPath() : '');
  updateMenu();
}

const mcpStatus = () => (mcp ? { state: 'running', url: mcp.url } : mcpStarting ? { state: 'starting' } : { state: 'off', ...mcpProblem });

// Starts the MCP server, or says why it couldn't. A taken port is tried again every few seconds
// (another copy of the app may be quitting); anything else waits for the user's Try again.
let mcpRetry = null;
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
let lastMcpStatus = null;

async function sendEverything() {
  send('recent-documents', await recentForWindow());
  send('mcp-status', mcpStatus());
  const { session } = current();
  if (session) send('ai-control', clientLabel(session.client));
  if (workspace.document) {
    await sendDraft();
    send('review', workspace.review);
  }
  updateMenu();
}

shared.events.on('folders', () => broadcast('folders', shared.folders));
shared.events.on('labels', () => broadcast('labels', shared.labels));
// A new name reaches every window showing that document, without redrawing its pages.
shared.events.on('renamed', (docId) => {
  for (const { contents, workspace: each } of windows.values()) {
    const doc = each.document;
    if (doc?.id !== docId) continue;
    const variation = doc.variations.find((v) => v.id === doc.variationId);
    contents.send('names', { document: doc.name, variation: variation.name });
  }
  sendAllTabs();
});
shared.events.on('recent', () => {
  broadcast('recent-documents', withIcons(shared.recent));
  updateMenuFor(lastFocused);
});

// The menu is the app's, so it's only ever the focused window's. With no window left it still
// offers what needs none.
const updateMenuFor = (ctx) => context.run(ctx ?? {}, updateMenu);
function updateMenu() {
  if (context.getStore()?.win && context.getStore() !== lastFocused) return;
  const doc = workspace.document;
  const at = doc ? doc.line.indexOf(doc.currentDraftId) : -1;
  const review = doc ? workspace.review : null;
  Menu.setApplicationMenu(buildMenu({
    hasWindow: Boolean(win()),
    hasDocument: Boolean(doc),
    hasDraft: Boolean(doc) && !workspace.previewing,
    review: review && {
      highlights: review.type === 'highlights',
      canStartAgain: review.status === 'committed' || Boolean(review.items?.length || review.highlights?.length || review.annotations?.length || review.requests?.length),
      canClearDecisions: review.type !== 'highlights' && review.status === 'committed'
        && Boolean(review.items.some((i) => i.decision.status !== 'pending' || i.decision.comment) || review.changes?.length || review.requests?.some((q) => q.afterCommit)),
    },
    // Stepping back from a preview returns to the draft it was written from.
    canStepBack: at > 0 || workspace.previewing,
    canStepForward: doc && !workspace.previewing ? at < doc.line.length - 1 : false,
    recent: workspace.recent.slice(0, MENU_RECENT),
    actions: {
      newWindow: () => context.run(createWindow(), () => {}),
      showOpenDialog,
      openDocument: (id) => openDocument(id),
      saveDraftAs,
      newVariation,
      documentFromDraft: () => {
        const doc = workspace.document;
        if (doc) documentFromDraft(doc.id, doc.variationId, doc.currentDraftId);
      },
      close: () => current() && closeTab(current()),
      nextTab: (delta) => stepTab(delta),
      showChat: () => current() && desktop.chat(current().id, true),
      stepDraft: (delta) => workspace.stepDraft(delta),
      find: (which) => send('find', which),
      showSettings: () => send('show-settings'),
      // Its answer shows in the update toast, in a window (one is opened if none is).
      checkForUpdates: async () => {
        if (!lastFocused) await createWindow().ready;
        updates.check({ byUser: true });
      },
      resetReview,
      showConnectAi,
    },
  }));
}

// --- Documents ---------------------------------------------------------------------------

async function ensureWindow() {
  if (!current()) createWindow();
  await current().ready;
}

// The next or previous tab in the window (the menu's Show Next Tab and Show Previous Tab).
function stepTab(delta) {
  const host = current()?.host;
  if (!host) return;
  const at = host.tabs.indexOf(host.active);
  activateTab(host.tabs[(at + delta + host.tabs.length) % host.tabs.length]);
}

// Opened from Home, it goes to a tab of its own (see moveToTab).
async function importFile(filePath) {
  await ensureWindow();
  const home = homeOf();
  let checked;
  try {
    checked = await checkImportable(filePath);
  } catch (error) {
    dialog.showErrorBox('Couldn’t open the file', error.message);
    return;
  }
  try {
    await context.run(home, () => home.workspace.importAndOpen(checked.path, { converted: checked.converted }));
  } catch {
    dialog.showErrorBox('Couldn’t open the file', `${filePath} could not be read.`);
    return;
  }
  tellConversion(checked);
}

// After a file's been turned into a PDF, what didn't come out as it is, if anything (fonts stood
// in for, things not drawn yet): said once, as it opens. The AI reads it in get_document_info.
function tellConversion(checked) {
  const notes = checked?.converted?.notes;
  if (!notes?.length || !win()) return;
  dialog.showMessageBox(win(), {
    type: 'info',
    message: `${path.basename(checked.path)} was turned into a PDF`,
    detail: `Opening Word, Excel and PowerPoint files is experimental. The original is kept with the document.\n\n${notes.join('\n\n')}`,
    buttons: ['OK'],
  });
}

// A document from the recent list: its tab, if one shows it, or a new one.
async function openDocument(docId) {
  await ensureWindow();
  const showing = current().host.tabs.find((t) => !t.home && !t.chat && t.workspace.document?.id === docId);
  if (showing) return activateTab(showing);
  const home = homeOf();
  await context.run(home, () => home.workspace.openDocument(docId));
}

async function pickPdf() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win() ?? undefined, {
    properties: ['openFile'],
    filters: experimental().convert ? [{ name: 'Documents', extensions: EXTENSIONS }] : [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return canceled ? null : filePaths[0] ?? null;
}

async function showOpenDialog() {
  const filePath = await pickPdf();
  if (filePath) await importFile(filePath);
}

// --- Documents opened by the AI ----------------------------------------------------------
// The AI can open a document from the recent list straight away. A file on disk needs the user:
// either the AI names a path and the user confirms it in the app (so an AI can't read files
// without the user knowing), or the user picks the file. Those wait on the user, so open_document
// returns at once, telling the AI to send the user to the app; reading the document then waits
// for the outcome. Only one such request waits at a time.

const AI_OPEN_WAIT_MS = 45 * 1000;
// current().aiOpen: { name, state: 'waiting' | 'opened' | 'cancelled' | 'failed', error, done }

async function bringToFront() {
  await ensureWindow();
  if (win().isMinimized()) win().restore();
  win().show();
  app.focus({ steal: true });
}

// Requests waiting on the user, by id, for `smartdoc wait`: kept once answered, as the wait may
// begin after.
const openRequests = new Map();
const MAX_OPEN_REQUESTS = 50;

function rememberRequest(request) {
  request.id = `${request.kind}-${randomUUID().slice(0, 8)}`;
  openRequests.set(request.id, request);
  if (openRequests.size > MAX_OPEN_REQUESTS) openRequests.delete(openRequests.keys().next().value);
  return request;
}

function waitOnUser(name, task) {
  const request = rememberRequest({ kind: 'open', owner: current(), name, state: 'waiting', error: null });
  request.done = task().then(
    (opened) => { request.state = opened ? 'opened' : 'cancelled'; },
    (error) => { request.state = 'failed'; request.error = error.message; },
  );
  current().aiOpen = request;
  return { request_id: request.id, wait: waitCommand('open', '--request', request.id) };
}

// Waits for the user's answer to a request. It's reported here, so not again by settle or
// delete_document.
function waitForRequest(kind, id) {
  const request = openRequests.get(id);
  if (request?.kind !== kind) throw new WaitRefused(`There's no ${kind} request ${id}.`, 404);
  let cancelled = false;
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve(null);
    };
    request.done.then(() => {
      if (cancelled) return;
      if (request.owner?.aiOpen === request) request.owner.aiOpen = null;
      if (deleteRequests.get(request.docId) === request) deleteRequests.delete(request.docId);
      resolve({ request: id, event: `${kind}-${request.state}`, ...(request.name && { name: request.name }), ...(request.error && { error: request.error }) });
    });
  });
  return { promise, cancel: () => cancel() };
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

// Whether a file can be opened: a PDF, or (with Settings › Experimental › Open Word, Excel and
// PowerPoint files) one that can be turned into one, which it then is: { path, converted? }.
async function checkImportable(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  const stats = await fs.promises.stat(resolved).catch(() => null);
  if (!stats?.isFile()) throw new Error(`There's no file at ${resolved}.`);
  const handle = await fs.promises.open(resolved, 'r');
  let isPdf;
  try {
    const { buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    isPdf = buffer.toString('latin1') === '%PDF-';
  } finally {
    await handle.close();
  }
  if (isPdf) return { path: resolved };
  const name = path.basename(resolved);
  const { kind, bytes, refusal } = await inspect(resolved);
  if (refusal) throw new Error(refusal);
  if (!CONVERTED[kind]) throw new Error(`${name} isn't a PDF. SmartDoc opens PDFs${experimental().convert ? ', Word, Excel and PowerPoint files, Markdown, text and pictures' : ' only'}.`);
  if (!experimental().convert) throw new Error(`${name} is a ${CONVERTED[kind]}, and SmartDoc opens PDFs. To open it, turn on Open Word, Excel and PowerPoint files in Settings › Experimental.`);
  try {
    return { path: resolved, converted: await convertFile(resolved, bytes) };
  } catch (error) {
    throw new Error(`${name} couldn’t be turned into a PDF: ${error.message}`);
  }
}

// Delete requests from the AI still to be reported, by document: one at a time for each.
const deleteRequests = new Map();
const DELETE_ANSWERS = {
  deleted: 'The user approved it, and the document is deleted for good.',
  declined: 'The user declined, so the document is still there. Don\'t ask again unless they want you to.',
  failed: 'It wasn\'t deleted.',
};

const documentsForAi = {
  // Filled in below: it depends on the session.
  useWindow: null,
  list: () => workspace.recent.map((r) => {
    const folder = workspace.folderPath(r.id);
    return { id: r.id, name: r.name, importedAt: r.importedAt, ...(folder && { folder }), icon: itemIcons.get(r.id)?.icon ?? null, open: workspace.document?.id === r.id };
  }),
  // The open document's icon (null until it has one of its own), and setting it (set_icon): the
  // user's choice is kept over the AI's.
  iconOf: () => (workspace.document ? itemIcons.get(workspace.document.id)?.icon ?? null : null),
  setIcon(icon) {
    const doc = workspace.document;
    if (!doc) throw new Error('No document is open. Open one first, then give it an icon.');
    const { icon: shown, kept } = itemIcons.set(doc.id, icon, 'ai');
    return kept ? { icon: shown, note: 'The user chose this document\'s icon, so it stays.' } : { icon: shown };
  },

  async open({ path: filePath, document_id: docId } = {}) {
    const aiOpen = current().aiOpen;
    if (aiOpen?.state === 'waiting') {
      throw new Error(`SmartDoc is still waiting for the user to ${aiOpen.name ? `confirm opening ${aiOpen.name}` : 'pick a file'}. Ask them to answer in the app, then call get_document_info.`);
    }
    if (docId) {
      if (!workspace.isRecent(docId)) throw new Error(`No document ${docId}. list_documents shows the ones that can be opened.`);
      await ensureWindow();
      if (workspace.document?.id !== docId) await workspace.openDocument(docId);
      return { status: 'opened', document: workspace.document.name };
    }
    if (filePath) {
      const checked = await checkImportable(filePath);
      const resolved = checked.path;
      const name = path.basename(resolved);
      const waiting = waitOnUser(name, async () => {
        await bringToFront();
        const choice = await confirmReplace(win(), { current: workspace.document?.name, next: name, unsaved: false, source: path.dirname(resolved) });
        if (choice === 'cancel') return false;
        await workspace.importAndOpen(resolved, { converted: checked.converted });
        tellConversion(checked);
        return true;
      });
      return {
        ...waiting,
        status: 'waiting_for_user',
        message: `Before anything else, tell the user to switch to the SmartDoc app and confirm opening ${name}: it won't open until they do. Then call get_document_info, which waits for their answer.`,
      };
    }
    const waiting = waitOnUser(null, async () => {
      await bringToFront();
      const picked = await pickPdf();
      if (!picked) return false;
      const checked = await checkImportable(picked);
      await workspace.importAndOpen(checked.path, { converted: checked.converted });
      tellConversion(checked);
      return true;
    });
    return {
      ...waiting,
      status: 'waiting_for_user',
      message: 'Before anything else, tell the user to switch to the SmartDoc app and choose the file in the window it has opened: nothing opens until they do. Then call get_document_info, which waits for their choice.',
    };
  },

  // Asks the user, in the app, to delete a document: every request asks again, and only their answer
  // deletes it. The AI hears the answer from its wait command, or by asking again.
  deleteDocument({ document_id: docId, reason }) {
    const session = current().session;
    const asked = deleteRequests.get(docId);
    if (asked?.state === 'waiting') {
      return { status: 'waiting_for_user', request_id: asked.id, wait: waitCommand('delete', '--request', asked.id), message: `Still waiting for the user to answer in the SmartDoc app about deleting ${asked.name}. Remind them to switch to it.` };
    }
    if (asked) {
      deleteRequests.delete(docId);
      return { status: asked.state, document: asked.name, ...(asked.error && { error: asked.error }), message: DELETE_ANSWERS[asked.state] };
    }
    const entry = workspace.recent.find((r) => r.id === docId);
    if (!entry) throw new Error(`No document ${docId}. list_documents shows the ones there are.`);
    if (openElsewhere(docId)) throw new Error(`${entry.name} is open in another SmartDoc window, so it can't be deleted. Nothing was changed. Tell the user: they can close it there.`);

    const request = rememberRequest({ kind: 'delete', docId, name: entry.name, state: 'waiting', error: null });
    deleteRequests.set(docId, request);
    request.done = (async () => {
      await bringToFront();
      const approved = await askToDeleteDocument(entry.name, `${clientLabel(session?.client)} asks to delete this document. It gives this reason, in its own words:\n\n“${reason}”`);
      if (!approved) return 'declined';
      // Things may have moved on while the question was up.
      if (!workspace.isRecent(docId)) throw new Error('It has already been deleted.');
      if (openElsewhere(docId)) throw new Error('It has since been opened in another window.');
      if (workspace.document?.id === docId) {
        workspace.close();
        if (session) session.docId = null;
      }
      await workspace.deleteDocument(docId);
      return 'deleted';
    })().then(
      (state) => { request.state = state; },
      (error) => { request.state = 'failed'; request.error = error.message; },
    );
    return {
      status: 'waiting_for_user',
      request_id: request.id,
      wait: waitCommand('delete', '--request', request.id),
      message: `Nothing is deleted yet. Tell the user straight away to switch to the SmartDoc app and answer about deleting ${entry.name}: only they can approve it. To hear their answer, run the wait command in the background if you can, or call delete_document again.`,
    };
  },

  // Called before reading the document: waits for the user's answer to an open request, if there is one.
  // An answer is reported once.
  async settle() {
    const request = current().aiOpen;
    if (!request) return;
    if (request.state === 'waiting') {
      await Promise.race([request.done, new Promise((resolve) => setTimeout(resolve, AI_OPEN_WAIT_MS))]);
    }
    const what = request.name ?? 'the file';
    if (request.state === 'waiting') throw new Error(`Still waiting for the user to ${request.name ? `confirm opening ${request.name}` : 'pick a file'} in SmartDoc. Remind them to switch to the app, then call get_document_info again.`);
    current().aiOpen = null;
    if (request.state === 'cancelled') throw new Error(`The user cancelled opening ${what}.`);
    if (request.state === 'failed') throw new Error(`Couldn't open ${what}: ${request.error}`);
  },
};

// --- AI sessions ---------------------------------------------------------------------------
// Each AI session has a window of its own, opened by its first tool call, whatever windows the user
// has open: theirs are left alone. The one exception is a prompt copied from a window, which names
// it, so the AI that gets it takes that window over (use_window); and the window SmartDoc opened on
// launch, when the AI's launcher is what started it. A window closed comes back as it was.

const sessions = createSessions();

// A chat's AI in SmartDesktop (its session `smartdesktop-<chat id>`, its client `smartdesktop-<AI>`).
const fromDesktop = (session) => Boolean(session?.client?.startsWith('smartdesktop-'));

function setSessionWindow(session, ctx) {
  session.ctx = ctx;
  session.restore = null;
  ctx.session = session;
  ctx.untouched = false;
  session.docId = ctx.workspace.document?.id ?? null;
  ctx.ready.then(() => ctx.contents.send('ai-control', clientLabel(session.client)));
  // A chat's AI taking a tab makes it that chat's (SmartDesktop says so back: `owners`).
  if (fromDesktop(session) && !ctx.home) desktop.sessionTab(ctx.id, session.id);
  sendTabs(ctx.host);
}

// Gives a window back to the user, whichever way the session stopped.
function releaseWindow(session) {
  sessions.releaseClaims(session);
  const { ctx } = session;
  session.ctx = null;
  session.restore = null;
  session.docId = null;
  if (ctx) {
    ctx.session = null;
    ctx.contents.send('ai-control', null);
    sendTabs(ctx.host);
    // An AI's tab it left with nothing in it isn't worth keeping.
    if (!ctx.home && !ctx.workspace.document) closeTab(ctx);
  }
}

// An AI session's first call opens a tab of its own, in the window last used (or a new window), behind
// the one showing unless the AI started SmartDoc. It shows nothing until the AI opens a document.
async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  const launched = startedApp && !session.restore && [...hosts].find((h) => h.tabs.length === 1 && h.tabs[0].untouched);
  const host = launched || (lastFocused?.host ?? createWindow({ focus: false }).host);
  const ctx = createTab(host);
  // A chat's AI gets a tab of its own, shown: the user is working with it.
  if (launched || fromDesktop(session)) activateTab(ctx);
  await ctx.ready;
  const { restore } = session;
  setSessionWindow(session, ctx);
  if (restore?.docId) {
    await ctx.workspace.openDraft(restore.docId, restore.variationId, restore.draftId, restore.tool).catch(() => {});
    session.docId = ctx.workspace.document?.id ?? null; // it may have been deleted since
  }
  if (!ctx.win.isVisible()) ctx.win.showInactive();
  sendTabs(ctx.host);
  return ctx;
}

// SmartDesktop's chat works in the window the user was last in, which it names: the session takes that
// window over, unless another AI is working in it. As a message starts (`turn`), the document it
// works on is the one showing, as the user may have moved the window since the last.
function bindWindow(session, windowId, { turn = false, strict = false } = {}) {
  const ctx = [...windows.values()].find((c) => c.id === windowId);
  if (!ctx) return;
  if (ctx.session && ctx.session !== session && sessions.alive(ctx.session)) {
    if (strict) throw new Error(`${clientLabel(ctx.session.client)} is working in this SmartDoc window. Tell the user: they can release it from the status pill's panel.`);
    return;
  }
  if (session.ctx !== ctx) {
    if (session.ctx) releaseWindow(session);
    setSessionWindow(session, ctx);
  } else if (turn) session.docId = ctx.workspace.document?.id ?? null;
}

// The calls about the user's documents as a whole (their list and folders), which need no document
// open, so no tab of the session's own (see call). A variation is of the open document.
const worksWithoutTab = (name, args) => ['list_documents', 'list_folders', 'create_folder', 'move_document'].includes(name) || (name === 'rename' && args?.kind !== 'variation');

// Whether a call says what it acts on, whatever the window shows. A variation is of the open document.
const namesItsTarget = (name, args) => ['delete_document', 'create_folder', 'move_document'].includes(name) || (name === 'rename' && args?.kind !== 'variation');

const aiForServer = {
  // SmartDesktop's chat says which window its AI works in (the one the user was last in) as each of
  // its messages starts (`turn`), and keeps the session alive while the AI thinks.
  alive: ({ session, client, window, turn }) => {
    const touched = sessions.touch(session, client);
    // Only as a message starts (`turn`), or with no window yet: within a message the AI stays where
    // it went (into a tab of its own, say), though the window it was sent from is still named.
    if (window && (turn || !touched.ctx)) bindWindow(touched, window, { turn });
  },
  waitCommand: (...args) => waitCommand(...args),
  wait({ what, review, request } = {}) {
    if (what === 'open' || what === 'delete') return waitForRequest(what, request);
    return waits.forReview(what, review);
  },
  ended({ session }) {
    const ended = session && sessions.get(session);
    if (!ended) return;
    releaseWindow(ended);
    sessions.end(session);
  },
  async call({ session: id, client, startedApp, window }, name, args, run) {
    const session = sessions.touch(id, client);
    if (window && !session.ctx) bindWindow(session, window, { strict: true });
    // Taking a window over is the one call that mustn't open one of its own.
    if (name === 'use_window') {
      const documents = { useWindow: (windowId) => takeOverWindow(session, windowId) };
      return run(null, documents);
    }
    // A call about the user's documents as a whole, not one open document, doesn't open the
    // session's tab: a chat's AI that only listed them left a tab waiting for a document that never
    // came, which looked frozen. It's answered from Home's window instead.
    if (!session.ctx && worksWithoutTab(name, args)) {
      const home = lastFocused?.host?.tabs[0] ?? [...hosts][0]?.tabs[0];
      if (home) return context.run(home, () => run(home.workspace, documentsForAi));
    }
    const ctx = await windowForSession(session, startedApp);
    return context.run(ctx, async () => {
      if (!READ_ONLY.has(name)) {
        // The user can take the window anywhere, but the AI's changes stay with its document.
        const showing = ctx.workspace.document?.id ?? null;
        if (session.docId && showing !== session.docId && name !== 'open_document' && !namesItsTarget(name, args)) {
          throw new Error(`This window has moved off the document you were working on. Nothing was changed. Tell the user, or call open_document with document_id ${session.docId} to go back to it.`);
        }
        ctx.workspace.refuseOnOlderDraft(name, args);
        const key = ctx.workspace.claimKey(name, args);
        const holder = key && sessions.claim(session, key);
        if (holder) throw new Error(`${clientLabel(holder.client)} is already working on this in another SmartDoc window, so this change wasn't made. You can still read the document. Tell the user: they can release that window from its top bar.`);
      }
      const before = ctx.workspace.document?.id;
      const result = await run(ctx.workspace, documentsForAi);
      // A document opened in Home goes to a tab of its own, and the AI with it (see moveToTab).
      if (ctx.home && ctx.workspace.document) {
        await moveToTab(ctx);
        return result;
      }
      const after = ctx.workspace.document?.id ?? null;
      if (name === 'open_document' || name === 'create_document_from_draft' || !session.docId) {
        if (before !== after) sessions.releaseClaims(session);
        session.docId = after;
      }
      return result;
    });
  },
};

// --- The chat, in SmartDesktop (see desktop.js) -----------------------------------------------
// The AI chat is SmartDesktop's, an app of its own, for SmartDoc and SmartSpec both: one chat
// window floating over the apps' windows, and one conversation across them (the user's choice: it
// was a chat for each window, docked or floating, in each app). SmartDoc tells it about each window
// (what it shows, when it has the focus, lines of context, the shortcuts to offer), and its AI uses
// SmartDoc's tools through the MCP server, on the window the user was last in (see aiForServer).

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


async function takeOverWindow(session, windowId) {
  const ctx = [...windows.values()].find((c) => c.id === windowId);
  if (!ctx) throw new Error(`There's no SmartDoc window ${windowId} open now. Carry on without it: your first tool call opens a window of your own.`);
  if (ctx.session && ctx.session !== session && sessions.alive(ctx.session)) {
    throw new Error(`${clientLabel(ctx.session.client)} is already working in window ${windowId}. Tell the user: they can release it from the status pill's panel.`);
  }
  if (ctx.session && ctx.session !== session) releaseWindow(ctx.session);
  const old = session.ctx;
  if (old && old !== ctx) {
    releaseWindow(session);
    // A window the session had only just opened, with nothing in it, isn't worth leaving behind.
    if (!old.workspace.document && !old.home) closeTab(old);
  }
  setSessionWindow(session, ctx);
  return { window: windowId, document: ctx.workspace.document?.name ?? null };
}

function sweepSessions() {
  for (const ctx of windows.values()) {
    if (ctx.session && !sessions.alive(ctx.session)) releaseWindow(ctx.session);
  }
  sessions.sweep();
}

// Writes the current draft anywhere, including over the file it was imported from.
async function saveDraftAs() {
  const doc = workspace.document;
  if (!doc) return;
  const number = doc.line.indexOf(doc.currentDraftId);
  const base = doc.name.replace(/\.pdf$/i, '').replace(/[/\\:]/g, '-'); // a name can hold what a file's can't
  const { canceled, filePath } = await dialog.showSaveDialog(win(), {
    defaultPath: number === 0 ? `${base}.pdf` : `${base} – Draft ${number}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!canceled && filePath) await workspace.saveDraftAs(filePath);
}

// A new variation is made by the AI: the window asks what it's for and copies a prompt asking the
// AI to make it from the draft showing (see variation-card.js).
function newVariation() {
  const doc = workspace.document;
  if (!doc) return;
  const number = doc.line.indexOf(doc.currentDraftId);
  const variation = doc.variations.find((v) => v.id === doc.variationId);
  send('variation-requested', { docId: doc.id, docName: doc.name, variationId: variation.id, variationName: variation.name, draft: number });
}

// A new document from a draft, from the menu (the draft showing) or the home screen. It goes to
// the top of the documents list, and the home screen shows it.
async function documentFromDraft(docId, variationId, draftId) {
  const made = await workspace.documentFromDraft(docId, variationId, draftId);
  const home = homeOf();
  if (home) {
    activateTab(home);
    home.contents.send('document-made', made.id);
  }
  return made;
}

// --- Connecting an AI --------------------------------------------------------------------
// AI apps start SmartDoc's MCP launcher, which is inside the app (see connect.js). The MCP panel
// (opened from the server pill, or Connect an AI in the menu) shows how to set up each AI app,
// and can add SmartDoc to Claude Desktop itself.

const WEBSITE = 'https://smartdoc.tw050x.net/';
const { setups, claudeDesktopStatus, addToClaudeDesktop, waitCommand } = createConnect({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  userData: app.getPath('userData'),
  port: MCP_PORT,
});

const showConnectAi = () => send('show-connect');

async function confirmAddToClaudeDesktop() {
  const status = await claudeDesktopStatus();
  const { response } = await dialog.showMessageBox(win() ?? undefined, {
    type: 'question',
    message: status.state === 'different' ? 'Update SmartDoc in Claude Desktop?' : 'Add SmartDoc to Claude Desktop?',
    detail: 'SmartDoc adds itself to Claude Desktop’s settings file (claude_desktop_config.json), and keeps a copy of the file as it was. Then quit Claude Desktop and open it again to connect.',
    buttons: [status.state === 'different' ? 'Update' : 'Add', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return status;
  return addToClaudeDesktop();
}

// macOS: AI apps start SmartDoc from where it's installed, so a copy run from the disk image or
// Downloads is offered a move to Applications (which opens it again from there).
async function offerMoveToApplications() {
  if (!app.isPackaged || process.platform !== 'darwin' || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox(win() ?? undefined, {
    type: 'question',
    message: 'Move SmartDoc to your Applications folder?',
    detail: 'Your agent opens SmartDoc from where it’s installed, so it works best in Applications.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox('SmartDoc couldn’t be moved', `${error.message}\n\nDrag SmartDoc into your Applications folder in Finder instead.`);
  }
}

// --- Updates -----------------------------------------------------------------------------

const updates = createUpdates({ report: (status) => broadcast('updates', status) });

// --- Window requests ---------------------------------------------------------------------

// Whatever a window asks for, it asks about itself.
const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => context.run(windows.get(event.sender.id) ?? strips.get(event.sender.id)?.active ?? lastFocused ?? {}, async () => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}));

// The user can always take a window back from an AI, in the MCP panel.
handle('ai-control-release', () => {
  const { session } = current();
  if (session) releaseWindow(session);
});

handle('open-path', (filePath) => importFile(filePath));
// The home screen browses the documents in the list: each one's variations and their drafts,
// opening a draft, and making a document from one.
handle('variations-of', (docId) => (workspace.isRecent(docId) ? workspace.variationsOf(docId) : null));
// Starting a review from the home screen: the focuses to offer, and the draft made current when
// the prompt is copied.
handle('focuses-for', (docId, variationId, draftId, type) => (workspace.isRecent(docId) ? workspace.focusesFor(docId, variationId, draftId, type) : null));
handle('prepare-draft', (docId, variationId, draftId, tool) => (workspace.isRecent(docId) ? workspace.prepareDraft(docId, variationId, draftId, tool) : null));
// Another draft of the tab's document opens in the tab; another document, from Home, in its own.
handle('open-draft', async (docId, variationId, draftId, tool) => {
  if (!workspace.isRecent(docId)) return;
  if (current().home || workspace.document?.id === docId) return workspace.openDraft(docId, variationId, draftId, tool);
  const home = homeOf();
  await context.run(home, () => home.workspace.openDraft(docId, variationId, draftId, tool));
});
// A draft's right-click menu on the home screen: a new variation from it (the window's variation
// card), a new document from it, or deleting it (not the original, or a draft another variation
// uses).
handle('draft-menu', async ({ docId, variationId, draftId, draft }) => {
  if (!workspace.isRecent(docId)) return;
  const { name, variations } = await workspace.variationsOf(docId);
  const variation = variations.find((v) => v.id === variationId);
  if (!variation) return;
  Menu.buildFromTemplate([
    { label: 'New Variation…', click: () => send('variation-requested', { docId, docName: name, variationId, variationName: variation.name, draft }) },
    { label: 'New Document from Draft', click: () => documentFromDraft(docId, variationId, draftId) },
    { label: 'Add Label…', click: () => send('label-requested', [docId, variationId, draftId]) },
    { type: 'separator' },
    { label: 'Delete this draft', enabled: await workspace.canDeleteDraft(docId, variationId, draftId), click: () => deleteDraft(docId, variationId, draftId, draft) },
  ]).popup({ window: win() });
});
// Asks first, since a deleted draft can't be got back.
async function deleteDraft(docId, variationId, draftId, number) {
  const elsewhere = [...windows.values()].some((c) => c !== current() && c.workspace.document?.id === docId && c.workspace.document.currentDraftId === draftId);
  if (elsewhere) {
    dialog.showErrorBox('This draft is open in another window', 'Move that window to another draft first, then delete this one.');
    return;
  }
  const { response } = await dialog.showMessageBox(win() ?? undefined, {
    type: 'warning',
    message: `Delete Draft ${number}?`,
    detail: 'Its PDF and its reviews are deleted, and can’t be got back. Any later drafts stay, and are renumbered.',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await workspace.deleteDraft(docId, variationId, draftId);
}
// A variation's right-click menu on the home screen: a new variation from its latest draft.
handle('variation-menu', async ({ docId, variationId }) => {
  if (!workspace.isRecent(docId)) return;
  const { name, variations } = await workspace.variationsOf(docId);
  const variation = variations.find((v) => v.id === variationId);
  if (!variation) return;
  // Drafts come newest first, numbered from the original (0).
  const draft = variation.drafts.length - 1;
  Menu.buildFromTemplate([
    ...(variationId === 'original' ? [] : [{ label: 'Rename', click: () => send('rename-variation', { docId, variationId }) }]),
    { label: 'New Variation from Latest Draft…', click: () => send('variation-requested', { docId, docName: name, variationId, variationName: variation.name, draft }) },
    { label: 'Add Label…', click: () => send('label-requested', [docId, variationId]) },
  ]).popup({ window: win() });
});
// Back to the home screen: the document closes (everything is already saved).
// Home is a tab of its own: going home shows it.
handle('go-home', () => {
  const home = homeOf();
  if (home && home !== current()) activateTab(home);
});
// A right-click menu on the home screen's document list: the window says what's on it, and gets
// back the id of the item chosen, or null. The click can come after the menu closes, so closing
// waits a moment for it.
handle('home-menu', (items) => new Promise((resolve) => {
  Menu.buildFromTemplate(items.map((item) => (item.separator ? { type: 'separator' } : { label: item.label, enabled: item.enabled !== false, click: () => resolve(item.id) }))).popup({
    window: win(),
    callback: () => setTimeout(() => resolve(null), 100),
  });
}));
handle('folders', () => workspace.folders);
handle('labels', () => workspace.labels);
handle('add-label', (item, name) => workspace.addLabel(item, name));
handle('remove-label', (item, labelId) => workspace.removeLabel(item, labelId));
handle('set-label-color', (labelId, color) => workspace.setLabelColor(labelId, color));
handle('set-home-folder', (id) => workspace.setHomeFolder(id));
handle('create-folder', (name, parentId) => workspace.createFolder(name, parentId));
// An empty document from home's + button, chosen on home once it's made.
handle('create-document', async (name, folderId) => {
  const made = await workspace.createDocument(name, folderId);
  send('document-made', made.id);
  return made;
});
handle('rename-folder', (id, name) => workspace.renameFolder(id, name));
handle('rename-document', (docId, name) => workspace.renameDocument(docId, name));
handle('rename-variation', (docId, variationId, name) => workspace.renameVariation(docId, variationId, name));
handle('delete-folder', (id) => workspace.deleteFolder(id));
handle('move-folder', (id, parentId) => workspace.moveFolder(id, parentId));
handle('move-document', (docId, folderId) => workspace.moveDocument(docId, folderId));
// Whether a window other than this one is showing a document.
const openElsewhere = (docId) => [...windows.values()].some((c) => c !== current() && c.workspace.document?.id === docId);

// The one question before a document is deleted, by the user or at an AI's request. Cancel is the
// default, and there's no way to stop it asking.
async function askToDeleteDocument(name, from = null) {
  const consequence = 'The document, all its drafts and variations, and their reviews are deleted, and can’t be got back. The PDF you imported it from isn’t touched.';
  const { response } = await dialog.showMessageBox(win() ?? undefined, {
    type: 'warning',
    message: `Delete “${name}”?`,
    detail: from ? `${from}\n\n${consequence}` : consequence,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
}

// Deleting a document is the only way off the list: the app is the only place to find it, so it
// never leaves files behind that nothing can reach. Asks first, and waits for any other window
// showing it to move on, as an AI may be working there.
handle('delete-document', async (docId) => {
  const entry = workspace.recent.find((r) => r.id === docId);
  if (!entry) return;
  if (openElsewhere(docId)) {
    dialog.showErrorBox('This document is open in another window', 'Close it there first, then delete it.');
    return;
  }
  if (await askToDeleteDocument(entry.name)) await workspace.deleteDocument(docId);
});
handle('page-texts', (docId, draftId, texts, details) => workspace.setPageTexts(docId, draftId, texts, details));
handle('add-request', (request) => workspace.addRequest(request));
handle('update-request', (id, changes) => workspace.updateRequest(id, changes));
handle('set-no-further-action', (id, on) => workspace.setNoFurtherAction(id, on));
handle('remove-request', (id) => workspace.removeRequest(id));
handle('decide', (itemId, decision) => workspace.decide(itemId, decision));
handle('open-preview', () => workspace.openPreview());
handle('close-preview', () => workspace.closePreview());
handle('preview-comparison', () => workspace.previewComparison());
// Asks first if the user hasn't decided on every finding: the AI wrote the preview without their
// say on those, and it's easy to miss them from the preview, where the cards step aside.
handle('accept-preview', async () => {
  const uncommented = workspace.review && acceptWarning(workspace.review);
  const undecided = (workspace.review?.items ?? []).filter((i) => i.decision.status === 'pending');
  if (undecided.length) {
    const titles = undecided.slice(0, 5).map((i) => `• ${i.title}`);
    if (undecided.length > titles.length) titles.push(`and ${undecided.length - titles.length} more`);
    const { response } = await dialog.showMessageBox(win() ?? undefined, {
      type: 'warning',
      message: undecided.length === 1 ? 'You haven’t decided on 1 finding. Accept anyway?' : `You haven’t decided on ${undecided.length} findings. Accept anyway?`,
      detail: `Your AI wrote this draft preview without your decision on:\n${titles.join('\n')}\n\nCheck the draft preview to see what it did with them.`,
      buttons: ['Cancel', 'Accept Anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return;
  }
  if (uncommented) {
    const { response } = await dialog.showMessageBox(win() ?? undefined, { type: 'warning', ...uncommented, buttons: ['Cancel', 'Accept Anyway'], defaultId: 0, cancelId: 0 });
    if (response !== 1) return;
  }
  await workspace.acceptPreview();
});
// Asks first, since the AI would have to write it again.
handle('discard-preview', async () => {
  const { response } = await dialog.showMessageBox(win() ?? undefined, {
    type: 'warning',
    message: 'Discard this draft preview?',
    detail: 'Your decisions stay as they are, and your AI can write another draft preview from them. Any comments you made on this draft preview are removed with it.',
    buttons: ['Cancel', 'Discard'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await workspace.discardPreview();
});
// Resetting the review (from the Review menu) asks first, since what's cleared can't be got back
// in the app. Step 1 starts the review again, empty; step 2 clears the user's decisions.
const RESETS = {
  1: {
    message: 'Start the review again?',
    detail: 'This clears the AI’s findings and notes, your comments, your decisions and the changes you added, leaving an empty review for your AI to fill.',
    run: () => workspace.resetToReview(),
  },
  2: {
    message: 'Clear your decisions?',
    detail: 'All your decisions, answers, edits and comments are cleared, and the changes and comments you added while deciding are removed. The AI’s findings stay, ready to decide again.',
    run: () => workspace.resetDecisions(),
  },
};
const HIGHLIGHTS_RESET = {
  message: 'Start the highlights again?',
  detail: 'This clears the AI’s highlights, leaving an empty review with the same goal for your AI to fill.',
  run: () => workspace.resetToReview(),
};
async function resetReview(step) {
  const reset = workspace.review?.type === 'highlights' ? step === 1 && HIGHLIGHTS_RESET : RESETS[step];
  if (!reset) return false;
  const { response } = await dialog.showMessageBox(win() ?? undefined, {
    type: 'warning',
    message: reset.message,
    detail: reset.detail,
    buttons: ['Cancel', 'Reset'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  await reset.run();
  return true;
}
// Setup for each AI app, shown and copied for pasting (see connect.js).
async function mcpSetup(target) {
  const all = await setups();
  if (!all[target]) throw new Error(`Unknown AI app: ${target}`);
  return all[target];
}
handle('mcp-setup', (target) => mcpSetup(target));
// Asked for by the window as it starts, so it never waits on a status sent before it was listening.
handle('mcp-status', () => mcpStatus());
handle('mcp-retry', () => startMcp());
// The chat, in SmartDesktop (see desktop.js): the window's chat button, the shortcuts and the hint it
// offers there, lines of context, and requests for the AI.
handle('chat-toggle', () => desktop.chat(current().id, 'toggle'));
handle('chat-shortcuts', ({ hint = null, shortcuts = [] } = {}) => desktop.window(current().id, { hint, shortcuts }));
handle('chat-note', (note) => desktop.note(current().id, note));
handle('chat-ask', (text) => desktop.ask(current().id, text));
handle('desktop-status', () => desktop.status);
// The top bar (tab-strip.js): its state, choosing and closing tabs, back and forward (done by the
// active tab, whose history it is, which says when they change), and the status pill, which opens
// the panel in the active tab.
handle('tabs-state', () => {
  const host = current()?.host;
  if (host) setTimeout(() => sendTabs(host));
  return null;
});
handle('tab-activate', (id) => {
  const tab = current()?.host.tabs.find((t) => t.id === id);
  if (tab) activateTab(tab);
});
handle('tab-close', (id) => {
  const tab = current()?.host.tabs.find((t) => t.id === id);
  if (tab) closeTab(tab);
});
handle('history-step', (delta) => current()?.contents.send('history-step', delta));
// A tab's right-click menu: choosing its icon (in a card the tab showing draws, under the tab: `box`
// is the tab's place in the top bar), and closing it.
handle('tab-menu', (id, box) => {
  const host = current()?.host;
  const tab = host?.tabs.find((t) => t.id === id);
  if (!tab) return;
  const doc = tab.workspace.document;
  Menu.buildFromTemplate([
    // The chat that owns it, if one does; and Open Chat (only with SmartDesktop installed: the user's
    // choice), as its chat button: this tab's chat, or a new one for it (from Home, the chat last
    // used), brought forward ready to type in.
    ...(tab.chat ? [{ label: `Chat: ${tab.chat.title}`, enabled: false }] : []),
    ...(desktop.installed() ? [{ label: 'Open Chat', click: () => openChatFor(tab) }, { type: 'separator' }] : tab.chat ? [{ type: 'separator' }] : []),
    { label: 'Change Icon…', enabled: Boolean(doc), click: () => host.active.contents.send('icon-picker', { docId: doc.id, current: tabIcon(tab), name: doc.name, at: { left: box.left, top: 6 } }) },
    ...(tab.home ? [] : [{ type: 'separator' }, { label: 'Close Tab', click: () => closeTab(tab) }]),
  ]).popup({ window: host.win });
});
// A tab's chat button: shows that tab, and its chat in SmartDesktop, brought forward ready to type in.
function openChatFor(tab) {
  activateTab(tab);
  return desktop.chat(tab.id, true);
}
handle('tab-chat', (id) => {
  const tab = [...windows.values()].find((t) => t.id === id);
  if (tab) return openChatFor(tab);
});
// The user's choice of a document's icon, which the AI never replaces.
handle('set-icon', (docId, icon) => itemIcons.set(docId, icon, 'user'));
handle('history-state', (state) => {
  const ctx = current();
  ctx.history = { back: Boolean(state?.back), forward: Boolean(state?.forward) };
  if (ctx.host.active === ctx) sendTabs(ctx.host);
});
handle('show-status', () => current()?.contents.send('toggle-status'));
// A tooltip of the top bar's, drawn by the tab showing (the top bar's page is behind it there), its
// box moved into the tab's page, which starts below the top bar.
// The pills under the tab showing and the tab pointed at in the top bar: their lower halves are over
// the tab showing's page, which draws them there (see tab-strip.js).
handle('tab-lines', (lines) => {
  const host = current()?.host;
  if (!host) return;
  host.lines = lines;
  for (const tab of host.tabs) tab.contents.send('tab-lines', tab === host.active ? lines : null);
});
// Dragging a tab (tab-strip.js, tab-drag.js): to another place in its top bar, into another
// window's, or anywhere else to make a new window of it, its picture following the pointer meanwhile.
// The top bar says where its tabs are (`tab-boxes`), and the one the pointer is over shows where the
// tab would go (`tab-drop`: { id, index, x }, or null).
const tabDrag = createTabDrag({ topBar: TOP_BAR_HEIGHT });
let dragging = null; // { tab, offset, chip, point, target }
handle('tab-boxes', (boxes) => {
  const host = current()?.host;
  if (host) host.tabBoxes = Array.isArray(boxes) ? boxes : [];
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
handle('tab-drag-start', async (id, { chip, offset, point } = {}) => {
  const host = current()?.host;
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
handle('tab-drag-move', (point) => {
  if (!dragging || !point) return;
  dragging.point = point;
  dragOver(point);
});
handle('tab-drag-end', (point) => {
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

handle('strip-tip', (tip) => {
  const host = current()?.host;
  if (!host) return;
  for (const tab of host.tabs) {
    if (tab === host.active && tip) tab.contents.send('strip-tip', { text: tip.text, plain: Boolean(tip.plain), box: { ...tip.box, top: tip.box.top - TOP_BAR_HEIGHT, bottom: tip.box.bottom - TOP_BAR_HEIGHT } });
    else tab.contents.send('strip-tip', null);
  }
});
// Opens SmartDesktop's page, to download it.
handle('get-desktop', () => shell.openExternal('https://github.com/tw050x/smartdesktop/releases/latest'));
handle('step-draft', (delta) => workspace.stepDraft(delta));
handle('draft-line', () => workspace.draftLine());
handle('draft-pdf', (draftId) => workspace.draftPdf(draftId));
handle('go-to-draft', (draftId) => workspace.goToDraft(draftId));
handle('send-to-ai', (what) => workspace.sendToAi(what));
handle('ai-waiting', () => waits.active());
handle('list-focuses', (type) => workspace.listFocuses(type));
handle('set-focus', (reviewId) => workspace.setFocus(reviewId));
handle('set-tool', (tool) => workspace.setTool(tool));
handle('copy-text', (text) => clipboard.writeText(String(text)));
handle('copy-mcp-setup', async (target) => clipboard.writeText(await mcpSetup(target)));
handle('open-website', () => shell.openExternal(WEBSITE));
handle('claude-desktop-status', () => claudeDesktopStatus());
handle('add-to-claude-desktop', () => confirmAddToClaudeDesktop());
handle('get-updates', () => updates.status);
handle('install-update', () => updates.install());
handle('get-appearance', () => nativeTheme.themeSource);
handle('get-experimental', () => experimental());
handle('set-experimental', (name, on) => setExperimental(name, on));
handle('reader-font', (file) => readerFont(file));
handle('set-appearance', (appearance) => setAppearance(appearance));

// --- App lifecycle -----------------------------------------------------------------------

// macOS: files opened from Finder or the Dock.
let pendingOpen = null;
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) importFile(filePath);
  else pendingOpen = filePath;
});

app.whenReady().then(async () => {
  // The app is in beta, and its About panel says so (as Settings does).
  app.setAboutPanelOptions({ credits: 'SmartDoc is in beta, so it may change significantly from one version to the next.' });
  const first = createWindow();
  await first.workspace.loadRecent();
  context.run(first, updateMenu);
  await startMcp();
  if (pendingOpen) importFile(pendingOpen);
  updates.start();
  await first.ready;
  offerMoveToApplications();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
