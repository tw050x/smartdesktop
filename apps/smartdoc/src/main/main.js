import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmReplace } from './confirm-replace.js';
import { buildMenu } from './menu.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const TOP_BAR_HEIGHT = 44;
// Height of the area macOS reserves for the traffic lights (the circles sit centred in it).
const TRAFFIC_LIGHTS_HEIGHT = 16;
const MAX_RECENT = 10;
const RECENT_IN_EMPTY_VIEW = 3;

let win = null;
let winReady = null; // resolves once the window's interface has loaded
let currentFile = null; // absolute path of the PDF shown in the window, or null when empty
let recent = [];
// Development and automated tests can point the app at a separate data folder, so they never
// read or overwrite the user's real data (recent files and anything stored later). Set before
// the app is ready so Chromium's own storage moves too. Ignored in packaged builds.
if (!app.isPackaged && process.env.EMPLOYMENT_SHORT_LIST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.EMPLOYMENT_SHORT_LIST_USER_DATA));
}

const recentPath = () => path.join(app.getPath('userData'), 'recent.json');

// Frameless window: the interface draws its own top bar. macOS keeps its traffic lights,
// placed in the top bar; Windows and Linux get the system window controls drawn over it.
function createWindow() {
  const frame = process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: (TOP_BAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#ebebef', symbolColor: '#3c3c43', height: TOP_BAR_HEIGHT } };

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'Employment Short List App',
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
  winReady.then(updateMenu);
  win.loadFile(path.join(dirname, '../../build/renderer/index.html'));

  // In full screen macOS moves the traffic lights out of the top bar, so the interface
  // can reclaim the space reserved for them.
  win.on('enter-full-screen', () => win.webContents.send('full-screen', true));
  win.on('leave-full-screen', () => win.webContents.send('full-screen', false));
  win.on('closed', () => {
    win = null;
    currentFile = null;
    updateMenu();
  });
}

// --- The open file -------------------------------------------------------------------------

async function open(filePath) {
  if (!win) createWindow();
  await winReady;
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    dialog.showErrorBox('Couldn’t open the file', `${filePath} could not be read. It may have been moved or deleted.`);
    removeRecent(filePath);
    return;
  }
  currentFile = filePath;
  await rememberRecent(filePath);
  win.setRepresentedFilename?.(filePath);
  win.webContents.send('file-opened', { name: path.basename(filePath), data: new Uint8Array(data) });
  updateMenu();
}

// Nothing in the app can be edited yet, so there's never anything to save. Once there is
// (e.g. review notes), report it here and save it in saveChanges().
const hasUnsavedChanges = () => false;
async function saveChanges() {}

// A PDF dropped while another is open replaces it only after the user confirms in a separate
// window, which also offers to save any unsaved changes first.
async function replaceWith(filePath) {
  if (currentFile && currentFile !== filePath) {
    const choice = await confirmReplace(win, { current: currentFile, next: filePath, unsaved: hasUnsavedChanges() });
    if (choice === 'cancel') return;
    if (choice === 'save') await saveChanges();
  }
  await open(filePath);
}

async function showOpenDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!canceled && filePaths.length) await open(filePaths[0]);
}

function close() {
  currentFile = null;
  win?.setRepresentedFilename?.('');
  win?.webContents.send('file-closed');
  updateMenu();
}

// --- Recent files ------------------------------------------------------------------------

async function loadRecent() {
  try {
    recent = JSON.parse(await readFile(recentPath(), 'utf8')).filter((p) => typeof p === 'string');
  } catch {
    recent = [];
  }
}

const saveRecent = () => writeFile(recentPath(), JSON.stringify(recent)).catch(() => {});

async function rememberRecent(filePath) {
  recent = [filePath, ...recent.filter((p) => p !== filePath)].slice(0, MAX_RECENT);
  app.addRecentDocument(filePath);
  await saveRecent();
}

function removeRecent(filePath) {
  recent = recent.filter((p) => p !== filePath);
  saveRecent();
  updateMenu();
}

function clearRecent() {
  recent = [];
  app.clearRecentDocuments();
  saveRecent();
  updateMenu();
}

// --- Menu --------------------------------------------------------------------------------

// The menu and the empty view's recent files both follow the app's state; call this whenever
// the open file or the recent list changes.
function updateMenu() {
  win?.webContents.send('recent-files', recent.slice(0, RECENT_IN_EMPTY_VIEW).map((p) => ({ path: p, name: path.basename(p) })));
  Menu.setApplicationMenu(buildMenu({
    file: currentFile,
    recent,
    actions: {
      showOpenDialog,
      open,
      clearRecent,
      reload: () => currentFile && open(currentFile),
      showInFolder: () => currentFile && shell.showItemInFolder(currentFile),
      close,
    },
  }));
}

// --- Renderer requests -------------------------------------------------------------------

ipcMain.handle('open-path', (_event, filePath) => replaceWith(filePath));
// Only paths from the recent list can be opened this way.
ipcMain.handle('open-recent', (_event, filePath) => recent.includes(filePath) && replaceWith(filePath));
// The empty view's previews read recent files directly (again, only files in the list).
// Resolves with the file's bytes, or null if it can't be read (moved or deleted).
ipcMain.handle('read-recent', async (_event, filePath) => {
  if (!recent.includes(filePath)) return null;
  try {
    return new Uint8Array(await readFile(filePath));
  } catch {
    return null;
  }
});

// --- App lifecycle -----------------------------------------------------------------------

nativeTheme.themeSource = 'light';

// macOS: files opened from Finder, the Dock or the Dock's recent documents.
let pendingOpen = null;
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) open(filePath);
  else pendingOpen = filePath;
});

app.whenReady().then(async () => {
  await loadRecent();
  updateMenu();
  createWindow();
  if (pendingOpen) open(pendingOpen);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
