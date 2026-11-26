// Windows of tabs, the same in every app with them (taken from SmartPlan's main.js, which SmartSpec's,
// SmartAd's, SmartPrep's and SmartStudio's matched but for names). A window holds tabs (the user's
// choice: working in tabs rather than in many windows, though more windows are still allowed), as
// a browser does (the user's choice, 2026-11-26: Home was a pinned first tab): each shows home or a
// document (a board, a schematic, a topic…), going between them as a browser tab goes between pages;
// the top bar's Home button takes the tab showing home (`go-home`), + or ⌘T opens a new tab on home
// (`newTab`), and closing a window's last tab closes the window. `ctx.home` says whether a tab shows
// home now (its `where`, as the tab says). Each tab is what a window was: its own history and AI
// session (`ctx`, with the tab's id, which a copied prompt names so an AI can take it over).
//
// The window's own page is the top bar across it (tabs.html: the traffic lights, back and forward,
// the tabs and the app's status, see renderer/tab-strip.js); each tab's page (index.html) is a view
// below it, only the active one showing. The window is frameless: macOS keeps its traffic lights,
// placed in the top bar; Windows and Linux get the system window controls drawn over it.
//
// The app keeps its own `windows` (a tab's webContents id → its tab) and `hosts` (its windows), which
// this fills and empties, and hears which tab has the focus (`onFocused`); everything that's the
// app's own (what a tab shows, its title and icon, the AI working in it, the app's status) comes from
// its options, asked for when needed, so they can name things the app sets up later.
import { app as electronApp, BrowserWindow, dialog, ipcMain, Menu, screen, shell, WebContentsView } from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTabDrag } from './tab-drag.js';
import { startGuestServer } from './guests.js';
import { confirm } from './confirm/confirm.js';
import { decode, encode } from './wire.js';
import { toData } from './menu-wire.js';

// The family's preload (preload.cjs), for an app that gives its pages' API as data (`api`), and a
// guest tab's (guest-preload.cjs), another app's page shown here.
const SHARED_PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const GUEST_PRELOAD = fileURLToPath(new URL('./guest-preload.cjs', import.meta.url));
// What this app sends a guest tab's page of its own: only what a window's shell sends every tab
// (the top bar's pills and tooltips, full screen, back and forward, the status pill). Everything
// else (this app's server status, its settings, its documents changing) is this app's, not the
// guest's, whose own come from its app.
const SHELL_CHANNELS = new Set(['tab-lines', 'strip-tip', 'full-screen', 'history-step', 'toggle-status']);
// (Not `go-home`: a guest tab gives way to this app's own home, see the handler.)

// JSON over a guest server (guests.js).
async function post(url, value) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value ?? {}) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
// A guest server's events ({ channel, value }), each to `heard`, until the stream ends (resolving)
// or `signal` aborts it.
async function listen(url, signal, heard) {
  const res = await fetch(url, { signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    text += decoder.decode(value, { stream: true });
    let at;
    while ((at = text.indexOf('\n\n')) >= 0) {
      const data = text.slice(0, at).split('\n').find((line) => line.startsWith('data: '));
      text = text.slice(at + 2);
      // (Bytes come as base64: see wire.js.)
      if (data) heard(decode(JSON.parse(data.slice(6))));
    }
  }
}
// A guest server's address, on this Mac: anything else is never loaded into a window.
const localServer = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

export function createTabs({
  id: appId, // the app's id, in each tab's arguments (`--smartplan-window`, `--smartplan-tab`)
  title, // the window's name, which Mission Control shows over it
  pages, // { preload, tabs, index }: the preload script (the family's, with `api`), the top bar's page and a tab's page
  api = null, // the pages' API as data ({ id, calls, events }: the app's main/api.js), for the family's preload
  topBar = 44, // the top bar's height
  trafficLights = 16, // the height of the area macOS reserves for the traffic lights
  windows,
  hosts,
  colours, // () => the window's colours: { background, bar, symbols }
  desktop, // () => the app's SmartDesktop connection (desktop.js)
  onFocused = () => {}, // (ctx or null): the tab the user was last in
  changed = () => {}, // after tabs open, close or move: the menu, say
  tabReady = () => {}, // (ctx): its page has loaded
  tabState, // (ctx) => { title, icon, ai }: for its tab in the top bar
  status, // () => the app's status, for the pill at the end of the top bar
  docOf = () => null, // (ctx) => the id of what a tab shows, or null: for Change Icon…
  release = () => {}, // (ctx): it's gone (the AI working in it gets a new tab, the next time)
  setupTab = () => {}, // (ctx, options): a new tab, before its page loads, with createTab's options (SmartDoc's workspace)
  onActivate = () => {}, // (ctx): it's the tab showing in its window now (SmartDoc's represented file)
  extraState = () => ({}), // () => more for the top bar's state (SmartDoc's `reader` switch)
  name = appId, // the app's name, as other apps' menus say it ("Move to SmartPrep Window")
  family = null, // the other apps running (family.js), for guest tabs
  guestOpen = () => null, // (ctx) => what another app's window is to show of this tab, as a guest (the app's own request), or null if it can't
  guestOpened = () => {}, // (ctx, request): a guest tab of this app's is to show what guestOpen gave (sent it as the app's own tabs are)
  windowless = false, // with SmartDesktop running, this app has no windows of its own: each tab it makes is a guest tab SmartDesktop shows (the user's choice, 2026-11-26)
  newTabIn = null, // (host) => a new tab in that window, for a window of guests only (SmartDesktop's: a tab of an app's); else one of this app's on home
  guestsGoHomeThere = false, // the Home button in a guest tab asks its own app to take it home (SmartDesktop's), rather than putting this app's home in its place
  onAppMenu = null, // (app, data): another app's menu, for this one's menu bar (SmartDesktop's, see menu-wire.js)
  isHome = (ctx) => ctx.where === 'home', // (ctx) => whether a tab shows home now (SmartDoc's: no document, and not waiting for one)
  goHome = (ctx) => ctx.contents.send('go-home', null), // (ctx): the Home button, in a tab not on home (SmartDoc closes its document)
}) {
  let guestUrl = null; // this app's guest server's, once it runs (serveGuests)
  let guestServer = null;
  // SmartDesktop, running, when this app has no windows of its own (`windowless`): its family entry.
  const shell = () => (windowless && family && guestServer ? family.others(appId).find((entry) => entry.app === 'smartdesktop' && entry.hosting) ?? null : null);
  // With its API as data, every page (the top bar's and each tab's) has the family's preload, which
  // asks for it as it starts.
  if (api) {
    pages = { ...pages, preload: pages.preload ?? SHARED_PRELOAD };
    ipcMain.on('preload-api', (event) => {
      event.returnValue = api;
    });
  }
  // A guest tab's page asks for its app's API as it starts, and sends its calls here, to be passed
  // on to its app's server.
  ipcMain.on('guest-api', (event) => {
    event.returnValue = windows.get(event.sender.id)?.hosted?.api ?? { id: 'guest', calls: {}, events: {} };
  });
  ipcMain.handle('guest-call', async (event, channel, args) => {
    const hosted = windows.get(event.sender.id)?.hosted;
    if (!hosted) return { ok: false, error: 'Not a guest tab' };
    try {
      return decode(await post(`${hosted.url}/tabs/${hosted.gid}/call`, { channel, args: encode(args) }));
    } catch {
      return { ok: false, error: `${hosted.name} can’t be reached` };
    }
  });
  let lastFocused = null;
  const focused = (ctx) => {
    lastFocused = ctx;
    onFocused(ctx);
    // Another app's tab here: that app hears it's the one the user is in (for its menus, and where its
    // AI and the chat work).
    if (ctx?.hosted) post(`${ctx.hosted.url}/tabs/${ctx.hosted.gid}/focused`, {}).catch(() => {});
    // One of this app's tabs in SmartDesktop's window: its menu goes there again, up to date.
    if (ctx?.remote) sendMenu(true);
  };

  // The app's menu (an Electron Menu, made by the app's menu.js): its menu bar's, and with no windows
  // of its own, SmartDesktop's while one of its tabs is in front (as data, its items run here when
  // chosen there: see menu-wire.js).
  let appMenu = null;
  let menuClicks = new Map();
  let menuSent = null;
  function setMenu(menu) {
    appMenu = menu;
    Menu.setApplicationMenu(menu);
    sendMenu();
  }
  function sendMenu(again = false) {
    const desktop = shell();
    if (!desktop || !appMenu) return;
    const { data, clicks } = toData(appMenu);
    menuClicks = clicks;
    const text = JSON.stringify(data);
    if (text === menuSent && !again) return;
    menuSent = text;
    post(`${desktop.url}/menu`, { app: appId, menu: { name, ...data } }).catch(() => {});
  }
  function menuClick(id) {
    menuClicks.get(id)?.click?.();
  }
  const strips = new Map(); // the top bar's webContents id → its window

  const tabBounds = (host) => {
    const { width, height } = host.win.getContentBounds();
    return { x: 0, y: topBar, width, height: Math.max(0, height - topBar) };
  };
  const layoutTabs = (host) => {
    for (const tab of host.tabs) tab.view.setBounds(tabBounds(host));
  };

  // `bounds`, where to put it (a tab dragged out of a window makes one where it's dropped). It opens
  // with a tab on home, or `empty` for a tab about to be moved into it (giving { host }).
  function createWindow({ focus = true, bounds = null, empty = false } = {}) {
    // With no windows of its own, a window is a tab on home in SmartDesktop's.
    if (!empty && shell()) return createTab(null, { home: true, focus });
    const colour = colours();
    const frame = process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: (topBar - trafficLights) / 2 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: colour.bar, symbolColor: colour.symbols, height: topBar } };
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      ...bounds,
      minWidth: 760,
      minHeight: 480,
      title,
      backgroundColor: colour.bar,
      show: focus,
      ...frame,
      webPreferences: {
        preload: pages.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Placed again once made: macOS fits a new window on the screen, which would move a tab dragged
    // out from under the pointer.
    if (bounds) win.setBounds(bounds);
    // The window's name, not the page's.
    win.on('page-title-updated', (event) => event.preventDefault());
    const host = { win, tabs: [], active: null };
    hosts.add(host);
    strips.set(win.webContents.id, host);
    win.webContents.on('did-finish-load', () => sendTabs(host));
    win.loadFile(pages.tabs);
    win.on('resize', () => layoutTabs(host));
    // The window has the focus: its active tab does, for the menu, the AI chat (SmartDesktop shows the
    // chat while a window of the apps has the focus) and the keyboard.
    win.on('focus', () => {
      host.focusedAt = Date.now(); // the window in front, for where a dragged tab is dropped
      const ctx = host.active;
      if (!ctx) return;
      focused(ctx);
      ctx.contents.focus();
      desktop().focus(ctx.id, win.getBounds());
      changed();
    });
    const away = () => host.active && desktop().blur(host.active.id);
    win.on('blur', away);
    win.on('minimize', away);
    win.on('hide', away);
    // In full screen macOS moves the traffic lights out of the top bar, so the interface can reclaim
    // the space reserved for them.
    const fullScreen = (on) => {
      win.webContents.send('full-screen', on);
      for (const tab of host.tabs) tab.contents.send('full-screen', on);
    };
    win.on('enter-full-screen', () => fullScreen(true));
    win.on('leave-full-screen', () => fullScreen(false));
    win.on('closed', () => {
      hosts.delete(host);
      for (const tab of [...host.tabs]) disposeTab(tab);
      host.tabs = [];
      if (lastFocused?.host === host) focused([...windows.values()].at(-1) ?? null);
      changed();
    });
    if (empty) return { host };
    const home = createTab(host, { home: true });
    activateTab(home);
    return home;
  }

  // A new tab on home (the top bar's +, File › New Tab), in the window last used, or a new window.
  function newTab(host = lastFocused?.host) {
    if (shell()) return createTab(null, { home: true });
    if (newTabIn) return newTabIn(host && !host.win?.isDestroyed() ? host : null);
    if (!host || host.win.isDestroyed()) return createWindow();
    const ctx = createTab(host, { home: true });
    activateTab(ctx);
    host.win.focus();
    return ctx;
  }

  function createTab(host, options = {}) {
    if (shell()) return createRemoteTab(options);
    const { home = false } = options;
    const id = `w-${randomUUID().slice(0, 4)}`;
    const view = new WebContentsView({
      webPreferences: {
        preload: pages.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [`--${appId}-window=${id}`, `--${appId}-tab=${home ? 'home' : 'document'}`],
      },
    });
    view.setBackgroundColor(colours().background);
    const contents = view.webContents;
    // On home (`home`), or about to be sent what to show (its page waits for it, rather than showing
    // home first).
    // `waiting`: opened to show something, and not showing it yet (the app clears it).
    const ctx = { id, host, get home() { return isHome(this); }, waiting: !home, view, contents, get win() { return this.host.win; }, ready: null, session: null, untouched: true, where: home ? 'home' : null, name: null, history: { back: false, forward: false } };
    windows.set(contents.id, ctx);
    // At the end, or just after `after` (a tab in the same window: "open in a new tab" puts it beside
    // the one it came from).
    const after = options.after && host.tabs.indexOf(options.after);
    if (after >= 0) host.tabs.splice(after + 1, 0, ctx);
    else host.tabs.push(ctx);
    // SmartDesktop is told the tab is on home: what happens there goes to no chat.
    if (home) desktop().window(id, { home: true, title: 'Home' });
    view.setVisible(false);
    host.win.contentView.addChildView(view);
    view.setBounds(tabBounds(host));
    // What a tab shows is written by an AI, and its links must never replace the interface: they
    // open in the browser, if they're web links at all.
    const openLink = (url) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
    };
    contents.on('will-navigate', (event, url) => {
      event.preventDefault();
      openLink(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      openLink(url);
      return { action: 'deny' };
    });
    ctx.ready = new Promise((resolve) => contents.once('did-finish-load', resolve));
    setupTab(ctx, options);
    ctx.ready.then(() => tabReady(ctx));
    ctx.ready.then(() => ctx.host.active === ctx && ctx.contents.send('tab-lines', ctx.host.lines ?? null));
    contents.loadFile(pages.index);
    changed();
    sendTabs(host);
    return ctx;
  }

  // Another app's page, shown here as a tab of this window (a guest tab): that app (`app`, its id;
  // `name`) serves it from its guest server (`url`), with what to show (`open`, that app's own
  // request). Its page gets that app's API (guest-preload.cjs), its calls passed on to that app and
  // its events passed back; this app sends it only what the window's shell sends every tab. Its
  // title, icon and back and forward come from that app (`guest-tab`), and that app closing it
  // (`guest-close`), or going, closes it here.
  async function createGuestTab(host, { app: guestApp, name: guestName = guestApp, url, open = null, gid: given = null, kind = null }) {
    const guestApi = await (await fetch(`${url}/api`)).json();
    // A tab its app made already (`given`), or a new one asked of it.
    const gid = given ?? (await post(`${url}/tabs`, { open })).id;
    const id = `w-${randomUUID().slice(0, 4)}`;
    const view = new WebContentsView({
      webPreferences: {
        preload: GUEST_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The tab's id as its app knows it (a prompt copied from its page names it).
        // (Opened with nothing to show, it's on its app's home.)
        additionalArguments: [`--${guestApi.id}-window=${gid}`, `--${guestApi.id}-tab=${kind ?? (open ? 'document' : 'home')}`],
      },
    });
    view.setBackgroundColor(colours().background);
    const page = view.webContents;
    // Until its page has loaded, what its app sends it waits.
    let loaded = false;
    const waiting = [];
    const toPage = (channel, value) => (loaded ? page.send(channel, value) : waiting.push([channel, value]));
    const contents = { id: page.id, send: (channel, value) => SHELL_CHANNELS.has(channel) && toPage(channel, value), focus: () => page.focus(), close: () => page.close(), isDestroyed: () => page.isDestroyed() };
    const controller = new AbortController();
    const ctx = { id, host, get home() { return Boolean(this.hosted?.state?.home); }, view, contents, get win() { return this.host.win; }, ready: null, session: null, untouched: false, where: null, name: null, history: { back: false, forward: false },
      hosted: { app: guestApp, name: guestName, url, gid, api: guestApi, state: null, stop: () => controller.abort() } };
    windows.set(page.id, ctx);
    host.tabs.push(ctx);
    view.setVisible(false);
    host.win.contentView.addChildView(view);
    view.setBounds(tabBounds(host));
    const openLink = (link) => {
      if (/^https?:/i.test(link) && !link.startsWith(url)) shell.openExternal(link);
    };
    page.on('will-navigate', (event, link) => {
      event.preventDefault();
      openLink(link);
    });
    page.setWindowOpenHandler(({ url: link }) => {
      openLink(link);
      return { action: 'deny' };
    });
    ctx.ready = new Promise((resolve) => page.once('did-finish-load', resolve));
    ctx.ready.then(() => {
      loaded = true;
      for (const [channel, value] of waiting.splice(0)) page.send(channel, value);
      if (ctx.host.active === ctx) page.send('tab-lines', ctx.host.lines ?? null);
    });
    listen(`${url}/tabs/${gid}/events`, controller.signal, ({ channel, value }) => {
      if (channel === 'guest-ui') return showForGuest(ctx, value);
      if (channel === 'guest-tab') {
        ctx.hosted.state = value;
        ctx.history = { back: Boolean(value?.back), forward: Boolean(value?.forward) };
        return sendTabs(ctx.host);
      }
      if (channel === 'guest-close') {
        closeTab(ctx);
        // Taken back by its app (moveToApp): it moved out of this window.
        if (ctx.movingOut) leftEmpty(ctx.host);
        return;
      }
      toPage(channel, value);
    })
      // Its app has gone (quit, say): the tab goes with it.
      .catch(() => {})
      .then(() => windows.has(page.id) && closeTab(ctx));
    page.loadURL(`${url}/page/index.html`);
    changed();
    sendTabs(host);
    return ctx;
  }

  // A tab of another app's (`entry`: its family entry), opened by this app (SmartDesktop's New Tab):
  // on that app's home, or showing `open`, in `host` (or a new window), showing, the window brought
  // forward.
  async function openApp(entry, { host = lastFocused?.host, open = null } = {}) {
    if (!entry?.serving || !localServer(entry.url)) throw new Error('Not an app of the family');
    const into = host && !host.win.isDestroyed() ? host : createWindow({ empty: true }).host;
    const ctx = await createGuestTab(into, { app: entry.app, name: entry.name, url: entry.url, open });
    activateTab(ctx);
    into.win.show();
    into.win.focus();
    return ctx;
  }

  // A tab of this app's in SmartDesktop's window (`windowless`): a guest tab made here, which
  // SmartDesktop is asked to show (behind the one showing, with `focus` false). It's what createTab
  // gives, so everything that opens a tab (the user, an AI, a dropped file) opens one there.
  // SmartDesktop, for an app with no windows of its own: started if it isn't running (the app's
  // desktop.js), and waited for until it shows tabs (the user's choice, 2026-11-26: an app opens its
  // tabs there, starting it; only if it can't be started does the app open a window of its own).
  // The Dock icon follows: hidden while the app's tabs are SmartDesktop's, shown when they're its own.
  async function ensureSmartDesktop() {
    if (!windowless || !family || !guestServer) return false;
    if (!shell()) {
      const started = await Promise.resolve(desktop()?.start?.()).catch(() => false);
      if (started) for (let i = 0; i < 40 && !shell(); i++) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const there = Boolean(shell());
    if (there) electronApp.dock?.hide();
    else electronApp.dock?.show();
    return there;
  }
  // The app opened again (from the Finder, say): one of its tabs in SmartDesktop brought forward, the
  // one last used, if it has any there. Gives whether it had one.
  function showTabs() {
    const tab = lastFocused?.remote && windows.has(lastFocused.contents.id) ? lastFocused : [...windows.values()].find((one) => one.remote);
    if (!tab) return false;
    showRemote(tab);
    return true;
  }

  function createRemoteTab(options = {}) {
    const { home = false, focus = true } = options;
    const ctx = guestServer.open({ home, setup: options });
    ctx.remote = true;
    showRemote(ctx, { focus, kind: home ? 'home' : 'document' });
    return ctx;
  }
  function showRemote(ctx, { focus = true, kind } = {}) {
    const desktop = shell();
    if (!desktop) return;
    post(`${desktop.url}/host`, { app: appId, url: guestUrl, gid: ctx.id, kind, focus }).catch((error) => console.error('SmartDesktop couldn’t show the tab:', error.message));
  }

  // Another app asks this one to show its tab (guests.js's `host`): in the window last used, at the
  // end of its tabs, showing, the window brought forward. Only an app of the family's that's running,
  // from its own server on this Mac.
  async function hostGuest({ app: guestApp, url, open = null, at = null, gid = null, kind = null, focus = true }) {
    const known = family?.get(guestApp);
    if (!known?.serving || known.url !== url || !localServer(url)) throw new Error('Not an app of the family');
    // A tab that app made itself (it has no windows of its own): shown, or brought forward if it is.
    if (gid) {
      const showing = [...windows.values()].find((tab) => tab.hosted?.app === guestApp && tab.hosted.gid === gid);
      if (showing) {
        activateTab(showing);
        showing.host.win.show();
        showing.host.win.focus();
        electronApp.focus({ steal: true });
        return showing;
      }
    }
    // Dropped on a top bar: there, where it was let go; else the window last used.
    dropOver(null);
    const target = at ? foreignTarget(at) : null;
    const host = target?.host ?? lastFocused?.host ?? [...hosts][0] ?? createWindow({ empty: true }).host;
    const ctx = await createGuestTab(host, { app: guestApp, name: known.name, url, open, gid, kind });
    if (gid && !focus) {
      // Behind the one showing (an AI's tab, opened while the user works in another).
      if (!host.active) activateTab(ctx);
      else sendTabs(host);
      if (!host.win.isVisible()) host.win.showInactive();
      return ctx;
    }
    if (target) {
      host.tabs.splice(host.tabs.indexOf(ctx), 1);
      host.tabs.splice(Math.max(0, Math.min(target.index, host.tabs.length)), 0, ctx);
    }
    activateTab(ctx);
    host.win.show();
    host.win.focus();
    electronApp.focus({ steal: true });
    return ctx;
  }

  // Another app's tab dragged over this one's windows (guests.js's `over`): the top bar under the
  // point shows where it would go, as for a tab of its own. Only top bars count: dropped anywhere
  // else, the app it's from makes a window of its own for it.
  const tabDragShared = createTabDrag({ topBar });
  const hostsByFront = () => [...hosts].sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0));
  // This app's window in front under `point` (any part of it, or just above it), when it last had the
  // focus (`at`, for comparing with other apps' windows there: which is in front isn't known across
  // apps, so the one used last counts as in front), and where in its top bar a tab would go, if it's
  // over that (`target`).
  function underPoint(point, dragId = null) {
    for (const host of hostsByFront()) {
      const { win: w } = host;
      if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) continue;
      const b = w.getContentBounds();
      if (point.x < b.x || point.x >= b.x + b.width || point.y < b.y - 24 || point.y >= b.y + b.height) continue;
      return { at: host.focusedAt ?? 0, target: tabDragShared.targetAt(point, [host], dragId) };
    }
    return null;
  }
  const foreignTarget = (point) => underPoint(point)?.target ?? null;
  let foreignOver = null; // the target a dragged tab of another app's is shown over
  // `front`: when the dragging app's own window under the point last had the focus (0 if none):
  // this app's is in front only if used since.
  function dropOver(point, front = 0) {
    const under = point ? underPoint(point) : null;
    const inFront = Boolean(under && under.at > front);
    const target = inFront ? under.target : null;
    const before = foreignOver;
    foreignOver = target;
    if (before && before.host !== target?.host && !before.host.win.isDestroyed()) before.host.win.webContents.send('tab-drop', null);
    if (target && (target.host !== before?.host || target.index !== before.index || target.x !== before.x)) target.host.win.webContents.send('tab-drop', { id: null, index: target.index, x: target.x });
    return { over: Boolean(target), front: inFront };
  }

  // Moves this app's tab to another app's window (`other`: its family entry), as a guest there
  // (`at`: where on the screen it was dropped, for its top bar): the tab here closes once it's open
  // there.
  // A guest tab here (another app's) moves the same way: back to its own app, which takes it back as
  // a tab of its own (and closes it here), or on to a third, as a guest of its own app's there.
  async function moveToApp(ctx, other, at = null) {
    const fail = (error) => ({ ok: false, error: error.message });
    let result;
    if (ctx.hosted) {
      const origin = ctx.hosted;
      if (other.app === origin.app) {
        ctx.movingOut = true;
        result = await post(`${origin.url}/tabs/${origin.gid}/return`, { at }).catch(fail);
        if (!result.ok) {
          ctx.movingOut = false;
          console.error(`Couldn’t move the tab back to ${other.name}:`, result.error);
        }
        return; // its app closes it here, as it takes it back
      }
      const { open = null } = await fetch(`${origin.url}/tabs/${origin.gid}/open`).then((res) => res.json()).catch(() => ({}));
      if (!open) return;
      result = await post(`${other.url}/host`, { app: origin.app, url: origin.url, open, at }).catch(fail);
    } else {
      const open = guestOpen(ctx);
      if (!open || !guestUrl) return;
      result = await post(`${other.url}/host`, { app: appId, url: guestUrl, open, at }).catch(fail);
    }
    if (result.ok) {
      const from = ctx.host;
      closeTab(ctx);
      leftEmpty(from);
    } else console.error(`Couldn’t move the tab to ${other.name}:`, result.error);
  }

  // A tab of this app's shown in another app's window comes back (guests.js's `return`), as a tab of
  // its own showing what it showed there: where it was dropped (a top bar), else in the window last
  // used, showing, the window brought forward. Its guest tab closes, and with it the other app's.
  async function returnGuest(guest, at) {
    const open = guestOpen(guest);
    if (!open) throw new Error('It can’t be moved');
    dropOver(null);
    const target = at ? foreignTarget(at) : null;
    const host = target?.host ?? lastFocused?.host ?? [...hosts][0] ?? createWindow({ empty: true }).host;
    const ctx = createTab(host);
    if (target) {
      host.tabs.splice(host.tabs.indexOf(ctx), 1);
      host.tabs.splice(Math.max(0, Math.min(target.index, host.tabs.length)), 0, ctx);
    }
    activateTab(ctx);
    host.win.show();
    host.win.focus();
    electronApp.focus({ steal: true });
    closeTab(guest);
    await ctx.ready;
    guestOpened(ctx, open);
  }

  // "Move to SmartPrep Window" for each other app of the family's that shows guests, for a tab of this
  // app's that can be shown as one, or a guest tab here (which can go back to its own app, or on).
  function moveItems(tab) {
    if (tab.home || !family || (!tab.hosted && (!guestUrl || !guestOpen(tab)))) return [];
    const others = family.others(appId).filter((other) => other.hosting);
    if (!others.length) return [];
    return [...others.map((other) => ({ label: `Move to ${other.name} Window`, click: () => moveToApp(tab, other) })), { type: 'separator' }];
  }

  // This app's guest server (guests.js): it shows other apps' tabs (hostGuest), and with `files` (its
  // built pages) and `run` (its handlers, by channel) serves its own as guests in theirs. It's
  // announced to the family while it runs.
  // `media(parts)`: a file of the app's its pages play or read, served too (SmartStudio's takes).
  async function serveGuests({ files = null, run = null, media = null } = {}) {
    const serving = Boolean(files && run && api);
    const server = await startGuestServer({
      files: serving ? files : null,
      api: serving ? api : null,
      open: (send, options) => createGuest(send, options),
      close: (ctx) => removeGuest(ctx),
      opening: (ctx) => guestOpen(ctx),
      answered: (ctx, ask, value) => answered(ctx, ask, value),
      focused: (ctx) => focused(ctx),
      menuClick: (id) => menuClick(id),
      menu: onAppMenu,
      returned: (ctx, at) => returnGuest(ctx, at),
      call: (ctx, channel, args) => run(ctx, channel, args),
      media: serving ? media : null,
      host: (request) => hostGuest(request),
      over: (point, front) => dropOver(point, front),
    });
    guestUrl = server.url;
    guestServer = server;
    family?.announce({ app: appId, name, url: server.url, hosting: true, serving });
    electronApp.on('will-quit', () => {
      server.stop();
      family?.withdraw(appId);
    });
    return server;
  }

  // A window its last tab has moved out of (to another window, or another app's) closes, as one whose
  // last tab is closed does.
  function leftEmpty(host) {
    if (!host || host.guest || host.win.isDestroyed() || host.tabs.length) return;
    host.win.close();
  }

  // Shows a tab, the others hidden behind it.
  function activateTab(ctx) {
    // A guest tab of this app's shows as the window showing it (another app's) chooses; one in
    // SmartDesktop's window that this app made, it brings forward there.
    if (ctx.guest) {
      if (ctx.remote) showRemote(ctx);
      return;
    }
    const { host } = ctx;
    const before = host.active;
    host.active = ctx;
    for (const tab of host.tabs) {
      tab.view.setVisible(tab === ctx);
      // The lower halves of the top bar's pills are drawn by the tab showing (see tab-lines).
      tab.contents.send('tab-lines', tab === ctx ? host.lines ?? null : null);
    }
    if (host.win.isFocused()) {
      if (before && before !== ctx) desktop().blur(before.id);
      desktop().focus(ctx.id, host.win.getBounds());
      ctx.contents.focus();
    }
    if (host.win.isFocused() || !lastFocused || lastFocused.host === host) focused(ctx);
    onActivate(ctx);
    changed();
    sendTabs(host);
  }

  // A guest tab: one of this app's pages shown in another app's window (guests.js serves it), which
  // counts here as a tab of its own in a window of its own that has nothing else: `send` is how
  // what this app would send its page reaches it (over the guest server's stream). Its title and
  // icon go to the window showing it (`guest-tab`), as a top bar's tabs do, and closing it asks that
  // window to (`guest-close`). An AI works in one as in any tab (`use_window` with its id, which its
  // page knows), its pill and chat shown by that window; it has no window here, so nothing shows it.
  // (`home`: made by this app on home, else waiting for what it's sent; `setup`: createTab's options,
  // for setupTab.)
  function createGuest(send, { open = null, home = !open, setup = {} } = {}) {
    const id = `g-${randomUUID().slice(0, 4)}`;
    const host = { guest: true, win: null, tabs: [], active: null };
    const contents = { id: `guest:${id}`, send, focus() {}, isDestroyed: () => false };
    const ctx = { id, guest: true, host, get home() { return isHome(this); }, waiting: !home, view: null, contents, win: null, ready: Promise.resolve(), session: null, untouched: true, where: home ? 'home' : null, name: null, history: { back: false, forward: false } };
    host.tabs.push(ctx);
    host.active = ctx;
    windows.set(contents.id, ctx);
    setupTab(ctx, setup);
    tabReady(ctx);
    if (open) guestOpened(ctx, open);
    changed();
    return ctx;
  }
  function removeGuest(ctx) {
    if (!windows.has(ctx.contents.id)) return;
    // What it asked its window to show goes unanswered.
    for (const [ask, waiting] of asks) {
      if (waiting.ctx !== ctx) continue;
      asks.delete(ask);
      waiting.resolve(null);
    }
    disposeTab(ctx);
  }

  // A menu over a tab's window (`items`: { id, label, enabled, separator }), giving the id chosen or
  // null; and a message box (Electron's options), giving its { response, checkboxChecked }. A guest
  // tab has no window here: the window showing it (another app's) shows them, and answers.
  const asks = new Map(); // ask → { ctx, resolve }
  let asked = 0;
  function askWindow(ctx, kind, value) {
    return new Promise((resolve) => {
      const ask = ++asked;
      asks.set(ask, { ctx, resolve });
      ctx.contents.send('guest-ui', { ask, kind, value });
    });
  }
  function answered(ctx, ask, value) {
    const waiting = asks.get(ask);
    if (!waiting || waiting.ctx !== ctx) return;
    asks.delete(ask);
    waiting.resolve(value);
  }
  function popupMenu(ctx, items) {
    if (ctx?.guest) return askWindow(ctx, 'menu', { items });
    return new Promise((resolve) => {
      const template = (items ?? []).map((item) => (item.separator ? { type: 'separator' } : { label: String(item.label), enabled: item.enabled !== false, click: () => resolve(item.id ?? null) }));
      Menu.buildFromTemplate(template).popup({ window: ctx?.win ?? undefined, callback: () => setTimeout(() => resolve(null), 100) });
    });
  }
  // A question in a sheet of its own (confirm/confirm.js: `question` as it takes), giving the chosen
  // button's choice, or 'cancel'.
  async function confirmSheet(ctx, question) {
    if (ctx?.guest) return (await askWindow(ctx, 'confirm', question)) ?? 'cancel';
    return confirm(ctx?.win ?? null, question);
  }
  // The Mac's file picker and save panel (Electron's options; { canceled, filePaths } and
  // { canceled, filePath }), over the tab's window or the window showing a guest tab: the paths are
  // on this Mac either way.
  async function openDialog(ctx, options) {
    if (ctx?.guest) return (await askWindow(ctx, 'open', options)) ?? { canceled: true, filePaths: [] };
    return dialog.showOpenDialog(...(ctx?.win ? [ctx.win] : []), options);
  }
  async function saveDialog(ctx, options) {
    if (ctx?.guest) return (await askWindow(ctx, 'save', options)) ?? { canceled: true, filePath: undefined };
    return dialog.showSaveDialog(...(ctx?.win ? [ctx.win] : []), options);
  }
  async function messageBox(ctx, options) {
    if (ctx?.guest) return (await askWindow(ctx, 'message', options)) ?? { response: options.cancelId ?? 0, checkboxChecked: false };
    return dialog.showMessageBox(ctx?.win ?? undefined, options);
  }
  // A guest tab here asks for one: shown over this window, and the answer sent back to its app.
  async function showForGuest(ctx, { ask, kind, value } = {}) {
    let answer = null;
    try {
      if (kind === 'menu') answer = await popupMenu(ctx, value?.items);
      else if (kind === 'confirm') answer = await confirm(ctx.win, value);
      else if (kind === 'open') {
        const { canceled, filePaths } = await dialog.showOpenDialog(ctx.win, value);
        answer = { canceled, filePaths };
      } else if (kind === 'save') {
        const { canceled, filePath } = await dialog.showSaveDialog(ctx.win, value);
        answer = { canceled, filePath };
      }
      else if (kind === 'message') {
        const { response, checkboxChecked } = await dialog.showMessageBox(ctx.win, value);
        answer = { response, checkboxChecked };
      }
    } catch {
      answer = null;
    }
    const { url, gid } = ctx.hosted;
    await post(`${url}/tabs/${gid}/answer`, { ask, value: answer }).catch(() => {});
  }

  // Closes a tab: the tab beside it shows instead, and closing a window's last tab closes the window.
  // A workspace an AI works in with no tab (SmartDoc's `headless`) has nothing to close; a guest tab
  // asks the window showing it to close it.
  function closeTab(ctx) {
    if (ctx.headless) return;
    if (ctx.guest) {
      ctx.contents.send('guest-close', null);
      return removeGuest(ctx);
    }
    const { host } = ctx;
    const at = host.tabs.indexOf(ctx);
    if (at < 0) return;
    host.tabs.splice(at, 1);
    if (host.active === ctx) {
      host.active = null;
      if (host.tabs.length) activateTab(host.tabs[at] ?? host.tabs[at - 1] ?? host.tabs[0]);
    }
    disposeTab(ctx);
    host.win.contentView.removeChildView(ctx.view);
    ctx.contents.close();
    if (!host.tabs.length) return host.win.close();
    sendTabs(host);
  }

  function disposeTab(ctx) {
    if (!windows.has(ctx.contents.id)) return;
    windows.delete(ctx.contents.id);
    ctx.hosted?.stop();
    if (lastFocused === ctx) focused(ctx.host.active !== ctx ? ctx.host.active : [...windows.values()].at(-1) ?? null);
    release(ctx);
    desktop().closed(ctx.id);
    changed();
  }

  // Moves a tab to `index` among a window's tabs: in its own window, or into
  // another (its page, and all it holds, go with it: what it shows, its history, an AI working in
  // it), where it shows.
  function moveTab(ctx, to, index) {
    const from = ctx.host;
    const at = from.tabs.indexOf(ctx);
    if (at < 0 || to.win.isDestroyed()) return;
    from.tabs.splice(at, 1);
    if (from !== to) {
      if (from.active === ctx) {
        from.active = null;
        if (from.tabs.length) activateTab(from.tabs[at] ?? from.tabs[at - 1] ?? from.tabs[0]);
      }
      from.win.contentView.removeChildView(ctx.view);
      ctx.host = to;
      to.win.contentView.addChildView(ctx.view);
      ctx.view.setBounds(tabBounds(to));
      ctx.contents.send('full-screen', to.win.isFullScreen());
      sendTabs(from);
      leftEmpty(from);
    }
    to.tabs.splice(Math.max(0, Math.min(index, to.tabs.length)), 0, ctx);
    activateTab(ctx);
    if (from !== to) to.win.focus();
  }

  // The top bar's state for each window: its tabs (each by its name and icon, or Home,
  // with the AI working in it and the chat owning it), back and forward for the active tab, and the
  // app's status.
  function sendTabs(host) {
    // A guest tab's window is another app's: it hears the tab's title and icon, for its top bar.
    if (host?.guest) {
      const tab = host.active;
      if (tab) {
        const { title: name, icon, ai } = tabState(tab);
        tab.contents.send('guest-tab', { title: name, icon, home: Boolean(tab.home), ai: ai ?? null, chat: tab.chat ?? null, back: Boolean(tab.history.back), forward: Boolean(tab.history.forward), doc: docOf(tab) });
      }
      return;
    }
    if (!host || host.win.isDestroyed()) return;
    const state = {
      tabs: host.tabs.map((t) => {
        const { title: name, icon, ai } = stateOf(t);
        return { id: t.id, home: t.home, title: name, icon: t.home ? null : icon, active: t === host.active, ai: ai ?? null, chat: (t.hosted ? t.hosted.state?.chat : t.chat) ?? null };
      }),
      back: Boolean(host.active?.history.back),
      forward: Boolean(host.active?.history.forward),
      status: status(),
      ...extraState(),
    };
    host.win.webContents.send('tabs', state);
  }
  // A tab's title, icon and AI: a guest tab's from its app (`guest-tab`), else this app's own.
  function stateOf(t) {
    if (!t.hosted) return tabState(t);
    const { title: name = t.hosted.name, icon = null, ai = null } = t.hosted.state ?? {};
    return { title: name, icon, ai };
  }
  const sendAllTabs = () => {
    for (const host of hosts) sendTabs(host);
  };


  // The next or previous tab in the window (the menu's Show Next Tab and Show Previous Tab).
  function stepTab(delta) {
    const host = lastFocused?.host;
    if (!host) return;
    const at = host.tabs.indexOf(host.active);
    activateTab(host.tabs[(at + delta + host.tabs.length) % host.tabs.length]);
  }

  // A tab's chat button: shows that tab, and its chat in SmartDesktop, brought forward ready to type in.
  function openChatFor(tab) {
    activateTab(tab);
    return desktop().chat(tab.id, true);
  }

  // The top bar's requests, and dragging tabs, through the app's `handle` (which finds the tab
  // asking: `ctx`).
  function handlers(handle) {
    // The top bar (tab-strip.js): its state, choosing and closing tabs, back and forward (done by the
    // active tab, whose history it is, which says when they change), and the status pill, which opens
    // the panel in the active tab.
    handle('tabs-state', (ctx) => {
      if (ctx?.host) setTimeout(() => sendTabs(ctx.host));
      return null;
    });
    handle('tab-activate', (ctx, id) => {
      const tab = ctx?.host.tabs.find((t) => t.id === id);
      if (tab) activateTab(tab);
    });
    // A tab by its id, or the tab asking (what it showed gone, say).
    handle('tab-close', (ctx, id = null) => {
      const tab = id ? ctx?.host.tabs.find((t) => t.id === id) : ctx;
      if (tab) closeTab(tab);
    });
    handle('history-step', (ctx, delta) => ctx?.contents.send('history-step', delta));
    // A tab's right-click menu: choosing its icon (in a card the tab showing draws, under the tab:
    // `box` is the tab's place in the top bar), and closing it.
    handle('tab-menu', (ctx, id, box) => {
      const host = ctx?.host;
      const tab = host?.tabs.find((t) => t.id === id);
      if (!tab) return;
      // A guest tab's document is its app's, which draws the card (and keeps the icon).
      const docId = tab.hosted ? tab.hosted.state?.doc ?? null : docOf(tab);
      const { title: tabName, icon: tabIcon } = stateOf(tab);
      const chooseIcon = () => {
        const request = { docId, current: tabIcon, name: tab.name ?? tabName, at: { left: box.left, top: 6 } };
        // Drawn by the tab showing (under its tab); a guest's by its own page.
        if (host.active?.hosted || tab.hosted) activateTab(tab);
        (tab.hosted ? tab.view.webContents : host.active.contents).send('icon-picker', request);
      };
      Menu.buildFromTemplate([
        // The chat that owns it, if one does; and (only with SmartDesktop installed: the user's
        // choice) a chat for it, named for what it does (the user's choice, 2026-11-26: Open in Chat
        // didn't say): Show the Chat for the tab's own chat (on home, the chat last used), New Chat
        // for This Tab when it has none, starting one that owns it. Either is brought forward ready
        // to type in.
        ...(tab.chat ? [{ label: `Chat: ${tab.chat.title}`, enabled: false }] : []),
        ...(desktop().installed() ? [{ label: tab.chat || tab.home ? 'Show the Chat' : 'New Chat for This Tab', click: () => openChatFor(tab) }, { type: 'separator' }] : tab.chat ? [{ type: 'separator' }] : []),
        // Another app of the family's running, which can show it as a guest (the trial: this app's
        // tab in that app's window).
        ...moveItems(tab),
        { label: 'Change Icon…', enabled: Boolean(docId), click: chooseIcon },
        { type: 'separator' },
        { label: 'Close Tab', click: () => closeTab(tab) },
      ]).popup({ window: host.win });
    });
    handle('tab-chat', (_ctx, id) => {
      const tab = [...windows.values()].find((t) => t.id === id);
      // A guest tab's chat is its own app's: that app brings it forward.
      if (tab?.hosted) return post(`${tab.hosted.url}/tabs/${tab.hosted.gid}/call`, { channel: 'tab-chat', args: [tab.hosted.gid] }).catch(() => {});
      if (tab) return openChatFor(tab);
    });
    handle('history-state', (ctx, state) => {
      ctx.history = { back: Boolean(state?.back), forward: Boolean(state?.forward) };
      if (ctx.host.active === ctx) sendTabs(ctx.host);
    });
    handle('show-status', (ctx) => ctx?.contents.send('toggle-status'));
    // The pills under the tab showing and the tab pointed at in the top bar: their lower halves are
    // over the tab showing's page, which draws them there (see tab-strip.js).
    handle('tab-lines', (ctx, lines) => {
      const host = ctx?.host;
      if (!host) return;
      host.lines = lines;
      for (const tab of host.tabs) tab.contents.send('tab-lines', tab === host.active ? lines : null);
    });
    // A tooltip of the top bar's, drawn by the tab showing (the top bar's page is behind it there),
    // its box moved into the tab's page, which starts below the top bar.
    handle('strip-tip', (ctx, tip) => {
      const host = ctx?.host;
      if (!host) return;
      for (const tab of host.tabs) {
        if (tab === host.active && tip) tab.contents.send('strip-tip', { text: tip.text, plain: Boolean(tip.plain), box: { ...tip.box, top: tip.box.top - topBar, bottom: tip.box.bottom - topBar } });
        else tab.contents.send('strip-tip', null);
      }
    });

    // Dragging a tab (tab-strip.js, tab-drag.js): to another place in its top bar, into another
    // window's, or anywhere else to make a new window of it, its picture following the pointer
    // meanwhile. The top bar says where its tabs are (`tab-boxes`), and the one the pointer is over
    // shows where the tab would go (`tab-drop`: { id, index, x }, or null).
    const tabDrag = createTabDrag({ topBar });
    let dragging = null; // { tab, offset, chip, point, target }
    handle('tab-boxes', (ctx, boxes) => {
      if (ctx?.host) ctx.host.tabBoxes = Array.isArray(boxes) ? boxes : [];
    });
    const hostsInFront = () => [...hosts].sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0));
    function dragOver(point) {
      const under = underPoint(point, dragging.tab.id);
      // Another app's window in front here (as last asked): none of this app's takes it.
      const target = dragging.behind ? null : under?.target ?? null;
      const before = dragging.target;
      dragging.target = target;
      if (before && before.host !== target?.host && !before.host.win.isDestroyed()) before.host.win.webContents.send('tab-drop', null);
      if (target && (target.host !== before?.host || target.index !== before.index || target.x !== before.x)) target.host.win.webContents.send('tab-drop', { id: dragging.tab.id, index: target.index, x: target.x });
      tabDrag.move(point);
      askOthers(dragging, point, under?.at ?? 0);
    }
    // The other apps of the family that show guests are asked about the pointer: whether a window
    // of theirs is in front of this app's there (`front`: when this app's there last had the focus),
    // and over its top bar (each showing where the tab would go, if it is). One question at a time,
    // the latest point asked next. Only a tab that can be a guest is dropped in another app; any
    // other still makes a window of its own under another app's window.
    function askOthers(drag, point, front) {
      if (!drag.others) drag.others = family && (guestUrl || drag.tab.hosted) ? family.others(appId).filter((other) => other.hosting) : [];
      if (!drag.others.length) return;
      const movable = Boolean(drag.tab.hosted) || Boolean(guestOpen(drag.tab));
      drag.ask = { point, front };
      if (drag.asking) return;
      drag.asking = (async () => {
        while (drag.ask) {
          const { point: at, front: own } = drag.ask;
          drag.ask = null;
          let foreign = null;
          let behind = false;
          for (const other of drag.others) {
            // Asked with no point, an app stops showing where the tab would go.
            const clear = () => post(`${other.url}/over`, { point: null }).catch(() => {});
            if (behind || !at) {
              if (drag.shown?.has(other)) await clear();
              drag.shown?.delete(other);
              continue;
            }
            const answer = await post(`${other.url}/over`, { point: at, front: own }).catch(() => ({ over: false, front: false }));
            if (answer.front) behind = true;
            if (answer.over && movable) foreign = other;
            else if (answer.over) await clear();
            drag.shown ??= new Set();
            if (answer.over && movable) drag.shown.add(other);
            else drag.shown.delete(other);
          }
          drag.foreign = foreign;
          if (behind !== Boolean(drag.behind)) {
            drag.behind = behind;
            if (dragging === drag) dragOver(drag.point);
          }
        }
        drag.asking = null;
      })();
    }
    handle('tab-drag-start', async (ctx, id, { chip, offset, point } = {}) => {
      const host = ctx?.host;
      const tab = host?.tabs.find((t) => t.id === id);
      if (!tab || dragging || !chip || !offset || !point) return false;
      const drag = { tab, offset, chip, point, target: null };
      dragging = drag;
      const box = { x: Math.round(chip.x), y: Math.round(chip.y), width: Math.max(1, Math.round(chip.width)), height: Math.max(1, Math.round(chip.height)) };
      const chipImage = await host.win.webContents.capturePage(box);
      if (dragging !== drag) return false; // let go meanwhile
      await tabDrag.show({ chip: chipImage, chipSize: box, offset, point: drag.point, colours: colours() });
      if (dragging === drag) dragOver(drag.point);
      return true;
    });
    handle('tab-drag-move', (_ctx, point) => {
      if (!dragging || !point) return;
      dragging.point = point;
      dragOver(point);
    });
    handle('tab-drag-end', async (_ctx, point) => {
      const drag = dragging;
      if (!drag) return;
      if (point) {
        drag.point = point;
        dragOver(point);
      }
      dragging = null;
      tabDrag.hide();
      const { tab } = drag;
      if (drag.target && !drag.target.host.win.isDestroyed()) drag.target.host.win.webContents.send('tab-drop', null);
      // Whether it was let go over another app's window, in front: the last question answered.
      await drag.asking;
      const target = drag.behind ? null : drag.target;
      if (!windows.has(tab.contents.id)) return; // closed meanwhile
      if (target) return moveTab(tab, target.host, target.index);
      if (drag.foreign) return moveToApp(tab, drag.foreign, drag.point);
      // Over no top bar: a new window, the size of the one it came from, its tab under the pointer
      // where it was let go (the window may run off the screen, but never its top bar).
      const from = tab.host;
      const { width, height } = from.win.getBounds();
      const first = from.tabBoxes?.[0]?.left ?? 160; // where a window's first tab starts
      const area = screen.getDisplayNearestPoint({ x: Math.round(drag.point.x), y: Math.round(drag.point.y) }).workArea;
      const KEEP = 160; // of the window, kept on the screen across
      const x = Math.round(Math.min(Math.max(drag.point.x - first - drag.offset.x, area.x + KEEP - width), area.x + area.width - KEEP));
      const y = Math.round(Math.min(Math.max(drag.point.y - drag.chip.y - drag.offset.y, area.y), area.y + area.height - 2 * topBar));
      const { host: made } = createWindow({ bounds: { x, y, width, height }, empty: true });
      moveTab(tab, made, 0);
    });

    // The Home button: the tab showing goes home, as a browser tab goes to a page (its page keeps
    // where it's been, for Back). A guest tab (another app's page) gives way to a tab of this app's
    // own on home, in its place.
    handle('go-home', (ctx) => {
      if (!ctx || ctx.home) return;
      if (ctx.hosted && guestsGoHomeThere) return post(`${ctx.hosted.url}/tabs/${ctx.hosted.gid}/call`, { channel: 'go-home', args: [] }).catch(() => {});
      if (ctx.hosted) {
        const { host } = ctx;
        const at = host.tabs.indexOf(ctx);
        const home = createTab(host, { home: true });
        host.tabs.splice(host.tabs.indexOf(home), 1);
        host.tabs.splice(at, 0, home);
        activateTab(home);
        return closeTab(ctx);
      }
      goHome(ctx);
    });
    // The top bar's +: a new tab on home, in this window.
    handle('tab-new', (ctx) => {
      newTab(ctx?.host);
    });
  }

  return { setMenu, ensureSmartDesktop, showTabs, inSmartDesktop: () => Boolean(shell()), popupMenu, messageBox, confirmSheet, openDialog, saveDialog, createWindow, createTab, newTab, activateTab, closeTab, moveTab, sendTabs, sendAllTabs, stepTab, openChatFor, tabBounds, handlers, strips, createGuest, removeGuest, serveGuests, hostGuest, moveToApp, openApp };
}
