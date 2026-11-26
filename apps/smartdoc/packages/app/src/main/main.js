import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFamily, familyFolder } from '@smartdesktop/ui/main/family.js';
import { CONVERTED, convertFile, EXTENSIONS, inspect } from './convert.js';
import { createConnect } from './connect.js';
import { MCP_PORT, portHolder, startMcpServer } from './mcp-server.js';
import { createDesktop } from './desktop.js';
import { iconFor } from '@smartdesktop/ui/main/icons.js';
import { createItemIcons } from './item-icons.js';
import { firstTodo, todoOf } from './home-review-state.js';
import { readPdfText } from './pdf-text.js';
import { createTabs } from '@smartdesktop/ui/main/tabs.js';
import { API } from './api.js';
import { READ_ONLY } from './mcp-tools.js';
import { clientLabel, createSessions } from './sessions.js';
import { describeStep } from '@smartdesktop/ui/main/steps/smartdoc.js';
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
// The family's windows of tabs (@smartdesktop/ui's main/tabs.js): Home first, pinned, showing the
// home screen, and each other tab showing one document, never home: opening a document from Home (or
// the menu, a dropped file, an AI) opens it in a tab, the one already showing it if there is one.
// Each tab is what a window was: its own workspace, history and AI session. What's SmartDoc's own is
// given here: each tab's workspace (set up as it's made, its handlers run in its context), the
// window's represented file, the New renderer switch, and an AI's tab kept to come back to.
const hosts = new Set(); // { win, tabs: [home, …], active }
const tabs = createTabs({
  id: 'smartdoc',
  title: WINDOW_TITLE,
  // The pages' API as data (api.js), which the family's preload builds `window.smartdoc` from.
  api: API,
  pages: {
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
  changed: () => updateMenuFor(lastFocused),
  setupTab,
  tabReady: (ctx) => context.run(ctx, sendEverything),
  onActivate: (ctx) => context.run(ctx, () => ctx.host.win.setRepresentedFilename?.(ctx.workspace.document ? ctx.workspace.currentDraftPdfPath() : '')),
  tabState: (ctx) => ({ title: tabTitle(ctx), icon: tabIcon(ctx), ai: ctx.session ? clientLabel(ctx.session.client) : null }),
  status: () => appStatus(),
  // The switch between pdf.js and SmartDoc's own reader (experimental).
  extraState: () => ({ reader: experimental().reader }),
  docOf: (ctx) => ctx.workspace?.document?.id ?? null,
  // A tab is on home with no document open in it, unless it was opened for one still coming.
  isHome: (ctx) => !ctx.workspace?.document && !ctx.waiting,
  // The Home button: the tab's document closes, and it shows home.
  goHome: (ctx) => context.run(ctx, () => {
    ctx.waiting = false;
    ctx.workspace.close();
    sendTabs(ctx.host);
  }),
  release: (ctx) => {
    // An AI's tab comes back as it was, the next time the AI needs it.
    if (ctx.session) {
      const doc = ctx.workspace.document;
      ctx.session.restore = doc && { docId: doc.id, variationId: doc.variationId, draftId: doc.workingDraftId ?? doc.currentDraftId, tool: ctx.workspace.tool };
      ctx.session.ctx = null;
    }
    ctx.workspace.dispose();
    ctx.workspace.events.removeAllListeners(); // nothing left to tell
    ctx.workspace.close();
  },
  // Guest tabs: a document's tab can be shown in another app's window (SmartDesktop's, say),
  // opening the same draft there, on the same variation and tool; and SmartDoc's windows show other
  // apps' tabs.
  name: 'SmartDoc',
  family: createFamily(familyFolder(app)),
  guestOpen: (ctx) => {
    const doc = ctx.workspace?.document;
    return doc ? { docId: doc.id, variationId: doc.variationId, draftId: doc.workingDraftId ?? doc.currentDraftId, tool: ctx.workspace.tool } : null;
  },
  guestOpened: (ctx, { docId, variationId, draftId, tool } = {}) => context.run(ctx, () => ctx.workspace.openDraft(docId, variationId, draftId, tool))
    .catch((error) => console.error('A guest tab couldn’t open its document:', error.message)),
});
// A menu, a question, a sheet, the file picker or the save panel over a tab's window (in a guest
// tab, the window showing it shows them).
const { popupMenu, messageBox, confirmSheet, openDialog, saveDialog, createWindow, createTab, activateTab, closeTab, moveTab, sendTabs, sendAllTabs, openChatFor, strips } = tabs;

// Something gone wrong, said over the tab it's about (or the window showing it, for a guest tab).
const warn = (message, detail) => messageBox(current(), { type: 'warning', message, detail, buttons: ['OK'] });
// A right-click menu of SmartDoc's own (`template`: { label, enabled, click } and { type:
// 'separator' }), over the tab's window (a guest tab's too): the item chosen does its click.
async function chooseFrom(template) {
  const chosen = await popupMenu(current(), template.map((item, i) => (item.type === 'separator' ? { separator: true } : { id: i, label: item.label, enabled: item.enabled !== false })));
  if (chosen !== null && chosen !== undefined) await template[chosen]?.click?.();
}
// Asking whether to open a file the AI asked for (it was a window of SmartDoc's own,
// confirm-replace.js; the family's sheet now): 'replace' or 'cancel'.
const replaceQuestion = ({ current: open, next, source }) => ({
  title: `Let your AI open “${next}”?`,
  message: `Your AI asked to open this file from ${source}. It will be able to read the file’s text.${open ? ` “${path.basename(open)}” will be closed.` : ''}`,
  buttons: [{ label: 'Cancel', choice: 'cancel' }, { label: 'Open', choice: 'replace', kind: 'primary' }],
});

// A new tab's workspace (`workspace`, one moved into it, or a new one), and what it tells the tab.
// A tab shows home or a document, going between them as a browser tab goes between pages (the
// user's choice, 2026-11-26: Home was a pinned tab of its own, which handed documents on to tabs).
function setupTab(ctx, { workspace: given = null } = {}) {
  Object.assign(ctx, { workspace: given ?? createWorkspace(shared), aiOpen: null, hadDocument: Boolean(given?.document) });
  if (given?.document) ctx.waiting = false;
  const inTab = (fn) => (...args) => context.run(ctx, () => fn(...args));
  ctx.workspace.events.on('draft', inTab(() => {
    ctx.untouched = false;
    const doc = ctx.workspace.document;
    // Its document arriving; or closing (deleted, say), when it goes home.
    if (doc) {
      ctx.waiting = false;
      ctx.hadDocument = true;
    } else if (ctx.hadDocument) ctx.waiting = false;
    sendTabs(ctx.host);
    return sendDraft();
  }));
  ctx.workspace.events.on('tool', inTab((tool) => send('tool', tool)));
  ctx.workspace.events.on('review', inTab((review) => {
    send('review', review);
    updateMenu();
  }));
}

// The tab to open a document in, from the menu, a dropped file or the home screen: the one showing,
// if it's on home (as a browser's page opens in its tab), else a new tab beside it.
async function tabToOpenIn() {
  await ensureWindow();
  const here = current();
  if (here?.home) return here;
  const { host } = here;
  const tab = createTab(host);
  host.tabs.splice(host.tabs.indexOf(tab), 1);
  host.tabs.splice(host.tabs.indexOf(here) + 1, 0, tab);
  activateTab(tab);
  await tab.ready;
  return tab;
}
// Opens something in `tab` (`open`, run as it): a new tab that couldn't open it closes, rather than
// say "Opening a document…" for good.
async function openIn(tab, open) {
  try {
    return await context.run(tab, open);
  } catch (error) {
    if (tab.waiting && !tab.workspace.document) closeTab(tab);
    throw error;
  }
}

// Each document's icon, set by the user or the AI (see item-icons.js), on its tab and on home.
const itemIcons = createItemIcons(app.getPath('userData'), {
  onChange: () => {
    sendAllTabs();
    broadcastRecent();
  },
});
const tabIcon = (ctx) => {
  const doc = ctx.workspace.document;
  return doc ? iconFor(itemIcons.get(doc.id), doc.name, 'file-text') : 'file-text';
};

// A tab's name in the top bar (each document's by its name, with the AI working in it).
function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  const doc = ctx.workspace.document;
  if (doc) return doc.name.replace(/\.pdf$/i, '');
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a document…` : 'Opening…';
}
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

// --- Keeping the window and menu in step with the workspace -----------------------------

const send = (channel, value) => current()?.contents?.send(channel, value);
// For every window: what's the same in all of them.
const broadcast = (channel, value) => {
  for (const { contents } of windows.values()) contents.send(channel, value);
};
// The home screen's documents, each with where it stands in each tool.
// Each with its icon (see icons.js): its own, or the guess from its name.
const withIcons = (list) => list.map((r) => ({ ...r, icon: iconFor(itemIcons.get(r.id), r.name, 'file-text') }));
// Home's documents, each with what it waits on the user for (`todo`: a draft preview, or what a
// review needs), for its pill there and its folder's (see home-review-state.js).
async function todoOfDocument(docId) {
  const each = [...windows.values()][0]?.workspace;
  if (!each) return null;
  try {
    const { variations } = await each.variationsOf(docId);
    return firstTodo(variations.map((v) => todoOf(v.drafts)));
  } catch {
    return null;
  }
}
const recentForWindow = async () => Promise.all(withIcons(shared.recent).map(async (r) => ({ ...r, todo: await todoOfDocument(r.id) })));
const broadcastRecent = async () => broadcast('recent-documents', await recentForWindow());
// A review saved anywhere can change what home's documents wait on: told shortly after (a burst of
// saves, once).
let recentSoon = null;
const broadcastRecentSoon = () => {
  clearTimeout(recentSoon);
  recentSoon = setTimeout(broadcastRecent, 300);
};
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
shared.events.on('review', broadcastRecentSoon);
shared.events.on('recent', () => {
  broadcastRecent();
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
  // (Through the family's tabs: with no windows of its own, SmartDesktop's menu bar shows it too.)
  tabs.setMenu(buildMenu({
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
      newTab: () => tabs.newTab(current()?.host),
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

// Opened in the tab on home, or a new one (see tabToOpenIn).
async function importFile(filePath) {
  let checked;
  try {
    checked = await checkImportable(filePath);
  } catch (error) {
    warn('Couldn’t open the file', error.message);
    return;
  }
  const tab = await tabToOpenIn();
  try {
    await openIn(tab, () => tab.workspace.importAndOpen(checked.path, { converted: checked.converted }));
  } catch {
    warn('Couldn’t open the file', `${filePath} could not be read.`);
    return;
  }
  tellConversion(checked);
}

// After a file's been turned into a PDF, what didn't come out as it is, if anything (fonts stood
// in for, things not drawn yet): said once, as it opens. The AI reads it in get_document_info.
function tellConversion(checked) {
  const notes = checked?.converted?.notes;
  if (!notes?.length || !current()) return;
  messageBox(current(), {
    type: 'info',
    message: `${path.basename(checked.path)} was turned into a PDF`,
    detail: `Opening Word, Excel and PowerPoint files is experimental. The original is kept with the document.\n\n${notes.join('\n\n')}`,
    buttons: ['OK'],
  });
}

// A document from the recent list, in the tab on home, or a new one (see tabToOpenIn): open in
// another tab too, it opens here as well (the user's choice).
async function openDocument(docId) {
  const tab = await tabToOpenIn();
  await openIn(tab, () => tab.workspace.openDocument(docId));
}

async function pickPdf() {
  const { canceled, filePaths } = await openDialog(current(), {
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
  // A guest tab: its window (another app's) shows what's asked over it.
  if (current()?.guest) return;
  await ensureWindow();
  // An AI working without a tab asks in the window last used.
  const front = win() ?? lastFocused?.win ?? createWindow().host.win;
  if (front.isMinimized()) front.restore();
  front.show();
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
  ).then(() => {
    // A tab opened for the user to pick or confirm a file, left with nothing in it, closes.
    const { owner } = request;
    if (request.state !== 'opened' && owner && !owner.home && !owner.headless && !owner.workspace.document) closeTab(owner);
  });
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
  // Pictures of a PDF's pages (view_pages), drawn by the session's tab.
  pagePictures: (pdfPath, pages, width) => drawPictures(current(), pdfPath, pages, width),
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
        const choice = await confirmSheet(current(), replaceQuestion({ current: workspace.document?.name, next: name, source: path.dirname(resolved) }));
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
const chatOf = (session) => (fromDesktop(session) ? /^smartdesktop-(.+)$/.exec(session.id)?.[1] ?? null : null);

// Who's working on what a tab shows, now (the user's choice: a tab on a document an AI is working
// on, with or without a tab of its own, follows its progress in the bar): each AI with that
// variation open that's been busy in the last few seconds, and what it's doing, from its last call
// ("Raising “…”"). Busy is a call, or SmartDesktop saying its AI is still thinking (it says so only
// while it is); not an AI app's connection saying it's still there (`smartdoc mcp` does every 20 s,
// working or not). Sent to each tab as it changes (`ai-at-work`), looked at again every few seconds
// while anyone's at work.
const AT_WORK_MS = 20 * 1000;
// The sessions with what a tab shows open, the busiest first.
function sessionsOn(ctx) {
  const doc = ctx?.workspace.document;
  if (!doc || ctx.home) return [];
  return sessions.all()
    .filter((s) => s.ctx && sessions.alive(s) && s.ctx.workspace.document?.id === doc.id && s.ctx.workspace.document.variationId === doc.variationId)
    .sort((a, b) => (b.busyAt ?? 0) - (a.busyAt ?? 0));
}
function aiAtWork(ctx) {
  const t = Date.now();
  return sessionsOn(ctx)
    .filter((s) => t - (s.busyAt ?? 0) < AT_WORK_MS)
    .map((s) => ({ who: clientLabel(s.client), step: s.step && t - s.step.at < AT_WORK_MS ? describeStep(s.step.name, s.step.args) : null, chat: chatOf(s), here: s.ctx === ctx }));
}
function sendAtWork() {
  let anyone = false;
  for (const ctx of windows.values()) {
    const work = aiAtWork(ctx);
    if (work.length) anyone = true;
    const next = JSON.stringify(work);
    if (next === ctx.sentAtWork) continue;
    ctx.sentAtWork = next;
    ctx.contents.send('ai-at-work', work);
  }
  clearTimeout(sendAtWork.timer);
  if (anyone) sendAtWork.timer = setTimeout(sendAtWork, 3000);
}

function setSessionWindow(session, ctx) {
  session.ctx = ctx;
  session.restore = null;
  ctx.session = session;
  ctx.untouched = false;
  session.docId = ctx.workspace.document?.id ?? null;
  if (ctx.headless) return;
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
  if (ctx?.headless) {
    // Work with no tab: nothing to give back, only the document it had open to let go. A session
    // that went quiet (a chat's AI between the user's messages) takes it up again when it's back.
    const doc = ctx.workspace.document;
    if (doc) taken.set(session.id, { docId: doc.id, variationId: doc.variationId, draftId: doc.workingDraftId ?? doc.currentDraftId, tool: ctx.workspace.tool });
    headless.delete(ctx);
    ctx.session = null;
    ctx.workspace.dispose();
    ctx.workspace.close();
    return;
  }
  if (ctx) {
    ctx.session = null;
    ctx.contents.send('ai-control', null);
    sendTabs(ctx.host);
    // An AI's tab it left with nothing in it isn't worth keeping.
    if (!ctx.home && !ctx.workspace.document) closeTab(ctx);
  }
}

// An AI session works without a tab (the user's choice: a tab is for the user, to review or
// approve something, not for every call): its document is open in a workspace of its own, read
// and changed as a tab's is, with no window (`headless`). A tab opens for it, showing that same
// workspace, once there's something for the user (see showSession). Its first call makes the
// workspace, taking up the document a tab of its that the user closed had open.
const headless = new Set(); // the sessions' workspaces with no tab
const taken = new Map(); // a session id → where its workspace was when the session went quiet
async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  if (!session.restore && taken.has(session.id)) session.restore = taken.get(session.id);
  taken.delete(session.id);
  session.startedApp ||= Boolean(startedApp);
  const ctx = { id: `h-${randomUUID().slice(0, 4)}`, headless: true, host: null, home: false, view: null, contents: null, win: null, workspace: createWorkspace(shared), ready: Promise.resolve(), session: null, aiOpen: null, untouched: false, hadDocument: false, history: { back: false, forward: false } };
  headless.add(ctx);
  const { restore } = session;
  setSessionWindow(session, ctx);
  if (restore?.docId) {
    await context.run(ctx, () => ctx.workspace.openDraft(restore.docId, restore.variationId, restore.draftId, restore.tool)).catch(() => {});
    session.docId = ctx.workspace.document?.id ?? null; // it may have been deleted since
  }
  return ctx;
}

// The calls whose result is the user's to look at, review or approve: then the session's work
// shows in a tab (a review to decide or read, a draft preview to accept), and open_document with
// show (the user asked to see it), or picking or confirming a file, which happens in a window.
const SHOWS_USER = new Set(['commit_review', 'apply_review', 'write_draft']);
const showsUser = (name, args = {}) => SHOWS_USER.has(name) || (name === 'open_document' && (Boolean(args.show) || !args.document_id));

// A session's work comes into a tab of its own, in the window last used (or a new one, or the one
// SmartDoc opened as the AI started it), shown for a chat's AI, which the user is working with,
// and behind the tab showing otherwise.
async function showSession(session) {
  const from = session.ctx;
  if (from && !from.headless) return from;
  // A tab of the user's already showing that draft (they opened it to follow the work) takes it.
  const doc = from?.workspace.document;
  const theirs = doc && [...windows.values()].find((t) => !t.home && !t.session && (!t.chat || t.chat.id === chatOf(session)) && t.workspace.document?.id === doc.id && t.workspace.document.variationId === doc.variationId && t.workspace.document.currentDraftId === doc.currentDraftId);
  if (theirs) {
    headless.delete(from);
    from.session = null;
    from.workspace.dispose();
    setSessionWindow(session, theirs);
    await context.run(theirs, async () => {
      if (theirs.workspace.tool !== from.workspace.tool) await theirs.workspace.setTool(from.workspace.tool);
      if (from.workspace.previewing) await theirs.workspace.openPreview();
    }).catch(() => {});
    return theirs;
  }
  // The window SmartDoc opened as it started, if the AI started it: its tab on home, untouched, gives
  // way to the AI's.
  const launched = session.startedApp && [...hosts].find((h) => h.tabs.length === 1 && h.tabs[0].untouched && h.tabs[0].home && !h.tabs[0].session);
  const host = launched || (lastFocused?.host ?? createWindow({ focus: false }).host);
  const ctx = createTab(host, { workspace: from?.workspace ?? null });
  if (launched) closeTab(launched.tabs[0]);
  if (from) {
    headless.delete(from);
    ctx.aiOpen = from.aiOpen;
    from.session = null;
  }
  if (launched || fromDesktop(session)) activateTab(ctx);
  await ctx.ready;
  setSessionWindow(session, ctx);
  if (ctx.win && !ctx.win.isVisible()) ctx.win.showInactive();
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
    if (fromDesktop(touched)) {
      touched.busyAt = Date.now();
      setTimeout(sendAtWork);
    }
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
    session.step = { name, args, at: Date.now() };
    session.busyAt = Date.now();
    setTimeout(sendAtWork);
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
      const home = lastFocused?.home ? lastFocused : [...windows.values()].find((t) => t.home);
      if (home) return context.run(home, () => run(home.workspace, documentsForAi));
    }
    let ctx = await windowForSession(session, startedApp);
    // Picking or confirming a file happens in a window, so the tab comes first.
    if (ctx.headless && name === 'open_document' && !args?.document_id) ctx = await showSession(session);
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
      // Something for the user: the work comes into a tab.
      if (ctx.headless && showsUser(name, args) && ctx.workspace.document) await showSession(session);
      const after = ctx.workspace.document?.id ?? null;
      if (name === 'open_document' || name === 'create_document_from_draft' || !session.docId) {
        if (before !== after) sessions.releaseClaims(session);
        session.docId = after;
      }
      return result;
    });
  },
};

// Pictures of a PDF's pages for the AI, to look at a draft's design (view_pages): drawn by a tab
// (`draw-pictures`, see app-shell.js), as the main process has no canvas, which answers with PNGs
// (`pictures-drawn`).
const pictureRequests = new Map(); // id → its answer
let pictureCount = 0;
async function drawPictures(ctx, pdfPath, pages, width) {
  // An AI working without a tab has them drawn by the tab last used (any tab can draw them).
  if (!ctx?.contents || ctx.contents.isDestroyed()) ctx = lastFocused ?? [...windows.values()][0] ?? createWindow({ focus: false });
  if (!ctx?.contents || ctx.contents.isDestroyed()) throw new Error('SmartDoc has no window to draw the pages in.');
  await ctx.ready;
  const pdf = new Uint8Array(await fs.promises.readFile(pdfPath));
  const id = ++pictureCount;
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pictureRequests.delete(id);
      resolve({ error: 'Drawing the pages took too long. Try fewer pages, or smaller.' });
    }, 60 * 1000);
    pictureRequests.set(id, (answer) => {
      clearTimeout(timer);
      resolve(answer ?? { error: 'Nothing was drawn.' });
    });
    ctx.contents.send('draw-pictures', { id, pdf, pages, width });
  });
  if (result.error) throw new Error(result.error);
  return result;
}

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
    if (!old.headless && !old.workspace.document && !old.home) closeTab(old);
  }
  setSessionWindow(session, ctx);
  return { window: windowId, document: ctx.workspace.document?.name ?? null };
}

function sweepSessions() {
  for (const ctx of [...windows.values(), ...headless]) {
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
  const { canceled, filePath } = await saveDialog(current(), {
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
  // The tab on home, or a new tab on home beside the one showing.
  const here = current();
  const home = here?.home ? here : here?.host ? tabs.newTab(here.host) : null;
  if (home) {
    activateTab(home);
    await home.ready;
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
  const { response } = await messageBox(current(), {
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
// As the app quits, an AI waiting on the user (`wait`) is told, and whether it's restarting to
// install an update, so it carries on once the app is back rather than thinking it's gone.
app.on('before-quit', () => mcp?.endWaits(updates.restarting));

// --- Window requests ---------------------------------------------------------------------

// Whatever a window asks for, it asks about itself.
// (Each is kept by its channel too, for a guest tab's calls: see the guest server below.)
const handlers = new Map(); // channel → handler
const run = (ctx, channel, args) => context.run(ctx ?? {}, async () => {
  try {
    return { ok: true, value: await handlers.get(channel)(...args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
const handle = (channel, fn) => {
  handlers.set(channel, fn);
  ipcMain.handle(channel, (event, ...args) => run(windows.get(event.sender.id) ?? strips.get(event.sender.id)?.active ?? lastFocused, channel, args));
};

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
// A draft opens in the tab asking (from home, its history, or its own document's drafts), as a
// browser tab goes to a page. `preview`: then its draft preview.
handle('open-draft', async (docId, variationId, draftId, tool, { preview = false } = {}) => {
  if (!workspace.isRecent(docId)) return;
  await workspace.openDraft(docId, variationId, draftId, tool);
  if (preview) await workspace.openPreview().catch(() => {});
});
// A draft's right-click menu on the home screen: a new variation from it (the window's variation
// card), a new document from it, or deleting it (not the original, or a draft another variation
// uses).
handle('draft-menu', async ({ docId, variationId, draftId, draft }) => {
  if (!workspace.isRecent(docId)) return;
  const { name, variations } = await workspace.variationsOf(docId);
  const variation = variations.find((v) => v.id === variationId);
  if (!variation) return;
  await chooseFrom([
    { label: 'New Variation…', click: () => send('variation-requested', { docId, docName: name, variationId, variationName: variation.name, draft }) },
    { label: 'New Document from Draft', click: () => documentFromDraft(docId, variationId, draftId) },
    { label: 'Add Label…', click: () => send('label-requested', [docId, variationId, draftId]) },
    { type: 'separator' },
    { label: 'Delete this draft', enabled: await workspace.canDeleteDraft(docId, variationId, draftId), click: () => deleteDraft(docId, variationId, draftId, draft) },
  ]);
});
// Asks first, since a deleted draft can't be got back.
async function deleteDraft(docId, variationId, draftId, number) {
  const elsewhere = [...windows.values()].some((c) => c !== current() && c.workspace.document?.id === docId && c.workspace.document.currentDraftId === draftId);
  if (elsewhere) {
    warn('This draft is open in another window', 'Move that window to another draft first, then delete this one.');
    return;
  }
  const { response } = await messageBox(current(), {
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
  await chooseFrom([
    ...(variationId === 'original' ? [] : [{ label: 'Rename', click: () => send('rename-variation', { docId, variationId }) }]),
    { label: 'New Variation from Latest Draft…', click: () => send('variation-requested', { docId, docName: name, variationId, variationName: variation.name, draft }) },
    { label: 'Add Label…', click: () => send('label-requested', [docId, variationId]) },
    ...(variationId === 'original' ? [] : [{ type: 'separator' }, { label: 'Delete Variation…', click: () => deleteVariation(docId, variationId) }]),
  ]);
});
// Asks first, since a deleted variation can't be got back. Not while a tab shows it (an AI may
// be working there), as a draft isn't deleted while another window shows it.
async function deleteVariation(docId, variationId) {
  const showing = [...windows.values()].some((c) => c.workspace.document?.id === docId && c.workspace.document.variationId === variationId);
  if (showing) {
    warn('This variation is open in a tab', 'Close that tab, or move it to another variation, then delete this one.');
    return;
  }
  const about = await workspace.variationToDelete(docId, variationId);
  if (!about) return;
  const drafts = about.drafts === 0 ? 'It has no drafts of its own, so only the variation goes.'
    : `Its ${about.drafts === 1 ? 'draft' : `${about.drafts} drafts`} and ${about.drafts === 1 ? 'its' : 'their'} reviews are deleted, and can’t be got back.`;
  const names = about.keeping.map((name) => `“${name}”`);
  const kept = !names.length ? '' : ` The drafts it shares with ${names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`} stay.`;
  const { response } = await messageBox(current(), {
    type: 'warning',
    message: `Delete “${about.name}”?`,
    detail: `${drafts}${kept}`,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await workspace.deleteVariation(docId, variationId);
}
// A right-click menu on the home screen's document list: the window says what's on it, and gets
// back the id of the item chosen, or null. The click can come after the menu closes, so closing
// waits a moment for it.
handle('home-menu', (items) => popupMenu(current(), Array.isArray(items) ? items : []));
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
const openElsewhere = (docId) => [...windows.values(), ...headless].some((c) => c !== current() && c.workspace.document?.id === docId);

// The one question before a document is deleted, by the user or at an AI's request. Cancel is the
// default, and there's no way to stop it asking.
async function askToDeleteDocument(name, from = null) {
  const consequence = 'The document, all its drafts and variations, and their reviews are deleted, and can’t be got back. The PDF you imported it from isn’t touched.';
  const { response } = await messageBox(current(), {
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
    warn('This document is open in another window', 'Close it there first, then delete it.');
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
    const { response } = await messageBox(current(), {
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
    const { response } = await messageBox(current(), { type: 'warning', ...uncommented, buttons: ['Cancel', 'Accept Anyway'], defaultId: 0, cancelId: 0 });
    if (response !== 1) return;
  }
  await workspace.acceptPreview();
});
// Asks first, since the AI would have to write it again.
handle('discard-preview', async () => {
  const { response } = await messageBox(current(), {
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
  const { response } = await messageBox(current(), {
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
// The top bar's requests (choosing, closing and dragging tabs, back and forward, the status pill,
// going home), the family's (@smartdesktop/ui's main/tabs.js), each given the tab asking, as
// SmartDoc's handlers find it (current()).
tabs.handlers((channel, fn) => handle(channel, (...args) => fn(current(), ...args)));
// The bottom bar's menu of what to ask the AI (see margin-review.js): the menu, by its labels, gives
// back the one chosen; and the request goes to the AI working on what the tab shows, a chat's in
// SmartDesktop (or the chat owning the tab, or a new one).
handle('ai-actions-menu', (labels) => popupMenu(current(), (Array.isArray(labels) ? labels : []).map((label, i) => (label === '-' ? { separator: true } : { id: i, label }))));
// An AI connected by hand (Claude Code, Claude Desktop) can't be sent a message: the request is
// copied for the user to paste to it, as it is with no SmartDesktop to send it.
handle('ask-ai', async (text) => {
  const ctx = current();
  const on = sessionsOn(ctx);
  const chatAi = on.find(fromDesktop);
  const other = on.find((s) => !fromDesktop(s));
  if (chatAi || (!other && desktop.installed())) {
    await desktop.ask(ctx.id, text, chatOf(chatAi) ?? chatOf(ctx.session));
    return { sent: true };
  }
  clipboard.writeText(text);
  return { copied: true, to: other ? clientLabel(other.client) : null };
});
handle('desktop-installed', () => desktop.installed());
handle('ai-at-work', () => aiAtWork(current()));
handle('open-chat', () => desktop.chat(current().id, true));

// The user's choice of a document's icon, which the AI never replaces.
handle('set-icon', (docId, icon) => itemIcons.set(docId, icon, 'user'));
handle('pictures-drawn', (id, result) => {
  const answer = pictureRequests.get(id);
  pictureRequests.delete(id);
  answer?.(result);
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
handle('install-update', () => {
  // The waits are told before the windows close (macOS quits the app only once they have).
  if (updates.status.state === 'ready') mcp?.endWaits(true);
  return updates.install();
});
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
  // Its pages served to other apps' windows (SmartDesktop's), each a guest tab of its own here (its
  // own workspace), its calls run by the same handlers; and other apps' tabs shown in its windows.
  await tabs.serveGuests({ files: path.join(dirname, '../../build/renderer'), run }).catch((error) => console.error('Guest tabs can’t be served:', error.message));
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
