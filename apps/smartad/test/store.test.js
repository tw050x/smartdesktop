import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createStore } from '../packages/app/src/main/store.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'smartad-store-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const fresh = (options) => {
  const root = path.join(temp, `store-${n++}`);
  return { root, store: createStore(root, options) };
};
const banner = { sizes: ['300x250'], layers: [{ id: 'headline', kind: 'text', text: 'Spring sale' }] };
const first = { name: 'Spring sale', content: banner, note: 'A banner for the spring sale', goal: 'Sell more seeds this spring', goalTitle: 'Spring' };

describe('an ad', () => {
  test('is made by its first proposal, with no draft until the user accepts it', async () => {
    const { root, store } = fresh();
    const made = await store.propose(first);
    assert.ok(made.ad && made.proposal);
    const [row] = await store.list();
    assert.equal(row.name, 'Spring sale');
    assert.equal(row.drafts, 0);
    assert.equal(row.proposal.id, made.proposal);
    await assert.rejects(store.get(made.ad), /no accepted draft yet/);
    const proposal = await store.getProposal(made.ad);
    assert.deepEqual(proposal.content, banner);
    assert.equal(proposal.basedOn, null);
    assert.equal(proposal.total, 0);
    assert.equal(proposal.goalTitle, 'Spring');
    const meta = JSON.parse(readFileSync(path.join(root, 'ads', made.ad, 'meta.json'), 'utf8'));
    assert.equal(meta.name, 'Spring sale');
    assert.deepEqual(meta.line, []);
  });

  test('gets its first draft once accepted, kept as drafts/1.json', async () => {
    const { root, store } = fresh();
    const made = await store.propose(first);
    const accepted = await store.accept(made.ad);
    assert.equal(accepted.number, 1);
    const shown = await store.get(made.ad);
    assert.equal(shown.number, 1);
    assert.equal(shown.total, 1);
    assert.equal(shown.draftId, accepted.draft);
    assert.deepEqual(shown.content, banner);
    assert.equal(shown.proposal, null);
    assert.equal(await store.getProposal(made.ad), null);
    const draft = JSON.parse(readFileSync(path.join(root, 'ads', made.ad, 'drafts', '1.json'), 'utf8'));
    assert.deepEqual(Object.keys(draft).sort(), ['content', 'createdAt', 'goal', 'goalTitle', 'id', 'n', 'note']);
    assert.equal(draft.goal, 'Sell more seeds this spring');
    assert.equal(existsSync(path.join(root, 'ads', made.ad, 'proposal.json')), false);
  });

  test('takes a change as a whole new content, which becomes the next draft', async () => {
    const { store } = fresh();
    const made = await store.propose(first);
    const one = await store.accept(made.ad);
    const changed = { ...banner, layers: [...banner.layers, { id: 'cta', kind: 'button', text: 'Shop now' }] };
    await store.propose({ adId: made.ad, content: changed, note: 'Adds a call to action', reasons: { cta: 'Gives the reader something to do' } });
    const proposal = await store.getProposal(made.ad);
    assert.equal(proposal.basedOn, one.draft);
    assert.equal(proposal.basedOnNumber, 1);
    assert.equal(proposal.goal, null);
    assert.equal((await store.get(made.ad)).proposal.id, proposal.proposalId);
    await store.accept(made.ad);
    assert.deepEqual((await store.get(made.ad)).content, changed);
    assert.deepEqual((await store.get(made.ad, { draftId: one.draft })).content, banner);
    const drafts = await store.listDrafts(made.ad);
    assert.deepEqual(drafts.map((d) => [d.number, d.latest]), [[2, true], [1, false]]);
    assert.equal(drafts[0].note, 'Adds a call to action');
    await assert.rejects(store.get(made.ad, { draftId: 'nope' }), /no draft nope/);
  });

  test('keeps the reasons and goal given before when a proposal is replaced', async () => {
    const { store } = fresh();
    const made = await store.propose({ ...first, reasons: { headline: 'Says what it is' } });
    const again = await store.propose({ adId: made.ad, content: banner, note: 'Again', reasons: { cta: 'Something to do' } });
    assert.ok(again.replaced);
    const proposal = await store.getProposal(made.ad);
    assert.deepEqual(proposal.reasons, { headline: 'Says what it is', cta: 'Something to do' });
    assert.equal(proposal.goal, 'Sell more seeds this spring');
    assert.equal(proposal.note, 'Again');
    // The draft keeps neither the reasons nor what it was based on.
    await store.accept(made.ad);
    const shown = await store.get(made.ad);
    assert.equal(shown.reasons, undefined);
    assert.equal(shown.goal, 'Sell more seeds this spring');
  });

  test('passes its content through the validator, which can refuse it or tidy it', async () => {
    const { store } = fresh({
      validate: (content) => {
        if (!Array.isArray(content.layers)) throw new Error('An ad needs layers.');
        return { ...content, checked: true };
      },
    });
    await assert.rejects(store.propose({ ...first, content: { sizes: [] } }), /needs layers/);
    assert.deepEqual(await store.list(), []);
    const made = await store.propose(first);
    assert.equal((await store.getProposal(made.ad)).content.checked, true);
  });

  test('refuses a proposal missing what it needs', async () => {
    const { store } = fresh();
    await assert.rejects(store.propose({ ...first, name: undefined }), /needs a name/);
    await assert.rejects(store.propose({ ...first, name: '   ' }), /needs a name/);
    await assert.rejects(store.propose({ ...first, note: '' }), /needs a note/);
    await assert.rejects(store.propose({ ...first, content: 'a banner' }), /content, as an object/);
    await assert.rejects(store.propose({ ...first, reasons: { cta: 'x'.repeat(301) } }), /longer than 300/);
    await assert.rejects(store.propose({ ...first, adId: 'missing' }), /No ad missing/);
    const made = await store.propose(first);
    await assert.rejects(store.propose({ adId: made.ad, name: 'Another name', content: banner, note: 'x' }), /rename_ad/);
    // Its own name again is fine.
    await store.propose({ adId: made.ad, name: 'Spring sale', content: banner, note: 'x' });
  });

  test('discarding a new ad\'s proposal removes the ad; a change\'s leaves the ad as it was', async () => {
    const { store } = fresh();
    const made = await store.propose(first);
    assert.deepEqual(await store.discard(made.ad), { ad: made.ad, removed: true });
    assert.deepEqual(await store.list(), []);
    const kept = await store.propose(first);
    await store.accept(kept.ad);
    await store.propose({ adId: kept.ad, content: { layers: [] }, note: 'Empty it' });
    assert.deepEqual(await store.discard(kept.ad), { ad: kept.ad, removed: false });
    assert.deepEqual((await store.get(kept.ad)).content, banner);
    await assert.rejects(store.discard(kept.ad), /no proposal to discard/);
    await assert.rejects(store.accept(kept.ad), /no proposal to accept/);
  });

  test('is renamed straight away', async () => {
    const { store } = fresh();
    const made = await store.propose(first);
    assert.deepEqual(await store.rename(made.ad, '  Autumn   sale '), { ad: made.ad, name: 'Autumn sale' });
    assert.equal((await store.list())[0].name, 'Autumn sale');
    await assert.rejects(store.rename(made.ad, ''), /needs a name/);
  });

  test('is deleted with its drafts and proposal', async () => {
    const { root, store } = fresh();
    const made = await store.propose(first);
    await store.accept(made.ad);
    await store.propose({ adId: made.ad, content: banner, note: 'Again' });
    assert.deepEqual(await store.delete(made.ad), { deleted: made.ad });
    assert.equal(existsSync(path.join(root, 'ads', made.ad)), false);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.delete(made.ad), /No ad/);
  });

  test('says when it changes', async () => {
    const { store } = fresh();
    const heard = [];
    store.events.on('changed', (id) => heard.push(id));
    const made = await store.propose(first);
    await store.rename(made.ad, 'Renamed');
    await store.accept(made.ad);
    assert.deepEqual(heard, [made.ad, made.ad, made.ad]);
  });

  test('refuses ids that aren\'t ids', async () => {
    const { store } = fresh();
    await assert.rejects(store.get('../escape'), /No ad/);
    await assert.rejects(store.proposalOutcome('../x'), /No proposal/);
    await assert.rejects(store.proposalOutcome('nope'), /no proposal nope/);
  });
});

describe('the list of ads', () => {
  test('puts the most recently changed first', async () => {
    const { store } = fresh();
    const a = await store.propose({ ...first, name: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.propose({ ...first, name: 'B' });
    assert.deepEqual((await store.list()).map((row) => row.name), ['B', 'A']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.accept(a.ad);
    const rows = await store.list();
    assert.deepEqual(rows.map((row) => row.name), ['A', 'B']);
    assert.equal(rows[0].drafts, 1);
    assert.equal(rows[0].proposal, null);
  });
});
