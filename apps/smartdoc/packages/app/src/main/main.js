import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmReplace } from './confirm-replace.js';
import { createConnect } from './connect.js';
import { MCP_PORT, startMcpServer } from './mcp-server.js';
import { buildMenu } from './menu.js';
import { createUpdates } from './updates.js';
import { createWorkspace } from './workspace.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
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
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});

let win = null;
let winReady = null; // resolves once the window's interface has loaded
let mcp = null; // { url, token } once the MCP server is listening
let mcpStarting = true;
const workspace = createWorkspace(app.getPath('userData'));

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
  if (!win) return;
  const colours = windowColours();
  win.setBackgroundColor(colours.background);
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT });
});

// Frameless window: the interface draws its own top bar. macOS keeps its traffic lights,
// placed in the top bar; Windows and Linux get the system window controls drawn over it.
function createWindow() {
  const colours = windowColours();
  const frame = process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: (TOP_BAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: colours.bar, symbolColor: colours.symbols, height: TOP_BAR_HEIGHT } };

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'SmartDoc',
    backgroundColor: colours.background,
    ...frame,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  winReady = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  winReady.then(sendEverything);
  win.loadFile(path.join(dirname, '../../build/renderer/index.html'));

  // In full screen macOS moves the traffic lights out of the top bar, so the interface
  // can reclaim the space reserved for them.
  win.on('enter-full-screen', () => win.webContents.send('full-screen', true));
  win.on('leave-full-screen', () => win.webContents.send('full-screen', false));
  win.on('closed', () => {
    win = null;
    workspace.close();
  });
}

// --- Keeping the window and menu in step with the workspace -----------------------------

const send = (channel, value) => win?.webContents.send(channel, value);
// The home screen's documents, each with where it stands in each tool.
const recentForWindow = async () => workspace.recent;

async function sendDraft() {
  const view = await workspace.draftView();
  // The draft's review comes with it, so the window never shows a draft with another draft's review.
  send(view ? 'draft-opened' : 'document-closed', view && { ...view, review: workspace.review, tool: workspace.tool });
  // Back on the home screen, its cards show where each document now stands.
  if (!view) send('recent-documents', await recentForWindow());
  win?.setRepresentedFilename?.(view ? workspace.currentDraftPdfPath() : '');
  updateMenu();
}

const mcpStatus = () => (mcp ? { state: 'running', url: mcp.url } : { state: mcpStarting ? 'starting' : 'off' });

async function sendEverything() {
  send('recent-documents', await recentForWindow());
  send('mcp-status', mcpStatus());
  if (workspace.document) {
    await sendDraft();
    send('review', workspace.review);
  }
  updateMenu();
}

workspace.events.on('draft', () => sendDraft());
workspace.events.on('tool', (tool) => send('tool', tool));
workspace.events.on('review', (review) => {
  send('review', review);
  updateMenu();
});
workspace.events.on('recent', async () => {
  send('recent-documents', await recentForWindow());
  updateMenu();
});

function updateMenu() {
  const doc = workspace.document;
  const at = doc ? doc.line.indexOf(doc.currentDraftId) : -1;
  const review = doc ? workspace.review : null;
  Menu.setApplicationMenu(buildMenu({
    hasDocument: Boolean(doc),
    review: review && {
      highlights: review.type === 'highlights',
      canStartAgain: review.status === 'committed' || Boolean(review.items?.length || review.highlights?.length || review.annotations?.length),
      canClearDecisions: review.type !== 'highlights' && review.status === 'committed'
        && Boolean(review.items.some((i) => i.decision.status !== 'pending' || i.decision.comment) || review.changes?.length),
    },
    canStepBack: at > 0,
    canStepForward: doc ? at < doc.line.length - 1 : false,
    recent: workspace.recent,
    actions: {
      showOpenDialog,
      openDocument: (id) => openDocument(id),
      clearRecent: () => workspace.clearRecent(),
      saveDraftAs,
      newVariation,
      documentFromDraft: () => {
        const doc = workspace.document;
        if (doc) documentFromDraft(doc.id, doc.variationId, doc.currentDraftId);
      },
      close: () => workspace.close(),
      stepDraft: (delta) => workspace.stepDraft(delta),
      resetReview,
      showConnectAi,
    },
  }));
}

// --- Documents ---------------------------------------------------------------------------

async function ensureWindow() {
  if (!win) createWindow();
  await winReady;
}

// Everything is saved as it happens, so switching documents never loses work. The confirmation
// still asks first, and its save option stays for anything that one day isn't saved instantly.
const hasUnsavedChanges = () => false;
async function saveChanges() {}

async function confirmSwitch(nextName) {
  const doc = workspace.document;
  if (!doc) return true;
  const choice = await confirmReplace(win, { current: doc.name, next: nextName, unsaved: hasUnsavedChanges() });
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
  const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
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
let aiOpen = null; // { name, state: 'waiting' | 'opened' | 'cancelled' | 'failed', error, done }

async function bringToFront() {
  await ensureWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

function waitOnUser(name, task) {
  const request = { name, state: 'waiting', error: null };
  request.done = task().then(
    (opened) => { request.state = opened ? 'opened' : 'cancelled'; },
    (error) => { request.state = 'failed'; request.error = error.message; },
  );
  aiOpen = request;
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

const documentsForAi = {
  list: () => workspace.recent.map((r) => ({ id: r.id, name: r.name, importedAt: r.importedAt, open: workspace.document?.id === r.id })),

  async open({ path: filePath, document_id: docId } = {}) {
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
      waitOnUser(name, async () => {
        await bringToFront();
        const choice = await confirmReplace(win, { current: workspace.document?.name, next: name, unsaved: false, source: path.dirname(resolved) });
        if (choice === 'cancel') return false;
        await workspace.importAndOpen(resolved);
        return true;
      });
      return {
        status: 'waiting_for_user',
        message: `Before anything else, tell the user to switch to the SmartDoc app and confirm opening ${name}: it won't open until they do. Then call get_document_info, which waits for their answer.`,
      };
    }
    waitOnUser(null, async () => {
      await bringToFront();
      const picked = await pickPdf();
      if (!picked) return false;
      await workspace.importAndOpen(picked);
      return true;
    });
    return {
      status: 'waiting_for_user',
      message: 'Before anything else, tell the user to switch to the SmartDoc app and choose the file in the window it has opened: nothing opens until they do. Then call get_document_info, which waits for their choice.',
    };
  },

  // Called before reading the document: waits for the user's answer to an open request, if there is one.
  // An answer is reported once.
  async settle() {
    const request = aiOpen;
    if (!request) return;
    if (request.state === 'waiting') {
      await Promise.race([request.done, new Promise((resolve) => setTimeout(resolve, AI_OPEN_WAIT_MS))]);
    }
    const what = request.name ?? 'the file';
    if (request.state === 'waiting') throw new Error(`Still waiting for the user to ${request.name ? `confirm opening ${request.name}` : 'pick a file'} in SmartDoc. Remind them to switch to the app, then call get_document_info again.`);
    aiOpen = null;
    if (request.state === 'cancelled') throw new Error(`The user cancelled opening ${what}.`);
    if (request.state === 'failed') throw new Error(`Couldn't open ${what}: ${request.error}`);
  },
};

// Writes the current draft anywhere, including over the file it was imported from.
async function saveDraftAs() {
  const doc = workspace.document;
  if (!doc) return;
  const number = doc.line.indexOf(doc.currentDraftId);
  const base = doc.name.replace(/\.pdf$/i, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
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

const WEBSITE = 'https://tw050x.github.io/smartdoc/';
const { setups, claudeDesktopStatus, addToClaudeDesktop } = createConnect({
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
  const { response } = await dialog.showMessageBox(win ?? undefined, {
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
  const { response } = await dialog.showMessageBox(win ?? undefined, {
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

const updates = createUpdates({ report: (status) => send('updates', status) });

// --- Window requests ---------------------------------------------------------------------

const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
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
// card), or a new document from it.
handle('draft-menu', async ({ docId, variationId, draftId, draft }) => {
  if (!workspace.isRecent(docId)) return;
  const { name, variations } = await workspace.variationsOf(docId);
  const variation = variations.find((v) => v.id === variationId);
  if (!variation) return;
  Menu.buildFromTemplate([
    { label: 'New Variation…', click: () => send('variation-requested', { docId, docName: name, variationId, variationName: variation.name, draft }) },
    { label: 'New Document from Draft', click: () => documentFromDraft(docId, variationId, draftId) },
  ]).popup({ window: win });
});
// A variation's right-click menu on the home screen: a new variation from its latest draft.
handle('variation-menu', async ({ docId, variationId }) => {
  if (!workspace.isRecent(docId)) return;
  const { name, variations } = await workspace.variationsOf(docId);
  const variation = variations.find((v) => v.id === variationId);
  if (!variation) return;
  // Drafts come newest first, numbered from the original (0).
  const draft = variation.drafts.length - 1;
  Menu.buildFromTemplate([
    { label: 'New Variation from Latest Draft…', click: () => send('variation-requested', { docId, docName: name, variationId, variationName: variation.name, draft }) },
  ]).popup({ window: win });
});
// Back to the home screen: the document closes (everything is already saved).
handle('go-home', () => workspace.close());
// A document's right-click menu on the home screen. Removing it from the list leaves its files in
// the data folder.
handle('document-menu', (docId) => {
  if (!workspace.isRecent(docId)) return;
  Menu.buildFromTemplate([
    { label: 'Remove from List', click: () => workspace.removeRecent(docId) },
  ]).popup({ window: win });
});
handle('page-texts', (docId, draftId, texts, details) => workspace.setPageTexts(docId, draftId, texts, details));
handle('add-request', (request) => workspace.addRequest(request));
handle('update-request', (id, changes) => workspace.updateRequest(id, changes));
handle('remove-request', (id) => workspace.removeRequest(id));
handle('decide', (itemId, decision) => workspace.decide(itemId, decision));
// Resetting the review (from the Review menu) asks first, since what's cleared can't be got back
// in the app. Step 1 starts the review again, empty; step 2 clears the user's decisions.
const RESETS = {
  1: {
    message: 'Start the review again?',
    detail: 'This clears the AI’s findings and notes, your decisions and the changes you added, leaving an empty review for your AI to fill.',
    run: () => workspace.resetToReview(),
  },
  2: {
    message: 'Clear your decisions?',
    detail: 'All your decisions, answers, edits and comments are cleared, and the changes you added are removed. The AI’s findings stay, ready to decide again.',
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
  const { response } = await dialog.showMessageBox(win ?? undefined, {
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
handle('step-draft', (delta) => workspace.stepDraft(delta));
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
  await workspace.loadRecent();
  updateMenu();
  createWindow();
  try {
    mcp = await startMcpServer(workspace, app.getPath('userData'), { documents: documentsForAi });
  } catch {
    mcp = null; // e.g. the port is taken by another copy of the app
  }
  mcpStarting = false;
  send('mcp-status', mcpStatus());
  if (pendingOpen) importFile(pendingOpen);
  updates.start();
  await winReady;
  offerMoveToApplications();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
