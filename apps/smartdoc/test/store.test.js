import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('where a document reopens', () => {
  const twoDrafts = async () => {
    const { doc, one, two } = await documentWithDrafts();
    return { doc: await store.loadDocument(doc.id), one, two };
  };
  const onDisk = async (doc) => JSON.parse(await readFile(path.join(root, 'documents', doc.id, 'document.json'), 'utf8'));

  test('on the draft last saved, whether or not the app has restarted since', async () => {
    const { doc, one } = await twoDrafts();
    doc.currentDraftId = one;
    await store.saveDocument(doc);
    assert.equal((await store.loadDocument(doc.id)).currentDraftId, one);
    assert.equal((await createStore(root).loadDocument(doc.id)).currentDraftId, one);
  });

  test('not on a draft only being looked at', async () => {
    const { doc, one, two } = await twoDrafts();
    doc.workingDraftId = two;
    doc.currentDraftId = one;
    await store.saveDocument(doc);
    assert.equal(doc.currentDraftId, one);
    assert.equal((await store.loadDocument(doc.id)).currentDraftId, two);
    const saved = await onDisk(doc);
    assert.equal(saved.currentDraftId, two);
    assert.equal(saved.workingDraftId, undefined);
  });

  test('a new draft is worked on, whatever was being looked at', async () => {
    const { doc, one, two } = await twoDrafts();
    doc.workingDraftId = two;
    doc.currentDraftId = one;
    const three = await nextDraft(doc, 'three');
    assert.equal(doc.workingDraftId, undefined);
    assert.equal((await store.loadDocument(doc.id)).currentDraftId, three);
  });

  test('a variation left while looking at a draft keeps the one being worked on', async () => {
    const { doc, one, two } = await twoDrafts();
    await store.createVariation(doc, { fromVariationId: ORIGINAL, fromDraftId: one, name: 'v', purpose: 'p' });
    const variation = doc.variationId;
    store.selectVariation(doc, ORIGINAL);
    doc.workingDraftId = two;
    doc.currentDraftId = one;
    store.selectVariation(doc, variation);
    assert.equal(doc.workingDraftId, undefined);
    assert.equal(doc.variations.find((v) => v.id === ORIGINAL).currentDraftId, two);
  });
});

describe('previews', () => {
  test('a preview is kept apart from the drafts until it is removed', async () => {
    const { doc, two } = await documentWithDrafts();
    const review = await store.createReview(doc.id, two, 'ai', { variationId: doc.variationId });
    await store.savePreview(doc.id, review, { pdf: Buffer.from('%PDF-preview'), html: '<p>preview</p>' });

    assert.equal((await store.listDrafts(doc.id)).length, 3);
    assert.deepEqual((await store.loadDocument(doc.id)).line.at(-1), two);
    assert.deepEqual(await store.listReviews(doc.id, two), [review]);
    const { pdf, html } = await store.loadPreview(doc.id, review);
    assert.equal(pdf.toString(), '%PDF-preview');
    assert.equal(html, '<p>preview</p>');

    await store.removePreview(doc.id, review);
    await assert.rejects(access(store.previewPdfPath(doc.id, review)));
  });
});

describe('deleting drafts', () => {
  test('a draft goes for good; later drafts stay and the current draft moves back', async () => {
    const { doc, one, two } = await documentWithDrafts();
    await store.deleteDraft(doc, ORIGINAL, two);
    const loaded = await store.loadDocument(doc.id);
    assert.deepEqual(loaded.line, [ORIGINAL, one]);
    assert.equal(loaded.currentDraftId, one);
    assert.deepEqual((await store.listDrafts(doc.id)).map((d) => d.id).sort(), [ORIGINAL, one].sort());
    await assert.rejects(access(store.draftPdfPath(doc.id, two)));
  });

  test('deleting from the middle of a line reparents the next draft', async () => {
    const { doc, one, two } = await documentWithDrafts();
    await store.deleteDraft(doc, ORIGINAL, one);
    assert.deepEqual(doc.line, [ORIGINAL, two]);
    assert.equal(doc.currentDraftId, two);
    assert.equal((await store.loadDraft(doc.id, two)).parentId, ORIGINAL);
  });

  test('the review it was applied from counts as not applied again', async () => {
    const { doc } = await documentWithDrafts();
    const review = await store.createReview(doc.id, doc.currentDraftId, 'ai', { variationId: doc.variationId });
    const { draftId } = await store.createDraft(doc, review, { pdf: Buffer.from('%PDF-three') });
    await store.saveReview(doc.id, { ...review, applications: [{ draftId, at: 'then', itemIds: [] }] });
    await store.deleteDraft(doc, ORIGINAL, draftId);
    assert.deepEqual((await store.loadReview(doc.id, review.draftId, review.id)).applications, []);
  });

  test('the original, and drafts another variation uses, are kept', async () => {
    const { doc, one, two } = await documentWithDrafts();
    await assert.rejects(store.deleteDraft(doc, ORIGINAL, ORIGINAL), /original/);
    const variation = await store.createVariation(doc, { name: 'Job', purpose: 'A job', fromVariationId: ORIGINAL, fromDraftId: one });
    await assert.rejects(store.deleteDraft(doc, variation.id, one), /uses this draft/);
    await assert.rejects(store.deleteDraft(doc, ORIGINAL, one), /uses this draft/);
    // Only the original line has this one.
    assert.equal(store.whyDraftKept(doc, ORIGINAL, two), null);
    await store.deleteDraft(doc, ORIGINAL, two);
    assert.deepEqual(doc.variations.find((v) => v.id === ORIGINAL).line, [ORIGINAL, one]);
  });

  test('a draft in a variation that isn’t showing can be deleted', async () => {
    const { doc, two } = await documentWithDrafts();
    const variation = await store.createVariation(doc, { name: 'Job', purpose: 'A job', fromVariationId: ORIGINAL, fromDraftId: two });
    const own = await nextDraft(doc, 'own');
    store.selectVariation(doc, ORIGINAL);
    await store.deleteDraft(doc, variation.id, own);
    const loaded = await store.loadDocument(doc.id);
    const saved = loaded.variations.find((v) => v.id === variation.id);
    assert.equal(saved.line.includes(own), false);
    assert.equal(saved.currentDraftId, two);
  });
});

describe('windows on the same document', () => {
  const imported = async (store) => {
    const source = path.join(await mkdtemp(path.join(os.tmpdir(), 'smartdoc-source-')), 'a.pdf');
    await writeFile(source, '%PDF-a');
    return store.importDocument(source);
  };

  test('each has its own place, but they share the drafts and the reviews', async () => {
    const store = createStore(await mkdtemp(path.join(os.tmpdir(), 'smartdoc-shared-')));
    const { id } = await imported(store);
    const [one, two] = [await store.loadDocument(id), await store.loadDocument(id)];
    const review = await store.createReview(id, one.currentDraftId, 'ai', { type: 'improve' });

    const { draftId } = await store.createDraft(one, review, { pdf: Buffer.from('%PDF-b'), html: '<p>b</p>' });
    assert.deepEqual(two.line, one.line, 'a new draft reaches the other window');
    assert.equal(one.currentDraftId, draftId);
    assert.equal(two.currentDraftId, store.ORIGINAL, 'the other window stays where it is');

    await store.saveDocument(two);
    assert.ok((await store.loadDocument(id)).line.includes(draftId), 'saving from the other window keeps the new draft');

    const [found] = await store.listReviews(id, store.ORIGINAL);
    assert.equal(found, review, 'one copy of a review in memory');
  });

  test('saves of the same record at once all land, the last one last', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'smartdoc-writes-'));
    const store = createStore(root);
    const { id } = await imported(store);
    const review = await store.createReview(id, store.ORIGINAL, 'ai', { type: 'improve' });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.saveReview(id, { ...review, summary: `save ${i}` })));
    assert.equal((await createStore(root).loadReview(id, store.ORIGINAL, review.id)).summary, 'save 19');
  });
});
