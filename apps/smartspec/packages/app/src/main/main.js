import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, createAgent } from './agent.js';
import { anchorOf, firstPlace, placeFrom } from './chat-anchor.js';
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

const windows = new Map(); // webContents id → { id, win, ready, session, untouched }
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
  followChat(ctx);
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

const mcpStatus = () => (mcp ? { state: 'running', url: mcp.url } : mcpStarting ? { state: 'starting' } : { state: 'off', ...mcpProblem });

// Starts the MCP server, or says why it couldn't. A taken port is tried again every few seconds
// (another copy of the app may be quitting); anything else waits for the user's Try again.
async function startMcp() {
  clearTimeout(mcpRetry);
  if (mcp) return mcpStatus();
  try {
    mcp = await startMcpServer(aiForServer, app.getPath('userData'));
    mcpProblem = null;
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
  }
  return mcpStatus();
}

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
      message: 'Nothing has changed yet. Tell the user straight away to switch to the SmartSpec app and accept or discard this: only they can. To hear their answer, run the wait command in the background if you can, or call get_schematic later. The wait also ends if the user sends you their comments to deal with first: answer them, revise if they need it, and wait again.',
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

// --- The chat: the user's own AI, run by the app (see agent.js) ------------------------------
// The AI works in the window the chat is in, as an AI session of its own bound to that window,
// with SmartSpec's tools only, through the app's own MCP server.

const agent = createAgent({
  userData: app.getPath('userData'),
  mcp: (headers) => ({ url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}`, ...headers } }),
  // To try the AIs' setup in a development build without touching the user's own (see agent.js).
  trial: app.isPackaged ? null : { home: process.env.SMARTSPEC_AI_HOME || null, hide: process.env.SMARTSPEC_AI_HIDE || '' },
  // To the window the AI was asked from, or, for a change to a chat not from a window (a new
  // session, a moved chat), to every window: each shows only its own chat.
  onEvent: (event) => {
    const to = event.windowId ? [...windows.values()].filter((c) => c.id === event.windowId) : [...windows.values()];
    for (const ctx of to) {
      ctx.win.webContents.send('agent-event', event);
      ctx.chat?.win.webContents.send('agent-event', event);
    }
  },
});
// Installing and signing in say how they're getting on, to every window (the panel and the chat
// both show it).
const agentProgress = (progress) => {
  for (const ctx of windows.values()) {
    ctx.win.webContents.send('agent-progress', progress);
    ctx.chat?.win.webContents.send('agent-progress', progress);
  }
};

// Floating, the chat is a window of its own, kept on top of the app window it belongs to and moved
// independently of it (see followChat). The user can put it anywhere, inside the window or out of
// it, and it opens again where it was beside that window (see chat-anchor.js). It does everything as that window: its requests run as that
// window's (chatOwners), and that window's interface sends it what it shows (chat-state).
const chatOwners = new Map(); // the chat window's webContents id → the ctx of the window it belongs to

function openChatWindow(ctx) {
  if (ctx.chat) return ctx.chat.win.show();
  const parent = ctx.win.getBounds();
  const size = ctx.chatSize ?? { width: 400, height: firstPlace(parent).height };
  const bounds = ctx.chatAnchor ? placeFrom(parent, ctx.chatAnchor, size) : firstPlace(parent);
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 300,
    frame: false,
    show: false,
    title: 'Chat',
    backgroundColor: windowColours().background,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--smartspec-window=${ctx.id}`],
    },
  });
  ctx.chat = { win, docking: false };
  const contentsId = win.webContents.id;
  chatOwners.set(contentsId, ctx);
  const remember = () => {
    if (win.isDestroyed() || ctx.win.isDestroyed()) return;
    const b = win.getBounds();
    ctx.chatAnchor = anchorOf(ctx.win.getBounds(), b);
    ctx.chatSize = { width: b.width, height: b.height };
  };
  // Where it is relative to the app window, to open there again.
  win.on('move', remember);
  win.on('resize', remember);
  // Opened from the app, which is active: at the floating level straight away (see followChat).
  floatChat(win, true);
  // Out of the way when the user shows all windows (Mission Control, App Exposé): a floating window
  // would otherwise stay on top of them (the user found it in the way).
  win.setHiddenInMissionControl?.(true);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    chatOwners.delete(contentsId);
    const { docking } = ctx.chat ?? {};
    ctx.chat = null;
    if (!ctx.win.isDestroyed()) ctx.win.webContents.send('chat-mode', { mode: docking ? 'docked' : 'closed' });
  });
  win.loadFile(path.join(dirname, '../../build/renderer/chat.html'));
  ctx.win.webContents.send('chat-mode', { mode: 'floating' });
}

// The chat floats in a window of its own, which the user moves independently of the app window (the
// user's choice: as a child window it moved with it), but it stays on top of it: while the app is
// the active one, the chat is at the floating windows' level, above every ordinary window (however
// often the app window is clicked: going back over it when that came forward wasn't enough), and
// when another app becomes active it's an ordinary window again, so that app's windows go over it.
// It hides while the app window is minimised and closes with it, and in full screen, where a window
// of its own can't follow, the chat docks.
const floatChat = (win, on) => {
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(on, 'floating');
};
const chatWindows = () => [...windows.values()].map((ctx) => ctx.chat?.win).filter(Boolean);
app.on('did-become-active', () => chatWindows().forEach((win) => floatChat(win, true)));
app.on('did-resign-active', () => chatWindows().forEach((win) => floatChat(win, false)));
function followChat(ctx) {
  // The window loaded again (a reload) while its chat floats: it's told, so it sends the chat what
  // it shows.
  ctx.win.webContents.on('did-finish-load', () => {
    if (ctx.chat) ctx.win.webContents.send('chat-mode', { mode: 'floating' });
  });
  const chatWin = () => (ctx.chat && !ctx.chat.win.isDestroyed() ? ctx.chat.win : null);
  ctx.win.on('show', () => chatWin()?.showInactive());
  ctx.win.on('minimize', () => chatWin()?.hide());
  ctx.win.on('restore', () => chatWin()?.showInactive());
  ctx.win.on('hide', () => chatWin()?.hide());
  ctx.win.on('closed', () => chatWin()?.destroy());
  ctx.win.on('enter-full-screen', () => closeChatWindow(ctx, true));
}

function closeChatWindow(ctx, dock) {
  if (!ctx.chat) return;
  ctx.chat.docking = dock;
  ctx.chat.win.close();
}

const CHAT_SYSTEM = 'You are working inside the SmartSpec app on the user\'s Mac. The user is chatting with you in the app\'s chat panel, beside the window they are working in, and the SmartSpec tools act on that window: never call use_window. Follow the SmartSpec server\'s instructions. When the user wants a schematic made or changed, propose it with propose_schematic: only they can accept or discard it, in the app, so tell them to look at it there. Never run a wait command: the user tells you what they decided when they next write. The app shows each tool you use as a step, so don\'t describe your tool calls; keep replies short and plain. A message may start with [What I\'ve done in the app since my last message, for context: …]: what the user did and looked at in the app since they last wrote, so you know what they mean by \"this\"; use it, and don\'t repeat it back. When it helps, end your reply with up to three short questions the user might want to ask you next, in their words, each on its own line as <suggest>question</suggest>: the app shows them as buttons, not as text.';

// The window's chat is one conversation, whatever it shows (the user's choice: it was a chat for each
// draft, and one for home): where the window goes is a line of context in it (see chat-shows).
const chatOfWindow = (ctx) => (ctx ? `window/${ctx.id}` : null);

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

async function chatSend(ctx, providerId, conversation, text, { model = null } = {}) {
  const provider = PROVIDERS[providerId] ?? PROVIDERS.claude;
  const client = `smartspec-${provider.id}`;
  const chatId = chatOfWindow(ctx);
  if (!mcp) throw new Error(`SmartSpec’s server isn’t running, so ${provider.name} can’t work in this window.`);
  const sessionId = `chat-${ctx.id}`;
  const session = sessions.touch(sessionId, client);
  if (ctx.session && ctx.session !== session && sessions.alive(ctx.session)) {
    throw new Error(`${clientLabel(ctx.session.client)} is working in this window. Release it from the panel first.`);
  }
  if (session.ctx !== ctx) {
    if (session.ctx) releaseWindow(session);
    setSessionWindow(session, ctx);
  }
  const systemPrompt = `${CHAT_SYSTEM} ${await chatWhere(ctx.chatShows)}`;
  // Calls keep the session alive; between them, while the AI thinks, this does.
  const keepAlive = setInterval(() => sessions.touch(sessionId, client), 10 * 1000);
  agent.send({ provider: provider.id, windowId: ctx.id, chatId, conversation, text, systemPrompt, model, sessionHeaders: { 'x-smartspec-session': sessionId, 'x-smartspec-client': client } })
    .catch((error) => {
      ctx.win.webContents.send('agent-event', { windowId: ctx.id, chatId, conversation, type: 'error', error: error.message });
      ctx.chat?.win.webContents.send('agent-event', { windowId: ctx.id, chatId, conversation, type: 'error', error: error.message });
    })
    .finally(() => clearInterval(keepAlive));
  return true;
}

// --- Window requests ---------------------------------------------------------------------

// Whatever a window asks for, it asks about itself: each handler gets that window first.
const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  try {
    return { ok: true, value: await fn(windows.get(event.sender.id) ?? chatOwners.get(event.sender.id) ?? lastFocused, ...args) };
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
handle('check-updates', () => updates.check());
handle('install-update', () => updates.install());
// The chat (see chatSend above and agent.js).
handle('agent-status', () => agent.status());
handle('agent-sign-in', (_ctx, id) => agent.signIn(id, agentProgress));
handle('agent-install', (_ctx, id) => agent.install(id, agentProgress));
handle('agent-install-help', (_ctx, id) => shell.openExternal((PROVIDERS[id] ?? PROVIDERS.claude).installHelp));
// The window's chat (the chat ids the window sends are for its own use: the chat is the window's).
handle('agent-chats', async (ctx) => {
  const chatId = chatOfWindow(ctx);
  return chatId ? { chatId, ...(await agent.load(chatId)), running: agent.runningIn(chatId) } : null;
});
handle('agent-send', (ctx, provider, conversation, text, _chatId, options) => chatSend(ctx, provider, conversation, text, options));
handle('agent-stop', (ctx, conversation) => agent.stop(chatOfWindow(ctx), conversation));
handle('agent-new-session', (ctx, provider, conversation) => agent.newSession(chatOfWindow(ctx), conversation, provider));
// Where the window is (see chatWhere), and the line for its chat when that changes; the first
// thing a window shows isn't news.
handle('chat-shows', (ctx, where, line) => {
  const before = ctx.chatShows;
  ctx.chatShows = where;
  if (before !== undefined && before !== where && line) return agent.note(chatOfWindow(ctx), line);
  return null;
});
handle('chat-float', (ctx) => openChatWindow(ctx));
handle('chat-dock', (ctx) => closeChatWindow(ctx, true));
handle('chat-close', (ctx) => closeChatWindow(ctx, false));
// What the app window shows, passed on to its chat window (kept for when it opens).
handle('chat-state', (ctx, state) => {
  ctx.chatState = state;
  ctx.chat?.win.webContents.send('chat-state', state);
});
handle('chat-action', (ctx, id) => ctx.win.webContents.send('chat-action', id));
// A line of context for the chat (what the user did or looked at), for the AI with their next
// message: in the window's chat (see note in agent.js).
handle('chat-note', (ctx, _chatId, note) => agent.note(chatOfWindow(ctx), note));
// The app window asks its floating chat to send the AI a request (see app-shell.js).
// A chat window still starting is sent it once it's ready (chat-ready).
handle('chat-ask', (ctx, text) => {
  if (ctx.chat?.ready) ctx.chat.win.webContents.send('chat-ask', text);
  else if (ctx.chat) ctx.chat.asked = text;
});
handle('chat-ready', (ctx) => {
  setTimeout(() => {
    if (!ctx.chat) return;
    if (ctx.chatState) ctx.chat.win.webContents.send('chat-state', ctx.chatState);
    ctx.chat.ready = true;
    if (ctx.chat.asked) ctx.chat.win.webContents.send('chat-ask', ctx.chat.asked);
    ctx.chat.asked = null;
  });
  return { view: 'main' };
});
handle('get-appearance', () => nativeTheme.themeSource);
handle('set-appearance', (_ctx, appearance) => setAppearance(appearance));

// --- App lifecycle -----------------------------------------------------------------------

app.whenReady().then(async () => {
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
