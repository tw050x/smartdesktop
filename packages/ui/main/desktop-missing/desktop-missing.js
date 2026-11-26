// The window an app shows when SmartDesktop has gone (the user's choice, 2026-11-26: every app shows a
// small window with Reinstall if SmartDesktop has gone): what SmartDesktop is, Reinstall (downloaded,
// checked and installed by install-desktop.js, its progress shown), or Use Without It (the app's own
// window, as before). Its page (page.html, page.js) and preload are beside it, loaded as they are.
// Resolves with 'installed' or 'without'.
import { BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDesktop } from '../install-desktop.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDTH = 460;
let showing = null; // { win, done }: one at a time

ipcMain.on('desktop-missing-fit', (event, height) => {
  if (!showing || event.sender !== showing.win.webContents) return;
  if (!showing.win.isVisible()) showing.win.show();
  showing.win.setContentSize(WIDTH, Math.ceil(height));
});
ipcMain.on('desktop-missing-response', (event, choice) => {
  if (showing && event.sender === showing.win.webContents) showing.done(choice === 'installed' ? 'installed' : 'without');
});
ipcMain.on('desktop-missing-install', async (event) => {
  if (!showing || event.sender !== showing.win.webContents) return;
  const { win, done } = showing;
  const tell = (value) => !win.isDestroyed() && win.webContents.send('desktop-missing-progress', value);
  try {
    const installed = await installDesktop({ progress: tell, trash: (target) => shell.trashItem(target) });
    // Opened from where it was put (it may not be known to macOS by its id yet).
    await shell.openPath(installed.path);
    done('installed');
  } catch (error) {
    tell({ error: error.message });
  }
});

// `name`: the app's, as the window says it.
export function askToReinstall(name) {
  if (showing) return showing.promise;
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: WIDTH,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    title: name,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#232326' : '#ffffff', // as its body (confirm/page.css)
    webPreferences: { preload: path.join(dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  showing = {
    win,
    promise,
    done(choice) {
      showing = null;
      if (!win.isDestroyed()) win.close();
      resolve(choice);
    },
  };
  win.on('closed', () => showing?.win === win && showing.done('without'));
  win.loadFile(path.join(dirname, 'page.html'), { query: { app: name } });
  return promise;
}
