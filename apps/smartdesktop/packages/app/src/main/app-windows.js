// SmartDesktop's app windows: windows of tabs where the other apps' front ends render (the user's
// choice, 2026-11-26: SmartDesktop has two kinds of window, these and the chat's). Every tab in them is
// another app's page, a guest tab (@smartdesktop/ui's main/guests.js): served by that app's backend,
// its calls passed on to it and its events back, the app running with no window of its own for it.
// The windows, their top bar, the tabs' dragging and moving are the family's (main/tabs.js); this
// gives them what's SmartDesktop's: no pages of its own, + opening a tab of the app showing, and the
// Home button asking the tab's app to take it home.
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
    },
    // (Only guests: their title, icon and AI come from their app.)
    tabState: () => ({ title: '', icon: null, ai: null }),
    status: () => ({ state: 'running', label: 'Ready', title: 'SmartDesktop' }),
    name: 'SmartDesktop',
    family,
    // + opens a tab of the app the tab showing is, on its home (else the first app running).
    newTabIn: (host) => {
      const showing = host?.active?.hosted?.app;
      const entry = apps().find((one) => one.app === showing) ?? apps()[0];
      if (entry) return tabs.openApp(entry, { host });
    },
    guestsGoHomeThere: true,
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
    // A tab of an app's, on its home, in the window last used (or a new window).
    open: (entry) => tabs.openApp(entry, { host: lastFocused?.host }),
    // A window of its own with a tab of that app.
    openInNewWindow: (entry) => tabs.openApp(entry, { host: null }),
    hasWindows: () => hosts.size > 0,
  };
}
