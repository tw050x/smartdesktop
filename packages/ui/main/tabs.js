// Windows of tabs, the same in every app with them (taken from SmartPlan's main.js, which SmartSpec's,
// SmartAd's, SmartPrep's and SmartStudio's matched but for names). A window holds tabs (the user's
// choice: working in tabs rather than in many windows, though more windows are still allowed). The
// first is Home, pinned: it can't be closed, and only it shows home. Each other tab shows one
// document (a board, a schematic, a topic…), and never home. Each tab is what a window was: its own
// history and AI session (`ctx`, with the tab's id, which a copied prompt names so an AI can take it
// over).
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
import { BrowserWindow, ipcMain, Menu, screen, shell, WebContentsView } from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTabDrag } from './tab-drag.js';

// The family's preload (preload.cjs), for an app that gives its pages' API as data (`api`).
const SHARED_PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));

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
}) {
  // With its API as data, every page (the top bar's and each tab's) has the family's preload, which
  // asks for it as it starts.
  if (api) {
    pages = { ...pages, preload: pages.preload ?? SHARED_PRELOAD };
    ipcMain.on('preload-api', (event) => {
      event.returnValue = api;
    });
  }
  let lastFocused = null;
  const focused = (ctx) => {
    lastFocused = ctx;
    onFocused(ctx);
  };
  const strips = new Map(); // the top bar's webContents id → its window

  const tabBounds = (host) => {
    const { width, height } = host.win.getContentBounds();
    return { x: 0, y: topBar, width, height: Math.max(0, height - topBar) };
  };
  const layoutTabs = (host) => {
    for (const tab of host.tabs) tab.view.setBounds(tabBounds(host));
  };

  // `bounds`, where to put it (a tab dragged out of a window makes one where it's dropped).
  function createWindow({ focus = true, bounds = null } = {}) {
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
    const home = createTab(host, { home: true });
    activateTab(home);
    return home;
  }

  function createTab(host, options = {}) {
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
    const ctx = { id, host, home, view, contents, get win() { return this.host.win; }, ready: null, session: null, untouched: true, where: null, name: null, history: { back: false, forward: false } };
    windows.set(contents.id, ctx);
    if (home) host.tabs.unshift(ctx);
    else host.tabs.push(ctx);
    // SmartDesktop is told which tab is Home: what happens there goes to no chat.
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

  // Shows a tab, the others hidden behind it.
  function activateTab(ctx) {
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

  // Closes a tab (Home only closes with its window). The tab beside it shows instead. A workspace an
  // AI works in with no tab (SmartDoc's `headless`) has nothing to close.
  function closeTab(ctx) {
    if (ctx.headless) return;
    const { host } = ctx;
    if (ctx.home) return host.win.close();
    const at = host.tabs.indexOf(ctx);
    if (at < 0) return;
    host.tabs.splice(at, 1);
    if (host.active === ctx) activateTab(host.tabs[at] ?? host.tabs[at - 1] ?? host.tabs[0]);
    disposeTab(ctx);
    host.win.contentView.removeChildView(ctx.view);
    ctx.contents.close();
    sendTabs(host);
  }

  function disposeTab(ctx) {
    if (!windows.has(ctx.contents.id)) return;
    windows.delete(ctx.contents.id);
    if (lastFocused === ctx) focused(ctx.host.active !== ctx ? ctx.host.active : [...windows.values()].at(-1) ?? null);
    release(ctx);
    desktop().closed(ctx.id);
    changed();
  }

  // Moves a tab to `index` among a window's tabs (never before Home): in its own window, or into
  // another (its page, and all it holds, go with it: what it shows, its history, an AI working in
  // it), where it shows.
  function moveTab(ctx, to, index) {
    const from = ctx.host;
    const at = from.tabs.indexOf(ctx);
    if (ctx.home || at < 0 || to.win.isDestroyed()) return;
    from.tabs.splice(at, 1);
    if (from !== to) {
      if (from.active === ctx) {
        from.active = null;
        activateTab(from.tabs[at] ?? from.tabs[at - 1] ?? from.tabs[0]);
      }
      from.win.contentView.removeChildView(ctx.view);
      ctx.host = to;
      to.win.contentView.addChildView(ctx.view);
      ctx.view.setBounds(tabBounds(to));
      ctx.contents.send('full-screen', to.win.isFullScreen());
      sendTabs(from);
    }
    to.tabs.splice(Math.max(1, Math.min(index, to.tabs.length)), 0, ctx);
    activateTab(ctx);
    if (from !== to) to.win.focus();
  }

  // The top bar's state for each window: its tabs (Home first; each other by its name and icon,
  // with the AI working in it and the chat owning it), back and forward for the active tab, and the
  // app's status.
  function sendTabs(host) {
    if (!host || host.win.isDestroyed()) return;
    const state = {
      tabs: host.tabs.map((t) => {
        const { title: name, icon, ai } = tabState(t);
        return { id: t.id, home: t.home, title: name, icon: t.home ? null : icon, active: t === host.active, ai: ai ?? null, chat: t.chat ?? null };
      }),
      back: Boolean(host.active?.history.back),
      forward: Boolean(host.active?.history.forward),
      status: status(),
      ...extraState(),
    };
    host.win.webContents.send('tabs', state);
  }
  const sendAllTabs = () => {
    for (const host of hosts) sendTabs(host);
  };

  // Home, of the window a tab is in.
  const homeOf = (ctx) => ctx?.host?.tabs[0] ?? null;

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
      const docId = docOf(tab);
      Menu.buildFromTemplate([
        // The chat that owns it, if one does; and Open Chat (only with SmartDesktop installed: the
        // user's choice), as its chat button: this tab's chat, or a new one for it (from Home, the
        // chat last used), brought forward ready to type in.
        ...(tab.chat ? [{ label: `Chat: ${tab.chat.title}`, enabled: false }] : []),
        ...(desktop().installed() ? [{ label: 'Open Chat', click: () => openChatFor(tab) }, { type: 'separator' }] : tab.chat ? [{ type: 'separator' }] : []),
        { label: 'Change Icon…', enabled: Boolean(docId), click: () => host.active.contents.send('icon-picker', { docId, current: tabState(tab).icon, name: tab.name ?? tabState(tab).title, at: { left: box.left, top: 6 } }) },
        ...(tab.home ? [] : [{ type: 'separator' }, { label: 'Close Tab', click: () => closeTab(tab) }]),
      ]).popup({ window: host.win });
    });
    handle('tab-chat', (_ctx, id) => {
      const tab = [...windows.values()].find((t) => t.id === id);
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
      const target = tabDrag.targetAt(point, hostsInFront(), dragging.tab.id);
      const before = dragging.target;
      dragging.target = target;
      if (before && before.host !== target?.host && !before.host.win.isDestroyed()) before.host.win.webContents.send('tab-drop', null);
      if (target && (target.host !== before?.host || target.index !== before.index || target.x !== before.x)) target.host.win.webContents.send('tab-drop', { id: dragging.tab.id, index: target.index, x: target.x });
      tabDrag.move(point);
    }
    handle('tab-drag-start', async (ctx, id, { chip, offset, point } = {}) => {
      const host = ctx?.host;
      const tab = host?.tabs.find((t) => t.id === id);
      if (!tab || tab.home || dragging || !chip || !offset || !point) return false;
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
    handle('tab-drag-end', (_ctx, point) => {
      const drag = dragging;
      if (!drag) return;
      if (point) {
        drag.point = point;
        dragOver(point);
      }
      dragging = null;
      tabDrag.hide();
      const { tab, target } = drag;
      if (target && !target.host.win.isDestroyed()) target.host.win.webContents.send('tab-drop', null);
      if (!windows.has(tab.contents.id)) return; // closed meanwhile
      if (target) return moveTab(tab, target.host, target.index);
      // Over no top bar: a new window, the size of the one it came from, its tab under the pointer
      // where it was let go (the window may run off the screen, but never its top bar).
      const from = tab.host;
      const { width, height } = from.win.getBounds();
      const first = from.tabBoxes?.[1]?.left ?? 120; // where a window's first tab after Home starts
      const area = screen.getDisplayNearestPoint({ x: Math.round(drag.point.x), y: Math.round(drag.point.y) }).workArea;
      const KEEP = 160; // of the window, kept on the screen across
      const x = Math.round(Math.min(Math.max(drag.point.x - first - drag.offset.x, area.x + KEEP - width), area.x + area.width - KEEP));
      const y = Math.round(Math.min(Math.max(drag.point.y - drag.chip.y - drag.offset.y, area.y), area.y + area.height - 2 * topBar));
      const home = createWindow({ bounds: { x, y, width, height } });
      moveTab(tab, home.host, 1);
    });

    // Home is a tab of its own: going home shows it.
    handle('go-home', (ctx) => {
      const home = homeOf(ctx);
      if (home && home !== ctx) activateTab(home);
    });
  }

  return { createWindow, createTab, activateTab, closeTab, moveTab, sendTabs, sendAllTabs, homeOf, stepTab, openChatFor, tabBounds, handlers, strips };
}
