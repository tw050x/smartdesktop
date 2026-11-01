import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const pending = new Map(); // confirmation window's webContents id → resolve
const WIDTH = 440;

ipcMain.on('confirm-replace-response', (event, choice) => {
  pending.get(event.sender.id)?.(choice);
});

// The window sizes itself to its content (long file names wrap), then shows.
ipcMain.on('confirm-replace-fit', (event, height) => {
  const dialog = BrowserWindow.fromWebContents(event.sender);
  if (!dialog || !pending.has(event.sender.id)) return;
  const wanted = Math.ceil(height);
  if (!dialog.isVisible()) dialog.show();
  dialog.setContentSize(WIDTH, wanted);
  // Once attached as a sheet, macOS gives a frameless window less height than asked for,
  // so make up any shortfall.
  const [, actual] = dialog.getContentSize();
  if (actual < wanted) dialog.setContentSize(WIDTH, wanted + (wanted - actual));
});

// Asks, in a window of its own, whether to replace the open file with another, or (with `source`,
// the folder of a file the AI asked to open) whether to let the AI open it. Attached to the
// parent (a sheet on macOS, a modal window elsewhere). Resolves with 'replace', 'save' (save
// the current file's changes, then replace) or 'cancel'.
export function confirmReplace(parent, { current, next, unsaved, source }) {
  const dialog = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    frame: false,
    useContentSize: true,
    width: WIDTH,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#232326' : '#ffffff', // as its body (confirm-replace.css)
    webPreferences: {
      preload: path.join(dirname, 'confirm-replace-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  return new Promise((resolve) => {
    const id = dialog.webContents.id;
    const finish = (choice) => {
      pending.delete(id);
      if (!dialog.isDestroyed()) dialog.close();
      resolve(choice);
    };
    pending.set(id, finish);
    dialog.on('closed', () => pending.has(id) && finish('cancel'));
    dialog.loadFile(path.join(dirname, '../../build/renderer/confirm-replace.html'), {
      query: { current: current ? path.basename(current) : '', next: path.basename(next), unsaved: unsaved ? '1' : '', source: source ?? '' },
    });
  });
}
