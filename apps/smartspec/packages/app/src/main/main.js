import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnect } from './connect.js';
import { MCP_PORT, startMcpServer } from './mcp-server.js';
import { clientLabel, createSessions } from './sessions.js';
import { buildMenu } from './menu.js';
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

const windows = new Map(); // webContents id → { id, win, ready, session, untouched }
let lastFocused = null;
let mcp = null; // { url, token } once the MCP server is listening
let mcpStarting = true;
const store = createStore(app.getPath('userData'));
// Where the user has placed things in each schematic's focus view, on this computer only.
const layouts = createLayouts(path.join(app.getPath('userData'), 'layouts'));
const waits = createWaits({ store });

// For every window: what's the same in all of them.
const broadcast = (channel, value) => {
  for (const { win } of windows.values()) win.webContents.send(channel, value);
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
  for (const { win } of windows.values()) {
    win.setBackgroundColor(colours.background);
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT });
  }
});

// --- Windows -------------------------------------------------------------------------------

// Frameless window: the interface draws its own top bar. macOS keeps its traffic lights,
// placed in the top bar; Windows and Linux get the system window controls drawn over it.
function createWindow({ focus = true } = {}) {
  const colours = windowColours();
  const frame = process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: (TOP_BAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT } };

  const id = `w-${randomUUID().slice(0, 4)}`;
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: WINDOW_TITLE,
    backgroundColor: colours.background,
    show: focus,
    ...frame,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--smartspec-window=${id}`],
    },
  });
  const ctx = { id, win, ready: null, session: null, untouched: true };
  const contentsId = win.webContents.id;
  windows.set(contentsId, ctx);
  // An AI's window opens without taking focus, so the menu stays with the one the user is in.
  if (focus || !lastFocused) lastFocused = ctx;
  updateMenu();
  win.on('focus', () => {
    lastFocused = ctx;
  });
  // In full screen macOS moves the traffic lights out of the top bar, so the interface can reclaim
  // the space reserved for them.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('enter-full-screen', () => win.webContents.send('full-screen', true));
  win.on('leave-full-screen', () => win.webContents.send('full-screen', false));
  // A schema's content is written by an AI, and its links must never replace the interface: they
  // open in the browser, if they're web links at all.
  const openLink = (url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openLink(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });
  ctx.ready = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  ctx.ready.then(() => {
    win.webContents.send('mcp-status', mcpStatus());
    if (ctx.session) win.webContents.send('ai-control', clientLabel(ctx.session.client));
  });
  win.loadFile(path.join(dirname, '../../build/renderer/index.html'));

  win.on('closed', () => {
    windows.delete(contentsId);
    if (lastFocused === ctx) lastFocused = [...windows.values()].at(-1) ?? null;
    // The AI gets a new window, the next time it needs one.
    if (ctx.session) ctx.session.ctx = null;
    updateMenu();
  });
  return ctx;
}

const mcpStatus = () => (mcp ? { state: 'running', url: mcp.url } : { state: mcpStarting ? 'starting' : 'off' });

function updateMenu() {
  Menu.setApplicationMenu(buildMenu({
    hasWindow: windows.size > 0,
    actions: {
      newWindow: () => createWindow(),
      close: () => lastFocused?.win.close(),
      newSchema: async () => {
        const ctx = lastFocused ?? createWindow();
        await ctx.ready;
        ctx.win.webContents.send('new-schema');
      },
      showConnectAi,
      showSettings: () => lastFocused?.win.webContents.send('show-settings'),
    },
  }));
}

// --- AI sessions ---------------------------------------------------------------------------
// Each AI session has a window of its own, opened by its first tool call, whatever windows the user
// has open: theirs are left alone. The one exception is the window SmartSpec opened on launch, when
// the AI's launcher is what started it. A window closed is opened again by the session's next call.

const sessions = createSessions();

function setSessionWindow(session, ctx) {
  session.ctx = ctx;
  ctx.session = session;
  ctx.untouched = false;
  ctx.ready.then(() => ctx.win.webContents.send('ai-control', clientLabel(session.client)));
}

// Gives a window back to the user, whichever way the session stopped.
function releaseWindow(session) {
  sessions.releaseClaims(session);
  const { ctx } = session;
  session.ctx = null;
  if (ctx) {
    ctx.session = null;
    ctx.win.webContents.send('ai-control', null);
  }
}

async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  const launch = startedApp && [...windows.values()].find((c) => c.untouched && !c.session);
  const ctx = launch || createWindow({ focus: false });
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
    old.win.close(); // a window the session opened for itself isn't worth leaving behind
  }
  setSessionWindow(session, ctx);
  return { window: windowId };
}

const schemaClaim = (schemaId) => `schema:${schemaId}`;

// The schemas as an AI session may use them. Its proposals show in its own window.
const schemasFor = (session, ctx) => ({
  list: () => store.list(),
  getSchema: (id, options) => store.getSchema(id, options),
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
    const made = await store.propose(proposal);
    sessions.claim(session, schemaClaim(made.schema));
    ctx.win.webContents.send('show-schema', { schemaId: made.schema, name: proposal.name ?? '' });
    if (!ctx.win.isVisible()) ctx.win.showInactive();
    return {
      ...made,
      status: 'waiting_for_user',
      wait: waitCommand('proposal', '--id', made.proposal),
      message: 'Nothing has changed yet. Tell the user straight away to switch to the SmartSpec app and accept or discard this: only they can. To hear their answer, run the wait command in the background if you can, or call get_schematic later.',
    };
  },
});

const aiForServer = {
  alive: ({ session, client }) => sessions.touch(session, client),
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
  async call({ session: id, client, startedApp }, name, _args, run) {
    const session = sessions.touch(id, client);
    // Taking a window over is the one call that mustn't open one of its own.
    if (name === 'use_window') return run({ useWindow: (windowId) => takeOverWindow(session, windowId) });
    const ctx = await windowForSession(session, startedApp);
    return run(schemasFor(session, ctx));
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
  ctx.win.webContents.send('show-connect');
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

// --- Window requests ---------------------------------------------------------------------

// Whatever a window asks for, it asks about itself: each handler gets that window first.
const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  try {
    return { ok: true, value: await fn(windows.get(event.sender.id) ?? lastFocused, ...args) };
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

// A domain (a group in the store) goes, and its schemas go to No domain: asked first, as it can't be
// had back.
async function deleteGroup(ctx, id) {
  const { groups } = await store.listGroups();
  const group = groups.find((one) => one.id === id);
  if (!group) return false;
  const { response } = await dialog.showMessageBox(ctx?.win ?? undefined, {
    type: 'warning',
    message: `Delete the domain “${group.name}”?`,
    detail: group.schemas ? `Its ${group.schemas === 1 ? 'schematic moves' : `${group.schemas} schematics move`} to No domain. Nothing in them changes.` : 'It has no schematics in it.',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  await store.deleteGroup(id);
  return true;
}

handle('list-schemas', () => store.list());
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
handle('set-no-further-action', (_ctx, id, commentId, flag) => store.setNoFurtherAction(id, commentId, flag));
handle('accept-proposal', async (_ctx, id) => {
  await store.accept(id);
  sessions.release(schemaClaim(id));
});
handle('discard-proposal', (ctx, id) => discardProposal(ctx, id));
// The user can always take a window back from an AI, in the MCP panel.
handle('ai-control-release', ({ session }) => {
  if (session) releaseWindow(session);
});
handle('mcp-setup', (_ctx, target) => mcpSetup(target));
handle('copy-mcp-setup', async (_ctx, target) => clipboard.writeText(await mcpSetup(target)));
handle('claude-desktop-status', () => claudeDesktopStatus());
handle('add-to-claude-desktop', (ctx) => confirmAddToClaudeDesktop(ctx));
handle('get-updates', () => updates.status);
handle('check-updates', () => updates.check());
handle('install-update', () => updates.install());
handle('get-appearance', () => nativeTheme.themeSource);
handle('set-appearance', (_ctx, appearance) => setAppearance(appearance));

// --- App lifecycle -----------------------------------------------------------------------

app.whenReady().then(async () => {
  const first = createWindow();
  try {
    mcp = await startMcpServer(aiForServer, app.getPath('userData'));
    setInterval(sweepSessions, SWEEP_MS).unref();
  } catch {
    mcp = null; // e.g. the port is taken by another copy of the app
  }
  mcpStarting = false;
  broadcast('mcp-status', mcpStatus());
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
