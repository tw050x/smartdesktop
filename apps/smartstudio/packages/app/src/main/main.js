import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeStretch } from './analysis.js';
import { createComfy } from './comfy.js';
import { createDesktop } from './desktop.js';
import { guessIcon, isIcon } from '@smartdesktop/ui/main/icons.js';
import { createItemIcons } from './item-icons.js';
import { createTabs } from '@smartdesktop/ui/main/tabs.js';
import { createFamily, familyFolder } from '@smartdesktop/ui/main/family.js';
import { API } from './api.js';
import { createConnect } from './connect.js';
import { MCP_PORT, portHolder, startMcpServer } from './mcp-server.js';
import { clientLabel, createSessions } from './sessions.js';
import { buildMenu } from './menu.js';
import { createGenerator } from './generator.js';
import { createStore, stretch } from './store.js';
import { createUpdates } from './updates.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_MS = 15 * 1000;
const TOP_BAR_HEIGHT = 44;
// Height of the area macOS reserves for the traffic lights (the circles sit centred in it).
const TRAFFIC_LIGHTS_HEIGHT = 16;

// A development copy keeps its data in a folder of its own, SmartStudio Dev (and its MCP server on a
// port of its own, see mcp-server.js), so it never reads or overwrites the installed app's data,
// and the two can run side by side: the app allows one copy per data folder. Automated tests
// point it at a separate folder again (SMARTSTUDIO_USER_DATA) and port (SMARTSTUDIO_PORT), so a test
// copy can run beside both. Set before the app is ready so Chromium's own storage moves too. The
// packaged app ignores both.
if (!app.isPackaged) {
  app.setPath('userData', process.env.SMARTSTUDIO_USER_DATA ? path.resolve(process.env.SMARTSTUDIO_USER_DATA) : path.join(app.getPath('appData'), 'SmartStudio Dev'));
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
const WINDOW_TITLE = app.isPackaged ? 'SmartStudio' : 'SmartStudio Development';

const windows = new Map(); // a tab's webContents id → its tab: { id, host, home, view, contents, win, ready, session, untouched, where, name }
let lastFocused = null;
let mcp = null; // { url, token } once the MCP server is listening
let mcpStarting = true;
let mcpProblem = null; // why it isn't running: { reason: 'port-in-use', port, holder } or { reason: 'error', message }
let lastMcpStatus = null;
let mcpRetry = null;
const MCP_RETRY_MS = 5000; // while the port is taken, how often to try again, so it starts once it's free
// The projects and their takes (see store.js).
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

// --- The generation server ---------------------------------------------------------------
// ComfyUI on the user's GPU machine (see comfy.js), at the address in Settings, kept in
// settings.json. Takes are sent there and followed (generator.js); how far along each is goes to
// every window as it changes (`take-progress`), and the server's state to Settings and the tabs
// (`server-check`).
const DEFAULT_SERVER = 'http://secondary.gx10:8188';
const serverUrl = () => readSettings().server ?? DEFAULT_SERVER;
function setServerUrl(value) {
  const said = String(value ?? '').trim().replace(/\/+$/, '');
  if (said && !/^https?:\/\/[^\s/]+(:\d+)?(\/.*)?$/i.test(said)) throw new Error('The address is a web address, such as http://secondary.gx10:8188.');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), server: said }, null, 2));
  progressWatch?.restart();
  return checkServer();
}
const comfy = createComfy({ url: serverUrl, clientId: `smartstudio-${randomUUID().slice(0, 8)}` });
const generator = createGenerator({
  store,
  comfy,
  onProgress: (progress) => broadcast('take-progress', progress),
});
let progressWatch = null;
let serverState = { reachable: false, checking: true, url: serverUrl() };
// Asks the server how it is: reachable, and which kinds it can make (each needs its models there).
async function checkServer() {
  try {
    serverState = await comfy.status();
  } catch (error) {
    serverState = { reachable: false, url: serverUrl(), error: error.message };
  }
  broadcast('server-check', serverState);
  return serverState;
}

// --- Stretches of takes ------------------------------------------------------------------
// A take's tab shows it on a timeline (studio.js), where the user selects a stretch of it and notes
// stretches. What's selected is the tab's (`ctx.selection`: { projectId, takeId, start, end, frames,
// at }, frames being a clip's pictures, taken in the page), for the AI to read (get_selection), and
// how loud each take is over time (store.js's levels, measured in the page) says how it sounds
// (analysis.js). Part of a song can be made again (remakePart), the rest kept.
const SELECTION_FRESH_MS = 30 * 60 * 1000; // a selection in another tab counts for this long

const overlaps = (note, start, end) => note.start < end && note.end > start;
async function stretchOf(projectId, takeId, { start, end } = {}) {
  const project = await store.get(projectId);
  const take = project.takes.find((one) => one.id === takeId);
  if (!take) throw new Error(`No take ${takeId} in this project. get_project lists its takes.`);
  if (take.status !== 'done') throw new Error(`Take ${takeId} isn't finished, so there's nothing to hear in it yet.`);
  const span = stretch(start ?? 0, end ?? take.seconds, take.seconds);
  const levels = await store.levels(projectId, takeId);
  return {
    project: { id: project.id, name: project.name },
    take: { id: take.id, kind: take.kind, prompt: take.prompt, lyrics: take.lyrics, seconds: take.seconds, seed: take.seed, from: take.from },
    ...span,
    notes: take.notes.filter((note) => overlaps(note, span.start, span.end)),
    sound: analyzeStretch(levels, { ...span, seconds: take.seconds }),
    ...(levels ? {} : { soundNote: 'This take hasn\'t been measured yet: the app measures each take as its tab shows it.' }),
  };
}

// The selection an AI's window has, or failing that the one the user made last in any tab, lately.
function selectionFor(ctx) {
  if (ctx?.selection) return ctx.selection;
  const recent = [...windows.values()].map((one) => one.selection).filter((one) => one && Date.now() - one.at < SELECTION_FRESH_MS);
  return recent.sort((a, b) => b.at - a.at)[0] ?? null;
}

// A stretch of a song made again: a new take, the rest of the song kept (see workflows.js's
// repaintGraph). Without a prompt or lyrics, the song's own, and its plan.
async function remakePart(projectId, takeId, { start, end, prompt, lyrics, seed } = {}, by = 'user') {
  const source = (await store.get(projectId)).takes.find((one) => one.id === takeId);
  if (!source) throw new Error(`No take ${takeId} in this project.`);
  if (source.kind !== 'music') throw new Error('Only music can have part of it made again, so far: generate a new clip instead.');
  if (source.status !== 'done') throw new Error(`Take ${takeId} isn't finished yet.`);
  const feature = serverState.features?.repaint;
  if (feature && !feature.ready) throw new Error(`The generation server can't make part of a song again yet: it needs SmartStudio's own nodes (${feature.missing.join(', ') || 'music models'}). Install them with scripts/install-comfy-nodes.sh in SmartStudio's repository.`);
  return generator.generate(projectId, {
    kind: 'music',
    prompt: prompt ?? source.prompt,
    lyrics: lyrics ?? source.lyrics,
    seconds: source.seconds,
    seed,
    planSeed: source.planSeed,
    from: { take: source.id, start, end },
    by,
  });
}

// A take's file, for its player in the page: studio-media://take/<project id>/<file>, from the
// project's media folder only (store.mediaPath takes nothing else). Registered before the app is
// ready, as a scheme the page's players can stream (and seek in) from.
protocol.registerSchemesAsPrivileged([{ scheme: 'studio-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
function serveMedia() {
  protocol.handle('studio-media', async (request) => {
    try {
      const { host, pathname } = new URL(request.url);
      const [projectId, file] = pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (host !== 'take' || !projectId || !file) return new Response('Not found', { status: 404 });
      // The page fetches it too (from file://), to measure it and take a clip's frames.
      const res = await net.fetch(pathToFileURL(store.mediaPath(projectId, file)).toString(), { headers: request.headers });
      const headers = new Headers(res.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
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

// --- Windows and their tabs ------------------------------------------------------------------
// The family's windows of tabs (@smartdesktop/ui's main/tabs.js): Home first, pinned, and each other
// tab showing one project, opened from Home (or an AI's takes there) in a tab, the one already
// showing it if there is one. The window says where each tab is as it moves (`chat-shows`: `where`,
// and the project's `name`). What's SmartStudio's own is given here.
const hosts = new Set(); // { win, tabs: [home, …], active }
const tabs = createTabs({
  id: 'smartstudio',
  title: WINDOW_TITLE,
  // The pages' API as data (api.js), which the family's preload builds `window.smartstudio` from.
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
  docOf: (ctx) => projectOf(ctx),
  // The AI gets a new tab, the next time it needs one.
  release: (ctx) => {
    if (ctx.session) ctx.session.ctx = null;
  },
  // Guest tabs: a project's tab can be shown in another app's window (SmartDesktop's, say), opening
  // the same project there (its takes played from the guest server); and SmartStudio's windows show
  // other apps' tabs.
  name: 'SmartStudio',
  family: createFamily(familyFolder(app)),
  guestOpen: (ctx) => (projectOf(ctx) ? { projectId: projectOf(ctx), name: ctx.name } : null),
  guestOpened: (ctx, request) => ctx.contents.send('open-project', request),
  // With SmartDesktop running, SmartStudio has no windows of its own: its tabs are in SmartDesktop's
  // (the user's choice, 2026-11-26), and it has no Dock icon.
  windowless: true,
});
// A menu or a question over a tab's window (in a guest tab, the window showing it shows them).
const { popupMenu, messageBox, createWindow, createTab, newTab, activateTab, closeTab, moveTab, sendTabs, sendAllTabs, stepTab, openChatFor, strips } = tabs;

// Where a tab is: 'home', or the id of the project it shows, as the tab says (chat-shows).
const projectOf = (ctx) => (ctx.where && ctx.where !== 'home' ? ctx.where : null);
// The tab showing a project (in the window of `host`) that no chat owns, if one does.
const tabsShowing = (projectId) => [...windows.values()].filter((t) => !t.home && projectOf(t) === projectId);

// A project opened in a new tab (the user asked for one: a project opened from home otherwise opens
// in the tab showing home, as a browser's page does), with what to open there (`request`: {
// projectId, name }), beside the tab it came from.
async function openInTab(from, request) {
  const { host } = from;
  const tab = createTab(host, { after: from });
  await tab.ready;
  tab.contents.send('open-project', request);
  activateTab(tab);
  return tab;
}

// Each project's icon, set by the user or the AI (see item-icons.js), on its tab and on home: its
// own, or the guess from its name.
const FALLBACK_ICON = 'music';
const itemIcons = createItemIcons(app.getPath('userData'), {
  onChange: () => {
    sendAllTabs();
    broadcast('projects-changed');
  },
});
const iconOfProject = (id, name) => {
  const own = itemIcons.get(id)?.icon;
  return isIcon(own) ? own : guessIcon(name, FALLBACK_ICON);
};
const tabIcon = (ctx) => (projectOf(ctx) ? iconOfProject(projectOf(ctx), ctx.name) : FALLBACK_ICON);
const withIcons = (list) => list.map((one) => ({ ...one, icon: iconOfProject(one.id, one.name) }));

// A tab's name in the top bar (each project's by its name and icon, with the AI working in it).
function tabTitle(ctx) {
  if (ctx.home) return 'Home';
  if (ctx.name) return ctx.name;
  return ctx.session ? `${clientLabel(ctx.session.client)} is opening a project…` : 'Opening…';
}
// The app's status, for the pill at the end of the top bar (see server-status.js for the panel it
// opens): the server's, and once it's running, whether SmartDesktop, which runs the chat, is there.
function appStatus() {
  const server = mcpStatus();
  const state = server.state !== 'running' ? server.state : desktop.status === 'missing' ? 'setup' : 'running';
  const label = { starting: 'Starting…', running: 'Ready', setup: 'Get SmartDesktop', off: 'Not running' }[state];
  const title = server.state === 'off' && server.reason === 'port-in-use'
    ? (server.holder?.kind === 'smartstudio' ? 'Another copy of SmartStudio is running the server' : 'SmartStudio’s server port is in use by another app')
    : { starting: 'SmartStudio is starting', running: 'SmartStudio is ready to work with your AI', setup: 'SmartStudio’s server is running, but SmartDesktop, which runs the AI chat, isn’t installed', off: 'SmartStudio’s server isn’t running' }[state];
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
      // A new project, empty, named after the first take asked for in it: in the tab on home, else
      // in a new tab.
      newProject: async () => {
        const ctx = lastFocused ?? createWindow();
        await ctx.ready;
        const made = await store.create({});
        const request = { projectId: made.project, name: made.name };
        if (ctx.home) {
          ctx.contents.send('open-project', request);
          activateTab(ctx);
        } else openInTab(ctx, request);
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
// alone. The one exception is the window SmartStudio opened on launch, when the AI's launcher is what
// started it. The tab is opened only once there's something for the user to see (a project made, or
// a take asked for), and a tab closed is opened again the next time there is.

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
    if (strict) throw new Error(`${clientLabel(ctx.session.client)} is working in this SmartStudio window. Tell the user: they can release it from the status pill's panel.`);
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
    if (!ctx.home && !ctx.hadProject) closeTab(ctx);
  }
}

// An AI session's tab, opened when it first has something to show: in the window last used (or a
// new window), behind the one showing unless the AI started SmartStudio or is a chat's (the user is
// working with it).
async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  // Its tab goes in SmartDesktop's window: started if the app runs on with it gone (an agent's MCP
  // server stays up whether SmartDesktop is running or not).
  await tabs.ensureSmartDesktop();
  // The window SmartStudio opened as it started, if the AI started it: its tab on home, untouched.
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
  if (!ctx) throw new Error(`There's no SmartStudio window ${windowId} open now. Carry on without it: SmartStudio opens a tab of your own when you make something.`);
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

// The projects as an AI session may use them. What it makes shows in its own tab, which is opened
// only when there's something for the user to see (a project made, or a take asked for): reading
// needs none, and a tab opened for it waited for what might never come, which looked frozen (the
// user found it so in SmartDoc and SmartSpec). `tab()` opens it (windowForSession). A project not
// named is the one the session's tab shows.
const projectsFor = (session, tab) => {
  const projectHere = (projectId) => {
    const id = projectId ?? (session.ctx && projectOf(session.ctx));
    if (!id) throw new Error('This window shows no project. Name the project with project_id (list_projects shows them).');
    return id;
  };
  const nameOf = async (id) => (await store.list()).find((one) => one.id === id)?.name ?? '';
  // Shows the project to the user, once there's something in it for them: in the session's tab, a
  // tab showing it already (the user's own, which the session then takes, rather than opening
  // another, if no other AI works there), or a tab of its own.
  async function show(projectId) {
    const request = { projectId, name: await nameOf(projectId) };
    if (session.ctx && projectOf(session.ctx) === projectId) return session.ctx;
    if (!session.ctx) {
      const theirs = tabsShowing(projectId).find((t) => !t.chat && (!t.session || !sessions.alive(t.session)));
      if (theirs) {
        if (theirs.session) releaseWindow(theirs.session);
        setSessionWindow(session, theirs);
        return theirs;
      }
    }
    const ctx = await tab();
    ctx.contents.send('open-project', request);
    // (A guest tab's window is another app's.)
    if (ctx.win && !ctx.win.isVisible()) ctx.win.showInactive();
    return ctx;
  }
  const withIcon = (project) => ({ ...project, icon: itemIcons.get(project.id)?.icon ?? null });
  // A take as the AI reads it: how far along it is while it runs, and not the server's job or file.
  const forAi = ({ job, file, ...take }) => ({ ...take, made: Boolean(file), progress: generator.progress(take.id) });
  return {
    list: async () => (await store.list()).map(withIcon),
    async create({ icon, ...project }) {
      const made = await store.create(project);
      // Its icon isn't part of it: it's kept apart, as the AI's.
      if (icon && !itemIcons.get(made.project)) itemIcons.set(made.project, icon, 'ai');
      await show(made.project);
      return { ...made, message: 'The project is open in SmartStudio for the user.' };
    },
    async get(projectId) {
      const project = withIcon(await store.get(projectHere(projectId)));
      return { ...project, takes: project.takes.map(forAi) };
    },
    rename: (projectId, change) => store.rename(projectHere(projectId), change),
    async generate(projectId, fields) {
      const id = projectHere(projectId);
      const take = await generator.generate(id, { ...fields, by: 'ai' });
      await show(id);
      return { take: take.id, kind: take.kind, seconds: take.seconds, seed: take.seed, status: take.status, message: 'Asked for: it shows in the project\'s tab as it\'s made. get_project says how it\'s going.' };
    },
    stop: (projectId, takeId) => generator.cancel(projectHere(projectId), takeId),
    async selection() {
      const chosen = selectionFor(session.ctx);
      if (!chosen) return { selection: null, message: 'Nothing is selected: the user selects a stretch by dragging across a take\'s timeline.' };
      const about = await stretchOf(chosen.projectId, chosen.takeId, chosen).catch((error) => ({ error: error.message }));
      return { selection: about, images: about.take?.kind === 'video' ? chosen.frames ?? [] : [] };
    },
    inspect: (projectId, takeId, span) => stretchOf(projectHere(projectId), takeId, span),
    async remakePart(projectId, takeId, part) {
      const id = projectHere(projectId);
      const take = await remakePart(id, takeId, part, 'ai');
      await show(id);
      return { take: take.id, from: take.from, seed: take.seed, status: take.status, message: 'Asked for: the song with that part made again shows in the project\'s tab as it\'s made. get_project says how it\'s going.' };
    },
    addNote: (projectId, takeId, note) => store.addNote(projectHere(projectId), takeId, { ...note, by: 'ai' }),
    serverStatus: () => checkServer(),
    // A project's icon (set_icon), the one named or the one the window shows: the user's choice is
    // kept over the AI's.
    async setIcon(icon, projectId = null) {
      const id = projectHere(projectId);
      await store.get(id);
      const { icon: shown, kept } = itemIcons.set(id, icon, 'ai');
      return kept ? { icon: shown, note: 'The user chose this project\'s icon, so it stays.' } : { icon: shown };
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
    return run(projectsFor(session, () => windowForSession(session, startedApp)));
  },
};

function sweepSessions() {
  for (const { session } of windows.values()) {
    if (session && !sessions.alive(session)) releaseWindow(session);
  }
  sessions.sweep();
}

// --- Connecting an AI --------------------------------------------------------------------
// AI apps start SmartStudio's MCP launcher, which is inside the app (see connect.js). The MCP panel
// (opened from the status pill, or Connect an AI in the menu) shows how to set up each AI app,
// and can add SmartStudio to Claude Desktop itself.

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
    message: status.state === 'different' ? 'Update SmartStudio in Claude Desktop?' : 'Add SmartStudio to Claude Desktop?',
    detail: 'SmartStudio adds itself to Claude Desktop’s settings file (claude_desktop_config.json), and keeps a copy of the file as it was. Then quit Claude Desktop and open it again to connect.',
    buttons: [status.state === 'different' ? 'Update' : 'Add', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return status;
  return addToClaudeDesktop();
}

// macOS: AI apps start SmartStudio from where it's installed, so a copy run from the disk image or
// Downloads is offered a move to Applications (which opens it again from there).
async function offerMoveToApplications(ctx) {
  if (!app.isPackaged || process.platform !== 'darwin' || app.isInApplicationsFolder()) return;
  const { response } = await messageBox(ctx, {
    type: 'question',
    message: 'Move SmartStudio to your Applications folder?',
    detail: 'Your agent opens SmartStudio from where it’s installed, so it works best in Applications.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox('SmartStudio couldn’t be moved', `${error.message}\n\nDrag SmartStudio into your Applications folder in Finder instead.`);
  }
}

// --- Updates -----------------------------------------------------------------------------

// (Nothing in SmartStudio waits on the user, as the AI's takes go straight into the project, so there's no
// `wait` to tell as the app quits, as SmartSpec's and SmartAd's tell theirs.)
const updates = createUpdates({ report: (status) => broadcast('updates', status) });

// --- The chat, in SmartDesktop (see desktop.js) -----------------------------------------------
// The AI chat is SmartDesktop's, an app of its own, for the family's apps: chat windows over the
// apps' windows, and one conversation across them (the user's choice). SmartStudio tells it about each
// tab (what it shows, when it has the focus, lines of context, the shortcuts to offer), and its AI
// uses SmartStudio's tools through the MCP server, on the tab the user was last in (see aiForServer).

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

// What the tab shows, for the AI: home, or a project (by name and id), with its takes so far and
// any still being made. `where` is as the tab says (see projectOf).
async function chatWhere(where = 'home') {
  if (where === 'home') return 'The window shows SmartStudio\'s home: the user\'s projects. To start a new one, ask the user what they want to make, then create_project.';
  const project = await store.get(where).catch(() => null);
  if (!project) return 'The window shows a project that is no longer there.';
  const count = (kind) => project.takes.filter((take) => take.kind === kind).length;
  const takes = project.takes.length ? `${count('music')} music and ${count('video')} video takes` : 'no takes yet';
  const making = project.takes.filter((take) => take.status === 'queued' || take.status === 'running').length;
  return `The window shows the project “${project.name}” (project_id ${where}), with ${takes}${making ? `, ${making} still being made` : ''}. “This project” means this one; get_project shows its takes.`;
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

store.events.on('changed', (id) => broadcast('projects-changed', id));

// The user deletes a project from home, asked first, as it can't be had back: its takes and their
// files go with it, and the tabs showing it close (each sees it's gone). The AI has no tool for
// this, as in the family's other apps.
async function deleteProject(ctx, projectId) {
  const project = (await store.list()).find((one) => one.id === projectId);
  if (!project) return false;
  const takes = project.takes === 1 ? 'Its take goes' : project.takes ? `Its ${project.takes} takes go` : null;
  const { response } = await messageBox(ctx, {
    type: 'warning',
    message: `Delete “${project.name}”?`,
    detail: `${takes ? `${takes} with it, and their files. ` : ''}This can't be undone.`,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  for (const take of (await store.get(projectId)).takes) {
    if (take.status === 'queued' || take.status === 'running') await generator.cancel(projectId, take.id).catch(() => {});
  }
  await store.delete(projectId);
  return true;
}

// The projects, as the tabs show them (see studio.js): home's list, a project in full, a new one
// (File › New Project, or a first prompt), and a take asked for in the project's tab, stopped,
// seen or shown in Finder. Each take's progress comes as it changes (`take-progress`); its file
// plays from studio-media:// (serveMedia).
handle('list-projects', async () => withIcons(await store.list()));
handle('get-project', async (_ctx, id) => {
  const project = await store.get(id);
  return { ...project, takes: project.takes.map((take) => ({ ...take, progress: generator.progress(take.id) })) };
});
handle('create-project', (_ctx, fields = {}) => store.create(fields));
handle('generate', (_ctx, projectId, fields) => generator.generate(projectId, { ...fields, by: 'user' }));
handle('stop-take', (_ctx, projectId, takeId) => generator.cancel(projectId, takeId));
handle('mark-seen', (_ctx, projectId, takeId) => store.markSeen(projectId, takeId));
handle('show-take-file', async (_ctx, projectId, file) => shell.showItemInFolder(store.mediaPath(projectId, file)));
// Stretches of takes (see remakePart): what the tab has selected (null for nothing), notes on
// stretches, a part of a song made again, and how loud a take is over time, measured in the page.
handle('set-selection', (ctx, selection) => {
  if (!ctx) return;
  ctx.selection = selection?.projectId && selection.takeId
    ? { projectId: String(selection.projectId), takeId: String(selection.takeId), start: Number(selection.start), end: Number(selection.end), frames: Array.isArray(selection.frames) ? selection.frames.slice(0, 8) : [], at: Date.now() }
    : null;
});
handle('add-note', (_ctx, projectId, takeId, note) => store.addNote(projectId, takeId, { ...note, by: 'user' }));
handle('remove-note', (_ctx, projectId, takeId, noteId) => store.removeNote(projectId, takeId, noteId));
handle('remake-part', (_ctx, projectId, takeId, part) => remakePart(projectId, takeId, part, 'user'));
handle('get-levels', (_ctx, projectId, takeId) => store.levels(projectId, takeId));
handle('set-levels', (_ctx, projectId, takeId, levels) => store.setLevels(projectId, takeId, levels));
handle('rename-project', (_ctx, id, name) => store.rename(id, { name }));
handle('delete-project', (ctx, id) => deleteProject(ctx, id));
// The generation server: its address (Settings), and how it is now (asked again with `check`).
handle('get-server', () => ({ url: serverUrl(), state: serverState }));
handle('set-server', (_ctx, url) => setServerUrl(url));
handle('check-server', () => checkServer());
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
handle('chat-shows', async (ctx, where, line, name = null) => {
  // Where the tab is, for its name and icon in the top bar (and to find the tab showing a project).
  ctx.where = where;
  ctx.name = where === 'home' ? null : name;
  if (!ctx.home && where !== 'home') ctx.hadProject = true;
  sendTabs(ctx.host);
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
// The user's choice of a project's icon, which the AI never replaces.
handle('set-icon', (_ctx, projectId, icon) => itemIcons.set(projectId, icon, 'user'));
// A project opened from home in a new tab (see openInTab): `request` is { projectId, name }.
handle('open-in-tab', (ctx, request) => {
  if (!request?.projectId || !ctx) return null;
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
  app.setAboutPanelOptions({ credits: 'SmartStudio is in beta, so it may change significantly from one version to the next.' });
  serveMedia();
  // Its pages served to other apps' windows (SmartDesktop's), each a guest tab of its own here, its
  // calls run by the same handlers, and its takes' files as media (take/<project>/<file>, as
  // studio-media:// serves them here); and other apps' tabs shown in its windows.
  await tabs.serveGuests({
    files: path.join(dirname, '../../build/renderer'),
    run,
    // (A project's id is letters, digits and dashes: nothing else, from a URL, reaches its folder.)
    media: ([kind, projectId, file]) => (kind === 'take' && /^[\w-]+$/.test(projectId ?? '') && file ? store.mediaPath(projectId, file) : null),
  }).catch((error) => console.error('Guest tabs can’t be served:', error.message));
  // Its MCP server first: SmartDesktop is told it as the app says hello (for the chat's AI's tools).
  await startMcp();
  // Its tabs are SmartDesktop's, which it starts if it isn't running; gone from this Mac, it offers to
  // reinstall it (else a window of its own).
  if (!(await tabs.ensureSmartDesktop())) await tabs.offerReinstall();
  const first = createWindow();
  updates.start();
  // The generation server: how it is now and every minute (Settings and the tabs show it), how far
  // along its jobs are, and the takes it was making when the app last quit.
  checkServer();
  setInterval(checkServer, 60_000).unref();
  progressWatch = comfy.watch((progress) => generator.progressed(progress));
  generator.resume();
  await first.ready;
  offerMoveToApplications(first);
  // Opened again (from the Finder, say): its tabs are in SmartDesktop (started if need be), the one
  // last used brought forward, or a new one on home; without SmartDesktop, a window of its own.
  app.on('activate', async () => {
    if ((await tabs.ensureSmartDesktop()) || (await tabs.offerReinstall())) {
      if (!tabs.showTabs()) createWindow();
    } else if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
