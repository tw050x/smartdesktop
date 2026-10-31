import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmReplace } from './confirm-replace.js';
import { startMcpServer } from './mcp-server.js';
import { buildMenu } from './menu.js';
import { createWorkspace } from './workspace.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const TOP_BAR_HEIGHT = 44;
// Height of the area macOS reserves for the traffic lights (the circles sit centred in it).
const TRAFFIC_LIGHTS_HEIGHT = 16;
const RECENT_IN_EMPTY_VIEW = 3;

// Development and automated tests can point the app at a separate data folder, so they never
// read or overwrite the user's real data (documents, recent files and anything stored later),
// and at a separate port for its MCP server (SMARTDOC_PORT, see mcp-server.js), so a test
// copy can run beside the real one. Set before the app is ready so Chromium's own storage moves
// too. Ignored in packaged builds.
if (!app.isPackaged && process.env.SMARTDOC_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.SMARTDOC_USER_DATA));
} else {
  moveLegacyUserData();
}

// The app used to be called Shortlist Dock, and before that Employment Short List App, and its
// data lived in a folder of each name. The first time it runs as SmartDoc, everything in the old
// folders moves across, newest name first (anything already in the new folder is left alone), so
// documents, drafts, recent files and the AI connection's token carry over. An old folder is
// removed once it's empty.
const LEGACY_NAMES = ['Shortlist Dock', 'Employment Short List App'];

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

// Frameless window: the interface draws its own top bar. macOS keeps its traffic lights,
// placed in the top bar; Windows and Linux get the system window controls drawn over it.
function createWindow() {
  const frame = process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: (TOP_BAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#dcdce1', symbolColor: '#3c3c43', height: TOP_BAR_HEIGHT } };

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'SmartDoc',
    backgroundColor: '#ebebef',
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
const recentForWindow = () => workspace.recent.slice(0, RECENT_IN_EMPTY_VIEW);

async function sendDraft() {
  const view = await workspace.draftView();
  // The draft's review comes with it, so the window never shows a draft with another draft's review.
  send(view ? 'draft-opened' : 'document-closed', view && { ...view, review: workspace.review });
  win?.setRepresentedFilename?.(view ? workspace.currentDraftPdfPath() : '');
  updateMenu();
}

const mcpStatus = () => (mcp ? { state: 'running', url: mcp.url, clients: mcp.clients() } : { state: mcpStarting ? 'starting' : 'off', clients: [] });

async function sendEverything() {
  send('recent-documents', recentForWindow());
  send('mcp-status', mcpStatus());
  if (workspace.document) {
    await sendDraft();
    send('review', workspace.review);
  }
  updateMenu();
}

workspace.events.on('draft', () => sendDraft());
workspace.events.on('review', (review) => send('review', review));
workspace.events.on('recent', () => {
  send('recent-documents', recentForWindow());
  updateMenu();
});

function updateMenu() {
  const doc = workspace.document;
  const at = doc ? doc.line.indexOf(doc.currentDraftId) : -1;
  Menu.setApplicationMenu(buildMenu({
    hasDocument: Boolean(doc),
    canStepBack: at > 0,
    canStepForward: doc ? at < doc.line.length - 1 : false,
    recent: workspace.recent,
    actions: {
      showOpenDialog,
      openDocument: (id) => openDocument(id),
      clearRecent: () => workspace.clearRecent(),
      saveDraftAs,
      close: () => workspace.close(),
      stepDraft: (delta) => workspace.stepDraft(delta),
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

// --- Connecting an AI --------------------------------------------------------------------
// AI apps start SmartDoc's MCP server themselves: Claude Code runs the npm package with npx,
// and Claude Desktop installs the .mcpb bundle from the website. Either one opens this app and
// talks to its server, so there's nothing to copy from here but the Claude Code command.

const WEBSITE = 'https://tw050x.github.io/smartdoc/';
const CLAUDE_CODE_COMMAND = 'claude mcp add --scope user smartdoc -- npx -y @smartdoc/mcp';

async function showConnectAi() {
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'info',
    message: 'Connect an AI',
    detail: 'Claude Desktop: install SmartDoc from the website (download the file and open it).\n\nClaude Code: run this command in a terminal, then start a new session:\n' + CLAUDE_CODE_COMMAND + '\n\nThe AI then opens this app whenever it needs it.',
    buttons: ['Open the Website', 'Copy the Claude Code Command', 'Close'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) shell.openExternal(WEBSITE);
  if (response === 1) clipboard.writeText(CLAUDE_CODE_COMMAND);
}

// --- Window requests ---------------------------------------------------------------------

const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

handle('open-path', (filePath) => importFile(filePath));
// Only documents in the recent list can be opened or previewed from the empty view.
handle('open-recent', (docId) => workspace.isRecent(docId) && openDocument(docId));
handle('read-recent', async (docId) => (workspace.isRecent(docId) ? new Uint8Array(await workspace.readCurrentDraftOf(docId)) : null));
handle('step-draft', (delta) => workspace.stepDraft(delta));
handle('page-texts', (docId, draftId, texts, details) => workspace.setPageTexts(docId, draftId, texts, details));
handle('add-request', (request) => workspace.addRequest(request));
handle('update-request', (id, changes) => workspace.updateRequest(id, changes));
handle('remove-request', (id) => workspace.removeRequest(id));
handle('decide', (itemId, decision) => workspace.decide(itemId, decision));
handle('rate-highlight', (id, feedback) => workspace.rateHighlight(id, feedback));
handle('add-change', (text) => workspace.addChange(text));
handle('update-change', (id, text) => workspace.updateChange(id, text));
handle('remove-change', (id) => workspace.removeChange(id));
// Resetting the review to the start of a step asks first, since what's cleared can't be got back
// in the app.
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
  detail: 'This clears the AI’s highlights and your feedback on them, leaving an empty review with the same goal for your AI to fill.',
  run: () => workspace.resetToReview(),
};
handle('reset-to-step', async (step) => {
  const reset = workspace.review?.type === 'highlights' ? step === 1 && HIGHLIGHTS_RESET : RESETS[step];
  if (!reset) throw new Error(`Step ${step} can't be reset.`);
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
});
handle('copy-text', (text) => clipboard.writeText(String(text)));
// Setup for each AI app, shown and copied for pasting: Claude Code's terminal command.
const MCP_SETUPS = { 'claude-code': () => CLAUDE_CODE_COMMAND };
function mcpSetup(target) {
  if (!MCP_SETUPS[target]) throw new Error(`Unknown AI app: ${target}`);
  return MCP_SETUPS[target]();
}
handle('mcp-setup', (target) => mcpSetup(target));
handle('copy-mcp-setup', (target) => clipboard.writeText(mcpSetup(target)));
handle('open-website', () => shell.openExternal(WEBSITE));

// --- App lifecycle -----------------------------------------------------------------------

nativeTheme.themeSource = 'light';

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
    mcp = await startMcpServer(workspace, app.getPath('userData'), { documents: documentsForAi, onClients: () => send('mcp-status', mcpStatus()) });
  } catch {
    mcp = null; // e.g. the port is taken by another copy of the app
  }
  mcpStarting = false;
  send('mcp-status', mcpStatus());
  if (pendingOpen) importFile(pendingOpen);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
