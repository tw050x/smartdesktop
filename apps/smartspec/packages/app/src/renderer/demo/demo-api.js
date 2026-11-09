// A stand-in for the app's API (window.smartspec, see preload.cjs) for the website demo. It runs the
// app's own store (main/store.js) over files held in memory (node/fs.js, swapped in by
// vite.demo.config.js), so every schematic, proposal, draft and comment is made and shown exactly
// as in the app. Layouts are kept in memory too, and start afresh with each scene. The main process's part, sending a proposal's
// window to it and saying which AI works there, is done by the director (director.js) through the
// demo's own methods, below the API's.
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

  return {
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
    onShowConnect: on('show-connect'),
    onUpdates: on('updates'),
    onShowSettings: on('show-settings'),
    onFullScreenChange: on('full-screen'),
    onLayoutsReset: on('layouts-reset'),

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
  };
}
