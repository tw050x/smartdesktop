// A stand-in for the app's API (window.smartspec, see preload.cjs) for the website demo. It runs the
// app's own store (main/store.js) over files held in memory (node/fs.js, swapped in by
// vite.demo.config.js), so every schematic, proposal, draft and comment is made and shown exactly
// as in the app. Layouts are kept in memory too, and start afresh with each scene. The main process's part, sending a proposal's
// window to it and saying which AI works there, is done by the director (director.js) through the
// demo's own methods, below the API's.
//
// The chat is the app's own (chat-panel.js), in the app's window and in a window of its own
// (demo-chat.html), as SmartDoc's demo has it: what's in it, and whether the AI's at work, are set by
// the director (setChat); nothing sent from it goes anywhere.
//
// The story's states are built once, each on the one before, and kept as snapshots of the files,
// so the director can go to any of them at once, in any order (goTo):
//   base       Larder's domains and its other schematics, accepted
//   proposed   + the AI's first proposal of Checkout
//   commented  + the user's comment on its Payments node
//   revised    + the AI's revision, and its reply to the comment
//   accepted   + the proposal accepted: Checkout's Draft 1

import { EventEmitter } from 'node:events';
import { restore, snapshot } from 'node:fs/promises';
import { createStore } from '../../main/store.js';
import { CHECKOUT, CHECKOUT_GOAL, CHECKOUT_TITLE, COMMENT, DOMAINS, NOTIFICATIONS, PAYMENTS, REPLY, REVISION, SERVICE_AUTH, STOCK } from './scenario.js';

// What the app's MCP panel shows for an installed app.
const DEMO_LAUNCHER = {
  command: '/Applications/SmartSpec.app/Contents/MacOS/SmartSpec',
  args: ['/Applications/SmartSpec.app/Contents/Resources/cli/mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};
export const STATES = ['base', 'proposed', 'commented', 'revised', 'accepted'];

const DEMO_AIS = {
  claude: { id: 'claude', name: 'Claude', tool: 'Claude Code', installers: ['Anthropic’s installer'], installed: true, loggedIn: true, account: 'Claude account', models: [{ id: 'claude-fable-5-1', name: 'Fable 5.1' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }, { id: 'claude-haiku-5-5', name: 'Haiku 5.5' }] },
  codex: { id: 'codex', name: 'ChatGPT', tool: 'Codex', installers: ['OpenAI’s installer'], installed: true, loggedIn: true, account: 'ChatGPT account', models: [] },
};

export function createDemoApi() {
  const listeners = {};
  const on = (name) => (callback) => (listeners[name] ??= []).push(callback);
  const emit = (name, value) => (listeners[name] ?? []).forEach((callback) => callback(value));

  const events = new EventEmitter();
  const store = createStore('/data', { events });
  events.on('changed', () => emit('schemas-changed'));
  let layouts = new Map(); // schematic id → its layout

  // The ids the store gives things, as they're made.
  const ids = { domains: {}, schemas: {} };
  const saved = new Map(); // state → its files
  let state = null;
  // The chat: whether its window shows, the window's one chat ({ main, threads, running }), and
  // what the app's window last sent it.
  const chat = { shown: false, window: null, state: null };
  const chatId = () => 'window/1';
  const chatOf = () => (chat.window ??= { main: { messages: [], sessions: {} }, threads: {}, running: [] });

  async function propose(key, { domain, schemaKey, uses, ...change }, extra = {}) {
    const made = await store.propose({
      ...change,
      ...(uses && { uses: uses.map(({ schemaKey: from, ...use }) => ({ ...use, schemaId: ids.schemas[from] })) }),
      ...(domain && { groupId: ids.domains[domain] }),
      ...extra,
    });
    ids.schemas[key] = made.schema;
    return made;
  }

  // Each state, made from the one before it.
  const MAKE = {
    async base() {
      for (const [key, name] of Object.entries(DOMAINS)) ids.domains[key] = (await store.createGroup(name)).id;
      for (const [key, schema] of [['serviceAuth', SERVICE_AUTH], ['payments', PAYMENTS], ['stock', STOCK], ['notifications', NOTIFICATIONS]]) {
        await propose(key, schema);
        await store.accept(ids.schemas[key]);
      }
    },
    async proposed() {
      await propose('checkout', CHECKOUT, { goal: CHECKOUT_GOAL, goalTitle: CHECKOUT_TITLE });
    },
    async commented() {
      const { text, ...target } = COMMENT;
      ids.comment = (await store.addComment(ids.schemas.checkout, { proposal: true, target, text })).id;
    },
    async revised() {
      await store.propose({ schemaId: ids.schemas.checkout, ...REVISION });
      await store.replyToComment(ids.schemas.checkout, ids.comment, { ...REPLY, author: 'Claude Code' });
    },
    async accepted() {
      await store.accept(ids.schemas.checkout);
    },
  };

  // Puts the store at a state of the story, building the states up to it the first time.
  async function goTo(name) {
    if (!saved.has(name)) {
      const before = STATES[STATES.indexOf(name) - 1];
      if (before) await goTo(before);
      else restore(null);
      await MAKE[name]();
      saved.set(name, snapshot());
    }
    restore(saved.get(name));
    layouts = new Map(); // each scene starts from the board as the app first lays it out
    emit('layouts-reset');
    state = name;
    emit('schemas-changed');
  }

  const api = {
    // --- The app's API -----------------------------------------------------------------------
    platform: 'darwin',
    windowId: '1',
    onAiControl: on('ai-control'),
    releaseAiControl: async () => emit('ai-control', null),
    listSchemas: () => store.list(),
    listFocuses: (id, options) => store.listFocuses(id, options),
    copyText: async () => {},
    listDrafts: (id) => store.listDrafts(id),
    getSchema: (id, draftId) => store.getSchema(id, { draftId: draftId ?? undefined }),
    getProposal: (id) => store.getProposal(id),
    getItem: (id, itemId, options) => store.getItem(id, itemId, options),
    getConnections: (id, options) => store.getConnections(id, options),
    listComments: (id, options) => store.listComments(id, options),
    listEarlierComments: (id, options) => store.listEarlierComments(id, options),
    getLayout: async (id) => structuredClone(layouts.get(id) ?? null),
    saveLayout: async (id, layout) => void layouts.set(id, structuredClone(layout)),
    listGroups: () => store.listGroups(),
    createGroup: (name, folderId) => store.createGroup(name, folderId ?? null),
    renameGroup: (id, name) => store.renameGroup(id, name),
    deleteGroup: async () => false,
    moveSchema: (schemaId, groupId) => store.moveSchema(schemaId, groupId ?? null),
    folders: () => store.folders(),
    createFolder: (name, parentId) => store.createFolder(name, parentId ?? null),
    renameFolder: (id, name) => store.renameFolder(id, name),
    deleteFolder: (id) => store.deleteFolder(id),
    moveFolder: (id, parentId) => store.moveFolder(id, parentId ?? null),
    moveGroup: (groupId, folderId) => store.moveGroup(groupId, folderId ?? null),
    showHomeMenu: async () => null,
    addComment: (id, comment) => store.addComment(id, comment),
    deleteComment: (id, commentId) => store.deleteComment(id, commentId),
    setNoFurtherAction: (id, commentId, flag) => store.setNoFurtherAction(id, commentId, flag),
    acceptProposal: (id) => store.accept(id),
    approveChange: (id, key, flag) => store.approveChange(id, key, flag),
    sendComments: (id) => store.sendComments(id),
    discardProposal: (id) => store.discard(id),
    onSchemasChanged: on('schemas-changed'),
    onShowSchema: on('show-schema'),
    onNewSchema: on('new-schema'),
    mcpSetup: async (target) => (target === 'claude-code'
      ? `claude mcp add --scope user smartspec -e ELECTRON_RUN_AS_NODE=1 -- ${DEMO_LAUNCHER.command} ${DEMO_LAUNCHER.args[0]}`
      : JSON.stringify({ mcpServers: { smartspec: DEMO_LAUNCHER } }, null, 2)),
    copyMcpSetup: async () => {},
    claudeDesktopStatus: async () => ({ state: 'added' }),
    addToClaudeDesktop: async () => ({ state: 'added' }),
    getUpdates: async () => ({ state: 'idle' }),
    checkForUpdates: async () => {},
    installUpdate: async () => {},
    getAppearance: async () => 'system',
    setAppearance: async () => {},
    onMcpStatus: (callback) => {
      on('mcp-status')(callback);
      setTimeout(() => callback({ state: 'running', url: 'http://127.0.0.1:47825/mcp' }));
    },
    mcpStatus: async () => ({ state: 'running', url: 'http://127.0.0.1:47825/mcp' }),
    // The AIs the chat runs, installed and signed in, so the status pill says Ready.
    agentStatus: async () => structuredClone(DEMO_AIS),
    onShowConnect: on('show-connect'),
    onUpdates: on('updates'),
    onShowSettings: on('show-settings'),
    onFullScreenChange: on('full-screen'),
    onLayoutsReset: on('layouts-reset'),

    // --- The chat (the app's window and the chat's) ---
    agentChats: async () => ({ chatId: chatId(), ...structuredClone(chatOf()) }),
    agentSend: async () => true, // what's sent, and the AI's answer, are the director's
    agentStop: async () => {},
    agentNewSession: async () => {},
    agentInstall: async () => structuredClone(DEMO_AIS),
    agentSignIn: async () => structuredClone(DEMO_AIS),
    agentInstallHelp: async () => {},
    onAgentEvent: on('agent-event'),
    onAgentProgress: on('agent-progress'),
    onChatMode: on('chat-mode'),
    chatFloat: async () => api.showChat(true),
    chatDock: async () => api.showChat(false),
    chatClose: async () => api.showChat(false),
    // What the app's window shows, for the chat's window (kept for when it starts).
    chatState(next) {
      chat.state = next;
      emit('chat-state', next);
    },
    onChatState(callback) {
      on('chat-state')(callback);
      if (chat.state) callback(chat.state);
    },
    chatReady: async () => {},
    chatAction: (id) => emit('chat-action', id),
    onChatAction: on('chat-action'),
    chatAsk: (text) => emit('chat-ask', text),
    onChatAsk: on('chat-ask'),
    // The lines the app posts as the window moves or the user does something are the director's.
    chatNote: async () => {},
    chatShows: async () => {},

    // --- The demo's own ----------------------------------------------------------------------
    store,
    ids,
    goTo,
    get state() {
      return state;
    },
    // What the main process does: an AI's proposal shown in its window, the AI named in the top bar,
    // and File › New Schematic.
    showSchema: (key) => emit('show-schema', { schemaId: ids.schemas[key], name: '' }),
    setAiControl: (name) => emit('ai-control', name),
    newSchema: () => emit('new-schema'),
    // The chat's window: shown or not.
    showChat(on) {
      if (on === chat.shown) return;
      chat.shown = on;
      emit('chat-mode', { mode: on ? 'floating' : 'closed' });
      emit('chat-shown', on);
    },
    get chatShown() {
      return chat.shown;
    },
    onChatShown: on('chat-shown'),
    // What's in the window's chat ({ main: [messages] }), and the conversations the AI is at work
    // in. Only what's changed is sent to the chat.
    setChat(conversations, running = []) {
      const store = chatOf();
      for (const [key, messages] of Object.entries(conversations)) {
        const convo = key === 'main' ? store.main : (store.threads[key] ??= { messages: [], sessions: {} });
        if (JSON.stringify(convo.messages) === JSON.stringify(messages)) continue;
        convo.messages = messages;
        emit('agent-event', { chatId: chatId(), conversation: key, type: 'messages', messages });
      }
      for (const key of new Set([...store.running, ...running])) {
        const now = running.includes(key);
        if (now !== store.running.includes(key)) emit('agent-event', { chatId: chatId(), conversation: key, type: 'running', running: now });
      }
      store.running = [...running];
    },
    // Forgets the chat (a scene starts from what it sets).
    clearChats() {
      for (const key of chat.window?.running ?? []) emit('agent-event', { chatId: chatId(), conversation: key, type: 'running', running: false });
      chat.window = null;
      emit('agent-event', { chatId: chatId(), conversation: 'main', type: 'messages', messages: [] });
    },
  };
  return api;
}
