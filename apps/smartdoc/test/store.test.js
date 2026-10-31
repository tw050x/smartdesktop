import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createStore } from '../packages/app/src/main/store.js';

// A data folder of its own, never the app's.
const root = await mkdtemp(path.join(os.tmpdir(), 'smartdoc-store-'));
after(() => rm(root, { recursive: true, force: true }));
const store = createStore(root);
const { ORIGINAL } = store;

// Applies an empty review of the current draft as the next draft.
async function nextDraft(doc, text) {
  const review = await store.createReview(doc.id, doc.currentDraftId, 'ai', { variationId: doc.variationId });
  return (await store.createDraft(doc, review, { pdf: Buffer.from(`%PDF-${text}`), html: `<p>${text}</p>` })).draftId;
}

// A document with two drafts on its original line.
async function documentWithDrafts() {
  const source = path.join(root, 'example.pdf');
  await writeFile(source, '%PDF-original');
  const doc = await store.importDocument(source);
  const one = await nextDraft(doc, 'one');
  const two = await nextDraft(doc, 'two');
  return { doc, one, two };
}

describe('variations', () => {
  test('a document starts with one variation, Original, holding its line', async () => {
    const { doc, one, two } = await documentWithDrafts();
    const loaded = await store.loadDocument(doc.id);
    assert.equal(loaded.variationId, ORIGINAL);
    assert.deepEqual(loaded.variations.map((v) => [v.id, v.name]), [[ORIGINAL, 'Original']]);
    assert.deepEqual(loaded.variations[0].line, [ORIGINAL, one, two]);
  });

  test('documents from before variations get Original from their line', async () => {
    const { doc, one } = await documentWithDrafts();
    const file = path.join(root, 'documents', doc.id, 'document.json');
    const { variations: _, variationId: __, ...old } = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...old, line: [ORIGINAL, one], currentDraftId: one }));
    const loaded = await store.loadDocument(doc.id);
    assert.deepEqual(loaded.variations[0].line, [ORIGINAL, one]);
    assert.equal(loaded.variations[0].currentDraftId, one);
  });

  test('a variation starts from any draft, and its drafts follow on from there', async () => {
    const { doc, one, two } = await documentWithDrafts();
    const acme = await store.createVariation(doc, { name: 'Acme', purpose: 'The Acme role', fromVariationId: ORIGINAL, fromDraftId: one });
    assert.equal(doc.variationId, acme.id);
    assert.deepEqual(doc.line, [ORIGINAL, one]);
    const tailored = await nextDraft(doc, 'acme');
    assert.deepEqual(doc.line, [ORIGINAL, one, tailored]);

    // Original keeps its own line, and its drafts after the branch aren't abandoned.
    const loaded = await store.loadDocument(doc.id);
    assert.deepEqual(loaded.variations.find((v) => v.id === ORIGINAL).line, [ORIGINAL, one, two]);
    assert.equal((await store.loadDraft(doc.id, two)).abandoned, false);

    store.selectVariation(loaded, ORIGINAL);
    assert.deepEqual(loaded.line, [ORIGINAL, one, two]);
    store.selectVariation(loaded, acme.id);
    assert.deepEqual(loaded.line, [ORIGINAL, one, tailored]);
  });

  test('branching inside a variation doesn’t abandon drafts another variation has', async () => {
    const { doc, one, two } = await documentWithDrafts();
    await store.createVariation(doc, { name: 'Acme', purpose: 'The Acme role', fromVariationId: ORIGINAL, fromDraftId: two });
    store.selectVariation(doc, ORIGINAL);
    doc.currentDraftId = one;
    const review = await store.createReview(doc.id, one, 'ai');
    await store.createDraft(doc, review, { pdf: Buffer.from('%PDF-other') });
    assert.equal((await store.loadDraft(doc.id, two)).abandoned, false);
  });
});

describe('documents from drafts', () => {
  test('the draft becomes a new document’s original, with its HTML', async () => {
    const { doc, one } = await documentWithDrafts();
    const before = await store.loadDocument(doc.id);
    const made = await store.documentFromDraft(doc, one, { name: 'Example (Draft 1)', draft: 'Draft 1' });
    assert.notEqual(made.id, doc.id);
    assert.deepEqual(made.line, [ORIGINAL]);
    assert.deepEqual(made.createdFrom, { id: doc.id, name: 'example.pdf', draftId: one, draft: 'Draft 1' });
    assert.equal(await readFile(store.draftPdfPath(made.id, ORIGINAL), 'utf8'), '%PDF-one');
    assert.equal(await readFile(path.join(path.dirname(store.draftPdfPath(made.id, ORIGINAL)), 'content.html'), 'utf8'), '<p>one</p>');
    assert.deepEqual(await store.listReviews(made.id, ORIGINAL), []);
    assert.deepEqual(await store.loadDocument(doc.id), before);
  });
});
