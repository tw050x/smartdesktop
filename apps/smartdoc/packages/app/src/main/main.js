import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmReplace } from './confirm-replace.js';
import { createConnect } from './connect.js';
import { MCP_PORT, portHolder, startMcpServer } from './mcp-server.js';
import { PROVIDERS, createAgent } from './agent.js';
import { anchorOf, firstPlace, placeFrom } from './chat-anchor.js';
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
const shared = createShared(app.getPath('userData'));
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

// The window's own colours, which the interface can't set: its background (showing as it opens
// or resizes) and, on Windows and Linux, the title bar's (the top bar's, see styles.css).
const windowColours = () => (nativeTheme.shouldUseDarkColors
  ? { background: '#161618', bar: '#1f1f22', symbols: '#d1d1d6' }
  : { background: '#ebebef', bar: '#dcdce1', symbols: '#3c3c43' });
nativeTheme.on('updated', () => {
  const colours = windowColours();
  for (const { win: browser } of windows.values()) {
    browser.setBackgroundColor(colours.background);
    if (process.platform !== 'darwin') browser.setTitleBarOverlay({ color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT });  }
});

// The windows' title, which Mission Control shows: a development build's says so, to tell it
// apart from the installed app.
const WINDOW_TITLE = app.isPackaged ? 'SmartDoc' : 'SmartDoc Development';

// Frameless window: the interface draws its own top bar. macOS keeps its traffic lights,
// placed in the top bar; Windows and Linux get the system window controls drawn over it.
function createWindow({ focus = true } = {}) {
  const colours = windowColours();
  const frame = process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: (TOP_BAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT } };

  const id = `w-${randomUUID().slice(0, 4)}`;
  const browser = new BrowserWindow({
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
      additionalArguments: [`--smartdoc-window=${id}`],
    },
  });
  // The window keeps its own title, not the page's, so a development build's is told apart.
  browser.on('page-title-updated', (e) => e.preventDefault());
  const ctx = { id, win: browser, workspace: createWorkspace(shared), ready: null, session: null, aiOpen: null, untouched: true, chat: null };
  windows.set(browser.webContents.id, ctx);
  followChat(ctx);
  lastFocused = ctx;
  const inWindow = (fn) => (...args) => context.run(ctx, () => fn(...args));
  ctx.workspace.events.on('draft', inWindow(() => { ctx.untouched = false; return sendDraft(); }));
  ctx.workspace.events.on('tool', inWindow((tool) => send('tool', tool)));
  ctx.workspace.events.on('review', inWindow((review) => {
    send('review', review);
    updateMenu();
  }));
  browser.on('focus', () => {
    lastFocused = ctx;
    context.run(ctx, updateMenu);
  });
  ctx.ready = new Promise((resolve) => browser.webContents.once('did-finish-load', resolve));
  ctx.ready.then(inWindow(sendEverything));
  browser.loadFile(path.join(dirname, '../../build/renderer/index.html'));

  // In full screen macOS moves the traffic lights out of the top bar, so the interface
  // can reclaim the space reserved for them.
  browser.on('enter-full-screen', () => browser.webContents.send('full-screen', true));
  browser.on('leave-full-screen', () => browser.webContents.send('full-screen', false));
  const contentsId = browser.webContents.id;
  browser.on('closed', () => {
    windows.delete(contentsId);
    if (lastFocused === ctx) lastFocused = [...windows.values()].at(-1) ?? null;
    // An AI's window comes back as it was, the next time the AI needs it.
    if (ctx.session) {
      const doc = ctx.workspace.document;
      ctx.session.restore = doc && { docId: doc.id, variationId: doc.variationId, draftId: doc.workingDraftId ?? doc.currentDraftId, tool: ctx.workspace.tool };
      ctx.session.ctx = null;
    }
    ctx.workspace.dispose();
    ctx.workspace.events.removeAllListeners(); // nothing left to tell
    ctx.workspace.close();
    updateMenuFor(lastFocused);
  });
  return ctx;
}

// --- Keeping the window and menu in step with the workspace -----------------------------

const send = (channel, value) => win()?.webContents.send(channel, value);
// For every window: what's the same in all of them.
const broadcast = (channel, value) => {
  for (const { win: browser } of windows.values()) browser.webContents.send(channel, value);
};
// The home screen's documents, each with where it stands in each tool.
const recentForWindow = async () => shared.recent;
const MENU_RECENT = 10; // File › Open Recent; the home screen lists them all

// The window's chat is one conversation, whatever it shows (the user's choice: it was a chat for each
// draft): what it moves to (a document, another draft or variation, a preview, home) goes into it as
// a line of context, so the AI knows, and the conversation reads in the order things happened.
const chatOfWindow = (ctx) => (ctx ? `window/${ctx.id}` : null);
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
  const shows = whatShows(view);
  ctx.chatShows = shows;
  // The first thing a window shows isn't news; after that, each move is.
  if (ctx.chatShowsKey !== undefined && ctx.chatShowsKey !== shows.key) agent.note(chatOfWindow(ctx), { text: shows.text, detail: shows.detail });
  ctx.chatShowsKey = shows.key;
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
  win()?.setRepresentedFilename?.(view ? workspace.currentDraftPdfPath() : '');
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
  for (const { win: browser, workspace: each } of windows.values()) {
    const doc = each.document;
    if (doc?.id !== docId) continue;
    const variation = doc.variations.find((v) => v.id === doc.variationId);
    browser.webContents.send('names', { document: doc.name, variation: variation.name });
  }
});
shared.events.on('recent', () => {
  broadcast('recent-documents', shared.recent);
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
      close: () => (workspace.document ? workspace.close() : win()?.close()),
      stepDraft: (delta) => workspace.stepDraft(delta),
      find: (which) => send('find', which),
      showSettings: () => send('show-settings'),
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

// Everything is saved as it happens, so switching documents never loses work. The confirmation
// still asks first, and its save option stays for anything that one day isn't saved instantly.
const hasUnsavedChanges = () => false;
async function saveChanges() {}

async function confirmSwitch(nextName) {
  const doc = workspace.document;
  if (!doc) return true;
  const choice = await confirmReplace(win(), { current: doc.name, next: nextName, unsaved: hasUnsavedChanges() });
  if (choice === 'cancel') return false;
  if (choice === 'save') await saveChanges();
  return true;
}

// Opening a file (menu, drop or Finder) always imports it as a new document.
async function importFile(filePath) {
  await ensureWindow();
  if (!(await confirmSwitch(path.basename(filePath)))) return;
  try {
    await workspace.importAndOpen(filePath);
  } catch {
    dialog.showErrorBox('Couldn’t open the file', `${filePath} could not be read.`);
  }
}

async function openDocument(docId) {
  await ensureWindow();
  if (workspace.document?.id === docId) return;
  const entry = workspace.recent.find((r) => r.id === docId);
  if (!(await confirmSwitch(entry?.name ?? 'the document'))) return;
  await workspace.openDocument(docId);
}

async function pickPdf() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win() ?? undefined, {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
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

async function checkPdf(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  const stats = await fs.promises.stat(resolved).catch(() => null);
  if (!stats?.isFile()) throw new Error(`There's no file at ${resolved}.`);
  const handle = await fs.promises.open(resolved, 'r');
  try {
    const { buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    if (buffer.toString('latin1') !== '%PDF-') throw new Error(`${path.basename(resolved)} isn't a PDF. SmartDoc opens PDFs only.`);
  } finally {
    await handle.close();
  }
  return resolved;
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
    return { id: r.id, name: r.name, importedAt: r.importedAt, ...(folder && { folder }), open: workspace.document?.id === r.id };
  }),

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
      const resolved = await checkPdf(filePath);
      const name = path.basename(resolved);
      const waiting = waitOnUser(name, async () => {
        await bringToFront();
        const choice = await confirmReplace(win(), { current: workspace.document?.name, next: name, unsaved: false, source: path.dirname(resolved) });
        if (choice === 'cancel') return false;
        await workspace.importAndOpen(resolved);
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
      await workspace.importAndOpen(picked);
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

function setSessionWindow(session, ctx) {
  session.ctx = ctx;
  session.restore = null;
  ctx.session = session;
  ctx.untouched = false;
  session.docId = ctx.workspace.document?.id ?? null;
  ctx.ready.then(() => ctx.win.webContents.send('ai-control', clientLabel(session.client)));
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
    ctx.win.webContents.send('ai-control', null);
  }
}

async function windowForSession(session, startedApp) {
  if (session.ctx) return session.ctx;
  const launch = startedApp && !session.restore && [...windows.values()].find((c) => c.untouched && !c.session && !c.workspace.document);
  const ctx = launch || createWindow({ focus: false });
  await ctx.ready;
  const { restore } = session;
  setSessionWindow(session, ctx);
  if (restore?.docId) {
    await ctx.workspace.openDraft(restore.docId, restore.variationId, restore.draftId, restore.tool).catch(() => {});
    session.docId = ctx.workspace.document?.id ?? null; // it may have been deleted since
  }
  if (!ctx.win.isVisible()) ctx.win.showInactive();
  return ctx;
}

// Whether a call says what it acts on, whatever the window shows. A variation is of the open document.
const namesItsTarget = (name, args) => ['delete_document', 'create_folder', 'move_document'].includes(name) || (name === 'rename' && args?.kind !== 'variation');

const aiForServer = {
  alive: ({ session, client }) => sessions.touch(session, client),
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
  async call({ session: id, client, startedApp }, name, args, run) {
    const session = sessions.touch(id, client);
    // Taking a window over is the one call that mustn't open one of its own.
    if (name === 'use_window') {
      const documents = { useWindow: (windowId) => takeOverWindow(session, windowId) };
      return run(null, documents);
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
      const after = ctx.workspace.document?.id ?? null;
      if (name === 'open_document' || name === 'create_document_from_draft' || !session.docId) {
        if (before !== after) sessions.releaseClaims(session);
        session.docId = after;
      }
      return result;
    });
  },
};

// --- The chat panel: Claude, run by the app (see agent.js) ------------------------------------
// Claude works in the window the chat is in, as an AI session of its own bound to that window, with
// SmartDoc's tools only, through the app's own MCP server.

const agent = createAgent({
  userData: app.getPath('userData'),
  mcp: (headers) => ({ url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}`, ...headers } }),
  // To try the AIs' setup in a development build without touching the user's own (see agent.js).
  trial: app.isPackaged ? null : { home: process.env.SMARTDOC_AI_HOME || null, hide: process.env.SMARTDOC_AI_HIDE || '' },
  // To the window the AI was asked from, or, for a change to a chat not from a window (a new
  // session), to every window: each shows only its own draft's chat.
  onEvent: (event) => {
    const to = event.windowId ? [...windows.values()].filter((c) => c.id === event.windowId) : [...windows.values()];
    for (const ctx of to) {
      ctx.win.webContents.send('agent-event', event);
      ctx.chat?.win.webContents.send('agent-event', event);
    }
  },
});

// --- The chat in a window of its own ----------------------------------------------------------
// Floating, the chat is a window of its own, kept on top of the app window it belongs to and moved
// independently of it (see followChat). The user can put it anywhere, inside the window or out of
// it, and it opens again where it was beside that window (see chat-anchor.js). It does everything as that window: its requests run in that
// window's context (chatOwners), and that window's interface sends it what its review shows.

const chatOwners = new Map(); // the chat window's webContents id → the ctx of the window it belongs to

function openChatWindow(ctx, view) {
  if (ctx.chat) {
    ctx.chat.win.webContents.send('chat-open-item', view === 'main' ? null : view);
    ctx.chat.win.show();
    return;
  }
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
      additionalArguments: [`--smartdoc-window=${ctx.id}`],
    },
  });
  ctx.chat = { win, view, docking: false };
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
  // Clicked away from, it hides unless its app window has the focus (see keepChatWithFocus).
  win.on('blur', () => setTimeout(() => keepChatWithFocus(ctx)));
  // Above the app window (see keepChatWithFocus).
  win.setAlwaysOnTop(true, 'floating');
  // Out of the way when the user shows all windows (Mission Control, App Exposé): a floating window
  // would otherwise stay on top of them (the user found it in the way).
  win.setHiddenInMissionControl?.(true);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    chatOwners.delete(contentsId);
    const { docking, view: at } = ctx.chat ?? {};
    ctx.chat = null;
    if (!ctx.win.isDestroyed()) ctx.win.webContents.send('chat-mode', { mode: docking ? 'docked' : 'closed', view: at });
  });
  win.loadFile(path.join(dirname, '../../build/renderer/chat.html'));
  ctx.win.webContents.send('chat-mode', { mode: 'floating' });
}

// The chat floats in a window of its own, which the user moves independently of the app window (the
// user's choice: as a child window it moved with it), above it at the floating windows' level
// (however often the app window is clicked: going back over it when that came forward wasn't
// enough). It shows only while its app window or the chat itself has the focus, and hides as soon as
// the focus goes anywhere else, another app or another window of this one (the user's choice: left
// showing, macOS showed it in Mission Control even above the ordinary windows and marked to be left
// out, and it got in the way). It hides while the app window is minimised and closes with it, and in
// full screen, where a window of its own can't follow, the chat docks.
// Coming back to the app, the chat waits for the windows to settle (Mission Control's animation as
// they go back into place, which nothing reports the end of), then fades in (the user's choice).
const SETTLE_MS = 450;
const FADE_MS = 160;
let activatedAt = 0;
app.on('did-become-active', () => { activatedAt = Date.now(); });
function keepChatWithFocus(ctx) {
  const win = ctx.chat?.win;
  if (!win || win.isDestroyed() || ctx.win.isDestroyed()) return;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused !== ctx.win && focused !== win) {
    clearTimeout(ctx.chat.showing);
    clearInterval(win.fading);
    win.hide();
    win.setOpacity(1);
    return;
  }
  if (win.isVisible() || !ctx.win.isVisible() || ctx.win.isMinimized()) return;
  const wait = activatedAt + SETTLE_MS - Date.now();
  if (wait > 0) {
    clearTimeout(ctx.chat.showing);
    ctx.chat.showing = setTimeout(() => keepChatWithFocus(ctx), wait);
    return;
  }
  fadeIn(win);
}
function fadeIn(win) {
  const start = Date.now();
  clearInterval(win.fading);
  win.setOpacity(0);
  win.showInactive();
  const step = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(step);
    const t = Math.min(1, (Date.now() - start) / FADE_MS);
    win.setOpacity(1 - (1 - t) ** 3);
    if (t === 1) clearInterval(step);
  }, 16);
  win.fading = step;
}
function followChat(ctx) {
  // The window loaded again (a reload) while its chat floats: it's told, so it sends the chat what
  // it shows.
  ctx.win.webContents.on('did-finish-load', () => {
    if (ctx.chat) ctx.win.webContents.send('chat-mode', { mode: 'floating' });
  });
  const chatWin = () => (ctx.chat && !ctx.chat.win.isDestroyed() ? ctx.chat.win : null);
  // The focus moves in steps, one window losing it before the next has it, so where it went is
  // looked at once it's there.
  const settle = () => setTimeout(() => keepChatWithFocus(ctx));
  ctx.win.on('focus', settle);
  ctx.win.on('blur', settle);
  ctx.win.on('minimize', () => chatWin()?.hide());
  ctx.win.on('hide', () => chatWin()?.hide());
  ctx.win.on('closed', () => chatWin()?.destroy());
  ctx.win.on('enter-full-screen', () => closeChatWindow(ctx, true));
}

function closeChatWindow(ctx, dock) {
  if (!ctx.chat) return;
  ctx.chat.docking = dock;
  ctx.chat.win.close();
}

const CHAT_SYSTEM = 'You are working inside the SmartDoc app on the user\'s Mac. The user is chatting with you in the app\'s chat panel, in one SmartDoc window, and the SmartDoc tools act on that window: never call use_window. The conversation carries on as the window moves between documents, drafts and home; lines of context say where it went, and what the window shows now is said at the end of these instructions. Only open another document if they ask. Follow the SmartDoc server\'s instructions for reviews. The app shows each tool you use as a step, so don\'t describe your tool calls; keep replies short and plain, and don\'t repeat what the app already shows (the findings and decisions are on screen). A message may start with [What I\'ve done in the app since my last message, for context: …]: what the user did and looked at in the app since they last wrote, so you know what they mean by \"this\"; use it, and don\'t repeat it back. When it helps, end your reply with up to three short questions the user might want to ask you next, in their words, each on its own line as <suggest>question</suggest>: the app shows them as buttons, not as text.';

function chatThreadPrompt(item, text) {
  const finding = { id: item.id, kind: item.kind, title: item.title, body: item.body, quote: item.anchors?.map((a) => a.text).join(' … '), proposal: item.proposal, options: item.options, question: item.question, decision: item.decision };
  return `The user has opened one finding of the current review in the chat to ask about it:\n${JSON.stringify(finding, null, 2)}\n\nThe user says: ${text}`;
}

async function chatSend(providerId, conversation, text, { model = null } = {}) {
  const provider = PROVIDERS[providerId] ?? PROVIDERS.claude;
  const client = `smartdoc-${provider.id}`;
  const ctx = current();
  if (!mcp) throw new Error(`SmartDoc’s server isn’t running, so ${provider.name} can’t work in this window.`);
  const chatId = chatOfWindow(ctx); // the window's chat
  const sessionId = `chat-${ctx.id}`;
  const session = sessions.touch(sessionId, client);
  if (ctx.session && ctx.session !== session && sessions.alive(ctx.session)) {
    throw new Error(`${clientLabel(ctx.session.client)} is working in this window. Release it from the server panel first.`);
  }
  if (session.ctx !== ctx) {
    if (session.ctx) releaseWindow(session);
    setSessionWindow(session, ctx);
  }
  let prompt = text;
  let systemPrompt = `${CHAT_SYSTEM} ${ctx.chatShows?.detail ?? whatShows(null).detail}`;
  if (conversation !== 'main') {
    const item = ctx.workspace.review?.items?.find((i) => i.id === conversation) ?? ctx.workspace.review?.highlights?.find((h) => h.id === conversation);
    if (!item) throw new Error('That finding isn’t in the review showing.');
    if (!(await agent.hasSession(chatId, conversation, provider.id))) prompt = chatThreadPrompt(item, text);
    systemPrompt += ` This conversation is about one finding only, ${item.id} (“${item.title}”). Answer about it. If the user wants it changed, or a change would clearly help them decide, improve it with revise_finding; never change any other finding, and don't write a draft from here.`;
  }
  // Calls keep the session alive; between them, while Claude thinks, this does.
  const keepAlive = setInterval(() => sessions.touch(sessionId, client), 10 * 1000);
  agent.send({ provider: provider.id, windowId: ctx.id, chatId, conversation, text, prompt, systemPrompt, model, sessionHeaders: { 'x-smartdoc-session': sessionId, 'x-smartdoc-client': client } })
    .catch((error) => {
      ctx.win.webContents.send('agent-event', { windowId: ctx.id, chatId, conversation, type: 'error', error: error.message });
      ctx.chat?.win.webContents.send('agent-event', { windowId: ctx.id, chatId, conversation, type: 'error', error: error.message });
    })
    .finally(() => clearInterval(keepAlive));
  return true;
}

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
    if (!old.workspace.document) old.win.close();
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
  if (workspace.document) workspace.close();
  send('document-made', made.id);
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
const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => context.run(windows.get(event.sender.id) ?? chatOwners.get(event.sender.id) ?? lastFocused ?? {}, async () => {
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
handle('open-draft', async (docId, variationId, draftId, tool) => {
  if (!workspace.isRecent(docId)) return;
  if (workspace.document?.id !== docId && !(await confirmSwitch(workspace.recent.find((r) => r.id === docId)?.name))) return;
  await workspace.openDraft(docId, variationId, draftId, tool);
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
handle('go-home', () => workspace.close());
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
// The chat panel (see chatSend above and agent.js).
handle('agent-status', () => agent.status());
// Installing and signing in say how they're getting on, to every window (the server panel and the
// chat both show it).
const agentProgress = (progress) => {
  broadcast('agent-progress', progress);
  for (const ctx of windows.values()) ctx.chat?.win.webContents.send('agent-progress', progress);
};
handle('agent-sign-in', (id) => agent.signIn(id, agentProgress));
handle('agent-install', (id) => agent.install(id, agentProgress));
// The window's chat: one conversation, whatever it shows.
handle('agent-chats', async () => {
  const chatId = chatOfWindow(current());
  return chatId ? { chatId, ...(await agent.load(chatId)), running: agent.runningIn(chatId) } : null;
});
handle('agent-send', (provider, conversation, text, options) => chatSend(provider, conversation, text, options));
handle('agent-stop', (conversation) => agent.stop(chatOfWindow(current()), conversation));
handle('agent-new-session', (provider, conversation) => agent.newSession(chatOfWindow(current()), conversation, provider));
handle('chat-float', (view) => openChatWindow(current(), view));
handle('chat-dock', (view) => {
  const ctx = current();
  if (ctx.chat) ctx.chat.view = view;
  closeChatWindow(ctx, true);
});
handle('chat-close', () => closeChatWindow(current(), false));
// What the app window's review shows, passed on to its chat window (kept for when it opens).
handle('chat-state', (state) => {
  const ctx = current();
  ctx.chatState = state;
  ctx.chat?.win.webContents.send('chat-state', state);
});
handle('chat-ready', () => {
  const ctx = current();
  setTimeout(() => ctx.chatState && ctx.chat?.win.webContents.send('chat-state', ctx.chatState));
  return { view: ctx.chat?.view ?? 'main' };
});
handle('chat-focus', (id) => current().win.webContents.send('chat-focus', id));
// A line of context for the chat (what the user did or looked at), for the AI with their next
// message: in the window's chat (see note in agent.js).
handle('chat-note', (note) => agent.note(chatOfWindow(current()), note));
handle('chat-open-item', (id) => openChatWindow(current(), id ?? 'main'));
handle('agent-install-help', (id) => shell.openExternal((PROVIDERS[id] ?? PROVIDERS.claude).installHelp));
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
handle('check-updates', () => updates.check());
handle('install-update', () => updates.install());
handle('get-appearance', () => nativeTheme.themeSource);
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
