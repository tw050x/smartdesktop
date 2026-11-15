// A chat's tab dragged out of its window (see chat.js and main.js): a picture of it follows the
// pointer in a window of its own, over every window and the desktop, as the apps' tabs do
// (tab-drag.js there). Inside its own window, chat.js draws it instead, so it shows only outside.
import { BrowserWindow } from 'electron';

const PAD = 18; // room round the picture for its shadow

export function createDragPicture() {
  let win = null;
  let at = null; // { offset } while there's a picture

  // `image` is the tab's picture (a NativeImage), `size` its size in the page, `offset` where in it
  // the pointer took hold of it, `point` the pointer on the screen.
  async function show({ image, size, offset, point }) {
    hide();
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    const shown = new BrowserWindow({
      width: width + 2 * PAD,
      height: height + 2 * PAD,
      x: Math.round(point.x - offset.x - PAD),
      y: Math.round(point.y - offset.y - PAD),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win = shown;
    at = { offset };
    shown.excludedFromShownWindowsMenu = true;
    shown.setIgnoreMouseEvents(true);
    shown.setAlwaysOnTop(true, 'pop-up-menu');
    const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  img { position: absolute; left: ${PAD}px; top: ${PAD}px; width: ${width}px; height: ${height}px; border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25), 0 0 0 0.5px rgba(0, 0, 0, 0.2); }
</style></head><body><img src="${image.toDataURL()}"></body></html>`;
    await shown.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  }

  // Follows the pointer; shown only while `visible` (outside the window it came from).
  function move(point, visible) {
    if (!win || win.isDestroyed()) return;
    win.setPosition(Math.round(point.x - at.offset.x - PAD), Math.round(point.y - at.offset.y - PAD));
    if (visible && !win.isVisible()) win.showInactive();
    if (!visible && win.isVisible()) win.hide();
  }

  function hide() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    at = null;
  }

  return { show, move, hide };
}
