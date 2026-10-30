import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Documents live in the app's data folder, one folder each. A document is defined by the upload:
// opening a PDF copies it in as the document's original, and the same file opened twice is two
// documents. Nothing links back to where the file came from.
//
//   documents/<document id>/
//     document.json                 name, import time, the active line of drafts, the current draft
//     drafts/<draft id>/
//       draft.json                  parent, the review it was applied from, abandoned or not
//       draft.pdf                   the original is the draft with id "original"
//       content.html                the source a generated draft was drawn from
//       reviews/<review id>.json    one review: requests, findings, decisions and history
//
// Drafts form a tree; the active line runs from the original to the current tip, and only it is
// walked by the draft controls. Applying a review from an earlier draft starts a new branch and
// marks the drafts after it on the old line abandoned (kept on disk, just no longer on the line).

const ORIGINAL = 'original';
const now = () => new Date().toISOString();
const newId = () => randomUUID().slice(0, 8);

export function createStore(root) {
  const docDir = (docId) => path.join(root, 'documents', safe(docId));
  const draftDir = (docId, draftId) => path.join(docDir(docId), 'drafts', safe(draftId));
  const reviewPath = (docId, draftId, reviewId) => path.join(draftDir(docId, draftId), 'reviews', `${safe(reviewId)}.json`);

  return {
    ORIGINAL,
    draftPdfPath: (docId, draftId) => path.join(draftDir(docId, draftId), 'draft.pdf'),

    async importDocument(sourcePath) {
      const id = `${Date.now().toString(36)}-${newId()}`;
      const doc = { id, name: path.basename(sourcePath), importedAt: now(), line: [ORIGINAL], currentDraftId: ORIGINAL };
      await mkdir(path.join(draftDir(id, ORIGINAL), 'reviews'), { recursive: true });
      await copyFile(sourcePath, path.join(draftDir(id, ORIGINAL), 'draft.pdf'));
      await writeJson(path.join(draftDir(id, ORIGINAL), 'draft.json'), {
        id: ORIGINAL, parentId: null, fromReviewId: null, createdAt: doc.importedAt, abandoned: false, summary: null, appliedItemIds: [],
      });
      await writeJson(path.join(docDir(id), 'document.json'), doc);
      return doc;
    },

    loadDocument: (docId) => readJson(path.join(docDir(docId), 'document.json')),
    saveDocument: (doc) => writeJson(path.join(docDir(doc.id), 'document.json'), doc),
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

    async createReview(docId, draftId, by) {
      const review = {
        id: `review-${Date.now().toString(36)}-${newId()}`,
        draftId,
        createdAt: now(),
        status: 'open', // open: requests and findings are being added; committed: ready for decisions
        requests: [], // the user's marks from the tools (rewrite, comment, keep, remove, add, ask)
        items: [], // the AI's findings, each carrying a decision for the user
        annotations: [], // the AI's decorations on the text
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
    // of the active line (abandoning any drafts after the review's draft) and the current draft.
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
      const abandoned = at === -1 ? [] : doc.line.slice(at + 1);
      for (const id of abandoned) {
        const meta = await readJson(path.join(draftDir(doc.id, id), 'draft.json'));
        await writeJson(path.join(draftDir(doc.id, id), 'draft.json'), { ...meta, abandoned: true, abandonedAt: now() });
      }
      doc.line = [...(at === -1 ? doc.line : doc.line.slice(0, at + 1)), draftId];
      doc.currentDraftId = draftId;
      await writeJson(path.join(docDir(doc.id), 'document.json'), doc);
      return { draftId, abandoned };
    },
  };
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
