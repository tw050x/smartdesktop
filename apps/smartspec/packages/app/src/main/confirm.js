import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A question asked in a window of its own, attached to the window it's about (a sheet on macOS, a
// modal window elsewhere), as SmartDoc asks before replacing a file. It says what's so and offers
// buttons; the answer is the chosen button's choice, or 'cancel' if it's closed.

const dirname = path.dirname(fileURLToPath(import.meta.url));
const pending = new Map(); // the asking window's webContents id → its finish
const WIDTH = 460;

ipcMain.on('confirm-response', (event, choice) => {
  pending.get(event.sender.id)?.(choice);
});

// The window sizes itself to what it says, then shows.
ipcMain.on('confirm-fit', (event, height) => {
  const dialog = BrowserWindow.fromWebContents(event.sender);
  if (!dialog || !pending.has(event.sender.id)) return;
  const wanted = Math.ceil(height);
  if (!dialog.isVisible()) dialog.show();
  dialog.setContentSize(WIDTH, wanted);
  // Once attached as a sheet, macOS gives a frameless window less height than asked for.
  const [, actual] = dialog.getContentSize();
  if (actual < wanted) dialog.setContentSize(WIDTH, wanted + (wanted - actual));
});

// `question`: { title, message, points (lines listed under the message), buttons: [{ label,
// choice, kind ('primary' or 'secondary'), apart (set off on the left) }] }. The last button is
// the default (Return); Escape cancels.
export function confirm(parent, question) {
  const dialog = new BrowserWindow({
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    frame: false,
    useContentSize: true,
    width: WIDTH,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#232326' : '#ffffff', // as its body (confirm.css)
    webPreferences: {
      preload: path.join(dirname, 'confirm-preload.cjs'),
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
    dialog.loadFile(path.join(dirname, '../../build/renderer/confirm.html'), { query: { question: JSON.stringify(question) } });
  });
}
