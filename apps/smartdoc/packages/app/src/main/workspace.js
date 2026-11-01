import { EventEmitter } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveQuote } from './anchors.js';
import { renderHtmlToPdf } from './render-draft.js';
import { createStore, logTo } from './store.js';
import { MAX_READ_CHARS, estimateTokens, findText, parsePages, textStats } from './text-stats.js';

const MAX_RECENT = 10;
const PAGE_TEXT_WAIT_MS = 15 * 1000;
const INFO_FIRST_LINES_UP_TO = 200; // pages
const FIND_LIMIT = 50;
const firstLine = (text) => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};
const REQUEST_KINDS = ['rewrite', 'comment', 'keep', 'remove', 'add', 'ask'];
const ITEM_KINDS = ['change', 'options', 'question', 'move', 'design', 'flag'];
const REVIEW_TYPES = ['improve', 'highlights'];
const IMPORTANCE = ['high', 'medium', 'low'];
const typeOf = (r) => r.type ?? 'improve'; // reviews from before types existed are improvement reviews
// A review's name in the focus picker: its title, else its goal cut short; an improvement review
// with neither is a general one.
const draftLabel = (number) => (number === 0 ? 'Original' : `Draft ${number}`);
// A variation's name from its purpose, when the AI doesn't give one.
const shortName = (purpose) => (purpose.length > 40 ? `${purpose.slice(0, 39).trimEnd()}…` : purpose);
const focusTitle = (r) => r.title ?? (r.goal && r.goal.length > 48 ? `${r.goal.slice(0, 47).trimEnd()}…` : r.goal) ?? (typeOf(r) === 'improve' ? 'General review' : 'Highlights');

// The open document, its current draft and that draft's current review, plus the list of recent
// documents. The window, the menu and the MCP server all act through this, and it emits:
//   'draft'       the document or draft changed (the window reloads the PDF)
//   'review'      the current review changed
//   'recent'      the recent documents changed
//   'page-texts'  the window reported the current draft's page texts
// A draft's current review is its newest one. Reviews are single records: the user's requests, the
// AI's findings and annotations, the user's decisions and the history all live in one file.
export function createWorkspace(userData) {
  const store = createStore(userData);
  const events = new EventEmitter();
  const recentFile = path.join(userData, 'recent-documents.json');

  let doc = null; // the open document's record
  // The app has two tools, one per kind of review: improve ("Review and draft") and highlights
  // ("Review and highlight"). The active one, chosen by the user or the AI and kept with the
  // document, decides which review shows: the current draft's newest review of that kind.
  let tool = 'improve';
  let review = null; // the current draft's current review of the active tool's kind, or null if it has none
  let pageTexts = null; // the current draft's page texts, reported by the window once drawn
  let pdfDetails = null; // and the PDF's own details: { info, outline }
  let recent = []; // [{ id, name, importedAt }], newest first

  const requireDoc = () => {
    if (!doc) throw new Error('No document is open. Open one with open_document (list_documents shows the ones opened before).');
    return doc;
  };
  const requireReview = () => {
    if (!review) throw new Error('The current draft has no review. Start one with start_review.');
    return review;
  };
  const requireOpenReview = () => {
    const r = requireReview();
    if (r.status !== 'open') throw new Error('The review has been committed and is waiting for the user’s decisions. Start a new review to make more changes.');
    return r;
  };
  const requireCommittedReview = () => {
    const r = requireReview();
    if (r.status !== 'committed') throw new Error('Your own changes can be added once the AI has finished its review.');
    return r;
  };
  // Findings, notes, decisions and drafts belong to improvement reviews; highlights to highlights
  // reviews.
  const requireType = (r, type) => {
    if (typeOf(r) === type) return r;
    throw new Error(type === 'improve'
      ? 'The current review is a highlights review: it has highlights, not findings, and nothing to decide or apply. Start an improvement review (start_review with type "improve") to suggest changes.'
      : 'The current review is an improvement review. Start a highlights review (start_review with type "highlights" and the goal) to add highlights.');
  };
  const requireText = (text) => {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) throw new Error('Write the change first.');
    return trimmed;
  };
  const saveReview = async () => {
    await store.saveReview(doc.id, review);
    events.emit('review', review);
  };
  const anchorsFrom = (quotes = []) => quotes.map((q) => resolveQuote(pageTexts, q));

  async function showDraft(draftId) {
    doc.currentDraftId = draftId;
    await store.saveDocument(doc);
    pageTexts = null;
    pdfDetails = null;
    review = await newestReview();
    events.emit('draft');
    events.emit('review', review);
  }

  // The review the active tool shows on the current draft. In the highlight tool that's the focus
  // the user (or the AI) last chose on this draft, else its newest; a new draft has none of its own.
  async function newestReview() {
    const reviews = (await store.listReviews(doc.id, doc.currentDraftId)).filter((r) => typeOf(r) === tool && inVariation(r));
    if (tool === 'highlights') {
      const chosen = reviews.find((r) => r.id === doc.focus?.[doc.currentDraftId]);
      if (chosen) return chosen;
    }
    return reviews.at(-1) ?? null;
  }

  // A draft shared by variations shows all its highlights reviews, but only the improvement
  // reviews of the variation showing: those started in it, or whose drafts are on its line.
  const inVariation = (r, variationId = doc.variationId, line = doc.line) => typeOf(r) !== 'improve'
    || (r.variationId ?? store.ORIGINAL) === variationId
    || r.applications.some((a) => line.includes(a.draftId));

  // The goals of reviews of a kind on the drafts before `draftId` on a line, newest first, leaving
  // out those in `goals` (already run): a draft's earlier focuses, offered to run again.
  async function earlierFocuses(docId, line, draftId, type, goals) {
    const earlier = [];
    for (let i = line.indexOf(draftId) - 1; i >= 0; i--) {
      for (const r of (await store.listReviews(docId, line[i])).filter((x) => typeOf(x) === type).reverse()) {
        if (!r.goal || goals.has(r.goal)) continue;
        goals.add(r.goal);
        earlier.push({ title: focusTitle(r), goal: r.goal, context: r.context ?? null, draft: i === 0 ? 'Original' : `Draft ${i}` });
      }
    }
    return earlier;
  }

  // Remembers the focus showing on the current draft (saved with the document).
  async function rememberFocus(reviewId) {
    doc.focus = { ...doc.focus, [doc.currentDraftId]: reviewId };
    await store.saveDocument(doc);
  }

  // Before documents existed the app kept a list of file paths (recent.json). The first time this
  // version runs, those files are imported as documents so the list carries over; the old file is
  // left untouched.
  async function importOldRecentFiles() {
    let paths = [];
    try {
      paths = JSON.parse(await readFile(path.join(userData, 'recent.json'), 'utf8')).filter((p) => typeof p === 'string');
    } catch {
      return [];
    }
    const imported = [];
    for (const p of paths.slice(0, MAX_RECENT)) {
      try {
        const d = await store.importDocument(p);
        imported.push({ id: d.id, name: d.name, importedAt: d.importedAt });
      } catch {} // moved or deleted since
    }
    return imported;
  }

  // Waits a little for a document that's just been opened to finish loading in the window.
  async function loadedPages() {
    requireDoc();
    if (!pageTexts) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, PAGE_TEXT_WAIT_MS);
        function done() {
          clearTimeout(timer);
          events.off('page-texts', done);
          resolve();
        }
        events.on('page-texts', done);
      });
    }
    requireDoc();
    if (!pageTexts) throw new Error('The document is still loading in the app. Try again in a moment.');
  }

  const activeVariation = () => doc.variations.find((v) => v.id === doc.variationId);
  const identity = () => {
    const number = doc.line.indexOf(doc.currentDraftId);
    const variation = activeVariation();
    return {
      id: doc.id,
      name: doc.name,
      variation: { id: variation.id, name: variation.name, ...(variation.purpose && { purpose: variation.purpose }) },
      draft: number === 0 ? 'Original' : `Draft ${number} of ${doc.line.length - 1}`,
      ...(doc.createdFrom && { createdFrom: { id: doc.createdFrom.id, name: doc.createdFrom.name, draft: doc.createdFrom.draft } }),
    };
  };

  async function saveRecent() {
    await writeFile(recentFile, JSON.stringify(recent)).catch(() => {});
    events.emit('recent', recent);
  }

  return {
    events,
    get document() { return doc; },
    get review() { return review; },
    get recent() { return recent; },

    async loadRecent() {
      try {
        recent = JSON.parse(await readFile(recentFile, 'utf8'));
      } catch {
        recent = await importOldRecentFiles();
        await saveRecent();
      }
      events.emit('recent', recent);
    },

    async removeRecent(docId) {
      recent = recent.filter((r) => r.id !== docId);
      await saveRecent();
    },

    async clearRecent() {
      recent = [];
      await saveRecent();
    },

    // Opening a file always imports it as a new document.
    async importAndOpen(sourcePath) {
      const imported = await store.importDocument(sourcePath);
      await this.openDocument(imported.id);
      return imported;
    },

    // A new variation of the open document for a purpose (a CV tailored to one job, say), from
    // one of a variation's drafts: by default the draft showing. It becomes the variation showing,
    // on that draft, and its next draft follows on from there.
    async createVariation({ purpose, name, variation: fromId, draft } = {}) {
      requireDoc();
      const clean = (text) => (typeof text === 'string' && text.trim() ? text.trim() : null);
      if (!clean(purpose)) throw new Error('A variation needs a purpose: what it\'s for, such as the job it\'s tailored to.');
      const from = doc.variations.find((v) => v.id === (fromId ?? doc.variationId));
      if (!from) throw new Error(`No variation ${fromId}. list_variations shows them.`);
      const line = from.id === doc.variationId ? doc.line : from.line;
      const number = draft ?? line.indexOf(from.id === doc.variationId ? doc.currentDraftId : from.currentDraftId);
      if (!Number.isInteger(number) || number < 0 || number >= line.length) {
        throw new Error(`No draft ${draft} in ${from.name}: it has the original (0) and drafts 1 to ${line.length - 1}.`);
      }
      const variation = await store.createVariation(doc, {
        name: clean(name) ?? shortName(clean(purpose)),
        purpose: clean(purpose),
        fromVariationId: from.id,
        fromDraftId: line[number],
      });
      await showDraft(doc.currentDraftId);
      events.emit('recent', recent); // the home screen lists variations
      return { variation: variation.id, name: variation.name, purpose: variation.purpose, from: `${draftLabel(number)} of ${from.name}`, showing: draftLabel(number) };
    },

    // The open document's variations, the one showing marked.
    listVariations() {
      requireDoc();
      return doc.variations.map((v) => {
        const line = v.id === doc.variationId ? doc.line : v.line;
        return { id: v.id, name: v.name, purpose: v.purpose ?? null, drafts: line.length - 1, showing: v.id === doc.variationId };
      });
    },

    // Shows one of the open document's variations, on its current draft.
    async setVariation(variationId) {
      requireDoc();
      if (variationId !== doc.variationId) {
        store.selectVariation(doc, variationId);
        await showDraft(doc.currentDraftId);
      }
      return { variation: variationId, name: doc.variations.find((v) => v.id === variationId).name, showing: identity().draft };
    },

    // Opens a document on one of its variations' drafts (from the home screen), in the given tool
    // or the one it was last used in.
    async openDraft(docId, variationId, draftId, nextTool) {
      if (doc?.id !== docId) await this.openDocument(docId);
      if (variationId !== doc.variationId) store.selectVariation(doc, variationId);
      if (!doc.line.includes(draftId)) throw new Error(`No draft ${draftId} in this variation.`);
      if (REVIEW_TYPES.includes(nextTool) && nextTool !== tool) {
        tool = nextTool;
        doc.tool = nextTool;
        events.emit('tool', tool);
      }
      await showDraft(draftId);
    },

    // A new document from one of a document's drafts (an improved CV, say, to make variations
    // of). It goes to the top of the documents list.
    async documentFromDraft(docId, variationId, draftId) {
      const source = doc?.id === docId ? doc : await store.loadDocument(docId);
      const variation = source.variations.find((v) => v.id === variationId);
      const line = variation && (variation.id === source.variationId ? source.line : variation.line);
      const number = line?.indexOf(draftId) ?? -1;
      if (number === -1) throw new Error(`No draft ${draftId} in that variation.`);
      const base = source.name.replace(/\.pdf$/i, '');
      const label = variation.id === store.ORIGINAL ? draftLabel(number) : `${variation.name}, ${draftLabel(number)}`;
      const made = await store.documentFromDraft(source, draftId, { name: `${base} (${label})`, draft: label });
      recent = [{ id: made.id, name: made.name, importedAt: made.importedAt }, ...recent].slice(0, MAX_RECENT);
      await saveRecent();
      return { id: made.id, name: made.name };
    },

    async openDocument(docId) {
      doc = await store.loadDocument(docId);
      // A document opens in the tool it was last used with; older ones in the kind of their newest
      // review.
      if (REVIEW_TYPES.includes(doc.tool)) tool = doc.tool;
      else tool = typeOf((await store.listReviews(doc.id, doc.currentDraftId)).at(-1) ?? {});
      events.emit('tool', tool);
      recent = [{ id: doc.id, name: doc.name, importedAt: doc.importedAt }, ...recent.filter((r) => r.id !== doc.id)].slice(0, MAX_RECENT);
      await saveRecent();
      await showDraft(doc.currentDraftId);
    },

    close() {
      doc = null;
      review = null;
      pageTexts = null;
      pdfDetails = null;
      events.emit('draft');
      events.emit('review', null);
    },

    isRecent: (docId) => recent.some((r) => r.id === docId),

    // A document's variations and each one's drafts, newest first, for the home screen. The
    // drafts a variation shares with the one it came from are marked, and each draft says where
    // its reviews stand: the variation's improvement review, and the highlights focus last shown
    // (with how many others there are).
    async variationsOf(docId) {
      const d = doc?.id === docId ? doc : await store.loadDocument(docId);
      const drafts = new Map((await store.listDrafts(d.id)).map((x) => [x.id, x]));
      const reviewsOf = async (variation, line, draftId) => {
        const all = await store.listReviews(d.id, draftId);
        const improve = all.filter((r) => typeOf(r) === 'improve' && inVariation(r, variation.id, line)).at(-1);
        const focuses = all.filter((r) => typeOf(r) === 'highlights');
        const highlights = focuses.find((r) => r.id === d.focus?.[draftId]) ?? focuses.at(-1);
        return {
          improve: improve && {
            title: focusTitle(improve),
            status: improve.status,
            findings: improve.items.length,
            decided: improve.items.filter((i) => i.decision.status !== 'pending').length,
            applied: improve.applications.length > 0,
          },
          highlights: highlights && {
            title: focusTitle(highlights),
            status: highlights.status,
            count: (highlights.highlights ?? []).length,
            others: focuses.length - 1,
          },
        };
      };
      return {
        id: d.id,
        name: d.name,
        createdFrom: d.createdFrom ?? null,
        variations: await Promise.all(d.variations.map(async (v) => {
          const line = v.id === d.variationId ? d.line : v.line;
          const shared = v.fromDraftId ? line.indexOf(v.fromDraftId) : -1;
          const from = d.variations.find((x) => x.id === v.fromVariationId);
          return {
            id: v.id,
            name: v.name,
            purpose: v.purpose ?? null,
            from: from ? `${draftLabel(shared)} of ${from.name}` : null,
            updatedAt: drafts.get(line.at(-1))?.createdAt ?? v.createdAt,
            drafts: (await Promise.all(line.map(async (id, i) => ({
              id,
              label: draftLabel(i),
              createdAt: drafts.get(id)?.createdAt ?? null,
              summary: drafts.get(id)?.summary ?? null,
              shared: i <= shared && Boolean(from) ? from.name : null,
              reviews: await reviewsOf(v, line, id),
            })))).reverse(),
          };
        })),
      };
    },

    // What the window needs to show the current draft.
    async draftView() {
      if (!doc) return null;
      const number = doc.line.indexOf(doc.currentDraftId);
      const draft = await store.loadDraft(doc.id, doc.currentDraftId);
      return {
        document: { id: doc.id, name: doc.name, importedAt: doc.importedAt },
        variation: { id: doc.variationId, name: activeVariation().name, isOriginal: doc.variationId === store.ORIGINAL },
        draft: { id: draft.id, number, total: doc.line.length - 1, isOriginal: draft.id === store.ORIGINAL, summary: draft.summary },
        pdf: new Uint8Array(await readFile(store.draftPdfPath(doc.id, doc.currentDraftId))),
      };
    },

    currentDraftPdfPath: () => doc && store.draftPdfPath(doc.id, doc.currentDraftId),

    // Steps along the active line (the draft history): -1 for the previous draft, +1 for the next.
    async stepDraft(delta) {
      requireDoc();
      const to = doc.line.indexOf(doc.currentDraftId) + delta;
      if (to < 0 || to >= doc.line.length) return;
      await showDraft(doc.line[to]);
    },

    // The window reports each draft's page texts once it has drawn the text layer.
    setPageTexts(docId, draftId, texts, details) {
      if (doc?.id !== docId || doc.currentDraftId !== draftId) return;
      pageTexts = texts;
      pdfDetails = details ?? null;
      events.emit('page-texts');
    },

    // --- Reading (for the AI) ------------------------------------------------------------

    // The document's size and shape, so the AI can plan how to read it: counts for the whole
    // document and each page (with its first line, often a heading), the PDF's own details and
    // its outline (bookmarks) if it has them.
    async getDocumentInfo() {
      await loadedPages();
      const pages = pageTexts.map((text, i) => ({ page: i + 1, ...textStats(text), firstLine: firstLine(text) }));
      // Characters are the pages' own, as get_document counts them for its limit.
      const whole = { ...textStats(pageTexts.join('\n')), characters: pages.reduce((n, p) => n + p.characters, 0) };
      // Very long documents leave out each page's first line, to keep this short.
      const brief = pages.length > INFO_FIRST_LINES_UP_TO;
      return {
        ...identity(),
        pages: pages.length,
        ...whole,
        paragraphsNote: 'Paragraph counts are estimated from the layout.',
        estimatedTokens: estimateTokens(whole.characters),
        readWhole: whole.characters <= MAX_READ_CHARS
          ? 'Small enough to read whole with get_document.'
          : 'Too large to read whole: read it a range of pages at a time (get_document with pages), and use find_text to find what matters.',
        pdf: pdfDetails?.info ?? {},
        outline: pdfDetails?.outline ?? [],
        perPage: brief ? pages.map(({ firstLine: _, ...p }) => p) : pages,
      };
    },

    // The text of the whole document, or of the pages asked for ("3", "5-9", "1-3, 12"), up to
    // MAX_READ_CHARS at a time.
    async getDocument({ pages: spec } = {}) {
      await loadedPages();
      const numbers = spec ? parsePages(spec, pageTexts.length) : pageTexts.map((_, i) => i + 1);
      const size = numbers.reduce((n, p) => n + pageTexts[p - 1].length, 0);
      if (size > MAX_READ_CHARS) {
        throw new Error(spec
          ? `Pages ${spec} hold about ${estimateTokens(size).toLocaleString('en')} tokens of text, more than can be read at once (about ${estimateTokens(MAX_READ_CHARS).toLocaleString('en')}). Ask for fewer pages; get_document_info shows each page's size.`
          : `This document has ${pageTexts.length} pages and about ${estimateTokens(size).toLocaleString('en')} tokens of text, more than can be read at once. Read it a range of pages at a time with pages, using get_document_info for its size and outline and find_text to find what matters.`);
      }
      return {
        ...identity(),
        totalPages: pageTexts.length,
        pages: numbers.map((page) => ({ page, text: pageTexts[page - 1] })),
      };
    },

    async findText({ query, limit = FIND_LIMIT }) {
      await loadedPages();
      return findText(pageTexts, query, Math.min(Math.max(1, limit), FIND_LIMIT));
    },

    getReview() {
      requireDoc();
      return review && { ...review, type: typeOf(review) };
    },

    // Every earlier review of this document, across all its drafts, oldest first: what the AI
    // raised and what the user decided, so a new review doesn't ask again. The current review
    // (get_review) is left out. Quotes are given as text only; they refer to the draft the review
    // was of.
    async getHistory() {
      requireDoc();
      const draftName = (id, abandoned) => {
        const number = doc.line.indexOf(id);
        if (number === 0) return 'Original';
        return number > 0 ? `Draft ${number}` : `Abandoned draft (${abandoned ? 'set aside' : 'not on the current line'})`;
      };
      const reviews = [];
      for (const draft of await store.listDrafts(doc.id)) {
        for (const r of await store.listReviews(doc.id, draft.id)) {
          if (r.id === review?.id) continue;
          const quoted = (anchors) => anchors.map((a) => a.text.replace(/\s+/g, ' '));
          if (typeOf(r) === 'highlights') {
            reviews.push({
              review: r.id,
              type: 'highlights',
              of: draftName(draft.id, draft.abandoned),
              startedAt: r.createdAt,
              committedAt: r.committedAt ?? null,
              goal: r.goal,
              context: r.context,
              summary: r.summary ?? null,
              highlights: r.highlights.map((h) => ({
                category: h.category,
                title: h.title,
                importance: h.importance,
                quotes: quoted(h.anchors),
                missing: h.missing,
              })),
            });
            continue;
          }
          reviews.push({
            review: r.id,
            type: 'improve',
            of: draftName(draft.id, draft.abandoned),
            startedAt: r.createdAt,
            committedAt: r.committedAt ?? null,
            goal: r.goal ?? null,
            // A review that was decided but not applied may have been replaced by a later one.
            outcome: r.applications.length ? `applied as ${r.applications.map((a) => draftName(a.draftId)).join(', ')}`
              : r.status !== 'committed' ? 'never committed'
              : r.items.some((i) => i.decision.status !== 'pending') ? 'decided, not applied'
              : 'committed, nothing decided',
            summary: r.summary ?? null,
            findings: r.items.map((i) => ({
              kind: i.kind,
              title: i.title,
              quotes: quoted(i.anchors),
              ...(i.proposal && { proposal: i.proposal }),
              ...(i.options && { options: i.options }),
              ...(i.question && { question: i.question }),
              decision: i.decision,
            })),
            requests: r.requests.map((q) => ({ kind: q.kind, quotes: quoted(q.anchors), note: q.note })),
            changes: (r.changes ?? []).map((c) => c.text),
          });
        }
      }
      return { document: doc.name, currentDraft: draftName(doc.currentDraftId), reviews };
    },

    // --- Reviews -------------------------------------------------------------------------

    // Starts a review of the given type, with the goal agreed with the user (required for a
    // highlights review). An open review of the same type carries on, taking any new goal; one
    // of the other type is left as it is, unfinished, and a new review becomes current.
    get tool() { return tool; },

    // Switches the active tool, showing the current draft's newest review of its kind.
    async setTool(next) {
      requireDoc();
      if (!REVIEW_TYPES.includes(next)) throw new Error(`Unknown tool: ${next}. Use "improve" or "highlights".`);
      if (next === tool) return { tool };
      tool = next;
      doc.tool = next;
      await store.saveDocument(doc);
      review = await newestReview();
      events.emit('tool', tool);
      events.emit('review', review);
      return { tool, review: review ? { id: review.id, status: review.status } : null };
    },

    async startReview(by, { type = 'improve', goal, context, title } = {}) {
      requireDoc();
      if (!REVIEW_TYPES.includes(type)) throw new Error(`Unknown review type: ${type}. Use "improve" or "highlights".`);
      // Starting a review of the other kind switches the app to that tool first.
      if (type !== tool) await this.setTool(type);
      const clean = (text) => (typeof text === 'string' && text.trim() ? text.trim() : null);
      if (type === 'highlights' && !clean(goal) && !(review?.status === 'open' && typeOf(review) === type)) {
        throw new Error('A highlights review needs a goal: what the user is looking for in the document. Ask them first.');
      }
      // An open review carries on, unless it's a highlights review and the goal is a new one: each
      // goal is its own focus, and the others are kept.
      const sameFocus = type !== 'highlights' || !clean(goal) || clean(goal) === review?.goal;
      if (review?.status === 'open' && typeOf(review) === type && sameFocus) {
        if (clean(goal)) review.goal = clean(goal);
        if (clean(context)) review.context = clean(context);
        if (clean(title)) review.title = clean(title);
        if (clean(goal) || clean(context) || clean(title)) await saveReview();
        return review;
      }
      review = await store.createReview(doc.id, doc.currentDraftId, by, { type, goal: clean(goal), context: clean(context), title: clean(title), variationId: doc.variationId });
      if (type === 'highlights') await rememberFocus(review.id);
      events.emit('review', review);
      return review;
    },

    // A tool's focuses (highlights by default). In the highlight tool: this draft's highlights
    // reviews, newest first, the one showing marked. In the draft tool, the draft's one review that
    // counts, its newest, with how far its decisions have got. And for either, the goals of
    // earlier drafts' reviews of that kind that haven't been run on this one, offered to run again
    // (a new draft shows none of them until then).
    async listFocuses(type = 'highlights') {
      requireDoc();
      if (!REVIEW_TYPES.includes(type)) throw new Error(`Unknown review type: ${type}. Use "improve" or "highlights".`);
      const summary = (r) => ({
        id: r.id,
        title: focusTitle(r),
        goal: r.goal,
        status: r.status,
        createdAt: r.createdAt,
        ...(type === 'highlights'
          ? { highlights: (r.highlights ?? []).length }
          : { findings: r.items.length, decided: r.items.filter((i) => i.decision.status !== 'pending').length, applied: r.applications.length > 0 }),
      });
      let here = (await store.listReviews(doc.id, doc.currentDraftId)).filter((r) => typeOf(r) === type && inVariation(r));
      if (type === 'improve') here = here.slice(-1);
      const showing = tool === type ? review?.id : (here.find((r) => r.id === doc.focus?.[doc.currentDraftId]) ?? here.at(-1))?.id;
      return {
        current: [...here].reverse().map((r) => ({ ...summary(r), showing: r.id === showing })),
        earlier: await earlierFocuses(doc.id, doc.line, doc.currentDraftId, type, new Set(here.map((r) => r.goal))),
      };
    },

    // The focuses to start a review of a kind on a draft the home screen lists (one with no review
    // of that kind yet): the goals of the drafts before it on its variation's line, to run again.
    async focusesFor(docId, variationId, draftId, type) {
      if (!REVIEW_TYPES.includes(type)) throw new Error(`Unknown review type: ${type}. Use "improve" or "highlights".`);
      const d = doc?.id === docId ? doc : await store.loadDocument(docId);
      const variation = d.variations.find((v) => v.id === variationId);
      const line = variation && (variation.id === d.variationId ? d.line : variation.line);
      if (!line?.includes(draftId)) throw new Error(`No draft ${draftId} in that variation.`);
      return { current: [], earlier: await earlierFocuses(d.id, line, draftId, type, new Set()) };
    },

    // Makes a draft its document's current place (its variation, the draft and the tool) without
    // opening it, so the agent finds it there when it opens the document: for a review started
    // from the home screen.
    async prepareDraft(docId, variationId, draftId, nextTool) {
      if (doc?.id === docId) return this.openDraft(docId, variationId, draftId, nextTool);
      const d = await store.loadDocument(docId);
      if (variationId !== d.variationId) store.selectVariation(d, variationId);
      if (!d.line.includes(draftId)) throw new Error(`No draft ${draftId} in that variation.`);
      d.currentDraftId = draftId;
      if (REVIEW_TYPES.includes(nextTool)) d.tool = nextTool;
      await store.saveDocument(d);
    },

    // Shows one of this draft's focuses, switching to the highlight tool if need be.
    async setFocus(reviewId) {
      requireDoc();
      const chosen = (await store.listReviews(doc.id, doc.currentDraftId)).find((r) => r.id === reviewId && typeOf(r) === 'highlights');
      if (!chosen) throw new Error(`No highlights review ${reviewId} on the current draft. list_focuses shows them.`);
      await rememberFocus(chosen.id);
      if (tool !== 'highlights') {
        tool = 'highlights';
        doc.tool = tool;
        await store.saveDocument(doc);
        events.emit('tool', tool);
      }
      review = chosen;
      events.emit('review', review);
      return { focus: focusTitle(chosen), review: chosen.id };
    },

    // The user's requests marked on the page. A committed review takes no more requests.
    async addRequest(request) {
      requireDoc();
      if (!REQUEST_KINDS.includes(request.kind)) throw new Error(`Unknown request kind: ${request.kind}`);
      if (!review || review.status !== 'open' || typeOf(review) !== 'improve') await this.startReview('user');
      const entry = { id: `request-${Date.now().toString(36)}-${review.requests.length}`, kind: request.kind, anchors: request.anchors ?? [], note: request.note ?? '', details: request.details ?? {}, createdAt: new Date().toISOString() };
      review.requests.push(entry);
      logTo(review, 'user', `added a ${entry.kind} request`);
      await saveReview();
      return entry;
    },

    async updateRequest(id, changes) {
      const r = requireOpenReview();
      const entry = r.requests.find((q) => q.id === id);
      if (!entry) throw new Error(`No request ${id}.`);
      if (typeof changes.note === 'string') entry.note = changes.note;
      if (changes.details) entry.details = { ...entry.details, ...changes.details };
      await saveReview();
    },

    async removeRequest(id) {
      const r = requireOpenReview();
      r.requests = r.requests.filter((q) => q.id !== id);
      logTo(r, 'user', 'removed a request');
      await saveReview();
    },

    async addAnnotation({ quotes, style = 'highlight', color, note }) {
      const r = requireType(requireOpenReview(), 'improve');
      const entry = { id: `annotation-${Date.now().toString(36)}-${r.annotations.length}`, anchors: anchorsFrom(quotes), style, color: color ?? null, note: note ?? '' };
      r.annotations.push(entry);
      await saveReview();
      return entry;
    },

    async addFinding(finding) {
      const r = requireType(requireOpenReview(), 'improve');
      if (!ITEM_KINDS.includes(finding.kind)) throw new Error(`Unknown finding kind: ${finding.kind}`);
      if (finding.in_response_to && !r.requests.some((q) => q.id === finding.in_response_to)) {
        throw new Error(`No request ${finding.in_response_to} in this review.`);
      }
      const item = {
        id: `item-${Date.now().toString(36)}-${r.items.length}`,
        kind: finding.kind,
        title: finding.title,
        body: finding.body ?? '',
        severity: finding.severity ?? 'medium',
        anchors: anchorsFrom(finding.quotes),
        inResponseTo: finding.in_response_to ?? null,
        proposal: finding.proposal ?? null, // change: { before, after }; move/design: { description }
        options: finding.options ?? null, // options: [{ label, text }]
        question: finding.question ?? null,
        decision: { status: 'pending' },
      };
      r.items.push(item);
      logTo(r, 'ai', `added a ${item.kind} finding: ${item.title}`);
      await saveReview();
      return item;
    },

    async removeFinding(id) {
      const r = requireType(requireOpenReview(), 'improve');
      r.items = r.items.filter((i) => i.id !== id);
      logTo(r, 'ai', 'removed a finding');
      await saveReview();
    },

    // A piece of key information for the user's goal, quoting the text it's in. One with no text
    // is something the user would expect that the document doesn't have.
    async addHighlight({ category, title, note, importance = 'medium', quotes }) {
      const r = requireType(requireOpenReview(), 'highlights');
      if (!IMPORTANCE.includes(importance)) throw new Error(`Unknown importance: ${importance}. Use high, medium or low.`);
      const anchors = anchorsFrom(quotes);
      const highlight = {
        id: `highlight-${Date.now().toString(36)}-${r.highlights.length}`,
        category: category.trim(),
        title: title.trim(),
        note: note?.trim() ?? '',
        importance,
        anchors,
        missing: !anchors.length,
      };
      r.highlights.push(highlight);
      logTo(r, 'ai', `added a highlight: ${highlight.title}`);
      await saveReview();
      return highlight;
    },

    async removeHighlight(id) {
      const r = requireType(requireOpenReview(), 'highlights');
      if (!r.highlights.some((h) => h.id === id)) throw new Error(`No highlight ${id}.`);
      r.highlights = r.highlights.filter((h) => h.id !== id);
      logTo(r, 'ai', 'removed a highlight');
      await saveReview();
    },

    async commitReview(summary) {
      const r = requireOpenReview();
      r.status = 'committed';
      r.committedAt = new Date().toISOString();
      r.summary = summary ?? null;
      logTo(r, 'ai', 'committed the review');
      await saveReview();
      return r;
    },

    // The user's decision on one finding: { status, choice, answer, edited, comment }.
    async decide(itemId, decision) {
      const r = requireType(requireReview(), 'improve');
      if (r.status !== 'committed') throw new Error('Decisions open once the review is committed.');
      const item = r.items.find((i) => i.id === itemId);
      if (!item) throw new Error(`No finding ${itemId}.`);
      item.decision = { ...item.decision, ...decision, at: new Date().toISOString() };
      logTo(r, 'user', `${item.decision.status} “${item.title}”`);
      await saveReview();
    },

    // Changes the user writes themselves for the AI to carry out with their decisions, once the
    // review is committed: free text, not tied to a finding.
    async addChange(text) {
      const r = requireType(requireCommittedReview(), 'improve');
      const entry = { id: `change-${Date.now().toString(36)}-${(r.changes ??= []).length}`, text: requireText(text), createdAt: new Date().toISOString() };
      r.changes.push(entry);
      logTo(r, 'user', 'added a change of their own');
      await saveReview();
      return entry;
    },

    async updateChange(id, text) {
      const r = requireCommittedReview();
      const entry = r.changes?.find((c) => c.id === id);
      if (!entry) throw new Error(`No change ${id}.`);
      entry.text = requireText(text);
      entry.updatedAt = new Date().toISOString();
      await saveReview();
    },

    async removeChange(id) {
      const r = requireCommittedReview();
      r.changes = (r.changes ?? []).filter((c) => c.id !== id);
      logTo(r, 'user', 'removed a change of their own');
      await saveReview();
    },

    // Back to the start of step 1: a new, empty review of the current draft for the AI to fill,
    // of the same type and goal. The old review stays in the draft's reviews folder.
    async resetToReview() {
      const old = requireReview();
      review = await store.createReview(doc.id, doc.currentDraftId, 'user', { type: typeOf(old), goal: old.goal ?? null, context: old.context ?? null, title: old.title ?? null, variationId: doc.variationId });
      if (typeOf(review) === 'highlights') await rememberFocus(review.id);
      events.emit('review', review);
      return review;
    },

    // Back to the start of step 2: every finding undecided again (choices, answers, edits and
    // comments cleared) and the user's own changes removed. The AI's findings and notes stay.
    async resetDecisions() {
      const r = requireType(requireCommittedReview(), 'improve');
      for (const item of r.items) item.decision = { status: 'pending' };
      r.changes = [];
      logTo(r, 'user', 'reset their decisions');
      await saveReview();
    },

    getDecisions() {
      const r = requireType(requireReview(), 'improve');
      return {
        status: r.status,
        requests: r.requests,
        changes: r.changes ?? [],
        items: r.items.map(({ id, kind, title, inResponseTo, proposal, options, question, decision }) => ({ id, kind, title, inResponseTo, proposal, options, question, decision })),
      };
    },

    // Applies the review: the AI supplies the new draft as a complete HTML document; the app
    // draws it to PDF and stores it as the next draft, which becomes current.
    async applyReview({ html, summary, appliedItemIds }) {
      const r = requireType(requireReview(), 'improve');
      if (r.status !== 'committed') throw new Error('Commit the review and let the user decide before applying it.');
      const page = withDefaultPage(html);
      const pdf = await renderHtmlToPdf(page);
      const { draftId, abandoned } = await store.createDraft(doc, r, { pdf, html: page, summary, appliedItemIds });
      r.applications.push({ draftId, at: new Date().toISOString(), itemIds: appliedItemIds ?? [] });
      logTo(r, 'ai', 'applied the review as a new draft');
      await store.saveReview(doc.id, r);
      await showDraft(draftId);
      return { draft: `Draft ${doc.line.length - 1}`, abandonedDrafts: abandoned.length };
    },

    async saveDraftAs(target) {
      requireDoc();
      await writeFile(target, await readFile(store.draftPdfPath(doc.id, doc.currentDraftId)));
    },

    async exists(file) {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// A4 with sensible margins unless the HTML sets its own @page rules (it comes later, so it wins).
function withDefaultPage(html) {
  // External images can't load (drafts are drawn offline), so hide any that fail rather than
  // leaving broken-image icons.
  const defaults = '<style>@page { size: A4; margin: 14mm 16mm; } img:not([src^="data:"]) { display: none; }</style>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${defaults}`) : `${defaults}${html}`;
}
