import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from './desktop.js';
import { guessIcon, isIcon } from '@smartdesktop/ui/main/icons.js';
import { createItemIcons } from './item-icons.js';
import { createTabs } from '@smartdesktop/ui/main/tabs.js';
import { API } from './api.js';
import { createConnect } from './connect.js';
import { MCP_PORT, portHolder, startMcpServer } from './mcp-server.js';
import { clientLabel, createSessions } from './sessions.js';
import { buildMenu } from './menu.js';
import { createFamily, familyFolder } from '@smartdesktop/ui/main/family.js';
import { createStore } from './store.js';
import { contractPartName } from './contract.js';
import { createLayouts } from './layouts.js';
import { createSecrets } from './secrets.js';
import { createTestRuns } from './test-runs.js';
import { createWorkspaces, WORKSPACE_KINDS } from './workspaces.js';
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
// The family's windows of tabs (@smartdesktop/ui's main/tabs.js): Home first, pinned, and each other
// tab showing one schematic, opened from Home (or an AI's proposal there) in a tab, the one already
// showing it if there is one. The window says where each tab is as it moves (`chat-shows`: `where`,
// and the schematic's `name`). What's SmartSpec's own is given here.
const hosts = new Set(); // { win, tabs: [home, …], active }
const tabs = createTabs({
  id: 'smartspec',
  title: WINDOW_TITLE,
  // The pages' API as data (api.js), which the family's preload builds `window.smartspec` from.
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
  docOf: (ctx) => schemaOf(ctx),
  // The AI gets a new tab, the next time it needs one.
  release: (ctx) => {
    if (ctx.session) ctx.session.ctx = null;
  },
  // Guest tabs: a schematic's tab can be shown in another app's window (SmartDesktop's, say), opening
  // the same schematic there (its latest draft); and SmartSpec's windows show other apps' tabs.
  name: 'SmartSpec',
  family: createFamily(familyFolder(app)),
  guestOpen: (ctx) => {
    const schemaId = ctx.where && ctx.where !== 'home' ? ctx.where.split('/')[0] : null;
    return schemaId ? { path: [{ schemaId, label: ctx.name ?? '' }] } : null;
  },
  guestOpened: (ctx, request) => ctx.contents.send('open-level', request),
  // With SmartDesktop running, SmartSpec has no windows of its own: its tabs are in SmartDesktop's
  // (the user's choice, 2026-11-26), and it has no Dock icon.
  windowless: true,
});
// A tab still there: a guest tab (another app's window shows it) or one whose window is open.
const tabAlive = (ctx) => Boolean(ctx && (ctx.guest || !ctx.win.isDestroyed()));
// A menu, a question or a sheet over a tab's window (in a guest tab, the window showing it shows them).
const { popupMenu, messageBox, confirmSheet, createWindow, createTab, newTab, activateTab, closeTab, moveTab, sendTabs, sendAllTabs, stepTab, openChatFor, strips } = tabs;

// A schematic opened in a new tab (the user asked for one: a schematic opened from home otherwise
// opens in the tab showing home, as a browser's page does), beside the tab it came from, with the
// levels to show (`request`: { path, layout }).
async function openInTab(from, request) {
  const { host } = from;
  const tab = createTab(host, { after: from });
  await tab.ready;
  tab.contents.send('open-level', request);
  activateTab(tab);
  return tab;
}

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

// A tab's name in the top bar (each schematic's by its name, with the AI working in it).
function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  if (ctx.name) return ctx.name;
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a schematic…` : 'Opening…';
}
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
  // The window SmartSpec opened as it started, if the AI started it: its tab on home, untouched.
  const launched = startedApp && [...hosts].find((h) => h.tabs.length === 1 && h.tabs[0].untouched && h.tabs[0].home && !h.tabs[0].session);
  // (With no windows of its own, the tab is SmartDesktop's to place: no window is made for it here.)
  const host = tabs.inSmartDesktop() ? null : lastFocused?.host ?? createWindow({ focus: false }).host;
  const ctx = launched ? launched.tabs[0] : createTab(host, { focus: Boolean(fromDesktop(session)) });
  // A chat's AI gets a tab of its own, shown: the user is working with it.
  if (launched || fromDesktop(session)) activateTab(ctx);
  await ctx.ready;
  setSessionWindow(session, ctx);
  if (ctx.win && !ctx.win.isVisible()) ctx.win.showInactive();
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
// How a run of the checks went, as a line of context for the chat: "Ran 4 checks of “Orders” against
// main at 1a2b3c4: 3 passed, 1 failed".
function runNote(state, record) {
  const of = `“${record.name}”${state.only ? `, ${contractPartName(record.contract, state.only)}` : ''}${state.code?.label ? ` against ${state.code.label}` : ''}`;
  const { passed = 0, failed = 0, error = 0 } = state.counts ?? {};
  const ran = passed + failed + error;
  const text = state.outcome === 'error' && !Object.keys(state.results ?? {}).length
    ? `Couldn’t run the checks of ${of}`
    : `Ran ${ran} ${ran === 1 ? 'check' : 'checks'} of ${of}: ${[`${passed} passed`, failed && `${failed} failed`, error && `${error} couldn’t be run`].filter(Boolean).join(', ')}`;
  return { text, detail: `${text}${state.detail ? ` (${state.detail})` : ''}${state.version === 'proposal' ? ', on the proposal' : ''}` };
}

const schemasFor = (session, tab) => ({
  list: async () => (await store.list()).map((one) => ({ ...one, icon: itemIcons.get(one.id)?.icon ?? null })),
  getSchema: async (id, options) => {
    const shown = await store.getSchema(id, options);
    if (!shown) return shown;
    // Where its code is kept to work on, on the user's Mac (see workspaces.js).
    const workspace = shown.implementation && WORKSPACE_KINDS.includes(shown.implementation.source.kind)
      ? await workspaces.info(id, shown.name).then(({ dir, cloned, branch, changes }) => ({ path: dir, cloned, ...(cloned ? { branch, changes } : {}) }))
      : null;
    // How its secrets stand on this Mac: set or not, never a value (see secrets.js).
    const kept = shown.implementation?.secrets?.length ? secrets.statusOf(id, shown.implementation).map((one) => ({ name: one.name, set: one.set, ...(one.random ? { random: true } : {}), ...(one.shared ? { shared: one.shared.name } : {}) })) : null;
    return { ...shown, icon: itemIcons.get(id)?.icon ?? null, ...(workspace ? { workspace } : {}), ...(kept ? { secrets: kept } : {}) };
  },
  // The AI having random values made for secrets that can be random (generate_secrets): which were
  // made, never the values; those set are left alone (only the user replaces a value).
  async generateSecrets(id, { names = null, proposal = false } = {}) {
    const record = proposal ? await store.getProposal(id) : await store.getSchema(id);
    if (!record) throw new Error(proposal ? 'There\'s no proposal waiting on that schematic.' : 'There\'s no schematic with that id.');
    const all = secrets.statusOf(id, record.implementation);
    if (!all.length) throw new Error(`${record.name}'s implementation lists no secrets.`);
    const unknown = (names ?? []).filter((name) => !all.some((one) => one.name === name));
    if (unknown.length) throw new Error(`${record.name} has no secret called ${unknown.join(' or ')}. Its secrets: ${all.map((one) => one.name).join(', ')}.`);
    const asked = names ? all.filter((one) => names.includes(one.name)) : all.filter((one) => !one.set && one.random);
    const made = [];
    const alreadySet = [];
    const notRandom = [];
    for (const one of asked) {
      if (one.set) alreadySet.push(one.name);
      else if (!one.random) notRandom.push(one.name);
      else {
        secrets.generate(id, one);
        made.push(one.name);
      }
    }
    if (made.length) {
      const ctx = session.ctx;
      const text = `Your AI made random ${made.length === 1 ? 'a value' : 'values'} for ${made.join(', ')}`;
      if (tabAlive(ctx)) desktop.note(ctx.id, { text, detail: `${text}, secrets of “${record.name}”` });
    }
    const missing = secrets.statusOf(id, record.implementation).filter((one) => !one.set).map((one) => one.name);
    return {
      made, ...(alreadySet.length ? { already_set: alreadySet } : {}), ...(notRandom.length ? { not_random: notRandom } : {}),
      still_missing: missing,
      message: missing.length ? `Still not set: ${missing.join(', ')}. Only the user can enter ${missing.length === 1 ? 'it' : 'them'}, in Test mode under Implementation › Secrets, or have it use a shared secret there: ask them to.` : 'Every secret is set, so its checks can be run.',
    };
  },
  // The AI asking to start a workspace again (start_workspace_again): the user is asked first, in
  // the window it works in, or the one last used.
  async startWorkspaceAgain(id) {
    const ctx = session.ctx;
    const result = await startWorkspaceAgain(tabAlive(ctx) ? ctx : lastFocused, id, { by: 'ai' });
    if (result.started_again && tabAlive(ctx)) desktop.note(ctx.id, { text: 'Your AI started the workspace again', detail: 'Your AI started the workspace again: its old folder is in the Bin' });
    return result;
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
  testResults: (id, options) => testRuns.resultsFor(id, options),
  listTestRuns: (id, options) => testRuns.listFor(id, options),
  decisionLog: (id, options) => store.decisions(id, options),
  discardedProposal: (id, proposalId) => store.discardedProposal(id, proposalId),
  // The AI running the checks (run_checks); once the run ends, a line in the chat saying how it went.
  runChecks: (id, options) => testRuns.runAndWait(id, { ...options, onEnd: (state, record) => {
    const ctx = session.ctx;
    if (tabAlive(ctx)) desktop.note(ctx.id, runNote(state, record));
  } }),
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
    const made = await store.propose({ ...rest, by: clientLabel(session.client) });
    sessions.claim(session, schemaClaim(made.schema));
    if (icon && !itemIcons.get(made.schema)) itemIcons.set(made.schema, icon, 'ai');
    // In the AI's tab (on home, it goes there, as a browser tab goes to a page).
    const request = { schemaId: made.schema, name: proposal.name ?? '' };
    const ctx = await tab();
    ctx.contents.send('show-schema', request);
    // (A guest tab's window is another app's.)
    if (ctx.win && !ctx.win.isVisible()) ctx.win.showInactive();
    return {
      ...made,
      status: 'waiting_for_user',
      wait: waitCommand('proposal', '--id', made.proposal),
      message: 'Nothing has changed yet. Tell the user straight away to switch to the SmartSpec app and accept or discard this: only they can. To hear their answer, run the wait command in the background if you can, or call get_schematic later. The wait also ends if the user sends you their comments to deal with first: answer them, revise if they need it, and wait again.'
        + (made.usedBy ? ` Once accepted, this also changes what embeds it following its latest draft (usedBy).${made.usedBy.some((one) => one.undeclared) ? ' Some of those uses set parameters this no longer declares (undeclared): tell the user, and offer to propose the changes to those schematics.' : ''}${made.usedBy.some((one) => one.breaks) ? ' Some of them link to clauses or shapes of the contract this removes or whose promise it changes (breaks): tell the user, and offer to propose the changes to those schematics.' : ''}` : ''),
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
  const { response } = await messageBox(ctx, {
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
  const { response } = await messageBox(ctx, {
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
// As the app quits, an AI waiting on the user (`wait`) is told, and whether it's restarting to
// install an update, so it carries on once the app is back rather than thinking it's gone.
app.on('before-quit', () => {
  mcp?.endWaits(updates.restarting);
  testRuns.stopAll();
});

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

store.events.on('changed', () => broadcast('schemas-changed'));

// Running a schematic's contract checks (see test-runs.js): the runner, carried in the app's
// resources as the smartspec command is (packages/runner while developing), run with the app's own
// Node; each run's progress and results sent to every window.
// Each schematic's workspace on this Mac, a clone of its code to work on (see workspaces.js).
const workspaces = createWorkspaces(app.getPath('userData'));
// The values of schematics' secrets, kept on this Mac, encrypted with a key in its Keychain (see
// secrets.js); each window told when a schematic's change.
const secrets = createSecrets(app.getPath('userData'), {
  cipher: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  },
  onChange: (schemaId) => broadcast('secrets-changed', schemaId),
  onShared: () => broadcast('shared-secrets-changed'),
});
const testRuns = createTestRuns({
  dir: path.join(app.getPath('userData'), 'test-results'),
  workspaces,
  secrets,
  runner: {
    command: process.execPath,
    args: [path.join(app.isPackaged ? path.join(process.resourcesPath, 'runner') : fileURLToPath(new URL('../../../runner', import.meta.url)), 'cli.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
  store,
  onChange: (schemaId, run) => broadcast('test-run', { schemaId, run }),
  // A branch moved on since its checks passed: home and what embeds it say so.
  onStatus: (schemaId) => broadcast('test-status', schemaId),
});
// Each schematic's status (on home, in what embeds it, and to the AI) is what its runs show.
store.setStatusOf((schemaId, version, record) => testRuns.statusOf(schemaId, version, record));
// And how what a schematic relies on from one it embeds stands against that one's code.
store.setExpectationsOf((schemaId, version, record, ownerId, use) => testRuns.expectationsOf(schemaId, version, record, ownerId, use));
store.events.on('changed', (schemaId) => testRuns.changed(schemaId));
handle('test-run', (_ctx, schemaId, version, options) => testRuns.start(schemaId, version, { ...options, by: 'user' }));
handle('test-stop', (_ctx, schemaId, runId) => testRuns.stop(schemaId, runId));
handle('test-state', (_ctx, schemaId) => testRuns.stateOf(schemaId));
handle('test-branches', (_ctx, schemaId, version) => testRuns.branchesOf(schemaId, version));
// A schematic's secrets on this Mac (see secrets.js): how each of a draft's or the proposal's
// (`version`) stands, and the user entering, generating or clearing one. Values only ever come in.
const secretRecord = async (schemaId, version) => (version === 'proposal' ? store.getProposal(schemaId) : store.getSchema(schemaId, { draftId: version }));
handle('secrets', async (_ctx, schemaId, version) => secrets.statusOf(schemaId, (await secretRecord(schemaId, version))?.implementation).map(({ name, description, env, files, random, set, by, at, shared }) => ({ name, description, env, files, random: Boolean(random), set, by, at, shared })));
handle('secret-set', (_ctx, schemaId, name, value) => secrets.set(schemaId, name, value));
handle('secret-generate', async (_ctx, schemaId, version, name) => {
  const secret = secrets.statusOf(schemaId, (await secretRecord(schemaId, version))?.implementation).find((one) => one.name === name);
  if (!secret) throw new Error(`There's no secret called ${name}.`);
  secrets.generate(schemaId, secret);
});
handle('secret-clear', (_ctx, schemaId, name) => secrets.clear(schemaId, name));
handle('secret-use-shared', (_ctx, schemaId, name, sharedId) => secrets.useShared(schemaId, name, sharedId));
handle('secret-share', (_ctx, schemaId, name, sharedName) => secrets.shareOwn(schemaId, name, sharedName));
// Shared secrets (Settings › Shared Secrets): one value, named, used by several schematics' secrets.
// Each with the schematics using it, by name; never a value.
handle('shared-secrets', async () => {
  const names = new Map((await store.list()).map((one) => [one.id, one.name]));
  return secrets.sharedList().map((one) => ({ ...one, usedBy: one.usedBy.map((use) => ({ ...use, schematic: names.get(use.schemaId) ?? 'A deleted schematic' })) }));
});
handle('shared-secret-create', (_ctx, { name, value = null, random = false }) => secrets.createShared({ name, value, random: random ? {} : null }));
handle('shared-secret-set', (_ctx, sharedId, value) => secrets.setShared(sharedId, value));
handle('shared-secret-generate', (_ctx, sharedId) => secrets.generateShared(sharedId));
handle('shared-secret-rename', (_ctx, sharedId, name) => secrets.renameShared(sharedId, name));
// Deleting one: asked first while schematics use it, naming them, as they'd be left not set.
handle('shared-secret-delete', async (ctx, sharedId) => {
  const one = secrets.sharedList().find((each) => each.id === sharedId);
  if (!one) return false;
  if (one.usedBy.length) {
    const names = new Map((await store.list()).map((each) => [each.id, each.name]));
    const choice = await confirmSheet(ctx, {
      title: `Delete the shared secret “${one.name}”?`,
      message: `Its value goes, and ${one.usedBy.length === 1 ? 'the secret using it is' : `the ${one.usedBy.length} secrets using it are`} left not set, until you enter a value or pick another shared secret:`,
      points: one.usedBy.map((use) => `${use.name}, in “${names.get(use.schemaId) ?? 'a deleted schematic'}”`),
      buttons: [{ label: 'Cancel', choice: 'cancel' }, { label: 'Delete', choice: 'delete', kind: 'primary' }],
    });
    if (choice !== 'delete') return false;
  }
  secrets.deleteShared(sharedId);
  return true;
});
// A schematic's workspace: where it is and how it stands, and showing it in the Finder (made
// first if its first run hasn't cloned it yet, so there's somewhere to show).
handle('workspace', async (_ctx, schemaId, name) => workspaces.info(schemaId, name));
handle('workspace-start-again', async (ctx, schemaId) => startWorkspaceAgain(ctx, schemaId));
handle('workspace-show', async (_ctx, schemaId, name) => {
  const { dir, cloned } = await workspaces.info(schemaId, name);
  if (cloned) shell.showItemInFolder(dir);
  else {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  }
});

// Starting a schematic's workspace again (the user's Start Again…, or the AI's
// start_workspace_again): asked first, naming what would go with it (uncommitted changes, commits
// on no remote), then its folder moved to the Bin, and the next run clones it afresh. Refused while
// its checks run. Asked over `ctx`'s window. { started_again, message }.
async function startWorkspaceAgain(ctx, schemaId, { by = 'user' } = {}) {
  const record = await store.getSchema(schemaId);
  if (!record) throw new Error('There\'s no schematic with that id.');
  if (!record.implementation || !WORKSPACE_KINDS.includes(record.implementation.source.kind)) throw new Error(`${record.name}'s code isn't a git repository, so it has no workspace.`);
  if (testRuns.stateOf(schemaId).some((run) => run.running)) throw new Error(`${record.name}'s checks are running: start the workspace again once they've finished.`);
  const info = await workspaces.info(schemaId, record.name);
  if (!info.cloned && !fs.existsSync(info.dir)) return { started_again: false, message: 'It hasn\'t been cloned yet: its next run clones it.' };
  const lost = [
    info.changes && `${info.changes} ${info.changes === 1 ? 'file' : 'files'} changed and not committed`,
    info.unpushed && `${info.unpushed} ${info.unpushed === 1 ? 'commit' : 'commits'} not pushed`,
  ].filter(Boolean);
  const choice = await confirmSheet(ctx, {
    title: `Start the workspace of “${record.name}” again?`,
    message: `${by === 'ai' ? 'Your AI asks to start it again. ' : ''}Its folder, ${info.label}, goes to the Bin, and the next run clones the repository afresh.`,
    points: lost.length ? lost : null,
    after: lost.length ? 'These go with it, kept in the Bin until it’s emptied.' : null,
    buttons: [{ label: 'Cancel', choice: 'cancel' }, { label: 'Move to Bin', choice: 'trash', kind: 'primary' }],
  });
  if (choice !== 'trash') return { started_again: false, message: 'The user chose not to start it again.' };
  await workspaces.startAgain(schemaId, record.name, (dir) => shell.trashItem(dir));
  broadcast('workspace-changed', schemaId);
  return { started_again: true, message: `Its folder went to the Bin. The next run clones the repository into ${info.dir} afresh.` };
}

// Asks first when there's no way back: the AI would have to write the proposal again.
async function discardProposal(ctx, schemaId) {
  const proposal = await store.getProposal(schemaId);
  if (!proposal) return;
  const { response } = await messageBox(ctx, {
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
  const draftLine = proposal.total ? `They become draft ${proposal.total + 1} of ${proposal.name}.` : `It becomes ${proposal.name}’s first draft.`;
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
  const keys = [...Object.keys(changes.items), ...changes.removed.map((one) => one.id), ...(changes.contract ? ['contract'] : []), ...(changes.implementation ? ['@implementation'] : [])];
  const unapproved = keys.filter((key) => !proposal.approved?.includes(key));
  const titleOf = (key) => (key === 'contract' ? 'the contract' : key === '@implementation' ? 'the implementation' : proposal.items.find((item) => item.id === key)?.title ?? changes.removed.find((one) => one.id === key)?.title ?? key);
  const named = unapproved.slice(0, MOST_LISTED).map((key) => `“${titleOf(key)}”`.replace('“the contract”', 'the contract').replace('“the implementation”', 'the implementation'));
  if (unapproved.length > MOST_LISTED) named.push(`${unapproved.length - MOST_LISTED} more`);
  const list = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
  // What embeds it following its latest draft changes with it (uses follow the latest unless
  // pinned), so accepting says so, and where a parameter a use sets would no longer be declared.
  const usedBy = proposal.usedBy ?? [];
  const followers = usedBy.slice(0, MOST_LISTED).map((one) => `“${one.name}”`);
  if (usedBy.length > MOST_LISTED) followers.push(`${usedBy.length - MOST_LISTED} more`);
  const unset = usedBy.filter((one) => one.undeclared).map((one) => `“${one.name}” sets ${list(one.undeclared.map((name) => `“${name}”`))}, which this no longer declares.`);
  // What a follower relies on in the contract (it links to those clauses and shapes) that this removes or changes.
  for (const one of usedBy.filter((follower) => follower.breaks)) {
    const removed = one.breaks.filter((broken) => broken.change === 'removed').map((broken) => `“${broken.part}”`);
    const changed = one.breaks.filter((broken) => broken.change === 'changed').map((broken) => `“${contractPartName(proposal.contract, broken.part)}”`);
    unset.push(`“${one.name}” relies on ${[removed.length && `${list(removed)}, which this removes`, changed.length && `${list(changed)}, which this changes`].filter(Boolean).join(', and ')}.`);
  }
  const alsoChanges = !usedBy.length ? ''
    : ` ${list(followers)} ${usedBy.length === 1 ? 'embeds' : 'embed'} its latest draft, so ${usedBy.length === 1 ? 'it changes' : 'they change'} with it.${unset.length ? ` ${unset.join(' ')}` : ''}`;
  const becomes = `${draftLine}${alsoChanges}`;
  const notApproved = !unapproved.length ? ''
    : unapproved.length === keys.length ? `You haven’t approved ${keys.length === 1 ? 'the change' : `any of the ${keys.length} changes`}: ${unapproved.length === 1 ? 'it is' : 'they are'} accepted as proposed. `
      : `You haven’t approved ${unapproved.length === 1 ? 'the change to' : `${unapproved.length} of the ${keys.length} changes:`} ${list(named)}${unapproved.length === 1 ? ', which is' : ', which are'} accepted as proposed. `;
  // How its checks stand: said, never in the way (the user's choice: a contract can be written
  // ahead of its code, so failing checks don't stop it being accepted).
  const standing = await testRuns.proposalStanding(schemaId).catch(() => ({ state: 'none' }));
  const checks = {
    none: '',
    'not-run': `Its checks haven’t been run on this proposal. `,
    running: `Its checks are running now, against ${standing.code}. `,
    'didnt-run': `Its checks couldn’t be run against ${standing.code}${standing.detail ? `: ${standing.detail.replace(/\.$/, '')}` : ''}. `,
    failing: `${[standing.failed && `${standing.failed} of its ${standing.total} checks fail`, standing.unchecked && `${standing.unchecked} couldn’t be run`, standing.missing && `${standing.missing} haven’t been run`].filter(Boolean).join(', ')} against ${standing.code}. `.replace(/^./, (one) => one.toUpperCase()),
    passing: `All ${standing.total} of its checks pass against ${standing.code}. `,
  }[standing.state] ?? '';
  // What the schematics depending on it rely on, run against the same code (see auto in
  // test-runs.js): those it breaks named, with what of theirs fails.
  const dependents = (standing.dependents ?? []).map((one) => (
    one.running ? `“${one.name}” relies on it: its checks are still running. `
      : one.failed || one.unchecked ? [
        one.broken.length && `It breaks what “${one.name}” relies on: ${list(one.broken.map((title) => `“${title}”`))} ${one.broken.length === 1 ? 'fails' : 'fail'}. `,
        one.already.length && `${one.broken.length ? '' : `“${one.name}” relies on it: `}${list(one.already.map((title) => `“${title}”`))} already failed before this change. `,
      ].filter(Boolean).join('')
        : one.notRun ? `“${one.name}” relies on it, and some of what it relies on hasn’t been run. `
          : `Everything “${one.name}” relies on from it passes. `)).join('');
  const checksLine = `${checks}${dependents}`;
  const warned = ['not-run', 'running', 'didnt-run', 'failing'].includes(standing.state) || (standing.dependents ?? []).some((one) => one.status !== 'passing');
  const question = !waiting
    ? { title: `Accept ${what}?`, message: `${checksLine}${notApproved}${becomes}`, buttons: [{ label: 'Cancel', choice: 'cancel' }, { label: warned ? 'Accept anyway' : 'Accept', choice: 'accept', kind: 'primary' }] }
    : sent === waiting
      // Sent to an AI in another app, which may be at work on them, or may have stopped.
      ? {
        title: `Accept ${what}?`,
        message: `The AI hasn’t answered the ${many(sent)} you sent it yet. If it isn’t working on ${sent === 1 ? 'it' : 'them'}, ask the AI here.`,
        points: quoted,
        after: `${checksLine}${notApproved}${becomes}`,
        buttons: [{ label: 'Accept anyway', choice: 'accept', apart: true }, ask, { label: 'Keep waiting', choice: 'cancel', kind: 'primary' }],
      }
      : aiWaits
        ? {
          title: `Accept ${what}?`,
          message: `You have ${many(waiting)} the AI hasn’t answered. Send ${waiting === 1 ? 'it' : 'them'} to the AI, to deal with before you accept?`,
          points: quoted,
          after: `${checksLine}${notApproved}${alsoChanges}`.trim() || null,
          buttons: [{ label: 'Cancel', choice: 'cancel', apart: true }, { label: 'Accept anyway', choice: 'accept' }, { label: 'Send to AI', choice: 'send', kind: 'primary' }],
        }
        // No AI in another app is waiting to be sent them: the chat's AI is asked.
        : {
          title: `Accept ${what}?`,
          message: `You have ${many(waiting)} the AI hasn’t answered.`,
          points: quoted,
          after: `${checksLine}${notApproved}${becomes}`,
          buttons: [{ label: 'Accept anyway', choice: 'accept', apart: true }, { label: 'Cancel', choice: 'cancel' }, { ...ask, kind: 'primary' }],
        };
  const choice = await confirmSheet(ctx, question);
  if (choice === 'send') {
    await store.sendComments(schemaId);
    return 'sent';
  }
  if (choice === 'ask') return 'ask';
  if (choice !== 'accept') return 'cancel';
  // What it warned of that the user accepted anyway goes in the decision log.
  const warning = [warned && checksLine.trim(), unset.length && unset.join(' ')].filter(Boolean).join(' ') || null;
  await store.accept(schemaId, { warning });
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
    const { response } = await messageBox(ctx, {
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
  const { response } = await messageBox(ctx, {
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
handle('home-menu', (ctx, items) => popupMenu(ctx, Array.isArray(items) ? items : []));
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
handle('approve-change', (_ctx, id, key, flag) => store.approveChange(id, key, flag));
handle('decision-log', (_ctx, id) => store.decisions(id));
handle('discarded-proposal', (_ctx, id, proposalId) => store.discardedProposal(id, proposalId));
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
handle('install-update', () => {
  // The waits are told before the windows close (macOS quits the app only once they have).
  if (updates.status.state === 'ready') mcp?.endWaits(true);
  return updates.install();
});
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
// The top bar's requests (choosing, closing and dragging tabs, back and forward, the status pill,
// going home), the family's (@smartdesktop/ui's main/tabs.js).
tabs.handlers(handle);
// The user's choice of a schematic's icon, which the AI never replaces.
handle('set-icon', (_ctx, schemaId, icon) => itemIcons.set(schemaId, icon, 'user'));
// A schematic opened in a new tab (see openInTab): from home (`request`: { path, layout }), or a
// schematic embedded in the one showing, from its card's Open in New Tab (`request`: { path } with
// that schematic alone). Nothing else moves with it (an AI working in this tab stays here).
handle('open-in-tab', (ctx, request) => {
  if (!request?.path?.[0]?.schemaId || !ctx?.host) return null;
  openInTab(ctx, request);
  return null;
});
handle('open-schematic-tab', (ctx, request) => {
  if (!request?.path?.[0]?.schemaId || !ctx?.host) return null;
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
  app.setAboutPanelOptions({ credits: 'SmartSpec is in beta, so it may change significantly from one version to the next.' });
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
