import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from './desktop.js';
import { guessIcon, isIcon } from '@smartdesktop/ui/main/icons.js';
import { createItemIcons } from './item-icons.js';
import { createLayouts } from './layouts.js';
import { createTabs } from '@smartdesktop/ui/main/tabs.js';
import { API } from './api.js';
import { createFamily, familyFolder } from '@smartdesktop/ui/main/family.js';
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

// A development copy keeps its data in a folder of its own, SmartPrep Dev (and its MCP server on a
// port of its own, see mcp-server.js), so it never reads or overwrites the installed app's data,
// and the two can run side by side: the app allows one copy per data folder. Automated tests
// point it at a separate folder again (SMARTPREP_USER_DATA) and port (SMARTPREP_PORT), so a test
// copy can run beside both. Set before the app is ready so Chromium's own storage moves too. The
// packaged app ignores both.
if (!app.isPackaged) {
  app.setPath('userData', process.env.SMARTPREP_USER_DATA ? path.resolve(process.env.SMARTPREP_USER_DATA) : path.join(app.getPath('appData'), 'SmartPrep Dev'));
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
const WINDOW_TITLE = app.isPackaged ? 'SmartPrep' : 'SmartPrep Development';

const windows = new Map(); // a tab's webContents id → its tab: { id, host, home, view, contents, win, ready, session, untouched, where, name }
let lastFocused = null;
let mcp = null; // { url, token } once the MCP server is listening
let mcpStarting = true;
let mcpProblem = null; // why it isn't running: { reason: 'port-in-use', port, holder } or { reason: 'error', message }
let lastMcpStatus = null;
let mcpRetry = null;
const MCP_RETRY_MS = 5000; // while the port is taken, how often to try again, so it starts once it's free
// The topics, and where the user has put each card on each topic's board (kept on this Mac, never
// with the topic: see layouts.js).
const store = createStore(app.getPath('userData'));
const layouts = createLayouts(path.join(app.getPath('userData'), 'layouts'));

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
// tab showing one topic's board, opened from Home (or an AI's cards there) in a tab, the one already
// showing it if there is one. The window says where each tab is as it moves (`chat-shows`: `where`,
// and the topic's `name`). What's SmartPrep's own is given here: a card's answer is written by an
// AI, so its web links open in the browser (links to cards are followed on the board).
const hosts = new Set(); // { win, tabs: [home, …], active }
const tabs = createTabs({
  id: 'smartprep',
  title: WINDOW_TITLE,
  // The pages' API as data (api.js), which the family's preload builds `window.smartprep` from.
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
  changed: () => updateMenu(),
  tabReady: (ctx) => {
    ctx.contents.send('mcp-status', mcpStatus());
    if (ctx.session) ctx.contents.send('ai-control', clientLabel(ctx.session.client));
  },
  tabState: (ctx) => ({ title: tabTitle(ctx), icon: tabIcon(ctx), ai: ctx.session ? clientLabel(ctx.session.client) : null }),
  status: () => appStatus(),
  docOf: (ctx) => topicOf(ctx),
  // The AI gets a new tab, the next time it needs one.
  release: (ctx) => {
    if (ctx.session) ctx.session.ctx = null;
  },
  // Guest tabs: a topic's tab can be shown in another app's window (SmartDesktop's, say), opening the
  // same topic there; and SmartPrep's windows show other apps' tabs.
  name: 'SmartPrep',
  family: createFamily(familyFolder(app)),
  guestOpen: (ctx) => (topicOf(ctx) ? { topicId: topicOf(ctx), name: ctx.name } : null),
  guestOpened: (ctx, request) => ctx.contents.send('open-topic', request),
  // With SmartDesktop running, SmartPrep has no windows of its own: its tabs are in SmartDesktop's
  // (the user's choice, 2026-11-26), and it has no Dock icon.
  windowless: true,
});
// A menu or a question over a tab's window (in a guest tab, the window showing it shows them).
const { popupMenu, messageBox, createWindow, createTab, newTab, activateTab, closeTab, moveTab, sendTabs, sendAllTabs, stepTab, openChatFor, strips } = tabs;

// Where a tab is: 'home', or the id of the topic it shows, as the tab says (chat-shows).
const topicOf = (ctx) => (ctx.where && ctx.where !== 'home' ? ctx.where : null);
// The tab showing a topic (in the window of `host`) that no chat owns, if one does.
const tabsShowing = (topicId) => [...windows.values()].filter((t) => !t.home && topicOf(t) === topicId);

// A topic opened from home in a new tab (the user asked for one: a topic opened from home otherwise
// opens in the tab showing home, as a browser's page does), with what to open there (`request`: {
// topicId, name, card }: `card` to bring to the middle), beside the tab it came from.
async function openInTab(from, request) {
  const { host } = from;
  const tab = createTab(host, { after: from });
  await tab.ready;
  tab.contents.send('open-topic', request);
  activateTab(tab);
  return tab;
}

// Each topic's icon, set by the user or the AI (see item-icons.js), on its tab and on home: its
// own, or the guess from its name.
const FALLBACK_ICON = 'graduation-cap';
const itemIcons = createItemIcons(app.getPath('userData'), {
  onChange: () => {
    sendAllTabs();
    broadcast('topics-changed');
  },
});
const iconOfTopic = (id, name) => {
  const own = itemIcons.get(id)?.icon;
  return isIcon(own) ? own : guessIcon(name, FALLBACK_ICON);
};
const tabIcon = (ctx) => (topicOf(ctx) ? iconOfTopic(topicOf(ctx), ctx.name) : FALLBACK_ICON);
const withIcons = (list) => list.map((one) => ({ ...one, icon: iconOfTopic(one.id, one.name) }));

// A tab's name in the top bar (each topic's by its name and icon, with the AI working in it).
function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  if (ctx.name) return ctx.name;
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a topic…` : 'Opening…';
}
// The app's status, for the pill at the end of the top bar (see server-status.js for the panel it
// opens): the server's, and once it's running, whether SmartDesktop, which runs the chat, is there.
function appStatus() {
  const server = mcpStatus();
  const state = server.state !== 'running' ? server.state : desktop.status === 'missing' ? 'setup' : 'running';
  const label = { starting: 'Starting…', running: 'Ready', setup: 'Get SmartDesktop', off: 'Not running' }[state];
  const title = server.state === 'off' && server.reason === 'port-in-use'
    ? (server.holder?.kind === 'smartprep' ? 'Another copy of SmartPrep is running the server' : 'SmartPrep’s server port is in use by another app')
    : { starting: 'SmartPrep is starting', running: 'SmartPrep is ready to work with your AI', setup: 'SmartPrep’s server is running, but SmartDesktop, which runs the AI chat, isn’t installed', off: 'SmartPrep’s server isn’t running' }[state];
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
  // (Through the family's tabs: with no windows of its own, SmartDesktop's menu bar shows it too.)
  tabs.setMenu(buildMenu({
    hasWindow: windows.size > 0,
    actions: {
      newWindow: () => createWindow(),
      newTab: () => newTab(),
      // The tab (a window's last closes the window).
      close: () => lastFocused && closeTab(lastFocused),
      nextTab: (delta) => stepTab(delta),
      showChat: () => lastFocused && desktop.chat(lastFocused.id, true),
      newTopic: async () => {
        const ctx = lastFocused ?? createWindow();
        await ctx.ready;
        ctx.contents.send('new-topic');
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
// alone. The one exception is the window SmartPrep opened on launch, when the AI's launcher is what
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
    if (strict) throw new Error(`${clientLabel(ctx.session.client)} is working in this SmartPrep window. Tell the user: they can release it from the status pill's panel.`);
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
    if (!ctx.home && !ctx.hadTopic) closeTab(ctx);
  }
}

// An AI session's tab, opened when it first has something to show: in the window last used (or a
// new window), behind the one showing unless the AI started SmartPrep or is a chat's (the user is
// working with it).
async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  // The window SmartPrep opened as it started, if the AI started it: its tab on home, untouched.
  const launched = startedApp && [...hosts].find((h) => h.tabs.length === 1 && h.tabs[0].untouched && h.tabs[0].home && !h.tabs[0].session);
  // (With no windows of its own, the tab is SmartDesktop's to place: no window is made for it here.)
  const host = tabs.inSmartDesktop() ? null : lastFocused?.host ?? createWindow({ focus: false }).host;
  const ctx = launched ? launched.tabs[0] : createTab(host, { focus: Boolean(fromDesktop(session)) });
  if (launched || fromDesktop(session)) activateTab(ctx);
  await ctx.ready;
  setSessionWindow(session, ctx);
  if (ctx.win && !ctx.win.isVisible()) ctx.win.showInactive();
  return ctx;
}

// A prompt copied from a window names it, so the AI that gets it takes that window over.
function takeOverWindow(session, windowId) {
  const ctx = [...windows.values()].find((one) => one.id === windowId);
  if (!ctx) throw new Error(`There's no SmartPrep window ${windowId} open now. Carry on without it: SmartPrep opens a tab of your own when you write cards.`);
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

// The topics as an AI session may use them. What it writes shows in its own tab, which is opened
// only when there's something for the user to see (cards on a board): reading needs none, and a
// tab opened for it waited for what might never come, which looked frozen (the user found it so in
// SmartDoc and SmartSpec). `tab()` opens it (windowForSession). A topic not named is the one the
// session's tab shows.
const topicsFor = (session, tab) => {
  const topicHere = (topicId) => {
    const id = topicId ?? (session.ctx && topicOf(session.ctx));
    if (!id) throw new Error('This window shows no topic. Name the topic with topic_id (list_topics shows them).');
    return id;
  };
  const nameOf = async (id) => (await store.list()).find((one) => one.id === id)?.name ?? '';
  // Shows the topic to the user, once there's something on it for them: in the session's tab, a tab
  // showing it already (the user's own, which the session then takes, rather than opening another,
  // if no other AI works there), or a tab of its own. `card` is brought to the middle.
  async function show(topicId, card = null) {
    const request = { topicId, name: await nameOf(topicId), card };
    if (session.ctx && topicOf(session.ctx) === topicId) {
      if (card) session.ctx.contents.send('show-card', { topicId, card });
      return session.ctx;
    }
    if (!session.ctx) {
      const theirs = tabsShowing(topicId).find((t) => !t.chat && (!t.session || !sessions.alive(t.session)));
      if (theirs) {
        if (theirs.session) releaseWindow(theirs.session);
        setSessionWindow(session, theirs);
        if (card) theirs.contents.send('show-card', { topicId, card });
        return theirs;
      }
    }
    const ctx = await tab();
    ctx.contents.send('open-topic', request);
    // (A guest tab's window is another app's.)
    if (ctx.win && !ctx.win.isVisible()) ctx.win.showInactive();
    return ctx;
  }
  const withIcon = (topic) => ({ ...topic, icon: itemIcons.get(topic.id)?.icon ?? null });
  return {
    list: async () => (await store.list()).map(withIcon),
    async create({ icon, ...topic }) {
      const made = await store.create(topic);
      // Its icon isn't part of it: it's kept apart, as the AI's.
      if (icon && !itemIcons.get(made.topic)) itemIcons.set(made.topic, icon, 'ai');
      await show(made.topic);
      return { ...made, message: 'The topic is open in SmartPrep for the user.' };
    },
    get: async (topicId) => withIcon(await store.get(topicHere(topicId))),
    getCards: (topicId, ids) => store.getCards(topicHere(topicId), ids),
    async writeCards(topicId, cards) {
      const id = topicHere(topicId);
      const written = await store.writeCards(id, cards);
      if (written.cards.some((one) => one.made !== 'unchanged')) await show(id);
      return written;
    },
    removeCards: (topicId, ids) => store.removeCards(topicHere(topicId), ids),
    listQuestions: async (topicId, { all = false } = {}) => (await store.listQuestions(topicHere(topicId), { all }))
      .map(({ target: { item, ...target }, ...question }) => ({ ...question, target, outcome: question.outcome ?? null, noFurtherAction: question.noFurtherAction ?? null, answeredBy: question.answeredBy ?? null })),
    async answerQuestion(topicId, questionId, answer) {
      const id = topicHere(topicId);
      const answered = await store.answerQuestion(id, questionId, { ...answer, author: clientLabel(session.client) });
      await show(id);
      return answered;
    },
    replyToQuestion: (topicId, questionId, reply) => store.replyToQuestion(topicHere(topicId), questionId, { ...reply, author: clientLabel(session.client) }),
    rename: (topicId, change) => store.rename(topicHere(topicId), change),
    // A topic's icon (set_icon), the one named or the one the window shows: the user's choice is
    // kept over the AI's.
    async setIcon(icon, topicId = null) {
      const id = topicHere(topicId);
      await store.get(id);
      const { icon: shown, kept } = itemIcons.set(id, icon, 'ai');
      return kept ? { icon: shown, note: 'The user chose this topic\'s icon, so it stays.' } : { icon: shown };
    },
    // A card brought to the middle of the topic's board, in the session's tab (the user asked to see it).
    async showCard(topicId, cardId) {
      const id = topicHere(topicId);
      await store.getCards(id, [cardId]);
      await show(id, cardId);
      return { topic: id, card: cardId, shown: true };
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
    return run(topicsFor(session, () => windowForSession(session, startedApp)));
  },
};

function sweepSessions() {
  for (const { session } of windows.values()) {
    if (session && !sessions.alive(session)) releaseWindow(session);
  }
  sessions.sweep();
}

// --- Connecting an AI --------------------------------------------------------------------
// AI apps start SmartPrep's MCP launcher, which is inside the app (see connect.js). The MCP panel
// (opened from the status pill, or Connect an AI in the menu) shows how to set up each AI app,
// and can add SmartPrep to Claude Desktop itself.

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
  const { response } = await messageBox(ctx, {
    type: 'question',
    message: status.state === 'different' ? 'Update SmartPrep in Claude Desktop?' : 'Add SmartPrep to Claude Desktop?',
    detail: 'SmartPrep adds itself to Claude Desktop’s settings file (claude_desktop_config.json), and keeps a copy of the file as it was. Then quit Claude Desktop and open it again to connect.',
    buttons: [status.state === 'different' ? 'Update' : 'Add', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return status;
  return addToClaudeDesktop();
}

// macOS: AI apps start SmartPrep from where it's installed, so a copy run from the disk image or
// Downloads is offered a move to Applications (which opens it again from there).
async function offerMoveToApplications(ctx) {
  if (!app.isPackaged || process.platform !== 'darwin' || app.isInApplicationsFolder()) return;
  const { response } = await messageBox(ctx, {
    type: 'question',
    message: 'Move SmartPrep to your Applications folder?',
    detail: 'Your agent opens SmartPrep from where it’s installed, so it works best in Applications.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox('SmartPrep couldn’t be moved', `${error.message}\n\nDrag SmartPrep into your Applications folder in Finder instead.`);
  }
}

// --- Updates -----------------------------------------------------------------------------

// (Nothing in SmartPrep waits on the user, as its cards go straight onto the board, so there's no
// `wait` to tell as the app quits, as SmartSpec's and SmartAd's tell theirs.)
const updates = createUpdates({ report: (status) => broadcast('updates', status) });

// --- The chat, in SmartDesktop (see desktop.js) -----------------------------------------------
// The AI chat is SmartDesktop's, an app of its own, for the family's apps: chat windows over the
// apps' windows, and one conversation across them (the user's choice). SmartPrep tells it about each
// tab (what it shows, when it has the focus, lines of context, the shortcuts to offer), and its AI
// uses SmartPrep's tools through the MCP server, on the tab the user was last in (see aiForServer).

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

// What the tab shows, for the AI: home, or a topic's board (by name and id), with how many cards
// it has, which are in the middle of the board, and how many of the user's questions wait. `where`
// is as the tab says (see topicOf); `middle`, the cards the tab has open in the middle, by id.
async function chatWhere(where = 'home', middle = []) {
  if (where === 'home') return 'The window shows SmartPrep\'s home: the user\'s topics. To start a new one, ask the user what it\'s for, then create_topic.';
  const topic = await store.get(where).catch(() => null);
  if (!topic) return 'The window shows a topic that is no longer there.';
  const open = middle.map((id) => topic.cards.find((card) => card.id === id)).filter(Boolean).map((card) => `“${card.title}” (${card.id})`);
  const waiting = topic.questions.waiting ? ` ${topic.questions.waiting === 1 ? 'One question waits' : `${topic.questions.waiting} questions wait`} for you (get_questions).` : '';
  return `The window shows the topic “${topic.name}” (topic_id ${where}), a board of ${topic.cards.length === 1 ? '1 card' : `${topic.cards.length} cards`}${open.length ? `, with ${open.join(', ')} in the middle` : ''}. “This topic” means this one.${waiting}`;
}

// --- Window requests ---------------------------------------------------------------------

// Whatever a window asks for, it asks about itself: each handler gets that window first.
// (Each is kept by its channel too, for a guest tab's calls: see the guest server below.)
const handlers = new Map(); // channel → handler
const run = async (ctx, channel, args) => {
  try {
    return { ok: true, value: await handlers.get(channel)(ctx, ...args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};
const handle = (channel, fn) => {
  handlers.set(channel, fn);
  ipcMain.handle(channel, (event, ...args) => run(windows.get(event.sender.id) ?? strips.get(event.sender.id)?.active ?? lastFocused, channel, args));
};

// Setup for each AI app, shown and copied for pasting (see connect.js).
async function mcpSetup(target) {
  const all = await setups();
  if (!all[target]) throw new Error(`Unknown AI app: ${target}`);
  return all[target];
}

store.events.on('changed', () => broadcast('topics-changed'));

// The user deletes a topic from home, asked first, as it can't be had back: its cards and
// questions go with it, and the tabs showing it close (each sees it's gone). The AI has no tool for
// this, as in SmartDoc and SmartSpec.
async function deleteTopic(ctx, topicId) {
  const topic = (await store.list()).find((one) => one.id === topicId);
  if (!topic) return false;
  const cards = topic.cards === 1 ? 'its card' : topic.cards ? `its ${topic.cards} cards` : null;
  const { response } = await messageBox(ctx, {
    type: 'warning',
    message: `Delete “${topic.name}”?`,
    detail: `${cards ? `${cards.charAt(0).toUpperCase()}${cards.slice(1)} and your questions go with it. ` : ''}This can't be undone.`,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  await store.delete(topicId);
  return true;
}

// The topics, as the tabs show them (see topics.js): home's list, a topic's board, its cards in
// full, the user's questions and what they do about them, and where they put each card.
handle('list-topics', async () => withIcons(await store.list()));
handle('get-topic', (_ctx, id) => store.get(id));
handle('get-cards', (_ctx, id) => store.getCards(id));
handle('mark-read', (_ctx, id, cardId) => store.markRead(id, cardId));
handle('list-questions', (_ctx, id) => store.listQuestions(id, { all: true }));
handle('add-question', (_ctx, id, question) => store.addQuestion(id, question));
handle('set-no-further-action', (_ctx, id, questionId, flag) => store.setNoFurtherAction(id, questionId, flag));
handle('rename-topic', (_ctx, id, name) => store.rename(id, { name }));
handle('delete-topic', (ctx, id) => deleteTopic(ctx, id));
handle('get-layout', (_ctx, id) => layouts.get(id));
handle('save-layout', (_ctx, id, layout) => layouts.save(id, layout));
// A right-click menu on home, as SmartDoc's: the chosen item's id, or null if none was chosen.
handle('home-menu', (ctx, items) => popupMenu(ctx, Array.isArray(items) ? items : []));
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
// `middle`: the cards open in the middle of the board, for what the AI is told.
handle('chat-shows', async (ctx, where, line, name = null, middle = []) => {
  // Where the tab is, for its name and icon in the top bar (and to find the tab showing a topic).
  ctx.where = where;
  ctx.name = where === 'home' ? null : name;
  if (!ctx.home && where !== 'home') ctx.hadTopic = true;
  sendTabs(ctx.host);
  const detail = await chatWhere(where, Array.isArray(middle) ? middle : []);
  return desktop.window(ctx.id, { shows: { key: where, text: line, detail }, title: where === 'home' ? 'Home' : name, home: Boolean(ctx.home) });
});
handle('chat-shortcuts', (ctx, { hint = null, shortcuts = [] } = {}) => desktop.window(ctx.id, { hint, shortcuts }));
handle('chat-note', (ctx, note) => desktop.note(ctx.id, note));
handle('chat-ask', (ctx, text) => desktop.ask(ctx.id, text));
handle('desktop-status', () => desktop.status);
// The top bar's requests (choosing, closing and dragging tabs, back and forward, the status pill,
// going home), the family's (@smartdesktop/ui's main/tabs.js).
tabs.handlers(handle);
// The user's choice of a topic's icon, which the AI never replaces.
handle('set-icon', (_ctx, topicId, icon) => itemIcons.set(topicId, icon, 'user'));
// A topic opened from home in a new tab (see openInTab): `request` is { topicId, name, card }.
handle('open-in-tab', (ctx, request) => {
  if (!request?.topicId || !ctx) return null;
  openInTab(ctx, request);
  return null;
});
// Opens SmartDesktop's page, to download it.
handle('get-desktop', () => shell.openExternal('https://github.com/tw050x/smartdesktop/releases/latest'));
handle('get-appearance', () => nativeTheme.themeSource);
handle('set-appearance', (_ctx, appearance) => setAppearance(appearance));

// --- App lifecycle -----------------------------------------------------------------------

app.whenReady().then(async () => {
  // The app is in beta, and its About panel says so (as Settings does).
  app.setAboutPanelOptions({ credits: 'SmartPrep is in beta, so it may change significantly from one version to the next.' });
  // Its pages served to other apps' windows (SmartDesktop's), each a guest tab of its own here, its
  // calls run by the same handlers; and other apps' tabs shown in its windows.
  await tabs.serveGuests({ files: path.join(dirname, '../../build/renderer'), run }).catch((error) => console.error('Guest tabs can’t be served:', error.message));
  if (tabs.inSmartDesktop()) app.dock?.hide();
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
