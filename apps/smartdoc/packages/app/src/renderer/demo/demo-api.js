// A stand-in for the app's API (window.smartdoc, see preload.cjs) for the website demo: the
// scenario's document, drafts, reviews and variation held in memory, firing the same events the
// main process sends. Quotes are placed the way the main process places them, once the window
// reports a draft's page texts. The director (director.js) sets the scene through the first group
// of methods: whether the document has been added, which screen shows, which drafts exist, how far
// each review has got (as the agent adds to it) and what's been decided.

import { resolveQuote } from '../../main/anchors.js';
import { DOCUMENT, DRAFTS, HIGHLIGHTS, IMPROVE, VARIATION } from './scenario.js';

const day = (n) => new Date(Date.parse(DOCUMENT.importedAt) + n * 864e5).toISOString();

export function createDemoApi() {
  const listeners = {};
  const on = (name) => (callback) => (listeners[name] ??= []).push(callback);
  const emit = (name, value) => (listeners[name] ?? []).forEach((callback) => callback(value));

  let state;
  const pdfs = {}; // draft id → the PDF's bytes, fetched once
  const pageTexts = {}; // draft id → its page texts, once drawn
  const reviews = { improve: review(IMPROVE, 0), highlights: review(HIGHLIGHTS, 1) };

  // Back to the start: no document added, nothing shown, no reviews.
  function reset() {
    state = {
      added: false, // whether the document has been added
      screen: null, // 'home' or 'document' once the director shows one
      tool: 'improve',
      draft: 0,
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
    return { ...r, status: p.done ? 'committed' : 'open', items: r.items.slice(0, p.shown), highlights: r.highlights.slice(0, p.shown) };
  };

  async function showDraft(n) {
    state.screen = 'document';
    state.draft = n;
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
  return {
    // --- For the director ---
    reset,
    showDraft,
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
    // How far a review has got: { started, shown, done }.
    setProgress(type, progress) {
      state.progress[type] = { ...state.progress[type], ...progress };
      if (state.screen === 'document' && state.tool === type) emit('review', current());
      if (state.screen === 'home') emit('recent', listed());
    },
    // The first `count` findings decided as the scenario has them (the rest undecided).
    setDecided(count, decisions) {
      reviews.improve.items.forEach((item, i) => (item.decision = i < count ? { ...decisions[i] } : { status: 'pending' }));
      if (state.screen === 'document') emit('review', current());
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
    mcpSetup: async () => 'claude mcp add --scope user smartdoc -- npx -y @smartdoc/mcp',
    copyMcpSetup: async () => {},
    openWebsite: async () => {},
    copyText: async () => {},
    getAppearance: async () => 'system',
    setAppearance: async () => {},

    onRecentDocuments: on('recent'),
    onDocumentMade: on('made'),
    onVariationRequested: on('variation'),
    variationsOf: async () => variationsOf(),
    focusesFor: async () => ({ current: [], earlier: [] }),
    prepareDraft: async () => {},
    openDraft: async () => {},
    showDraftMenu: async () => {},
    showDocumentMenu: async () => {},
    showVariationMenu: async () => {},
    goHome: async () => {},

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
}
