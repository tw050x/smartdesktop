import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createStore } from '../packages/app/src/main/store.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-store-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const newStore = () => createStore(path.join(temp, `store-${n++}`));
const proposal = (extra = {}) => ({ name: 'M2M auth', summary: 'Tokens between services.', note: 'First version', ...extra });
const doc = (id, markdown = '# Hello', extra = {}) => ({ id, kind: 'document', title: id, markdown, ...extra });

// A schema with one accepted draft.
async function accepted(store, extra) {
  const { schema } = await store.propose(proposal(extra));
  const { draft } = await store.accept(schema);
  return { schema, draft };
}

describe('proposing and accepting', () => {
  test('a proposal is not a draft until the user accepts it', async () => {
    const store = newStore();
    const { schema, proposal: id } = await store.propose(proposal({ items: [doc('notes')] }));
    await assert.rejects(store.getSchema(schema), /no accepted draft/);
    const [row] = await store.list();
    assert.equal(row.drafts, 0);
    assert.equal(row.proposal.id, id);
    assert.equal(row.name, 'M2M auth');
    assert.equal((await store.getItem(schema, 'notes', { proposal: true })).markdown, '# Hello');
    assert.equal(await store.proposalOutcome(id), null);

    const { draft } = await store.accept(schema);
    const shown = await store.getSchema(schema);
    assert.equal(shown.draftId, draft);
    assert.equal(shown.number, 1);
    assert.equal(shown.proposal, null);
    assert.equal(shown.status, 'design-only');
    assert.equal(await store.getProposal(schema), null);
    assert.deepEqual({ ...(await store.proposalOutcome(id)), at: null }, { proposal: id, schema, outcome: 'accepted', draft, at: null });
  });

  test('a change sends only what changes, and earlier drafts stay', async () => {
    const store = newStore();
    const { schema, draft: first } = await accepted(store, { contract: 'Promise', items: [doc('a'), doc('b')] });
    await store.propose({ schemaId: schema, summary: 'Changed.', items: [doc('b', '# New')], note: 'Changed it' });
    assert.equal((await store.getSchema(schema)).summary, 'Tokens between services.');
    assert.equal((await store.getSchema(schema)).proposal.note, 'Changed it');
    const waiting = await store.getProposal(schema);
    assert.equal(waiting.basedOn, first);
    assert.deepEqual(waiting.changes.items, { b: 'changed' });
    const { draft: second } = await store.accept(schema);
    const shown = await store.getSchema(schema);
    assert.equal(shown.summary, 'Changed.');
    assert.equal(shown.contract, 'Promise');
    assert.equal(shown.name, 'M2M auth');
    assert.deepEqual(shown.items.map((i) => i.id), ['a', 'b']);
    assert.deepEqual(shown.line, [first, second]);
    assert.equal((await store.getItem(schema, 'b')).markdown, '# New');
    assert.equal((await store.getItem(schema, 'b', { draftId: first })).markdown, '# Hello');
  });

  test('a new proposal builds on the one waiting, and says so to anyone waiting on it', async () => {
    const store = newStore();
    const { schema } = await accepted(store);
    const first = await store.propose({ schemaId: schema, items: [doc('a')], note: 'One' });
    const second = await store.propose({ schemaId: schema, items: [doc('b')], note: 'Two' });
    assert.equal(second.replaced, first.proposal);
    assert.equal((await store.proposalOutcome(first.proposal)).outcome, 'replaced');
    assert.deepEqual((await store.getProposal(schema)).items.map((i) => i.id), ['a', 'b']);
  });

  test('items can be added, replaced in place, removed and put in order', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('a'), doc('b'), doc('c')] });
    await store.propose({ schemaId: schema, items: [doc('b', '# Two'), doc('d')], removeItems: ['a'], note: 'n' });
    let waiting = await store.getProposal(schema);
    assert.deepEqual(waiting.items.map((i) => i.id), ['b', 'c', 'd']);
    assert.deepEqual(waiting.changes.items, { b: 'changed', d: 'added' });
    assert.deepEqual(waiting.changes.removed.map((i) => i.id), ['a']);
    await store.propose({ schemaId: schema, itemOrder: ['d', 'b'], note: 'n' });
    waiting = await store.getProposal(schema);
    assert.deepEqual(waiting.items.map((i) => i.id), ['d', 'b', 'c']);
  });

  test('refuses what can\'t be, leaving nothing behind', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('a')] });
    await assert.rejects(store.propose({ schemaId: schema, removeItems: ['nope'], note: 'n' }), /no item nope to remove/);
    await assert.rejects(store.propose({ schemaId: schema, itemOrder: ['nope'], note: 'n' }), /no item nope to put/);
    await assert.rejects(store.propose({ schemaId: schema, items: [doc('contract')], note: 'n' }), /is the schematic's contract/);
    await assert.rejects(store.propose({ schemaId: schema, items: [doc('x'), doc('x')], note: 'n' }), /Two items/);
    await assert.rejects(store.propose({ name: 'No summary', note: 'n' }), /name and a summary/);
    assert.equal(await store.getProposal(schema), null);
    assert.equal((await store.list()).length, 1);
  });

  test('discarding keeps the schema, unless it has no drafts', async () => {
    const store = newStore();
    const { schema } = await accepted(store);
    const { proposal: changed } = await store.propose({ schemaId: schema, summary: 'No.', note: 'n' });
    assert.equal((await store.discard(schema)).removed, false);
    assert.equal((await store.getSchema(schema)).summary, 'Tokens between services.');
    assert.equal((await store.proposalOutcome(changed)).outcome, 'discarded');

    const fresh = await store.propose(proposal({ name: 'New' }));
    assert.equal((await store.discard(fresh.schema)).removed, true);
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.proposalOutcome(fresh.proposal)).outcome, 'discarded');
  });

  test('accepting twice fails, and only one draft is made', async () => {
    const store = newStore();
    const { schema } = await store.propose(proposal());
    const results = await Promise.allSettled([store.accept(schema), store.accept(schema)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await store.getSchema(schema)).total, 1);
  });

  test('lists a schema\'s drafts, newest first', async () => {
    const store = newStore();
    const { schema, draft: first } = await accepted(store);
    assert.deepEqual((await store.listDrafts(schema)).map((d) => [d.id, d.number, d.latest]), [[first, 1, true]]);
    await store.propose({ schemaId: schema, note: 'Second' });
    assert.equal((await store.listDrafts(schema)).length, 1); // a proposal isn't a draft
    const { draft: second } = await store.accept(schema);
    const drafts = await store.listDrafts(schema);
    assert.deepEqual(drafts.map((d) => [d.id, d.number, d.latest]), [[second, 2, true], [first, 1, false]]);
    assert.equal(drafts[0].note, 'Second');
  });

  test('an id can\'t reach outside the data folder', async () => {
    const store = newStore();
    await assert.rejects(store.getSchema('../../etc'), /No schema/);
    await assert.rejects(store.proposalOutcome('../x'), /No proposal/);
    await assert.rejects(store.proposalOutcome('nope'), /no proposal nope/);
  });
});

describe('reading only what\'s needed', () => {
  test('get_schematic lists items and links without their content', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('a', 'See [b](b#top).', { description: 'The first' }), doc('b', '# Top')] });
    const shown = await store.getSchema(schema);
    assert.deepEqual(shown.items[0], { id: 'a', kind: 'document', title: 'a', description: 'The first' });
    assert.equal(shown.items[0].markdown, undefined);
    assert.deepEqual(shown.links, [{ from: 'a', to: 'b#top', label: 'b' }]);
  });

  test('says in words what connects each pair, from the draft or the proposal', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('a', 'See [b](b#top).'), doc('b', '# Top')] });
    assert.deepEqual(await store.getConnections(schema), { '["a","b"]': { count: 1, ways: [{ id: 'a', from: 'a', to: 'b', links: [{ from: null, to: 'Top', label: 'b' }] }] } });
    await store.propose({ schemaId: schema, items: [doc('a', 'No links now.')] });
    assert.deepEqual(await store.getConnections(schema, { proposal: true }), {});
    assert.equal(Object.keys(await store.getConnections(schema)).length, 1);
  });

  test('an item comes with its links out and in', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('a', 'See [b](b#top).'), doc('b', '# Top')] });
    const b = await store.getItem(schema, 'b');
    assert.equal(b.markdown, '# Top');
    assert.deepEqual(b.linkedFrom, [{ from: 'a', to: 'b#top', label: 'b' }]);
    assert.deepEqual(b.linksOut, []);
    assert.deepEqual((await store.getItem(schema, 'a')).linksOut, [{ from: 'a', to: 'b#top', label: 'b' }]);
    await assert.rejects(store.getItem(schema, 'nope'), /no item nope/);
  });
});

describe('focuses', () => {
  test('a proposal keeps the goal it was for, named or cut short, and a draft keeps it', async () => {
    const store = newStore();
    const { schema } = await store.propose(proposal({ goal: 'x'.repeat(60) }));
    const waiting = await store.getProposal(schema);
    assert.equal(waiting.focus.goal, 'x'.repeat(60));
    assert.equal(waiting.focus.title.length, 48);
    await store.accept(schema);
    assert.equal((await store.getSchema(schema)).focus.goal, 'x'.repeat(60));
    await store.propose({ schemaId: schema, goal: 'Named', goalTitle: 'A name', note: 'n' });
    assert.deepEqual((await store.getProposal(schema)).focus, { goal: 'Named', title: 'A name' });
  });

  test('a focus belongs to its draft, and survives only a revision of its proposal', async () => {
    const store = newStore();
    const { schema } = await store.propose(proposal({ goal: 'First' }));
    await store.propose({ schemaId: schema, summary: 'Revised.', note: 'n' });
    assert.equal((await store.getProposal(schema)).focus.goal, 'First');
    await store.accept(schema);
    await store.propose({ schemaId: schema, summary: 'Next.', note: 'n' });
    assert.equal((await store.getProposal(schema)).focus, null);
    await store.accept(schema);
    assert.equal((await store.getSchema(schema)).focus, null);
  });

  test('lists a draft\'s focus and earlier ones to run again, newest first and each once', async () => {
    const store = newStore();
    const one = await accepted(store, { goal: 'Alpha' });
    await store.propose({ schemaId: one.schema, goal: 'Beta', note: 'n' });
    const { draft: second } = await store.accept(one.schema);
    await store.propose({ schemaId: one.schema, goal: 'Alpha', note: 'n' });
    const { draft: third } = await store.accept(one.schema);
    let focuses = await store.listFocuses(one.schema, { draftId: third });
    assert.equal(focuses.current.goal, 'Alpha');
    assert.deepEqual(focuses.earlier.map((f) => [f.goal, f.draft]), [['Beta', 'Draft 2']]);
    focuses = await store.listFocuses(one.schema, { draftId: second });
    assert.equal(focuses.current.goal, 'Beta');
    assert.deepEqual(focuses.earlier.map((f) => f.goal), ['Alpha']);
    await store.propose({ schemaId: one.schema, goal: 'Gamma', note: 'n' });
    focuses = await store.listFocuses(one.schema, { proposal: true });
    assert.equal(focuses.current.goal, 'Gamma');
    assert.deepEqual(focuses.earlier.map((f) => f.goal), ['Alpha', 'Beta']);
  });
});

describe('links across a schema', () => {
  test('a link that goes nowhere refuses the proposal', async () => {
    const store = newStore();
    await assert.rejects(store.propose(proposal({ items: [doc('a', '[x](nope)')] })), /goes to nope/);
    assert.deepEqual(await store.list(), []);
  });

  test('removing an item others link to is refused', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('a', '[x](b)'), doc('b')] });
    await assert.rejects(store.propose({ schemaId: schema, removeItems: ['b'], note: 'n' }), /goes to b/);
    assert.doesNotThrow(() => store.propose({ schemaId: schema, removeItems: ['a', 'b'], note: 'n' }));
  });

  test('links reach an embedded schema and its contract, but not inside it', async () => {
    const store = newStore();
    const auth = await accepted(store, { items: [doc('inner')] });
    const uses = [{ id: 'auth', schemaId: auth.schema }];
    await assert.doesNotReject(store.propose(proposal({ uses, items: [doc('a', '[x](auth) [y](auth#contract)')] })));
    await assert.rejects(store.propose(proposal({ uses, items: [doc('a', '[x](auth#inner)')] })), /reaches inside an embedded schema/);
  });

  test('an item and a use can\'t share an id', async () => {
    const store = newStore();
    const auth = await accepted(store);
    await assert.rejects(store.propose(proposal({ uses: [{ id: 'auth', schemaId: auth.schema }], items: [doc('auth')] })), /both called auth/);
  });
});

describe('embedding', () => {
  test('a use is pinned to the latest draft, collapsed, and says when a newer one exists', async () => {
    const store = newStore();
    const auth = await accepted(store, { contract: 'Gives tokens.', items: [doc('secret')], parameters: [{ name: 'issuer' }] });
    const billing = await accepted(store, { name: 'Billing', uses: [{ id: 'ledger-auth', schemaId: auth.schema, with: { issuer: 'auth0' } }] });

    let [use] = (await store.getSchema(billing.schema)).uses;
    assert.equal(use.draftId, auth.draft);
    assert.equal(use.name, 'M2M auth');
    assert.equal(use.contract, 'Gives tokens.');
    assert.deepEqual(use.with, { issuer: 'auth0' });
    assert.equal(use.items, undefined);
    assert.equal(use.newerDraftId, null);

    await store.propose({ schemaId: auth.schema, summary: 'Newer.', note: 'n' });
    const { draft: newer } = await store.accept(auth.schema);
    [use] = (await store.getSchema(billing.schema)).uses;
    assert.equal(use.draftId, auth.draft);
    assert.equal(use.summary, 'Tokens between services.');
    assert.equal(use.newerDraftId, newer);
  });

  test('levels open only as far as asked', async () => {
    const store = newStore();
    const keys = await accepted(store, { name: 'Keys', items: [doc('k')] });
    const auth = await accepted(store, { items: [doc('z')], uses: [{ id: 'keys', schemaId: keys.schema }] });
    const billing = await accepted(store, { name: 'Billing', uses: [{ id: 'auth', schemaId: auth.schema }] });

    const one = (await store.getSchema(billing.schema, { depth: 1 })).uses[0];
    assert.deepEqual(one.items.map((i) => i.id), ['z']);
    assert.equal(one.uses[0].name, 'Keys');
    assert.equal(one.uses[0].items, undefined);
    assert.deepEqual((await store.getSchema(billing.schema, { depth: 2 })).uses[0].uses[0].items.map((i) => i.id), ['k']);
  });

  test('a schema can\'t embed itself, directly or through another', async () => {
    const store = newStore();
    const auth = await accepted(store);
    const billing = await accepted(store, { name: 'Billing', uses: [{ id: 'auth', schemaId: auth.schema }] });
    await assert.rejects(store.propose({ schemaId: auth.schema, uses: [{ id: 'self', schemaId: auth.schema }], note: 'n' }), /can't embed itself/);
    await assert.rejects(store.propose({ schemaId: auth.schema, uses: [{ id: 'billing', schemaId: billing.schema }], note: 'n' }), /can't embed itself/);
  });

  test('one standard can be used many times', async () => {
    const store = newStore();
    const auth = await accepted(store);
    const billing = await accepted(store, { name: 'Billing', uses: [{ id: 'a', schemaId: auth.schema }, { id: 'b', schemaId: auth.schema }] });
    assert.equal((await store.getSchema(billing.schema)).uses.length, 2);
  });

  test('refuses what a use can\'t do', async () => {
    const store = newStore();
    const auth = await accepted(store, { parameters: [{ name: 'issuer' }] });
    const draftless = await store.propose(proposal({ name: 'Unaccepted' }));
    const uses = (use) => store.propose(proposal({ uses: [{ schemaId: auth.schema, id: 'a', ...use }] }));
    await assert.rejects(uses({ with: { secret: 'x' } }), /no parameter "secret"/);
    await assert.rejects(uses({ draftId: 'nope' }), /no draft nope/);
    await assert.rejects(uses({ schemaId: 'missing' }), /No schematic missing/);
    await assert.rejects(uses({ schemaId: draftless.schema }), /no accepted draft/);
    await assert.rejects(uses({ id: 'not ok' }), /can't be a use's id/);
    await assert.rejects(store.propose(proposal({ uses: [{ id: 'a', schemaId: auth.schema }, { id: 'a', schemaId: auth.schema }] })), /Two uses/);
    assert.equal((await store.list()).length, 2); // nothing new came of those
  });
});

describe('comments', () => {
  const rules = doc('rules', '# Rules\n\nPrices are fixed.\n\n## Pricing\n\nIn pence.');

  test('a comment on the proposal follows it as the AI revises it, and goes into the draft it becomes', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [rules] });
    await store.propose({ schemaId: schema, summary: 'Changed.', note: 'Tighter' });
    const comment = await store.addComment(schema, { proposal: true, target: { item: 'rules', part: 'pricing', quote: 'In pence.' }, text: 'Say which currency.' });
    assert.equal((await store.getProposal(schema)).comments, 1);
    const [listed] = await store.listComments(schema, { proposal: true });
    assert.deepEqual(listed.target, { item: 'rules', part: 'pricing', quote: 'In pence.', title: 'rules', partName: 'Pricing' });
    assert.equal((await store.listComments(schema)).length, 0, 'not on the draft');

    await store.replyToComment(schema, comment.id, { text: 'Now says GBP.', author: 'Claude Code' });
    await store.propose({ schemaId: schema, summary: 'Changed again.', note: 'Revised' });
    const [kept] = await store.listComments(schema, { proposal: true });
    assert.equal(kept.replies[0].text, 'Now says GBP.');
    assert.equal(kept.replies[0].author, 'Claude Code');

    const { draft } = await store.accept(schema);
    assert.equal((await store.listComments(schema, { draftId: draft })).length, 1);
    assert.equal((await store.getSchema(schema)).comments, 1);
  });

  test('discarding the proposal takes its comments, and leaves those on drafts', async () => {
    const store = newStore();
    const { schema, draft } = await accepted(store, { items: [rules] });
    await store.addComment(schema, { draftId: draft, target: { item: 'rules' }, text: 'On the draft.' });
    await store.propose({ schemaId: schema, summary: 'Changed.', note: 'Tighter' });
    await store.addComment(schema, { proposal: true, target: { item: 'contract' }, text: 'On the proposal.' });
    await store.discard(schema);
    const left = await store.listComments(schema);
    assert.deepEqual(left.map((one) => one.text), ['On the draft.']);
  });

  test('a comment needs words and something to be on, and the user can take it back', async () => {
    const store = newStore();
    const { schema, draft } = await accepted(store, { items: [rules] });
    await assert.rejects(store.addComment(schema, { target: { item: 'rules' }, text: '  ' }), /something said/);
    await assert.rejects(store.addComment(schema, { target: { item: 'nowhere' }, text: 'Hm' }), /no nowhere/);
    await assert.rejects(store.addComment(schema, { proposal: true, target: { item: 'rules' }, text: 'Hm' }), /no proposal/);
    const comment = await store.addComment(schema, { target: { item: 'rules' }, text: 'Hm' });
    assert.equal(comment.on, draft);
    await store.deleteComment(schema, comment.id);
    assert.equal((await store.listComments(schema)).length, 0);
    await assert.rejects(store.replyToComment(schema, comment.id, { text: 'Late' }), /no comment/);
  });

  test('a comment can be on the whole schematic, or a point in an item, as well as on a part, words or a card', async () => {
    const store = newStore();
    const { schema, draft } = await accepted(store, { items: [rules] });
    const whole = await store.addComment(schema, { target: { schematic: true, at: { x: 0.25, y: 2 } }, text: 'Is this the whole of checkout?' });
    assert.deepEqual(whole.target, { schematic: true, at: { x: 0.25, y: 1 } });
    const point = await store.addComment(schema, { target: { item: 'rules', point: { x: 0.5, y: 0.1 } }, text: 'Something is missing here.' });
    assert.deepEqual(point.target, { item: 'rules', point: { x: 0.5, y: 0.1 } });
    const card = await store.addComment(schema, { target: { item: 'rules', card: true, part: 'pricing' }, text: 'Call it Pricing rules.' });
    assert.deepEqual(card.target, { item: 'rules', card: true });
    const listed = await store.listComments(schema);
    assert.equal(listed.find((one) => one.id === whole.id).target.title, 'M2M auth');
    assert.equal(listed.find((one) => one.id === point.id).target.title, 'rules');
    // On the next draft, unanswered ones on the schematic as a whole, or a point in an item still
    // there, are earlier comments.
    await store.propose({ schemaId: schema, summary: 'Changed.', note: 'Tighter' });
    const earlier = await store.listEarlierComments(schema, { proposal: true });
    assert.deepEqual(earlier.map((one) => one.id).sort(), [whole.id, point.id, card.id].sort());
    assert.ok(earlier.every((one) => one.earlier.draftId === draft));
  });

  test('the AI says how it dealt with a comment in its own words, and whether anything more is needed', async () => {
    const store = newStore();
    const { schema, draft } = await accepted(store, { items: [rules] });
    const read = await store.addComment(schema, { target: { item: 'rules' }, text: 'FYI, prices change in April.' });
    const fix = await store.addComment(schema, { target: { item: 'rules' }, text: 'Say which currency.' });
    assert.equal((await store.getSchema(schema)).comments, 2);

    // An outcome alone is a reply: some comments only need reading.
    const noted = await store.replyToComment(schema, read.id, { outcome: 'Noted', noFurtherAction: true, author: 'Claude' });
    assert.deepEqual([noted.outcome, noted.noFurtherAction], ['Noted', true]);
    await store.replyToComment(schema, fix.id, { text: 'Now says GBP.', outcome: 'Actioned' });
    const [first, second] = await store.listComments(schema);
    assert.equal(first.outcome, 'Noted');
    assert.equal(first.noFurtherAction.by, 'ai');
    assert.deepEqual(first.replies[0], { ...first.replies[0], author: 'Claude', outcome: 'Noted' });
    assert.equal(first.replies[0].text, undefined);
    assert.equal(second.outcome, 'Actioned');
    assert.equal(second.noFurtherAction, undefined, 'left open: the AI didn\'t say it was done');
    assert.equal((await store.getSchema(schema)).comments, 1, 'only open comments count');

    // The user can set the flag too, or clear it to open a comment again.
    await store.setNoFurtherAction(schema, fix.id, true);
    assert.equal((await store.listComments(schema))[1].noFurtherAction.by, 'user');
    assert.equal((await store.getSchema(schema, { draftId: draft })).comments, 0);
    await store.setNoFurtherAction(schema, read.id, false);
    assert.equal((await store.listComments(schema))[0].noFurtherAction, null);
    assert.equal((await store.getSchema(schema)).comments, 1);
    // The AI can take its own flag back.
    await store.replyToComment(schema, fix.id, { outcome: 'Reopened', noFurtherAction: false });
    assert.equal((await store.listComments(schema))[1].noFurtherAction, null);
  });

  test('a reply needs words or an outcome, and an outcome is a word or two', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [rules] });
    const comment = await store.addComment(schema, { target: { item: 'rules' }, text: 'Hm' });
    await assert.rejects(store.replyToComment(schema, comment.id, { text: ' ', outcome: ' ' }), /something said, or an outcome/);
    await assert.rejects(store.replyToComment(schema, comment.id, { outcome: 'x'.repeat(41) }), /40 characters/);
    await assert.rejects(store.setNoFurtherAction(schema, 'nope', true), /no comment nope/);
  });

  test('a flag on a proposal\'s comment goes with it into the draft', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [rules] });
    await store.propose({ schemaId: schema, summary: 'Changed.', note: 'Tighter' });
    const comment = await store.addComment(schema, { proposal: true, target: { item: 'rules' }, text: 'Looks right.' });
    await store.replyToComment(schema, comment.id, { outcome: 'Noted', noFurtherAction: true });
    assert.equal((await store.getProposal(schema)).comments, 0);
    const { draft } = await store.accept(schema);
    const [kept] = await store.listComments(schema, { draftId: draft });
    assert.deepEqual([kept.outcome, kept.noFurtherAction.by], ['Noted', 'ai']);
  });

  test('a comment whose part has gone says so', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [rules] });
    await store.propose({ schemaId: schema, note: 'Rename', items: [doc('rules', '# Rules\n\n## Prices\n\nIn pence.')] });
    await store.addComment(schema, { proposal: true, target: { item: 'rules', part: 'pricing' }, text: 'Old heading' });
    const [one] = await store.listComments(schema, { proposal: true });
    assert.equal(one.target.partMissing, true);
  });
});

describe('earlier comments', () => {
  const rules = doc('rules', '# Rules\n\nPrices are **fixed** for a [year](contract).\n\n## Pricing\n\nIn pence.');

  // A draft with comments on it, then a proposal changing it.
  async function commented(store, items = [rules]) {
    const { schema, draft } = await accepted(store, { items: [rules] });
    const say = (target, text) => store.addComment(schema, { draftId: draft, target, text });
    const comments = {
      quote: await say({ item: 'rules', quote: 'Prices are fixed for a year' }, 'Which year?'),
      part: await say({ item: 'rules', part: 'pricing' }, 'Name the currency.'),
      card: await say({ item: 'rules', card: true }, 'Show the price.'),
      answered: await say({ item: 'rules' }, 'Answered one.'),
      done: await say({ item: 'rules' }, 'Done with.'),
    };
    await store.replyToComment(schema, comments.answered.id, { text: 'Did it.' });
    await store.setNoFurtherAction(schema, comments.done.id, true);
    await store.propose({ schemaId: schema, note: 'Next', items });
    return { schema, draft, comments };
  }

  test('the proposal shows the unanswered comments on its draft that are still about something there, counting none', async () => {
    const store = newStore();
    const { schema, draft } = await commented(store);
    const earlier = await store.listEarlierComments(schema, { proposal: true });
    assert.deepEqual(earlier.map((one) => one.text), ['Which year?', 'Name the currency.', 'Show the price.']);
    assert.deepEqual(earlier[0].earlier, { draftId: draft, draft: 1 });
    assert.equal((await store.getProposal(schema)).comments, 0);
    assert.equal((await store.listComments(schema, { proposal: true })).length, 0);
    assert.equal((await store.listEarlierComments(schema, { draftId: draft })).length, 0, 'the first draft came from none');
  });

  test('one whose words, part or item has gone is not shown', async () => {
    const store = newStore();
    const { schema } = await commented(store, [doc('rules', '# Rules\n\nPrices change.\n\n## Prices\n\nIn pence.')]);
    assert.deepEqual((await store.listEarlierComments(schema, { proposal: true })).map((one) => one.text), ['Show the price.']);
    const gone = newStore();
    const { schema: other } = await commented(gone, []);
    await gone.propose({ schemaId: other, note: 'Without', removeItems: ['rules'] });
    assert.deepEqual(await gone.listEarlierComments(other, { proposal: true }), []);
  });

  test('commenting again puts it on what is showing, and the earlier one goes', async () => {
    const store = newStore();
    const { schema, comments } = await commented(store);
    const again = await store.addComment(schema, { proposal: true, target: { item: 'rules', part: 'pricing' }, text: 'Name the currency.', from: comments.part.id });
    assert.equal(again.from, comments.part.id);
    assert.equal((await store.getProposal(schema)).comments, 1);
    assert.deepEqual((await store.listEarlierComments(schema, { proposal: true })).map((one) => one.text), ['Which year?', 'Show the price.']);
  });

  test('a draft shows those on the draft before it, and no further back', async () => {
    const store = newStore();
    const { schema } = await commented(store);
    const { draft: second } = await store.accept(schema);
    assert.equal((await store.listEarlierComments(schema, { draftId: second })).length, 3);
    assert.equal((await store.listComments(schema, { draftId: second })).length, 0);
    await store.propose({ schemaId: schema, note: 'Again' });
    const { draft: third } = await store.accept(schema);
    assert.equal((await store.listEarlierComments(schema, { draftId: third })).length, 0);
  });
});

describe('cards', () => {
  test('an item can say what its card shows, listed with it', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('rules', '# Rules', { card: [' Prices in pence ', '', 'Tax at checkout'] })] });
    const [rules] = (await store.getSchema(schema)).items;
    assert.deepEqual(rules.card, ['Prices in pence', 'Tax at checkout']);
    await assert.rejects(store.propose({ schemaId: schema, note: 'n', items: [doc('rules', '# Rules', { card: ['1', '2', '3', '4', '5'] })] }), /fits 4/);
  });

  test('a comment can be on an item\'s card', async () => {
    const store = newStore();
    const { schema } = await accepted(store, { items: [doc('rules')] });
    await store.addComment(schema, { target: { item: 'rules', card: true, part: 'ignored' }, text: 'Show the currency here.' });
    const [one] = await store.listComments(schema);
    assert.deepEqual(one.target, { item: 'rules', card: true, title: 'rules' });
  });
});

describe('domains (groups in the store)', () => {
  test('schemas start ungrouped, and move between groups without counting as a change', async () => {
    const store = newStore();
    const { schema } = await accepted(store);
    const before = (await store.list())[0];
    assert.equal(before.group, null);
    const auth = await store.createGroup('  Auth  ');
    assert.equal(auth.name, 'Auth');
    await store.moveSchema(schema, auth.id);
    const after = (await store.list())[0];
    assert.equal(after.group, auth.id);
    assert.equal(after.updatedAt, before.updatedAt);
    const listed = await store.listGroups();
    assert.deepEqual(listed.groups.map(({ id, name, schemas }) => ({ id, name, schemas })), [{ id: auth.id, name: 'Auth', schemas: 1 }]);
    assert.equal(listed.ungrouped, 0);
    assert.ok(listed.groups[0].createdAt);
    await store.moveSchema(schema, null);
    assert.equal((await store.list())[0].group, null);
  });

  test('names are checked, and a deleted group leaves its schemas ungrouped', async () => {
    const store = newStore();
    const { schema } = await accepted(store);
    await assert.rejects(store.createGroup(' '), /needs a name/);
    await assert.rejects(store.createGroup('ungrouped'), /can't take that name/);
    await assert.rejects(store.createGroup('No Domain'), /can't take that name/);
    const team = await store.createGroup('Payments team');
    await assert.rejects(store.createGroup('payments TEAM'), /already a domain/);
    await store.renameGroup(team.id, 'Payments');
    await store.moveSchema(schema, team.id);
    await store.deleteGroup(team.id);
    assert.equal((await store.list())[0].group, null);
    assert.deepEqual(await store.listGroups(), { groups: [], ungrouped: 1 });
    await assert.rejects(store.moveSchema(schema, team.id), /no domain/);
  });

  test('a new schema can be proposed straight into a group', async () => {
    const store = newStore();
    const group = await store.createGroup('Auth');
    const { schema } = await store.propose(proposal({ groupId: group.id }));
    assert.equal((await store.list()).find((one) => one.id === schema).group, group.id);
    await assert.rejects(store.propose(proposal({ groupId: 'nope' })), /no domain nope/);
  });

  test("domains are organised in folders, which nest, and a deleted folder's contents move up", async () => {
    const store = newStore();
    const department = await store.createFolder('  Platform  ');
    assert.equal(department.name, 'Platform');
    const team = await store.createFolder('Identity team', department.id);
    assert.equal(team.path, 'Platform / Identity team');
    const auth = await store.createGroup('Auth', team.id);
    assert.equal(auth.path, 'Platform / Identity team');
    let [listed] = (await store.listGroups()).groups;
    assert.equal(listed.folder, team.id);
    assert.equal(listed.path, 'Platform / Identity team');
    assert.deepEqual((await store.listFolders()).map(({ name, path: at, folders, domains }) => ({ name, at, folders, domains })), [
      { name: 'Platform', at: 'Platform', folders: 1, domains: 0 },
      { name: 'Identity team', at: 'Platform / Identity team', folders: 0, domains: 1 },
    ]);
    await assert.rejects(store.moveFolder(department.id, team.id), /inside itself/);
    await assert.rejects(store.createGroup('Billing', 'nope'), /no folder nope/);
    assert.equal((await store.listGroups()).groups.length, 1);
    await store.deleteFolder(team.id);
    [listed] = (await store.listGroups()).groups;
    assert.equal(listed.folder, department.id);
    await store.moveGroup(auth.id, null);
    [listed] = (await store.listGroups()).groups;
    assert.equal(listed.folder, null);
    await store.moveGroup(auth.id, department.id);
    await store.deleteGroup(auth.id);
    assert.deepEqual((await store.folders()).placement, {});
    await assert.rejects(store.moveGroup('nope', null), /no domain nope/);
  });
});
