import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { brokenParts, checkContract, expectationsJob, shapesNamed, checksUnder, contractChanges, contractLinks, contractParts, contractText, contractTree, pathUnder, placeholders } from '../packages/app/src/main/contract.js';
import { checkLinks, linkGraph, partsOf } from '../packages/app/src/main/items.js';
import { createStore } from '../packages/app/src/main/store.js';

// Orders: /orders, with /orders/:id under it, which makes an order first to read it.
const contract = () => ({
  markdown: 'Orders are made by the checkout.',
  children: [{
    id: 'orders',
    name: '/orders',
    path: '/orders',
    markdown: 'Making orders.',
    shapes: [{ id: 'order', title: 'An order', schema: { type: 'object', required: ['id'] } }],
    clauses: [
      {
        id: 'create-order',
        title: 'Creating an order returns its id',
        markdown: 'A basket with a line in it becomes an [order](flow#paid).',
        checks: [{ id: 'one-line', kind: 'http', request: { method: 'post', path: '/orders', body: { lines: [{ sku: 'apple' }] } }, expect: { status: 201, shape: 'order' } }],
      },
      { id: 'empty-refused', title: 'An empty basket is refused', checks: [{ id: 'empty', kind: 'http', request: { method: 'POST', path: '/orders', body: { lines: [] } }, expect: { status: 422 } }] },
    ],
    children: [{
      id: 'order',
      name: ':id',
      path: '/orders/:id',
      setup: [{ id: 'make', kind: 'http', request: { method: 'POST', path: '/orders', body: { lines: [{ sku: 'apple' }] } }, keep: { id: 'body.id' } }],
      clauses: [{ id: 'price-kept', title: 'Orders keep their price', checks: [{ id: 'read', kind: 'http', request: { method: 'GET', path: '/orders/{id}' }, expect: { status: 200, shape: 'order' } }] }],
    }],
  }],
});
const flow = { id: 'flow', kind: 'flow', title: 'States', nodes: [{ id: 'paid', label: 'Paid' }], edges: [] };
const image = { id: 'pic', kind: 'image', title: 'Pic', mediaType: 'image/png', data: 'AAAA' };
const orders = (tree) => tree.children[0];
const byId = (tree) => orders(tree).children[0];
const valid = () => {
  const tree = contract();
  byId(tree).id = 'one-order';
  return tree;
};

describe('the contract', () => {
  test('Markdown is a root with only writing, and no public names', () => {
    assert.deepEqual(contractTree('Gives tokens.'), { markdown: 'Gives tokens.' });
    assert.deepEqual(contractParts('Gives tokens.'), []);
    assert.equal(contractText('Gives tokens.'), 'Gives tokens.');
    assert.doesNotThrow(() => checkContract('Anything'));
  });

  test('its nodes, clauses and shapes are its public names, and it reads as writing', () => {
    assert.throws(() => checkContract(contract()), /Two of the contract's nodes, clauses and shapes have the id order/);
    const tree = contract();
    byId(tree).id = 'one-order';
    checkContract(tree);
    assert.deepEqual(contractParts(tree), ['orders', 'order', 'create-order', 'empty-refused', 'one-order', 'price-kept']);
    assert.match(contractText(tree), /^Orders are made by the checkout\.\n\n\*\*\/orders\*\*\n\nMaking orders\.\n\n\*\*Creating an order/);
    assert.equal(orders(tree).clauses[0].checks[0].request.method, 'POST');
  });

  const broken = (change) => {
    const tree = valid();
    change(tree);
    return () => checkContract(tree, { items: [flow, image], partsOf });
  };

  test('checks are checked', () => {
    assert.throws(broken((tree) => { orders(tree).clauses[0].title = ' '; }), /needs a title/);
    assert.throws(broken((tree) => { orders(tree).clauses[0].checks[0].expect = {}; }), /expects nothing/);
    assert.throws(broken((tree) => { orders(tree).clauses[0].checks[0].kind = 'grpc'; }), /unknown kind/);
    assert.throws(broken((tree) => { orders(tree).name = ''; }), /needs a name/);
    assert.throws(broken((tree) => { tree.id = 'root'; }), /the tree's root/);
  });

  test('a check\'s path sits under its node\'s, and a node\'s under its parent\'s', () => {
    assert.ok(pathUnder('/orders/{id}', '/orders/:id'));
    assert.ok(pathUnder('/orders/7/refunds', '/orders/:id'));
    assert.ok(!pathUnder('/baskets/7', '/orders/:id'));
    assert.ok(!pathUnder('/orders', '/orders/:id'));
    assert.throws(broken((tree) => { byId(tree).clauses[0].checks[0].request.path = '/baskets/{id}'; }), /isn't under its node's path, \/orders\/:id/);
    assert.throws(broken((tree) => { byId(tree).path = '/baskets/:id'; }), /isn't under its parent's, \/orders/);
  });

  test('shapes are seen on their node and below, never above', () => {
    const tree = valid();
    byId(tree).shapes = [{ id: 'refund', schema: { type: 'object' } }];
    assert.doesNotThrow(() => checkContract(structuredClone(tree)));
    orders(tree).clauses[0].checks[0].expect.shape = 'refund';
    assert.throws(() => checkContract(tree), /shape refund, which isn't declared on its node or one above it\. Those it can use are: order/);
  });

  test('a request uses only what setup above it keeps', () => {
    assert.deepEqual(placeholders({ path: '/orders/{id}', headers: { Authorization: 'Bearer {token}' }, body: { of: '{id}' } }), ['id', 'token']);
    assert.throws(broken((tree) => { delete byId(tree).setup; }), /uses \{id\}, which no setup above it keeps/);
    assert.throws(broken((tree) => { orders(tree).clauses[0].checks[0].request.path = '/orders/{id}'; }), /uses \{id\}/);
    assert.throws(broken((tree) => { byId(tree).setup[0].keep = { id: 'id' }; }), /starting body\., headers\. or status/);
  });

  test('a clause can be defined by an item or a part of one, but not an image', () => {
    const with_ = (definedBy) => broken((tree) => { orders(tree).clauses[0].defined_by = definedBy; });
    assert.doesNotThrow(with_('flow'));
    assert.doesNotThrow(with_('flow#paid'));
    assert.throws(with_('flow#sent'), /has no part sent/);
    assert.throws(with_('nowhere'), /no item nowhere/);
    assert.throws(with_('pic'), /can't define a clause/);
  });

  test('its links come from its writing, its clauses and what defines a clause', () => {
    const tree = valid();
    orders(tree).clauses[1].defined_by = 'flow';
    tree.markdown = 'See [making](contract#orders).';
    assert.deepEqual(contractLinks(tree).map(({ part, to }) => [part, to]), [[null, 'contract#orders'], ['create-order', 'flow#paid'], ['empty-refused', 'flow']]);
    assert.deepEqual(linkGraph({ contract: tree, items: [] }).map(({ from, to }) => [from, to]), [['contract', 'contract#orders'], ['contract#create-order', 'flow#paid'], ['contract#empty-refused', 'flow']]);
  });

  test('links reach its public names, and a use\'s, but never a use\'s items', () => {
    const doc = (markdown) => ({ id: 'n', kind: 'document', title: 'N', markdown });
    const record = (markdown) => ({ contract: valid(), items: [flow, doc(markdown)], uses: [{ id: 'auth' }] });
    const useParts = new Map([['auth', ['issue-token']]]);
    assert.doesNotThrow(() => checkLinks(record('[a](contract#create-order) [b](contract#order) [c](contract#one-order) [d](auth#issue-token) [e](auth#contract)'), { useParts }));
    assert.throws(() => checkLinks(record('[a](contract#nothing)'), { useParts }), /no node, clause or shape nothing/);
    assert.throws(() => checkLinks(record('[a](auth#inside)'), { useParts }), /only its contract can be seen, so link to auth, auth#contract, or one of its contract's public names: auth#issue-token/);
  });

  test('a branch runs its checks after the setup above them', () => {
    const tree = valid();
    const ran = (id) => checksUnder(tree, id).map(({ clause, check, setup }) => `${clause.id}/${check.id} after ${setup.map((step) => step.id).join(',') || 'nothing'}`);
    assert.deepEqual(ran(), ['create-order/one-line after nothing', 'empty-refused/empty after nothing', 'price-kept/read after make']);
    assert.deepEqual(ran('one-order'), ['price-kept/read after make']);
    assert.deepEqual(ran('orders'), ran());
    assert.deepEqual(ran('empty-refused'), ['empty-refused/empty after nothing']);
    assert.deepEqual(ran('order'), []);
  });

  test('what changes, and what that breaks for those relying on it', () => {
    const next = valid();
    orders(next).clauses[0].markdown = 'Reworded.';
    orders(next).clauses.splice(1, 1);
    orders(next).shapes[0].schema = { type: 'object' };
    // Moved to the root: the same promise, so nothing breaks.
    next.clauses = byId(next).clauses.splice(0, 1);
    assert.deepEqual(contractChanges(valid(), next).parts, { 'create-order': 'changed', order: 'changed', 'empty-refused': 'removed' });
    assert.deepEqual(brokenParts(valid(), next, ['create-order', 'empty-refused', 'order']), [{ part: 'empty-refused', change: 'removed' }, { part: 'order', change: 'changed' }]);
    assert.equal(contractChanges('Same', 'Same').changed, false);
  });
});

const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-contract-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const newStore = () => createStore(path.join(temp, `store-${n++}`));
const proposal = (extra = {}) => ({ name: 'Orders', summary: 'Takes orders.', note: 'First version', ...extra });
async function accepted(store, extra) {
  const { schema } = await store.propose(proposal(extra));
  const { draft } = await store.accept(schema);
  return { schema, draft };
}

describe('the contract in the store', () => {
  test('outsiders link to its public names, and a change says what it breaks for them', async () => {
    const store = newStore();
    const first = valid();
    const ordersSchema = await accepted(store, { contract: first, items: [flow] });
    const uses = [{ id: 'orders', schemaId: ordersSchema.schema }];
    const checkout = await accepted(store, { name: 'Checkout', uses, items: [{ id: 'pay', kind: 'document', title: 'Pay', markdown: 'Then [order](orders#create-order), or be [refused](orders#empty-refused).' }] });
    await assert.rejects(store.propose(proposal({ uses, items: [{ id: 'x', kind: 'document', title: 'X', markdown: '[in](orders#flow)' }] })), /only its contract can be seen/);

    const next = valid();
    orders(next).clauses[0].markdown = 'Reworded.';
    orders(next).clauses.splice(1, 1);
    const made = await store.propose({ schemaId: ordersSchema.schema, contract: next, note: 'n' });
    assert.deepEqual(made.usedBy, [{ id: checkout.schema, name: 'Checkout', uses: ['orders'], breaks: [{ part: 'empty-refused', change: 'removed' }] }]);
    const waiting = await store.getProposal(ordersSchema.schema);
    assert.deepEqual(waiting.changes.contractParts, { 'create-order': 'changed', 'empty-refused': 'removed' });
  });

  test('a comment can be on a clause', async () => {
    const store = newStore();
    const one = await accepted(store, { contract: valid(), items: [flow] });
    await store.addComment(one.schema, { target: { item: 'contract', part: 'create-order' }, text: 'What about two lines?' });
    const [comment] = await store.listComments(one.schema);
    assert.equal(comment.target.partName, 'Creating an order returns its id');
  });
});

describe('what a use relies on', () => {
  const expects = {
    setup: [{ id: 'in', kind: 'http', request: { method: 'POST', path: '/sign-in', form: { client: '{client}' } }, keep: { token: 'body.token' } }],
    clauses: [{ id: 'reads', title: 'Lets {client} read', checks: [{ id: 'ok', kind: 'http', request: { method: 'GET', path: '/me', headers: { authorization: 'Bearer {token}', 'x-client': '{client}' } }, expect: { shape: 'user' } }] }],
  };

  test('is keyed apart, its parameters filled in, what setup keeps left for the runner', () => {
    const job = expectationsJob(expects, { ownerId: 'shop', useId: 'auth', values: { client: 'shop' } });
    const [one] = job.checks;
    assert.equal(one.key, 'use:shop/auth/reads/ok');
    assert.equal(one.clause, 'use:shop/auth/reads');
    assert.deepEqual(one.setup[0].request.form, { client: 'shop' });
    assert.deepEqual(one.request.headers, { authorization: 'Bearer {token}', 'x-client': 'shop' });
    assert.deepEqual(shapesNamed(expects), ['user']);
  });

  test('can name the embedded schematic\'s shapes and the use\'s parameters, and nothing else', () => {
    assert.doesNotThrow(() => checkContract(structuredClone(expects), { shapes: ['user'], known: ['client'] }));
    assert.throws(() => checkContract(structuredClone(expects), { shapes: ['user'] }), /uses \{client\}/);
    assert.throws(() => checkContract(structuredClone(expects), { known: ['client'] }), /expects shape user/);
  });
});
