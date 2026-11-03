import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Documents live in the app's data folder, one folder each. A document is defined by the upload:
// opening a PDF copies it in as the document's original, and the same file opened twice is two
// documents. Nothing links back to where the file came from.
//
//   documents/<document id>/
//     document.json                 name, import time, its variations (each a line of drafts and
//                                   its current draft), the active one, and for a document made
//                                   from another's draft, which
//     drafts/<draft id>/
//       draft.json                  parent, the review it was applied from, abandoned or not
//       draft.pdf                   the original is the draft with id "original"
//       content.html                the source a generated draft was drawn from
//       reviews/<review id>.json    one review: requests, findings, decisions and history
//       previews/<review id>/       the next draft the AI wrote from that review, waiting for the
//                                   user to accept it (draft.pdf and content.html); not yet a draft
//
// Drafts form a tree. Each variation is a line through it, from the original to its tip: the
// "Original" variation is the document's own, and the others (one per purpose, such as a job)
// branch off at a draft of their choosing, sharing the drafts before it. The active variation's
// line is walked by the draft controls. Applying a review from an earlier draft starts a new
// branch and marks the drafts after it on the old line abandoned (kept on disk, just no longer
// on the line).

const ORIGINAL = 'original';
const now = () => new Date().toISOString();
const newId = () => randomUUID().slice(0, 8);

export function createStore(root, { onReview = () => {}, onDocument = () => {} } = {}) {
  // Several windows can have a document open, so there's one copy in memory of each review, and of
  // what a document's windows share (its variations and their lines of drafts). Each window has
  // its own view of the document: where it is (variation, draft, tool, focus).
  const reviews = new Map(); // review file → its record, read once
  const readReview = (file) => {
    if (!reviews.has(file)) reviews.set(file, readJson(file).catch((error) => { reviews.delete(file); throw error; }));
    return reviews.get(file);
  };
  const documents = new Map(); // document id → its record, read once
  const views = new WeakSet();
  function viewOf(shared) {
    const view = { ...shared };
    delete view.line;
    const active = () => view.variations.find((v) => v.id === view.variationId);
    Object.defineProperty(view, 'line', { enumerable: true, get: () => active().line, set: (line) => { active().line = line; } });
    views.add(view);
    return view;
  }

  const docDir = (docId) => path.join(root, 'documents', safe(docId));
  const draftDir = (docId, draftId) => path.join(docDir(docId), 'drafts', safe(draftId));
  const reviewPath = (docId, draftId, reviewId) => path.join(draftDir(docId, draftId), 'reviews', `${safe(reviewId)}.json`);
  const previewDir = (docId, review) => path.join(draftDir(docId, review.draftId), 'previews', safe(review.id));

  // The active variation's line is kept on the document (doc.line, doc.currentDraftId), where
  // everything else reads it; saving copies it back into the variation.
  const saveDocument = async (doc) => {
    const active = doc.variations.find((v) => v.id === doc.variationId);
    active.line = doc.line;
    // A draft only being looked at (workingDraftId, see showDraft) is never where the document
    // reopens.
    const { workingDraftId, ...saved } = doc;
    saved.currentDraftId = settledDraft(doc);
    active.currentDraftId = saved.currentDraftId;
    if (!views.has(doc)) documents.delete(doc.id); // written from outside the views: read it afresh
    // A view opened from now on starts here, just as it would after a restart.
    else Object.assign(await documents.get(doc.id) ?? {}, saved);
    await writeJson(path.join(docDir(doc.id), 'document.json'), saved);
    onDocument(doc);
  };

  async function newDocument(name, copyOriginal, extra = {}) {
    const id = `${Date.now().toString(36)}-${newId()}`;
    const doc = withVariations({ id, name, importedAt: now(), ...extra, line: [ORIGINAL], currentDraftId: ORIGINAL });
    const to = draftDir(id, ORIGINAL);
    await mkdir(path.join(to, 'reviews'), { recursive: true });
    await copyOriginal(to);
    await writeJson(path.join(to, 'draft.json'), {
      id: ORIGINAL, parentId: null, fromReviewId: null, createdAt: doc.importedAt, abandoned: false, summary: null, appliedItemIds: [],
    });
    await saveDocument(doc);
    return doc;
  }

  return {
    ORIGINAL,
    draftPdfPath: (docId, draftId) => path.join(draftDir(docId, draftId), 'draft.pdf'),

    async importDocument(sourcePath) {
      return newDocument(path.basename(sourcePath), (to) => copyFile(sourcePath, path.join(to, 'draft.pdf')));
    },

    // A new document from one of another document's drafts (an improved CV, say, to make
    // variations of): that draft, its PDF and the HTML it was drawn from, becomes the new
    // document's original. The other document is left as it is.
    async documentFromDraft(source, draftId, { name, draft }) {
      const from = draftDir(source.id, draftId);
      return newDocument(name, async (to) => {
        await copyFile(path.join(from, 'draft.pdf'), path.join(to, 'draft.pdf'));
        await copyFile(path.join(from, 'content.html'), path.join(to, 'content.html')).catch(() => {}); // an imported original has none
      }, { createdFrom: { id: source.id, name: source.name, draftId, draft } });
    },

    // A variation of the document for a purpose of its own (a CV tailored to one job, say),
    // starting from one of a variation's drafts: its line is that variation's up to the draft,
    // and its own drafts follow on from there. It becomes the active variation.
    async createVariation(doc, { name, purpose, fromVariationId, fromDraftId }) {
      const from = doc.variations.find((v) => v.id === fromVariationId);
      if (!from) throw new Error(`No variation ${fromVariationId}.`);
      const at = lineOf(doc, from).indexOf(fromDraftId);
      if (at === -1) throw new Error(`No draft ${fromDraftId} in ${from.name}.`);
      const variation = {
        id: `variation-${Date.now().toString(36)}-${newId()}`,
        name, purpose, fromVariationId, fromDraftId, createdAt: now(),
        line: lineOf(doc, from).slice(0, at + 1), currentDraftId: fromDraftId,
      };
      doc.variations.push(variation);
      selectVariation(doc, variation.id);
      await saveDocument(doc);
      return variation;
    },

    selectVariation,

    async loadDocument(docId) {
      if (!documents.has(docId)) {
        documents.set(docId, readJson(path.join(docDir(docId), 'document.json')).then(withVariations).catch((error) => {
          documents.delete(docId);
          throw error;
        }));
      }
      return viewOf(await documents.get(docId));
    },
    saveDocument,
    loadDraft: (docId, draftId) => readJson(path.join(draftDir(docId, draftId), 'draft.json')),

    // Every draft of a document, abandoned ones included, oldest first.
    async listDrafts(docId) {
      const ids = await readdir(path.join(docDir(docId), 'drafts'));
      const drafts = await Promise.all(ids.map((id) => readJson(path.join(draftDir(docId, id), 'draft.json')).catch(() => null)));
      return drafts.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async listReviews(docId, draftId) {
      let files = [];
      try {
        files = (await readdir(path.join(draftDir(docId, draftId), 'reviews'))).filter((f) => f.endsWith('.json'));
      } catch {}
      const found = await Promise.all(files.map((f) => readReview(path.join(draftDir(docId, draftId), 'reviews', f))));
      return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // A review is one of two types. An improvement review ('improve') holds findings for the user
    // to decide on, then applied as a new draft. A highlights review ('highlights') holds the key
    // information the AI found for the user's goal; nothing is decided or applied. Reviews from
    // before types existed have none, and are improvement reviews.
    async createReview(docId, draftId, by, { type = 'improve', goal = null, context = null, title = null, variationId = ORIGINAL } = {}) {
      const review = {
        id: `review-${Date.now().toString(36)}-${newId()}`,
        draftId,
        variationId, // the variation it was started in: an improvement review's drafts are that variation's
        type,
        goal, // what the user wants from the review, agreed with the AI before it started
        title, // a highlights review's short name, its focus (e.g. "Recruiter skim")
        context, // what the AI learned about the document from the user (highlights)
        createdAt: now(),
        status: 'open', // open: the AI is still adding to it; committed: the AI has finished
        requests: [], // the user's marks from the tools (rewrite, comment, keep, remove, add, ask)
        items: [], // the AI's findings, each carrying a decision for the user (improve)
        annotations: [], // the AI's decorations on the text (improve)
        highlights: [], // the key information the AI found (highlights)
        applications: [], // drafts created from this review: { draftId, at, itemIds }
        history: [],
      };
      logTo(review, by, 'started the review');
      await mkdir(path.join(draftDir(docId, draftId), 'reviews'), { recursive: true });
      await writeJson(reviewPath(docId, draftId, review.id), review);
      reviews.set(reviewPath(docId, draftId, review.id), Promise.resolve(review));
      onReview(review);
      return review;
    },

    loadReview: (docId, draftId, reviewId) => readReview(reviewPath(docId, draftId, reviewId)),
    async saveReview(docId, review) {
      await writeJson(reviewPath(docId, review.draftId, review.id), review);
      reviews.set(reviewPath(docId, review.draftId, review.id), Promise.resolve(review));
      onReview(review);
    },

    // The AI's next draft for a review, kept beside the review until the user accepts or discards
    // it. A review has one preview at a time: a newer one replaces it.
    previewPdfPath: (docId, review) => path.join(previewDir(docId, review), 'draft.pdf'),
    async savePreview(docId, review, { pdf, html }) {
      const dir = previewDir(docId, review);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'draft.pdf'), pdf);
      await writeFile(path.join(dir, 'content.html'), html);
    },
    async loadPreview(docId, review) {
      const dir = previewDir(docId, review);
      return { pdf: await readFile(path.join(dir, 'draft.pdf')), html: await readFile(path.join(dir, 'content.html'), 'utf8') };
    },
    removePreview: (docId, review) => rm(previewDir(docId, review), { recursive: true, force: true }),

    // Why a draft can't be deleted from a variation, or null if it can: the original, or a draft
    // another variation still has or started from.
    whyDraftKept(doc, variationId, draftId) {
      if (draftId === ORIGINAL) return 'The original can’t be deleted.';
      const others = doc.variations.filter((v) => v.id !== variationId);
      const other = others.find((v) => lineOf(doc, v).includes(draftId)) ?? doc.variations.find((v) => v.fromDraftId === draftId);
      return other ? `“${other.name}” uses this draft.` : null;
    },

    // Deletes a draft for good: its PDF and its reviews. The drafts after it stay on the line, and
    // take its parent as theirs. A variation showing it moves to the draft before it, and the
    // review it was applied from counts as not applied again.
    async deleteDraft(doc, variationId, draftId) {
      const variation = doc.variations.find((v) => v.id === variationId);
      if (!variation) throw new Error(`No variation ${variationId}.`);
      const line = lineOf(doc, variation);
      const at = line.indexOf(draftId);
      if (at === -1) throw new Error(`No draft ${draftId} in ${variation.name}.`);
      const kept = this.whyDraftKept(doc, variationId, draftId);
      if (kept) throw new Error(kept);

      const meta = await this.loadDraft(doc.id, draftId);
      const applied = await this.loadReview(doc.id, meta.parentId, meta.fromReviewId).catch(() => null); // its draft may be gone
      if (applied) {
        applied.applications = applied.applications.filter((a) => a.draftId !== draftId);
        await this.saveReview(doc.id, applied);
      }
      for (const draft of await this.listDrafts(doc.id)) {
        if (draft.parentId === draftId) await writeJson(path.join(draftDir(doc.id, draft.id), 'draft.json'), { ...draft, parentId: meta.parentId });
      }

      const remaining = line.filter((id) => id !== draftId);
      if (variation.id === doc.variationId) {
        doc.line = remaining;
        if (doc.currentDraftId === draftId) doc.currentDraftId = line[at - 1];
      } else {
        variation.line = remaining;
        if (variation.currentDraftId === draftId) variation.currentDraftId = line[at - 1];
      }
      if (doc.focus) delete doc.focus[draftId];
      await saveDocument(doc);
      await rm(draftDir(doc.id, draftId), { recursive: true, force: true });
    },

    // Applies a review: stores the new draft as a child of the review's draft, makes it the tip
    // of the active line (abandoning any drafts after the review's draft, unless another
    // variation's line has them) and the current draft.
    async createDraft(doc, review, { pdf, html, summary, appliedItemIds }) {
      const draftId = `draft-${Date.now().toString(36)}-${newId()}`;
      const dir = draftDir(doc.id, draftId);
      await mkdir(path.join(dir, 'reviews'), { recursive: true });
      await writeFile(path.join(dir, 'draft.pdf'), pdf);
      if (html) await writeFile(path.join(dir, 'content.html'), html);
      await writeJson(path.join(dir, 'draft.json'), {
        id: draftId, parentId: review.draftId, fromReviewId: review.id, createdAt: now(), abandoned: false, summary: summary ?? null, appliedItemIds: appliedItemIds ?? [],
      });

      const at = doc.line.indexOf(review.draftId);
      const elsewhere = new Set(doc.variations.filter((v) => v.id !== doc.variationId).flatMap((v) => v.line));
      const abandoned = (at === -1 ? [] : doc.line.slice(at + 1)).filter((id) => !elsewhere.has(id));
      for (const id of abandoned) {
        const meta = await readJson(path.join(draftDir(doc.id, id), 'draft.json'));
        await writeJson(path.join(draftDir(doc.id, id), 'draft.json'), { ...meta, abandoned: true, abandonedAt: now() });
      }
      doc.line = [...(at === -1 ? doc.line : doc.line.slice(0, at + 1)), draftId];
      doc.currentDraftId = draftId;
      delete doc.workingDraftId;
      await saveDocument(doc);
      return { draftId, abandoned };
    },
  };
}

// Every document has variations, the first its original line ("Original"). Documents from before
// variations get that one, from their line.
function withVariations(doc) {
  if (!doc.variations?.length) {
    doc.variations = [{ id: ORIGINAL, name: 'Original', purpose: null, createdAt: doc.importedAt, line: doc.line, currentDraftId: doc.currentDraftId }];
    doc.variationId = ORIGINAL;
  }
  return doc;
}

// A variation's line: the active one's is the document's own (it may have moved on since saving).
const lineOf = (doc, variation) => (variation.id === doc.variationId ? doc.line : variation.line);

// The draft a view is working on: the one showing, unless it's only looking at another for now.
function settledDraft(doc) {
  return doc.line.includes(doc.workingDraftId) ? doc.workingDraftId : doc.currentDraftId;
}

// Makes a variation the active one (without saving): its line becomes the document's.
function selectVariation(doc, variationId) {
  const next = doc.variations.find((v) => v.id === variationId);
  if (!next) throw new Error(`No variation ${variationId}.`);
  const active = doc.variations.find((v) => v.id === doc.variationId);
  active.line = doc.line;
  active.currentDraftId = settledDraft(doc);
  delete doc.workingDraftId;
  doc.variationId = next.id;
  doc.line = next.line;
  doc.currentDraftId = next.currentDraftId;
}

export function logTo(review, who, what) {
  review.history.push({ at: now(), who, what });
}

// Ids come from the app itself, but never let one step outside the data folder.
function safe(id) {
  if (!/^[\w.-]+$/.test(String(id))) throw new Error(`Invalid id: ${id}`);
  return String(id);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

// Written to a temporary file first, so a crash mid-write never leaves a half-written record, and
// one at a time per file, as several windows can save the same record at once.
const writing = new Map();
function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2);
  const next = (writing.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
  });
  writing.set(file, next);
  next.finally(() => { if (writing.get(file) === next) writing.delete(file); }).catch(() => {});
  return next;
}
