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
  let review = null; // the current draft's current review, or null if it has none
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
    const reviews = await store.listReviews(doc.id, draftId);
    review = reviews.at(-1) ?? null;
    events.emit('draft');
    events.emit('review', review);
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

  const identity = () => {
    const number = doc.line.indexOf(doc.currentDraftId);
    return { id: doc.id, name: doc.name, draft: number === 0 ? 'Original' : `Draft ${number} of ${doc.line.length - 1}` };
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

    async openDocument(docId) {
      doc = await store.loadDocument(docId);
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

    async readCurrentDraftOf(docId) {
      const d = await store.loadDocument(docId);
      return readFile(store.draftPdfPath(d.id, d.currentDraftId));
    },

    // What the window needs to show the current draft.
    async draftView() {
      if (!doc) return null;
      const number = doc.line.indexOf(doc.currentDraftId);
      const draft = await store.loadDraft(doc.id, doc.currentDraftId);
      return {
        document: { id: doc.id, name: doc.name, importedAt: doc.importedAt },
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
                feedback: h.feedback,
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
    async startReview(by, { type = 'improve', goal, context } = {}) {
      requireDoc();
      if (!REVIEW_TYPES.includes(type)) throw new Error(`Unknown review type: ${type}. Use "improve" or "highlights".`);
      const clean = (text) => (typeof text === 'string' && text.trim() ? text.trim() : null);
      if (type === 'highlights' && !clean(goal) && !(review?.status === 'open' && typeOf(review) === type)) {
        throw new Error('A highlights review needs a goal: what the user is looking for in the document. Ask them first.');
      }
      if (review?.status === 'open' && typeOf(review) === type) {
        if (clean(goal)) review.goal = clean(goal);
        if (clean(context)) review.context = clean(context);
        if (clean(goal) || clean(context)) await saveReview();
        return review;
      }
      review = await store.createReview(doc.id, doc.currentDraftId, by, { type, goal: clean(goal), context: clean(context) });
      events.emit('review', review);
      return review;
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
        feedback: { useful: null, comment: '' }, // the user's: useful true/false, and a comment
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

    // The user's feedback on a highlight, at any time: { useful: true | false | null, comment }.
    async rateHighlight(id, feedback) {
      const r = requireType(requireReview(), 'highlights');
      const highlight = r.highlights.find((h) => h.id === id);
      if (!highlight) throw new Error(`No highlight ${id}.`);
      if ('useful' in feedback) highlight.feedback.useful = feedback.useful === null ? null : Boolean(feedback.useful);
      if (typeof feedback.comment === 'string') highlight.feedback.comment = feedback.comment;
      if ('useful' in feedback) logTo(r, 'user', `marked “${highlight.title}” ${highlight.feedback.useful === null ? 'unrated' : highlight.feedback.useful ? 'useful' : 'not useful'}`);
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
      review = await store.createReview(doc.id, doc.currentDraftId, 'user', { type: typeOf(old), goal: old.goal ?? null, context: old.context ?? null });
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
