// Dragging a tab out of the top bar (the user's choice, as in a browser): while it's dragged, a
// picture of it follows the pointer in a window of its own, over every window and the desktop, so it
// can be dropped in another window's top bar, or anywhere else to make a new window of it. Over a
// top bar the picture is the tab alone; anywhere else it's the tab with its page under it, as the
// window it would make. The top bar the pointer is over shows where the tab would go (see
// tab-strip.js); main.js moves it. The same in SmartDoc and SmartSpec.
import { BrowserWindow } from 'electron';

const PAD = 18; // room round the picture for its shadow
const PAGE_WIDTH = 320; // the page's picture, under the tab, over no top bar
const BELOW = 24; // how far below a top bar still counts as over it

// `point`s are on the screen. show() takes pictures of the tab (`chip`, `chipSize` its size in the
// top bar) and of its page (`page`, `pageSize`, or none), and `offset`, where in the tab the pointer
// took hold of it.
export function createTabDrag({ topBar }) {
  let win = null;
  let at = null; // { offset } while showing
  let mode = 'tab';

  async function show({ chip, chipSize, page, pageSize, offset, point, colours }) {
    hide();
    const chipWidth = Math.round(chipSize.width);
    const chipHeight = Math.round(chipSize.height);
    const pageHeight = page && !page.isEmpty() && pageSize?.width ? Math.round((PAGE_WIDTH * pageSize.height) / pageSize.width) : 0;
    const width = pageHeight ? Math.max(PAGE_WIDTH, chipWidth) : chipWidth;
    const height = chipHeight + pageHeight;
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
    mode = 'tab';
    shown.excludedFromShownWindowsMenu = true;
    shown.setIgnoreMouseEvents(true);
    shown.setAlwaysOnTop(true, 'pop-up-menu');
    const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  .card { position: absolute; left: ${PAD}px; top: ${PAD}px; overflow: hidden; border-radius: 8px;
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3), 0 0 0 0.5px rgba(0, 0, 0, 0.25); background: ${colours.bar}; }
  .chip { display: block; width: ${chipWidth}px; height: ${chipHeight}px; }
  .page { display: block; width: ${PAGE_WIDTH}px; height: ${pageHeight}px; }
  .head { width: ${chipWidth}px; }
  :root.window .card { border-radius: 10px; }
  :root.window .head { width: ${width}px; }
  :root:not(.window) .page { display: none; }
</style></head>
<body><div class="card"><div class="head"><img class="chip" src="${chip.toDataURL()}"></div>${pageHeight ? `<img class="page" src="${page.resize({ width: PAGE_WIDTH * 2 }).toDataURL()}">` : ''}</div></body></html>`;
    await shown.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    if (win !== shown) return;
    shown.showInactive();
  }

  // Follows the pointer; `over` is true over a top bar (the tab alone), false elsewhere (the window
  // it would make).
  function move(point, over) {
    if (!win || win.isDestroyed()) return;
    const [x, y] = [Math.round(point.x - at.offset.x - PAD), Math.round(point.y - at.offset.y - PAD)];
    win.setPosition(x, y);
    const want = over ? 'tab' : 'window';
    if (want === mode) return;
    mode = want;
    // Its page has no scripts: the class is set from here (the main world), and its styles follow.
    win.webContents.executeJavaScript(`document.documentElement.classList.toggle('window', ${want === 'window'})`).catch(() => {});
  }

  function hide() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    at = null;
  }

  // The top bar under `point`, and where in it the tab would go: { host, index, x } (the index
  // among its tabs once the one dragged is out of them, never before Home; `x` the pointer's in the
  // window), or null over anything else. `hosts` front to back, each { win, tabBoxes: [{ id, left,
  // width }] } (its tabs, as its top bar last measured them).
  function targetAt(point, hosts, dragId) {
    for (const host of hosts) {
      const { win: w } = host;
      if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) continue;
      const b = w.getContentBounds();
      if (point.x < b.x || point.x >= b.x + b.width || point.y < b.y - BELOW || point.y >= b.y + b.height) continue;
      // The window in front there: its top bar, or a little below it, takes the tab; the rest of it
      // makes a new window, as the desktop does.
      if (point.y > b.y + topBar + BELOW) return null;
      const x = point.x - b.x;
      const tabs = (host.tabBoxes ?? []).filter((t) => t.id !== dragId);
      let index = 1;
      for (const box of tabs.slice(1)) if (box.left + box.width / 2 < x) index++;
      return { host, index, x };
    }
    return null;
  }

  return { show, move, hide, targetAt };
}
