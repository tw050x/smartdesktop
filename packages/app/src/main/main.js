// SmartDesktop: the AI chat for SmartDoc and SmartSpec. It has no window of its own and no Dock
// icon, only an icon in the menu bar (Set Up AI…, Settings…, Quit) and the chat, a window floating
// over the apps' windows. SmartDoc and SmartSpec start it when they need it, connect to it (hub.js)
// and tell it about their windows; it runs the user's own AI (agent.js) with both apps' tools, in
// one conversation across them.

import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, nativeTheme, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, createAgent } from './agent.js';
import { firstPlace } from './chat-anchor.js';
import * as grid from './chat-layout.js';
import { startHub } from './hub.js';
import { createUpdates } from './updates.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const page = (name) => path.join(dirname, '../../build/renderer', name);
const resource = (name) => path.join(dirname, '../../resources', name);

// A development copy keeps its data in SmartDesktop Dev, and listens on a port of its own, so it
// runs beside the installed app: the apps' development builds connect to it, and installed apps to
// the installed one. SMARTDESKTOP_USER_DATA and SMARTDESKTOP_PORT move a test copy again.
if (!app.isPackaged) {
  app.setPath('userData', process.env.SMARTDESKTOP_USER_DATA ? path.resolve(process.env.SMARTDESKTOP_USER_DATA) : path.join(app.getPath('appData'), 'SmartDesktop Dev'));
}
// The chat window's name, as Mission Control and the Window menu show it: a development build's says
// so, as the apps' windows do ("SmartDoc Development").
const CHAT_TITLE = app.isPackaged ? 'SmartDesktop' : 'SmartDesktop Development';
const HUB_PORT = app.isPackaged ? 47830 : Number(process.env.SMARTDESKTOP_PORT) || 47831;
const NAME = app.isPackaged ? 'SmartDesktop' : 'SmartDesktop Development';

// One copy runs at a time (per data folder). Opened again (from the Finder, say), it opens the setup.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => app.isReady() && openSetup());

// --- Settings ------------------------------------------------------------------------------
// Kept in settings.json: the appearance, whether the setup has been shown, where the chat was and
// whether it was open.
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(changes) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...changes }, null, 2));
}
const APPEARANCES = ['system', 'light', 'dark'];
nativeTheme.themeSource = APPEARANCES.includes(readSettings().appearance) ? readSettings().appearance : 'system';
function setAppearance(appearance) {
  if (!APPEARANCES.includes(appearance)) return;
  nativeTheme.themeSource = appearance;
  writeSettings({ appearance });
}
const background = () => (nativeTheme.shouldUseDarkColors ? '#232326' : '#ffffff');
nativeTheme.on('updated', () => {
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(background());
});

// --- The apps connected, their tabs, and the chats that own them ------------------------------
// Each app connected (a client of the hub) with its tabs (its windows' tabs: each was a window once,
// and the protocol still calls them windows): what each shows ({ key, text, detail }: a line for its
// chat when it changes, and what the AI is told), whether it's Home, the hint for an empty chat, and
// the shortcuts of what to ask the AI there. `front` is the app tab in front now, if one is (the chat
// shows while one is).
//
// Each chat owns at most one tab in each app, where its AI works (the user's choice): `owned`, chat
// id → { smartdoc: tab id, smartspec: tab id }. Only what happens in a chat's own tabs reaches it;
// Home and tabs no chat owns reach none. Ownership lasts while the app runs (its tab ids are new
// each launch), and each app is told which of its tabs each chat owns (`owners`).
const LABEL = { smartdoc: 'SmartDoc', smartspec: 'SmartSpec' };
const apps = new Map(); // client id → { client, windows: Map(tab id → tab) }
let front = null; // { clientId, windowId }
let lastFront = null; // the app tab last in front
const appOf = (clientId) => apps.get(clientId);
const appNamed = (name) => [...apps.values()].find((a) => a.client.app === name) ?? null;
const windowOf = (at) => (at ? appOf(at.clientId)?.windows.get(at.windowId) ?? null : null);
const owned = new Map(); // chat id → { [app]: tab id }

function upsertWindow(entry, id) {
  if (!entry.windows.has(id)) entry.windows.set(id, { id, title: null, shows: null, home: false, hint: null, shortcuts: [], bounds: null });
  return entry.windows.get(id);
}

// The chat owning an app's tab, if one does.
function ownerOf(appName, tabId) {
  for (const [chatId, tabs] of owned) if (tabs[appName] === tabId) return chatId;
  return null;
}
// A chat comes to own a tab (its only tab in that app; no other chat's any more).
function own(chatId, appName, tabId) {
  for (const tabs of owned.values()) if (tabs[appName] === tabId) delete tabs[appName];
  owned.set(chatId, { ...(owned.get(chatId) ?? {}), [appName]: tabId });
  sendOwners(appName);
  sendChatState();
}
// Tells an app which of its tabs each chat owns, by the chat's name.
const titles = new Map(); // chat id → its name, as last known
function sendOwners(appName) {
  const entry = appNamed(appName);
  if (!entry || !hub) return;
  const tabs = {};
  for (const [chatId, mine] of owned) {
    if (mine[appName] && entry.windows.has(mine[appName])) tabs[mine[appName]] = { chat: chatId, title: titles.get(chatId) ?? 'New chat' };
  }
  hub.send(entry.client.id, { type: 'owners', tabs });
}
const sendAllOwners = () => Object.keys(LABEL).forEach(sendOwners);

// The chat for a request from an app tab (Show the Chat, or a shortcut): the chat owning it, or a
// new chat owning it; from Home (or no tab), the chat last used, or a new one.
async function chatForTab(client, windowId) {
  const win = windowId ? appOf(client.id)?.windows.get(windowId) : null;
  if (win && !win.home) {
    const owner = ownerOf(client.app, windowId);
    if (owner) return owner;
    const chat = await newChat();
    own(chat.id, client.app, windowId);
    return chat.id;
  }
  const last = readSettings().focusedChat;
  if (last && (await agent.load(last))) return last;
  return (await newChat()).id;
}

async function onMessage(client, message) {
  const entry = appOf(client.id);
  if (!entry) throw new Error('Not connected.');
  const id = message.windowId;
  switch (message.type) {
    // What a tab shows, whether it's Home, and what to offer in its chat about it. Where it went is
    // a line of context in the chat owning it; the first thing a tab shows isn't news.
    case 'window': {
      const win = upsertWindow(entry, id);
      if ('home' in message) win.home = Boolean(message.home);
      if (message.shows) {
        const before = win.shows?.key;
        const owner = ownerOf(client.app, id);
        if (owner && before !== undefined && before !== message.shows.key && message.shows.text) {
          agent.note(owner, { text: message.shows.text, detail: `In ${client.name}: ${message.shows.detail ?? message.shows.text}` });
        }
        win.shows = message.shows;
      }
      if ('title' in message) win.title = message.title;
      if ('hint' in message) win.hint = message.hint;
      if ('shortcuts' in message) win.shortcuts = message.shortcuts ?? [];
      sendChatState();
      break;
    }
    case 'closed': {
      entry.windows.delete(id);
      const owner = ownerOf(client.app, id);
      if (owner) delete owned.get(owner)[client.app];
      if (front?.clientId === client.id && front.windowId === id) front = null;
      if (lastFront?.clientId === client.id && lastFront.windowId === id) lastFront = front;
      arrange();
      sendOwners(client.app);
      sendChatState();
      break;
    }
    // A tab of the app came to the front (its window has the focus, and it's the tab showing), or
    // went from it.
    case 'focus': {
      const win = upsertWindow(entry, id);
      if (message.bounds) win.bounds = message.bounds;
      front = { clientId: client.id, windowId: id };
      lastFront = front;
      arrange();
      sendChatState();
      break;
    }
    case 'blur': {
      if (front?.clientId === client.id && front.windowId === id) front = null;
      // The focus moves in steps (one window losing it before the next has it, and the chat's own
      // focus arriving by another way), so where it went is looked at once it's there.
      setTimeout(arrange, 150);
      break;
    }
    // A SmartDesktop chat's AI session took a tab (`smartdesktop-<chat id>`): the chat owns it now,
    // in place of any tab it had in that app.
    case 'session-tab': {
      const chatId = /^smartdesktop-(.+)$/.exec(message.session ?? '')?.[1];
      if (chatId && id && (await agent.load(chatId))) {
        upsertWindow(entry, id);
        own(chatId, client.app, id);
      }
      break;
    }
    // A line of context: what the user did or looked at in a tab (see note in agent.js), for the chat
    // owning it.
    case 'note': {
      const owner = ownerOf(client.app, id);
      const note = message.note ?? {};
      if (owner) await agent.note(owner, { ...note, detail: `In ${client.name}: ${note.detail ?? note.text}` });
      break;
    }
    // Show the Chat (or, from older apps, their chat button: 'toggle'): the tab's chat, or a new one
    // owning it, shown and given the focus.
    case 'chat': {
      if (message.open === false) {
        setChatOpen(false);
        break;
      }
      const chatId = await chatForTab(client, id);
      if (message.open === 'toggle' && chatOpen && readSettings().focusedChat === chatId) {
        setChatOpen(false);
        break;
      }
      showChat(chatId);
      break;
    }
    // A request for the AI from the app (a shortcut in it: Answer my comments, say): the tab's chat
    // sends it, or puts it in its message box if it can't go now.
    case 'ask': {
      const chatId = await chatForTab(client, id);
      showChat(chatId);
      askInChat(chatId, message.text);
      break;
    }
    default:
      throw new Error(`Unknown message: ${message.type}`);
  }
  return { chatOpen };
}

// --- The chats -------------------------------------------------------------------------------

const agent = createAgent({
  userData: app.getPath('userData'),
  // To try the AIs' setup in a development build without touching the user's own (see agent.js).
  trial: app.isPackaged ? null : { home: process.env.SMARTDESKTOP_AI_HOME || null, hide: process.env.SMARTDESKTOP_AI_HIDE || '' },
  onEvent: (event) => {
    // The AI named a chat (or the user did): its tab, and the apps' tabs it owns, say so.
    if (event.type === 'title') {
      titles.set(event.chatId, event.title);
      sendAllOwners();
      sendChatState();
    }
    chatWin()?.webContents.send('agent-event', event);
  },
});
const agentProgress = (progress) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('agent-progress', progress);
};

async function newChat() {
  const chat = await agent.create();
  titles.set(chat.id, chat.title);
  return chat;
}

const SYSTEM = 'You are working inside SmartDesktop, the chat for the user\'s SmartDoc and SmartSpec apps on their Mac. SmartDoc reviews and redrafts documents (PDFs) with the user; SmartSpec holds the design of systems as schematics. You have the tools of whichever of the two are open. This chat has a tab of its own in each app, where its tools act (said below): never call use_window. If it has none in an app yet, your first tool call there opens one for it. Other chats have their own tabs, which you can\'t see. Lines of context say what the user did in this chat\'s tabs and where they went, and "this" means what those tabs show. Only open another document or schematic if they ask. Follow each server\'s instructions: SmartDoc\'s for reviews; in SmartSpec, when the user wants a schematic made or changed, propose it with propose_schematic: only they can accept or discard it, in the app, so tell them to look at it there. Never run a wait command: the user tells you what they decided when they next write. The apps show each tool you use as a step, so don\'t describe your tool calls; keep replies short and plain, and don\'t repeat what the apps already show (findings, proposals and decisions are on screen). A message may start with [What I\'ve done in the apps since my last message, for context: …]: what the user did and looked at in this chat\'s tabs since they last wrote, so you know what they mean by "this"; use it, and don\'t repeat it back. In your first reply in a chat, name the chat for its tab: a few words on what it\'s about, on a line of its own as <title>name</title>; the chat shows it as the tab\'s name, not as text. When it helps, end your reply with up to three short questions the user might want to ask you next, in their words, each on its own line as <suggest>question</suggest>: the chat shows them as buttons, not as text.';

// This chat's own tab in an app, if it has one and it's still open.
const tabOf = (chatId, entry) => {
  const tabId = owned.get(chatId)?.[entry.client.app];
  return tabId && entry.windows.has(tabId) ? tabId : null;
};

// Where things are now, for a chat's AI with each message: its own tab in each app and what it
// shows, and the apps it has none in yet, or that aren't open.
function where(chatId) {
  if (!apps.size) return 'Neither SmartDoc nor SmartSpec is open now, so you have no tools: tell the user to open one.';
  const lines = ['Where things are now, in this chat\'s own tabs:'];
  for (const entry of apps.values()) {
    const tabId = tabOf(chatId, entry);
    const win = tabId && entry.windows.get(tabId);
    if (win) lines.push(`- ${entry.client.name} tab ${tabId}${front?.clientId === entry.client.id && front.windowId === tabId ? ' (in front now)' : ''}: ${win.shows?.detail ?? 'just opened'}`);
    else lines.push(`- ${entry.client.name}: this chat has no tab there yet; your first ${entry.client.name} tool call opens one for it.`);
  }
  for (const name of Object.keys(LABEL)) {
    if (!appNamed(name)) lines.push(`- ${LABEL[name]} isn't open, so its tools aren't available.`);
  }
  return lines.join('\n');
}

// The headers each app's MCP server needs for a chat's AI: who it is (the chat's own session), and
// its tab there, if it has one (without one, the app opens a tab for it, and says which:
// session-tab).
const headersFor = (client, provider, chatId, windowId) => ({
  Authorization: `Bearer ${client.mcp.token}`,
  [`x-${client.app}-session`]: `smartdesktop-${chatId}`,
  [`x-${client.app}-client`]: `smartdesktop-${provider.id}`,
  ...(windowId && { [`x-${client.app}-window`]: windowId }),
});

async function chatSend(chatId, providerId, text, { model = null } = {}) {
  const provider = PROVIDERS[providerId] ?? PROVIDERS.claude;
  if (!apps.size) throw new Error('Open SmartDoc or SmartSpec to chat: the AI works in them.');
  const servers = [...apps.values()].map((entry) => ({ name: entry.client.app, url: entry.client.mcp.url, headers: headersFor(entry.client, provider, chatId, tabOf(chatId, entry)) }));
  // As it starts, each app is told which tab the AI works in (`turn`), and while it works, that it's
  // still there, so the tab stays its.
  let first = true;
  const turn = () => {
    for (const s of servers) {
      fetch(`${s.url}/alive`, { method: 'POST', headers: { ...s.headers, ...(first && { [`x-${s.name}-turn`]: '1' }) }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    first = false;
  };
  focusChat(chatId);
  agent.send(chatId, { provider: provider.id, text, systemPrompt: SYSTEM, where: where(chatId), servers, model, turn })
    .catch((error) => chatWin()?.webContents.send('agent-event', { chatId, type: 'error', error: error.message }));
  return true;
}

// --- The chat's window -----------------------------------------------------------------------
// A window of its own, on the Space the user is on (not every Space: the user's choice, so it isn't a
// panel, which would be; see makeChat). It shows when it's asked for (the chat button on an app's
// tab, Show the Chat, a shortcut in an app, the menu bar icon), brought forward with the typing in
// its focused chat, and stays until it's closed, an ordinary window among the others (the user's
// choice: it came forward with the apps, floating over them, and hid when another app did). It
// shows in Mission Control, to be picked from there. The user can put it anywhere; it opens again
// where it was.
const FADE_MS = 160;
let chat = null;
let chatOpen = Boolean(readSettings().chatOpen);
let chatFocused = false;
let chatReady = false;
const chatWin = () => (chat && !chat.isDestroyed() ? chat : null);

function makeChat() {
  const saved = readSettings().chatBounds;
  const near = windowOf(lastFront)?.bounds ?? screen.getPrimaryDisplay().workArea;
  const bounds = saved && screen.getAllDisplays().some((d) => overlaps(d.workArea, saved)) ? saved : firstPlace(near);
  chat = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 300,
    // A top bar like the apps' windows, with the traffic lights in it (see styles.css). Closing it
    // closes the chat (see below); it can't be minimised or zoomed.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 11 },
    minimizable: false,
    maximizable: false,
    show: false,
    title: CHAT_TITLE,
    backgroundColor: background(),
    fullscreenable: false,
    webPreferences: { preload: path.join(dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  chat.on('page-title-updated', (event) => event.preventDefault()); // keeps CHAT_TITLE, not chat.html's
  chatReady = false;
  // Only on the Space it shows on, not every one (the user's choice). It's an ordinary window, not a
  // panel, as a panel is on every Space whatever it's told; so clicking into it makes SmartDesktop
  // the active app (its own Edit menu, see below), and the app's menus come back with the app.
  chat.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  // It shows in Mission Control like any window, to be picked from there (the user's choice: the
  // apps' own chats were left out of it, but this one is shared by them all).
  let saving = null;
  const remember = () => {
    clearTimeout(saving);
    saving = setTimeout(() => chatWin() && writeSettings({ chatBounds: chat.getBounds() }), 300);
  };
  chat.on('move', remember);
  chat.on('resize', remember);
  chat.on('focus', () => {
    chatFocused = true;
    arrange();
  });
  chat.on('blur', () => {
    chatFocused = false;
    setTimeout(arrange, 150);
  });
  // Its close button closes the chat, as the apps' chat buttons do: the window is kept, hidden.
  chat.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    setChatOpen(false);
  });
  chat.on('closed', () => {
    chat = null;
    chatFocused = false;
  });
  chat.loadFile(page('chat.html'));
  widenForColumns();
  return chat;
}
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Opens the chat, brought forward with the focus in it (`now`: the user asked for it), or closes it.
function setChatOpen(open, { now = false } = {}) {
  chatOpen = open;
  writeSettings({ chatOpen });
  hub?.broadcast({ type: 'chat-open', open });
  updateTray();
  arrange({ now });
  if (open && now) {
    // SmartDesktop comes forward (it's in the background while the app is used), and the chat with
    // it, its focused chat's message box taking the typing (see chat.js).
    app.focus({ steal: true });
    chatWin()?.focus();
  }
}

// Shows the chat when it's asked for (`now`), and hides it once it's closed. It's an ordinary window
// otherwise: it doesn't come and go with the apps (the user's choice: it showed whenever an app came
// forward, floating over it, and hid when another app did).
function arrange({ now = false } = {}) {
  const win = chatWin();
  if (!chatOpen) {
    if (win?.isVisible()) {
      clearInterval(win.fading);
      win.hide();
      win.setOpacity(1);
    }
    return;
  }
  sendChatState();
  if (now && !win?.isVisible()) fadeIn(win ?? makeChat());
}

function fadeIn(win) {
  const start = Date.now();
  clearInterval(win.fading);
  win.setOpacity(0);
  // On the Space the user is on: joining every Space for a moment as it shows brings it there,
  // rather than macOS switching to the Space it was last on; then it leaves the others.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.showInactive();
  setTimeout(() => !win.isDestroyed() && win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true }), 50);
  const step = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(step);
    const t = Math.min(1, (Date.now() - start) / FADE_MS);
    win.setOpacity(1 - (1 - t) ** 3);
    if (t === 1) clearInterval(step);
  }, 16);
  win.fading = step;
}

// The chat window's layout (chat-layout.js): its columns of chat tabs, kept in settings.json, and
// the chat with the focus (the one last used: Show the Chat from Home brings it back).
let layout = grid.normalize(readSettings().chatLayout);
function setLayout(next) {
  const before = layout.columns.length;
  layout = grid.normalize(next);
  writeSettings({ chatLayout: layout });
  if (layout.columns.length > before) widenForColumns();
  sendChatState();
}
// More columns than the chat window has room for (each at least COLUMN_WIDTH): it widens, as far as
// its screen allows, keeping on it.
const COLUMN_WIDTH = 340;
function widenForColumns() {
  const win = chatWin();
  if (!win) return;
  const bounds = win.getBounds();
  const need = layout.columns.length * COLUMN_WIDTH;
  if (bounds.width >= need) return;
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(need, area.width);
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  win.setBounds({ ...bounds, x, width }, true);
}
function focusChat(chatId) {
  if (readSettings().focusedChat === chatId) return;
  writeSettings({ focusedChat: chatId });
  sendChatState();
}
// A chat shown in the chat window, given the focus: in its column if it's in one, else in the
// column with the focus (or the first), and the window opened.
function showChat(chatId) {
  if (grid.columnOf(layout, chatId) < 0) {
    const focused = grid.columnOf(layout, readSettings().focusedChat);
    setLayout(grid.place(layout, chatId, Math.max(0, focused)));
  } else setLayout(grid.show(layout, chatId));
  focusChat(chatId);
  setChatOpen(true, { now: true });
}

// What the chat window shows: its layout and the chat with the focus; each chat in it by name, with
// its own tabs in the apps (by app and what they show), and the hint and shortcuts its tabs offer;
// and which apps are connected.
function chatState() {
  const chats = {};
  for (const column of layout.columns) {
    for (const chatId of column.chats) {
      const tabs = [];
      let hint = null;
      const shortcuts = [];
      for (const entry of apps.values()) {
        const tabId = tabOf(chatId, entry);
        const win = tabId && entry.windows.get(tabId);
        if (!win) continue;
        tabs.push({ app: entry.client.app, name: entry.client.name, title: win.title ?? null });
        hint ??= win.hint;
        shortcuts.push(...(win.shortcuts ?? []).map((sc) => ({ ...sc, at: { clientId: entry.client.id, windowId: tabId } })));
      }
      chats[chatId] = { title: titles.get(chatId) ?? 'New chat', tabs, hint, shortcuts };
    }
  }
  return { layout, focused: readSettings().focusedChat ?? null, chats, connected: [...apps.values()].map((a) => a.client.name) };
}
let sentState = null;
function sendChatState() {
  const state = JSON.stringify(chatState());
  if (state === sentState || !chatReady) return;
  sentState = state;
  chatWin()?.webContents.send('chat-state', JSON.parse(state));
}
// A request for a chat's AI (see ask), once the chat window is ready.
const asked = [];
function askInChat(chatId, text) {
  if (chatReady) chatWin()?.webContents.send('chat-ask', { chatId, text });
  else asked.push({ chatId, text });
}

// --- The setup and settings windows ------------------------------------------------------------
// Ordinary windows. While either is open SmartDesktop shows in the Dock, so it can be found again
// behind other windows; with neither, it goes back to the menu bar alone.
const panels = {};
function openPanel(name, { width, height, title }) {
  if (panels[name] && !panels[name].isDestroyed()) {
    panels[name].show();
    panels[name].focus();
    app.focus({ steal: true });
    return panels[name];
  }
  const win = new BrowserWindow({
    width,
    height,
    title,
    show: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    backgroundColor: background(),
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  panels[name] = win;
  app.dock?.show();
  win.once('ready-to-show', () => {
    win.show();
    app.focus({ steal: true });
  });
  win.on('closed', () => {
    delete panels[name];
    if (!Object.keys(panels).length) app.dock?.hide();
  });
  win.loadFile(page(`${name}.html`));
  return win;
}
function openSetup() {
  writeSettings({ setupSeen: true });
  return openPanel('setup', { width: 520, height: 600, title: 'Set Up Your AI' });
}
const openSettings = () => openPanel('settings', { width: 480, height: 420, title: 'Settings' });

// --- The menu bar icon -----------------------------------------------------------------------
let tray = null;
function updateTray() {
  if (!tray) return;
  const connected = [...apps.values()].map((a) => a.client.name);
  tray.setToolTip(connected.length ? `${NAME}: the chat for ${connected.join(' and ')}` : NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: chatOpen ? 'Hide the Chat' : 'Show the Chat', click: () => setChatOpen(!chatOpen, { now: true }) },
    { type: 'separator' },
    { label: 'Set Up AI…', click: openSetup },
    { label: 'Settings…', click: openSettings },
    updates.status.state === 'ready'
      ? { label: `Restart to Update to ${updates.status.next}`, click: () => installUpdate() }
      : { label: 'Check for Updates…', click: checkForUpdates },
    { type: 'separator' },
    { label: connected.length ? `Connected to ${connected.join(' and ')}` : 'Not connected: open SmartDoc or SmartSpec', enabled: false },
    { type: 'separator' },
    { label: `Quit ${NAME}`, role: 'quit' },
  ]));
}

// --- Requests from SmartDesktop's own windows ----------------------------------------------------
const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
handle('agent-status', () => agent.status());
handle('agent-sign-in', (id) => agent.signIn(id, agentProgress));
handle('agent-install', (id) => agent.install(id, agentProgress));
handle('agent-install-help', (id) => shell.openExternal((PROVIDERS[id] ?? PROVIDERS.claude).installHelp));
handle('chat-load', async (chatId) => {
  const chat = await agent.load(chatId);
  return chat ? { id: chat.id, title: chat.title, messages: chat.messages, running: agent.isRunning(chatId) } : null;
});
handle('agent-send', (chatId, provider, text, options) => chatSend(chatId, provider, text, options));
handle('agent-stop', (chatId) => agent.stop(chatId));
handle('agent-new-session', (chatId, provider) => agent.newSession(chatId, provider));
handle('chat-ready', () => {
  chatReady = true;
  sentState = null;
  setTimeout(() => {
    sendChatState();
    for (const request of asked.splice(0)) chatWin()?.webContents.send('chat-ask', request);
  });
  return chatState();
});
// The chat window's tabs (see chat-layout.js): a new chat (in a column), choosing, moving,
// splitting off and closing a chat's tab, the columns' widths, and the chat with the focus.
handle('chat-new', async (column = 0) => {
  const chat = await newChat();
  setLayout(grid.place(layout, chat.id, column));
  focusChat(chat.id);
  return chat.id;
});
handle('chat-show', (chatId) => {
  setLayout(grid.show(layout, chatId));
  focusChat(chatId);
});
handle('chat-move', (chatId, column, index) => {
  setLayout(grid.place(layout, chatId, column, index));
  focusChat(chatId);
});
handle('chat-split', (chatId, column, side) => {
  setLayout(grid.split(layout, chatId, column, side));
  focusChat(chatId);
});
handle('chat-close-tab', (chatId) => {
  setLayout(grid.close(layout, chatId));
  if (readSettings().focusedChat === chatId) focusChat(layout.columns[0]?.active ?? null);
});
handle('chat-widths', (widths) => setLayout(grid.resize(layout, widths)));
handle('chat-even', () => setLayout(grid.even(layout)));
handle('chat-focus', (chatId) => focusChat(chatId));
handle('chat-rename', (chatId, title) => agent.rename(chatId, title));
// A chat tab's right-click menu: Rename… (done in the tab: the answer goes back) and Close.
handle('chat-tab-menu', (chatId) => new Promise((resolve) => {
  Menu.buildFromTemplate([
    { label: 'Rename…', click: () => resolve('rename') },
    { label: 'Close', click: () => resolve('close') },
  ]).popup({ window: chatWin() ?? undefined, callback: () => setTimeout(() => resolve(null), 100) });
}));
handle('chat-close', () => setChatOpen(false));
// A shortcut that's an action in the app (the go-ahead to an AI waiting in another app, say): the
// app window it's about does it.
handle('chat-action', (chip) => {
  if (!chip?.at) return false;
  return hub.send(chip.at.clientId, { type: 'action', windowId: chip.at.windowId, id: chip.id });
});
handle('open-setup', () => {
  openSetup();
});
handle('open-settings', () => {
  openSettings();
});
handle('get-appearance', () => nativeTheme.themeSource);
handle('set-appearance', (appearance) => setAppearance(appearance));
handle('get-updates', () => updates.status);
// Restarting to update closes the windows before the app says it's quitting (macOS's updater), and
// the chat's window only hides when it's closed, unless the app is quitting: so it's marked as
// quitting first, or the chat's window stopped the restart (the user found it did nothing).
handle('install-update', () => installUpdate());
function installUpdate() {
  if (updates.status.state !== 'ready') return;
  quitting = true;
  hub?.close();
  updates.install();
}

// --- Updates ---------------------------------------------------------------------------------
const updates = createUpdates({
  report: (status) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('updates', status);
    updateTray(); // its menu offers Restart to Update once one is ready
  },
});
// The app menu's and the menu bar icon's Check for Updates…: its answer shows in the update toast,
// in the chat's window (update-toast.js), which comes forward for it.
async function checkForUpdates() {
  setChatOpen(true, { now: true });
  const win = chatWin();
  if (win?.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  updates.check({ byUser: true });
}

// --- Starting ----------------------------------------------------------------------------------
let hub = null;
app.whenReady().then(async () => {
  app.dock?.hide();
  // No menu bar of its own shows (it lives in the menu bar's icon), but typing in the chat needs the
  // Edit menu's shortcuts (copy, paste, undo, select all), and ⌘Q quits.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: checkForUpdates }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
  ]));
  app.setAboutPanelOptions({ credits: 'SmartDesktop is in beta, so it may change significantly from one version to the next.' });
  tray = new Tray(nativeImage.createFromPath(resource('trayTemplate.png')));
  updateTray();
  try {
    hub = await startHub({
      userData: app.getPath('userData'),
      port: HUB_PORT,
      about: { app: 'SmartDesktop', development: !app.isPackaged, version: app.getVersion() },
      onHello(client) {
        // The same app connecting again (it restarted) replaces itself.
        for (const [id, entry] of apps) if (entry.client.app === client.app) apps.delete(id);
        apps.set(client.id, { client, windows: new Map() });
        // Its tabs are new (it started again, or SmartDesktop did): no chat owns any of them yet.
        for (const tabs of owned.values()) delete tabs[client.app];
        updateTray();
        sendOwners(client.app);
        sendChatState();
      },
      onMessage,
      onGone(client) {
        apps.delete(client.id);
        for (const tabs of owned.values()) delete tabs[client.app];
        if (front?.clientId === client.id) front = null;
        if (lastFront?.clientId === client.id) lastFront = null;
        updateTray();
        arrange();
        sendChatState();
      },
    });
  } catch (error) {
    // The port taken: another copy of the same build (the single instance lock stops that), or
    // another program.
    console.error(`SmartDesktop couldn’t listen on port ${HUB_PORT}:`, error.message);
    tray.setToolTip(`${NAME} couldn’t start: port ${HUB_PORT} is taken by another program.`);
  }
  // The names of the chats in the chat window's tabs; a chat no longer there leaves its tab.
  for (const chatId of layout.columns.flatMap((c) => c.chats)) {
    const chat = await agent.load(chatId);
    if (chat) titles.set(chatId, chat.title);
    else layout = grid.close(layout, chatId);
  }
  setLayout(layout);
  updates.start();
  // The first time, the setup: which AI to use, installed and signed in to.
  if (!readSettings().setupSeen) openSetup();
});

// It keeps running with no windows: it lives in the menu bar.
app.on('window-all-closed', () => {});
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
  hub?.close();
});
