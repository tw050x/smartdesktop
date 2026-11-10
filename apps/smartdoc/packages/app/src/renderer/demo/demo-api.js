// A stand-in for the app's API (window.smartdoc, see preload.cjs) for the website demo: the
// scenario's document, drafts, reviews and variation held in memory, firing the same events the
// main process sends. Quotes are placed the way the main process places them, once the window
// reports a draft's page texts. The director (director.js) sets the scene through the first group
// of methods: whether the document has been added, which screen shows, which drafts exist, how far
// each review has got (as the agent adds to it) and what's been decided.
//
// It's the chat window's API too (demo-chat.html, the app's chat-window.js): the same object, so
// the two windows talk as the app's do through its main process. Each draft has a chat of its
// own; the director sets what's in it as the scene goes (setChat), and which AIs are set up.

import { resolveQuote } from '../../main/anchors.js';
import { DOCUMENT, DRAFTS, HIGHLIGHTS, IMPROVE, VARIATION } from './scenario.js';

// What the app's MCP panel shows for an installed app.
const DEMO_LAUNCHER = {
  command: '/Applications/SmartDoc.app/Contents/MacOS/SmartDoc',
  args: ['/Applications/SmartDoc.app/Contents/Resources/cli/mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

const day = (n) => new Date(Date.parse(DOCUMENT.importedAt) + n * 864e5).toISOString();

// The AIs the chat can run, as main/agent.js reports them: both set up, unless a scene says not.
const AIS = {
  claude: { id: 'claude', name: 'Claude', tool: 'Claude Code', installers: ['Anthropic’s installer'], installed: true, loggedIn: true, account: 'Claude account' },
  codex: { id: 'codex', name: 'ChatGPT', tool: 'Codex', installers: ['OpenAI’s installer'], installed: true, loggedIn: true, account: 'ChatGPT account' },
};

export function createDemoApi() {
  const listeners = {};
  const on = (name) => (callback) => (listeners[name] ??= []).push(callback);
  const emit = (name, value) => (listeners[name] ?? []).forEach((callback) => callback(value));

  let state;
  const pdfs = {}; // draft id → the PDF's bytes, fetched once
  const pageTexts = {}; // draft id → its page texts, once drawn
  const reviews = { improve: review(IMPROVE, 0), highlights: review(HIGHLIGHTS, 1) };
  // When each review was finished, once it is: where its card goes in the chat (setCommitTimes).
  const committedAt = {};
  // The chat: whether its window shows, each draft's conversations (draft id → { main, threads,
  // running }), the AIs, what the app window last sent it, and an install or sign-in under way.
  const chat = { shown: false, drafts: {}, ais: structuredClone(AIS), state: null, pending: null };
  const draftShowing = () => DRAFTS[state.draft].id; // a preview's chat is its draft's
  const chatId = (draftId = draftShowing()) => `${DOCUMENT.id}/original/${draftId}`;
  const chatOf = (draftId = draftShowing()) => (chat.drafts[draftId] ??= { main: { messages: [], sessions: {} }, threads: {}, running: [] });

  // Back to the start: no document added, nothing shown, no reviews.
  function reset() {
    state = {
      added: false, // whether the document has been added
      screen: null, // 'home' or 'document' once the director shows one
      tool: 'improve',
      draft: 0,
      previewing: null, // the draft whose preview is showing, waiting to be accepted
      made: 0, // the drafts after the original that exist so far
      variation: false, // whether the Acme variation exists yet
      // How far each review has got: started, how many of its findings or highlights the agent
      // has added so far, and whether it's finished (committed).
      progress: { improve: { started: false, shown: 0, done: false }, highlights: { started: false, shown: 0, done: false } },
    };
  }

  // A review record as the store makes it (see store.js), its quotes placed once the page is drawn.
  function review(source, n) {
    let i = 0;
    const id = () => `${source.type}-${i++}`;
    return {
      id: `review-${source.type}`,
      draftId: DRAFTS[n].id,
      variationId: 'original',
      type: source.type,
      goal: source.goal,
      title: source.title,
      context: null,
      createdAt: day(n),
      status: 'committed',
      summary: source.summary,
      requests: [],
      annotations: [],
      applications: [],
      history: [],
      changes: [],
      items: (source.items ?? []).map((f) => ({
        id: id(), kind: f.kind, title: f.title, body: f.body ?? '', severity: 'medium', anchors: [], quotes: f.quotes,
        inResponseTo: null, proposal: f.proposal ?? null, options: f.options ?? null, question: f.question ?? null, decision: { status: 'pending' },
      })),
      highlights: (source.highlights ?? []).map((h) => ({
        id: id(), category: h.category, title: h.title, note: h.note, importance: h.importance, anchors: [], quotes: h.quotes, missing: !h.quotes.length,
      })),
    };
  }

  // Places a review's quotes on its draft's text: on the page given, or any page if the text has
  // moved (a longer draft can push a line onto the next page).
  function place(r) {
    const texts = pageTexts[r.draftId];
    if (!texts) return;
    for (const x of [...r.items, ...r.highlights]) {
      x.anchors = x.quotes.map((q) => {
        for (const page of [q.page, ...texts.map((_, i) => i + 1).filter((p) => p !== q.page)]) {
          try {
            return resolveQuote(texts, { ...q, page });
          } catch {}
        }
        return resolveQuote(texts, q); // not found anywhere: says so
      });
    }
  }

  // The active tool's review as it stands, if it's of the draft showing and has been started: only
  // what the agent has added so far, and open until it's finished.
  const current = () => {
    const r = reviews[state.tool];
    const p = state.progress[state.tool];
    if (!p.started || r.draftId !== DRAFTS[state.draft].id) return null;
    return { ...r, status: p.done ? 'committed' : 'open', committedAt: p.done ? committedAt[state.tool] ?? null : null, items: r.items.slice(0, p.shown), highlights: r.highlights.slice(0, p.shown) };
  };

  async function showDraft(n) {
    state.screen = 'document';
    state.draft = n;
    state.previewing = null;
    const draft = DRAFTS[n];
    pdfs[draft.id] ??= new Uint8Array(await (await fetch(draft.pdf)).arrayBuffer());
    emit('draft-opened', {
      document: DOCUMENT,
      variation: { id: 'original', name: 'Original', isOriginal: true },
      draft: { id: draft.id, number: n, total: state.made, isOriginal: n === 0, summary: draft.summary },
      pdf: pdfs[draft.id].slice(), // pdf.js takes the buffer it's given
      review: current(),
      tool: state.tool,
    });
  }

  const comparesWith = (n) => (n === 0 ? 'Original' : `Draft ${n}`);

  // The agent's next draft, as a preview: only accepting it makes it a draft.
  async function showPreview(n) {
    state.previewing = n;
    const draft = DRAFTS[n];
    pdfs[draft.id] ??= new Uint8Array(await (await fetch(draft.pdf)).arrayBuffer());
    emit('draft-opened', {
      document: DOCUMENT,
      variation: { id: 'original', name: 'Original', isOriginal: true },
      draft: { id: 'preview', number: n, total: state.made, isOriginal: false, isPreview: true, summary: draft.summary, setsAside: 0, comparesWith: comparesWith(state.draft) },
      pdf: pdfs[draft.id].slice(),
      review: current(),
      tool: state.tool,
    });
  }

  const listed = () => (state.added ? [{ id: DOCUMENT.id, name: DOCUMENT.name, importedAt: DOCUMENT.importedAt }] : []);

  // Where a draft's reviews stand, as the home screen lists them (see workspace.variationsOf).
  function reviewsOf(draftId) {
    const status = (type) => {
      const r = reviews[type];
      const p = state.progress[type];
      return p.started && r.draftId === draftId ? { r, p } : null;
    };
    const improve = status('improve');
    const highlights = status('highlights');
    return {
      improve: improve && {
        title: improve.r.title, status: improve.p.done ? 'committed' : 'open', findings: improve.p.shown,
        decided: improve.r.items.slice(0, improve.p.shown).filter((i) => i.decision.status !== 'pending').length, applied: state.made >= 1,
      },
      highlights: highlights && { title: highlights.r.title, status: highlights.p.done ? 'committed' : 'open', count: highlights.p.shown, others: 0 },
    };
  }

  function variationsOf() {
    const line = DRAFTS.slice(0, state.made + 1).map((d, i) => ({
      id: d.id, label: i ? `Draft ${i}` : 'Original', createdAt: day(i), summary: d.summary, shared: null, reviews: reviewsOf(d.id),
    }));
    const variations = [{ id: 'original', name: 'Original', purpose: null, from: null, updatedAt: day(state.made), drafts: [...line].reverse() }];
    if (state.variation) {
      const own = VARIATION.drafts.map((d, i) => ({
        id: d.id, label: `Draft ${VARIATION.fromDraft + 1 + i}`, createdAt: day(3 + i), summary: d.summary, shared: null,
        reviews: { improve: { title: d.review.title, status: 'committed', findings: d.review.findings, decided: d.review.decided, applied: false }, highlights: null },
      }));
      const shared = line.slice(0, VARIATION.fromDraft + 1).map((d) => ({ ...d, shared: 'Original' }));
      variations.push({ id: VARIATION.id, name: VARIATION.name, purpose: VARIATION.purpose, from: `Draft ${VARIATION.fromDraft} of Original`, updatedAt: day(3), drafts: [...shared, ...own].reverse() });
    }
    return { id: DOCUMENT.id, name: DOCUMENT.name, createdFrom: null, variations };
  }

  reset();
  const api = {
    // The window's back and forward can't reopen anywhere here (see history-nav.js).
    isDemo: true,
    // --- For the director ---
    reset,
    showDraft,
    showPreview,
    get state() { return state; },
    reviews,
    // The home screen, listing the document (its variations and drafts as the state has them).
    showHome() {
      state.screen = 'home';
      emit('closed');
      emit('recent', listed());
    },
    // Which drafts exist, and whether the variation does; the home screen lists them afresh.
    setMade(made, variation = false) {
      state.made = made;
      state.variation = variation;
      if (state.screen === 'home') emit('recent', listed());
    },
    // When each review is finished, once it is: { improve, highlights }, ISO times.
    setCommitTimes(times) {
      Object.assign(committedAt, times);
    },
    // How far a review has got: { started, shown, done }.
    setProgress(type, progress) {
      state.progress[type] = { ...state.progress[type], ...progress };
      if (state.screen === 'document' && state.tool === type) emit('review', current());
      if (state.screen === 'home') emit('recent', listed());
    },
    // A finding of the improvement review reworked by the AI (as revise_finding does), or, with no
    // changes, back as the scenario has it.
    reviseItem(index, changes) {
      const item = reviews.improve.items[index];
      const source = IMPROVE.items[index];
      if (changes) Object.assign(item, changes, { decision: { status: 'pending' }, revisedAt: new Date().toISOString() });
      else Object.assign(item, { title: source.title, body: source.body ?? '', proposal: source.proposal ?? null, options: source.options ?? null, question: source.question ?? null, revisedAt: null });
      if (state.screen === 'document') emit('review', current());
    },
    // The first `count` findings decided as the scenario has them (the rest undecided).
    setDecided(count, decisions) {
      reviews.improve.items.forEach((item, i) => (item.decision = i < count ? { ...decisions[i] } : { status: 'pending' }));
      if (state.screen === 'document') emit('review', current());
    },
    // The AI working in this window, for the top bar.
    setAiControl: (name) => emit('ai-control', name),
    // The chat's window: shown (on a conversation: 'main' or an item's id) or not.
    showChat(on, view = 'main') {
      if (on === chat.shown && !on) return;
      chat.shown = on;
      emit('chat-mode', { mode: on ? 'floating' : 'closed', view });
      emit('chat-shown', on);
      if (on) emit('chat-open-item', view === 'main' ? null : view);
    },
    get chatShown() { return chat.shown; },
    onChatShown: on('chat-shown'),
    // What's in the draft's chat: { main: [messages], [item id]: [messages] }, and the
    // conversations the AI is working in. Only what's changed is sent to the chat.
    setChat(conversations, running = [], draftId = draftShowing()) {
      const store = chatOf(draftId);
      for (const [key, messages] of Object.entries(conversations)) {
        const convo = key === 'main' ? store.main : (store.threads[key] ??= { messages: [], sessions: {} });
        if (JSON.stringify(convo.messages) === JSON.stringify(messages)) continue;
        convo.messages = messages;
        emit('agent-event', { chatId: chatId(draftId), conversation: key, type: 'messages', messages });
      }
      for (const key of new Set([...store.running, ...running])) {
        const now = running.includes(key);
        if (now !== store.running.includes(key)) emit('agent-event', { chatId: chatId(draftId), conversation: key, type: 'running', running: now });
      }
      store.running = [...running];
    },
    // Forgets every draft's chat (a scene starts from what it sets).
    clearChats() {
      for (const [draftId, store] of Object.entries(chat.drafts)) {
        for (const key of store.running) emit('agent-event', { chatId: chatId(draftId), conversation: key, type: 'running', running: false });
      }
      chat.drafts = {};
    },
    // The draft whose chat shows (a preview's is its draft's).
    get chatDraft() { return draftShowing(); },
    // Which AIs are installed and signed in: { codex: { installed: false } }, the rest as AIS has.
    setAis(changes = {}) {
      api.finishSetup(); // one left under way ends
      chat.ais = structuredClone(AIS);
      for (const [id, change] of Object.entries(changes)) Object.assign(chat.ais[id], change);
    },
    // An install or sign-in getting on (as agent.js reports it), and its end.
    aiProgress: (id, stage, line, percent = null) => emit('agent-progress', { id, stage, line, percent }),
    finishSetup(changes) {
      if (changes) for (const [id, change] of Object.entries(changes)) Object.assign(chat.ais[id], change);
      chat.pending?.(structuredClone(chat.ais));
      chat.pending = null;
    },
    // Opens the new-variation card, as right-clicking a draft and choosing New Variation does.
    requestVariation: (request) => emit('variation', request),

    // --- The app's API ---
    platform: 'darwin',
    // A file dropped on the window: the document, added and opened.
    openDroppedFile: async () => {
      state.added = true;
      await showDraft(0);
    },
    onFullScreenChange: () => {},
    onMcpStatus: (callback) => callback({ state: 'running', url: 'http://127.0.0.1:47815/mcp' }),
    mcpSetup: async (target) => (target === 'config' ? JSON.stringify({ mcpServers: { smartdoc: DEMO_LAUNCHER } }, null, 2) : 'claude mcp add --scope user smartdoc -e ELECTRON_RUN_AS_NODE=1 -- /Applications/SmartDoc.app/Contents/MacOS/SmartDoc /Applications/SmartDoc.app/Contents/Resources/cli/mcp.js'),
    copyMcpSetup: async () => {},
    openWebsite: async () => {},
    claudeDesktopStatus: async () => ({ state: 'added', extension: false }),
    addToClaudeDesktop: async () => ({ state: 'added', extension: false }),
    getUpdates: async () => ({ state: 'current', version: '1.0.0' }),
    checkForUpdates: async () => {},
    installUpdate: async () => {},
    onShowConnect: () => {},
    onUpdates: () => {},
    onShowSettings: () => {}, // the demo has no menu, so Settings never opens
    copyText: async () => {},
    getAppearance: async () => 'system',
    setAppearance: async () => {},

    // --- The chat (the app's window and the chat's) ---
    agentStatus: async () => structuredClone(chat.ais),
    agentChats: async () => ({ chatId: chatId(), ...structuredClone(chatOf()) }),
    agentSend: async () => true, // what's sent, and the AI's answer, are the director's
    agentStop: async () => {},
    agentInstall: () => new Promise((resolve) => (chat.pending = resolve)),
    agentSignIn: () => new Promise((resolve) => (chat.pending = resolve)),
    agentInstallHelp: async () => {},
    onAgentEvent: on('agent-event'),
    onAgentProgress: on('agent-progress'),
    onChatMode: on('chat-mode'),
    chatFloat(view) {
      api.showChat(true, view);
    },
    chatClose() {
      api.showChat(false);
    },
    chatDock() {
      api.showChat(false);
    },
    chatOpenItem(id) {
      if (!chat.shown) api.showChat(true, id ?? 'main');
      else emit('chat-open-item', id);
    },
    onChatOpenItem: on('chat-open-item'),
    // What the app's window shows, for the chat's window (kept for when it starts).
    chatState(next) {
      chat.state = next;
      emit('chat-state', next);
    },
    onChatState(callback) {
      on('chat-state')(callback);
      if (chat.state) callback(chat.state);
    },
    chatReady: async () => ({ view: 'main' }),
    chatFocus: (id) => emit('chat-focus', id),
    onChatFocus: on('chat-focus'),
    openPreview: async () => showPreview(state.made + 1),

    onRecentDocuments: on('recent'),
    onAiControl: on('ai-control'),
    releaseAiControl: async () => {},
    onDocumentMade: on('made'),
    onVariationRequested: on('variation'),
    variationsOf: async () => variationsOf(),
    focusesFor: async () => ({ current: [], earlier: [] }),
    prepareDraft: async () => {},
    // A draft chosen in the top bar's list (draft-picker.js).
    openDraft: async (_docId, _variationId, draftId) => {
      const n = DRAFTS.findIndex((d) => d.id === draftId);
      if (n !== -1 && n <= state.made) await showDraft(n);
    },
    showDraftMenu: async () => {},
    showDocumentMenu: async () => {},
    showVariationMenu: async () => {},
    goHome: async () => {},
    acceptPreview: async () => {
      state.made = state.previewing;
      await showDraft(state.previewing);
    },
    closePreview: async () => showDraft(state.draft),
    // Comments stay in the demo's review until the scene moves on (clearComments).
    addRequest: async (request) => {
      const r = reviews[state.tool];
      const entry = { id: `request-${r.requests.length}`, createdAt: new Date().toISOString(), afterCommit: state.progress[state.tool].done, ...request };
      r.requests.push(entry);
      emit('review', current());
      return entry;
    },
    updateRequest: async (id, { note }) => {
      const entry = reviews[state.tool].requests.find((q) => q.id === id);
      if (entry && note) {
        entry.note = note;
        entry.noFurtherAction = null; // saying more opens it again, as in the app
      }
      emit('review', current());
    },
    setNoFurtherAction: async (id, on) => {
      const entry = reviews[state.tool].requests.find((q) => q.id === id);
      if (entry) entry.noFurtherAction = on ? { by: 'user', at: new Date().toISOString() } : null;
      emit('review', current());
    },
    removeRequest: async (id) => {
      const r = reviews[state.tool];
      r.requests = r.requests.filter((q) => q.id !== id);
      emit('review', current());
    },
    clearComments: () => {
      for (const r of Object.values(reviews)) r.requests = [];
    },
    previewComparison: async () => {
      const [before, after] = [DRAFTS[state.draft], DRAFTS[state.previewing]];
      pdfs[before.id] ??= new Uint8Array(await (await fetch(before.pdf)).arrayBuffer());
      return {
        before: { label: comparesWith(state.draft), pdf: pdfs[before.id].slice() },
        after: { label: `Draft ${state.previewing} preview`, pdf: pdfs[after.id].slice() },
      };
    },
    discardPreview: async () => showDraft(state.draft),

    onDraftOpened: on('draft-opened'),
    onDocumentClosed: on('closed'),
    onReview: on('review'),
    onTool: on('tool'),
    stepDraft: async (delta) => {
      const n = state.draft + delta;
      if (n >= 0 && n <= state.made) await showDraft(n);
    },
    // Once a draft is drawn, its reviews' quotes are placed on its text.
    reportPageTexts: async (_docId, draftId, texts) => {
      pageTexts[draftId] = texts;
      for (const r of Object.values(reviews)) if (r.draftId === draftId) place(r);
      if (current()?.draftId === draftId) emit('review', current());
    },
    setTool: async (tool) => {
      state.tool = tool;
      emit('tool', tool);
      emit('review', current());
    },
    listFocuses: async (type) => {
      const r = reviews[type];
      const p = state.progress[type];
      const here = p.started && r.draftId === DRAFTS[state.draft].id;
      const items = r.items.slice(0, p.shown);
      return {
        current: here ? [{
          id: r.id, title: r.title, goal: r.goal, status: p.done ? 'committed' : 'open', createdAt: r.createdAt, showing: state.tool === type,
          highlights: p.shown, findings: items.length, decided: items.filter((i) => i.decision.status !== 'pending').length, applied: state.made >= 1,
        }] : [],
        earlier: [],
      };
    },
    setFocus: async () => {},
    decide: async (itemId, decision) => {
      const item = reviews.improve.items.find((i) => i.id === itemId);
      item.decision = { ...item.decision, ...decision, at: new Date().toISOString() };
      emit('review', current());
    },
  };
  return api;
}
