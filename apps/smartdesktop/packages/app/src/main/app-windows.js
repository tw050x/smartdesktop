// SmartDesktop's app windows: windows of tabs where the other apps' front ends render (the user's
// choice, 2026-11-26: SmartDesktop has two kinds of window, these and the chat's). Every tab in them is
// another app's page, a guest tab (@smartdesktop/ui's main/guests.js): served by that app's backend,
// its calls passed on to it and its events back, the app running with no window of its own for it.
// The windows, their top bar, the tabs' dragging and moving are the family's (main/tabs.js); this
// gives them what's SmartDesktop's: no pages of its own, each window's Home (pinned first, one a
// window: the user's choice, 2026-11-26) the home of the app last opened there.
import { app, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { createTabs } from '@smartdesktop/ui/main/tabs.js';
import { createFamily, familyFolder } from '@smartdesktop/ui/main/family.js';
import { API } from './app-api.js';

const TOP_BAR_HEIGHT = 44;
const TRAFFIC_LIGHTS_HEIGHT = 16;

const colours = () => (nativeTheme.shouldUseDarkColors
  ? { background: '#161618', bar: '#1f1f22', symbols: '#d1d1d6' }
  : { background: '#ebebef', bar: '#dcdce1', symbols: '#3c3c43' });

// `dirname`: SmartDesktop's src/main, for its built pages. `onChange`: the apps that can be opened
// changed (one started or quit), for the menus.
export async function startAppWindows({ dirname, title, onChange = () => {} }) {
  const windows = new Map(); // a tab's webContents id → its tab
  const hosts = new Set(); // the windows
  let lastFocused = null;
  const family = createFamily(familyFolder(app));
  // Each app's menu (see @smartdesktop/ui's main/menu-wire.js), and the app whose tab is in front: its
  // menus join SmartDesktop's menu bar.
  const menus = new Map(); // app id → { name, app, menus }
  let front = null; // the app id of the tab in front in the app window last used
  // Its tabs are other apps', whose chats are their own (each app's tab-chat): none of SmartDesktop's
  // own chat ties applies to them here.
  const desktop = { window() {}, focus() {}, blur() {}, closed() {}, installed: () => false, chat() {} };

  // The apps that can be opened in a tab: each running app of the family's that serves its pages.
  const apps = () => family.others(API.id).filter((entry) => entry.serving);

  const tabs = createTabs({
    id: API.id,
    title,
    api: API,
    pages: { tabs: path.join(dirname, '../../build/renderer/app.html'), index: null },
    topBar: TOP_BAR_HEIGHT,
    trafficLights: TRAFFIC_LIGHTS_HEIGHT,
    windows,
    hosts,
    colours,
    desktop: () => desktop,
    onFocused: (ctx) => {
      lastFocused = ctx;
      const now = ctx?.hosted?.app ?? null;
      if (now !== front) {
        front = now;
        onChange();
      }
    },
    onAppMenu: (from, data) => {
      menus.set(from, data);
      if (from === front) onChange();
    },
    // (Only guests: their title, icon and AI come from their app.)
    tabState: () => ({ title: '', icon: null, ai: null }),
    status: () => ({ state: 'running', label: 'Ready', title: 'SmartDesktop' }),
    name: 'SmartDesktop',
    family,
  });

  // Whatever a window asks for, it asks about itself: each handler gets the tab it's from (or the
  // window's tab showing, for its top bar) first.
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    try {
      const ctx = windows.get(event.sender.id) ?? tabs.strips.get(event.sender.id)?.active ?? lastFocused;
      return { ok: true, value: await fn(ctx, ...args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  tabs.handlers(handle);

  nativeTheme.on('updated', () => {
    const now = colours();
    for (const host of hosts) {
      host.win.setBackgroundColor(now.bar);
      for (const tab of host.tabs) tab.view.setBackgroundColor(now.background);
    }
  });

  // Shows the other apps' tabs, and announces it to the family (so their tabs can move into these
  // windows too).
  await tabs.serveGuests();
  // The apps running change as they start and quit: the menus follow.
  const folder = path.join(familyFolder(app), 'apps');
  try {
    (await import('node:fs')).watch(folder, () => onChange());
  } catch {
    // No folder yet: nothing running to open.
  }

  return {
    apps,
    // The menus of the app whose tab is in front, and choosing one of their items (it runs in that app).
    frontMenu: () => {
      const data = front && menus.get(front);
      const entry = front && family.others(API.id).find((one) => one.app === front);
      if (!data || !entry) return null;
      return {
        ...data,
        choose: (id) => fetch(`${entry.url}/menu-click`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {}),
      };
    },
    // The tab before or after the one showing, in the app window last used (Window › Show Previous Tab).
    stepTab: (delta) => tabs.stepTab(delta),
    // An app's home, as the Home of the window last used (or a new window).
    open: (entry) => tabs.openApp(entry, { host: lastFocused?.host }),
    // A window of its own with a tab of that app.
    openInNewWindow: (entry) => tabs.openApp(entry, { host: null }),
    hasWindows: () => hosts.size > 0,
  };
}
