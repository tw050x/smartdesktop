import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
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

export function createStore(root) {
  const docDir = (docId) => path.join(root, 'documents', safe(docId));
  const draftDir = (docId, draftId) => path.join(docDir(docId), 'drafts', safe(draftId));
  const reviewPath = (docId, draftId, reviewId) => path.join(draftDir(docId, draftId), 'reviews', `${safe(reviewId)}.json`);

  // The active variation's line is kept on the document (doc.line, doc.currentDraftId), where
  // everything else reads it; saving copies it back into the variation.
  const saveDocument = (doc) => {
    const active = doc.variations.find((v) => v.id === doc.variationId);
    active.line = doc.line;
    active.currentDraftId = doc.currentDraftId;
    return writeJson(path.join(docDir(doc.id), 'document.json'), doc);
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

    loadDocument: async (docId) => withVariations(await readJson(path.join(docDir(docId), 'document.json'))),
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
      const reviews = await Promise.all(files.map((f) => readJson(path.join(draftDir(docId, draftId), 'reviews', f))));
      return reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      return review;
    },

    loadReview: (docId, draftId, reviewId) => readJson(reviewPath(docId, draftId, reviewId)),
    saveReview: (docId, review) => writeJson(reviewPath(docId, review.draftId, review.id), review),

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

// Makes a variation the active one (without saving): its line becomes the document's.
function selectVariation(doc, variationId) {
  const next = doc.variations.find((v) => v.id === variationId);
  if (!next) throw new Error(`No variation ${variationId}.`);
  const active = doc.variations.find((v) => v.id === doc.variationId);
  active.line = doc.line;
  active.currentDraftId = doc.currentDraftId;
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

// Written to a temporary file first, so a crash mid-write never leaves a half-written record.
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}
