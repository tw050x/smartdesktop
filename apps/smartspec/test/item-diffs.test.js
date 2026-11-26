import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diffOf, flowDiff, mergeOrder, sequenceDiff, tableDiff, WAS, changedFields, sideDiff } from '../packages/app/src/renderer/item-diffs.js';

const ids = (list) => list.map((one) => one.id);

test('both versions in one order: what was removed goes back after what it followed', () => {
  const after = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
  const before = [{ id: 'x' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(ids(mergeOrder(after, before)), ['x', 'a', 'b', 'c', 'd']);
  assert.deepEqual(ids(mergeOrder([], [{ id: 'a' }, { id: 'b' }])), ['a', 'b']);
});

test('a flow diagram marks new, removed and changed nodes and connections, and what a changed one said', () => {
  const before = { kind: 'flow', nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'Pay' }], edges: [{ from: 'a', to: 'b' }] };
  const after = { kind: 'flow', nodes: [{ id: 'a', label: 'Begin' }, { id: 'c', label: 'Ship' }], edges: [{ from: 'a', to: 'c', label: 'then' }] };
  const { item, status, was } = flowDiff(after, before);
  assert.deepEqual(ids(item.nodes).sort(), ['a', 'b', 'c']);
  assert.equal(item.edges.length, 2);
  assert.equal(status.get('a'), 'changed');
  assert.equal(was.get('a'), 'Start');
  assert.equal(status.get('b'), 'removed');
  assert.equal(status.get('c'), 'added');
  assert.equal(status.get('a-b'), 'removed');
  assert.equal(status.get('a-c'), 'added');
  assert.deepEqual(diffOf(after, before).status, status);
});

test('a sequence keeps a removed message in its place in time, and marks a new box', () => {
  const people = [{ id: 'u', label: 'User' }, { id: 's', label: 'Shop' }];
  const before = { kind: 'sequence', participants: people, messages: [{ id: 'm1', from: 'u', to: 's', label: 'Buy' }, { id: 'm2', from: 's', to: 'u', label: 'Paid', reply: true }] };
  const after = {
    kind: 'sequence', participants: people,
    messages: [{ id: 'm1', from: 'u', to: 's', label: 'Buy' }, { id: 'm3', from: 's', to: 's', label: 'Retry' }],
    groups: [{ id: 'g', kind: 'loop', label: 'until paid', from: 'm3', to: 'm3' }],
  };
  const { item, status } = sequenceDiff(after, before);
  assert.deepEqual(ids(item.messages), ['m1', 'm2', 'm3']);
  assert.equal(status.get('m2'), 'removed');
  assert.equal(status.get('m3'), 'added');
  assert.equal(status.get('g'), 'added');
  assert.equal(status.has('m1'), false);
  assert.equal(status.has('u'), false);
});

test('a table marks new and removed rows and columns, and says what a changed cell held', () => {
  const before = { kind: 'table', columns: [{ id: 'f', label: 'Field' }, { id: 't', label: 'Type' }], rows: [{ id: 'r1', cells: { f: 'id', t: 'int' } }, { id: 'r2', cells: { f: 'name', t: 'text' } }] };
  const after = { kind: 'table', columns: [{ id: 'f', label: 'Field' }, { id: 't', label: 'Type' }, { id: 'n', label: 'Notes' }], rows: [{ id: 'r1', cells: { f: 'id', t: 'uuid', n: 'new' } }, { id: 'r3', cells: { f: 'email', t: 'text' } }] };
  const { item, status, cells } = tableDiff(after, before);
  assert.deepEqual(ids(item.rows), ['r1', 'r2', 'r3']);
  assert.deepEqual(ids(item.columns), ['f', 't', 'n']);
  assert.equal(status.get('r1'), 'changed');
  assert.equal(status.get('r2'), 'removed');
  assert.equal(status.get('r3'), 'added');
  assert.equal(status.get('n'), 'added');
  assert.deepEqual([...cells.get('r1')], [['t', 'int']]); // a new column's cell isn't a changed one
});

test('rows taken into a new box show as removed where they were, and added inside it', () => {
  const people = [{ id: 'a', label: 'API' }, { id: 'p', label: 'Payments' }];
  const before = { kind: 'sequence', participants: people, messages: [{ id: 'c', from: 'a', to: 'p', label: 'charge' }, { id: 'ok', from: 'p', to: 'a', label: 'charged' }] };
  const after = {
    kind: 'sequence', participants: people,
    messages: [{ id: 'c', from: 'a', to: 'p', label: 'charge' }, { id: 'ok', from: 'p', to: 'a', label: 'charged' }, { id: 'no', from: 'p', to: 'a', label: 'declined' }],
    groups: [{ id: 'g', kind: 'alt', label: 'succeeds', from: 'ok', to: 'no', sections: [{ at: 'no', label: 'fails' }] }],
  };
  const { item, status } = sequenceDiff(after, before);
  // The old row where it was, then the new ones; the row that didn't move is only there once.
  assert.deepEqual(ids(item.messages), ['c', `ok${WAS}`, 'ok', 'no']);
  assert.equal(status.get(`ok${WAS}`), 'removed');
  assert.equal(status.get('ok'), 'added');
  assert.equal(status.has('c'), false);
  // A message reworded where it is shows the same way: old row removed, new one added.
  const reworded = sequenceDiff({ ...before, messages: [before.messages[0], { ...before.messages[1], label: 'paid' }] }, before);
  assert.equal(reworded.status.get(`ok${WAS}`), 'removed');
  assert.equal(reworded.status.get('ok'), 'added');
});

test('only diagrams and tables are drawn from both versions', () => {
  assert.equal(diffOf({ kind: 'document', markdown: 'b' }, { kind: 'document', markdown: 'a' }), null);
  assert.equal(diffOf({ kind: 'table', columns: [], rows: [] }, null), null);
});

describe('what a flow proposal changed, in words', () => {
  const before = {
    kind: 'flow',
    nodes: [{ id: 'fn', label: 'Cloud Functions', description: 'Sign-in links and deletions.' }, { id: 'old', label: 'Old box' }, { id: 'db', label: 'Firestore' }],
    edges: [{ from: 'fn', to: 'db', label: 'writes' }],
  };
  const after = {
    kind: 'flow',
    nodes: [{ id: 'fn', label: 'Cloud Functions', description: 'Sign-in links, deletions and locks.', link: 'account' }, { id: 'db', label: 'Firestore backup' }, { id: 'mail', label: 'Mailjet' }],
    edges: [{ from: 'fn', to: 'db', label: 'writes' }, { from: 'fn', to: 'mail' }],
  };

  test('each part keeps its two versions, and says which of its fields changed', () => {
    const diff = flowDiff(after, before);
    assert.deepEqual(diff.parts.get('fn').before, before.nodes[0]);
    assert.deepEqual(diff.parts.get('fn').after, after.nodes[0]);
    assert.deepEqual(changedFields(after.nodes[0], before.nodes[0]), ['description', 'link']);
    assert.deepEqual(changedFields(after.nodes[1], before.nodes[2]), ['label']);
  });
});

describe('one side alone', () => {
  const before = { kind: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'gone', label: 'Gone' }, { id: 'c', label: 'C', description: 'old words' }], edges: [{ from: 'a', to: 'gone' }] };
  const after = { kind: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'new', label: 'New' }, { id: 'c', label: 'C', description: 'new words' }], edges: [{ from: 'a', to: 'new' }] };

  test('Before is the draft’s version with what’s removed marked, and what changed', () => {
    const side = sideDiff(after, before, 'before');
    assert.equal(side.item, before);
    assert.equal(side.side, 'before');
    assert.equal(side.status.get('gone'), 'removed');
    assert.equal(side.status.get('c'), 'changed');
    assert.equal(side.status.has('new'), false);
    assert.equal(side.parts.get('c').before.description, 'old words');
  });

  test('After is the proposed version with what’s added marked, and what changed', () => {
    const side = sideDiff(after, before, 'after');
    assert.equal(side.item, after);
    assert.equal(side.status.get('new'), 'added');
    assert.equal(side.status.get('c'), 'changed');
    assert.equal(side.status.has('gone'), false);
  });

  test('a sequence’s changed message is its old row, removed, before, and its new one, added, after', () => {
    const was = { kind: 'sequence', participants: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }], messages: [{ id: 'm', from: 'p', to: 'q', label: 'asks' }] };
    const now = { kind: 'sequence', participants: was.participants, messages: [{ id: 'm', from: 'p', to: 'q', label: 'asks twice' }] };
    assert.equal(sideDiff(now, was, 'before').status.get('m'), 'removed');
    assert.equal(sideDiff(now, was, 'after').status.get('m'), 'added');
  });
});
