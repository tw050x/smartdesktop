import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowDetails, sequenceDetails } from '../packages/app/src/renderer/diagram-details.js';

const sequence = {
  participants: [{ id: 'a', label: 'API' }, { id: 'd', label: 'Database' }, { id: 'm', label: 'Mailer' }],
  messages: [
    { id: 'save', from: 'a', to: 'd', label: 'save' },
    { id: 'saved', from: 'd', to: 'a', label: 'saved', reply: true },
    { id: 'check', from: 'a', to: 'a', label: 'check' },
    { id: 'mail', from: 'a', to: 'm', label: 'mail' },
  ],
  groups: [
    { id: 'retry', kind: 'loop', label: 'up to 3 times', from: 'save', to: 'saved' },
    { id: 'either', kind: 'alt', label: 'it worked', from: 'check', to: 'mail', sections: [{ at: 'mail', label: 'it failed' }] },
  ],
};

test('a message says who it joins, where it falls and what wraps it', () => {
  const details = sequenceDetails(sequence);
  assert.deepEqual(details.message(sequence.messages[0]), { name: 'save', facts: ['API → Database', 'Step 1 of 4', 'Inside a loop: up to 3 times'] });
  assert.deepEqual(details.message(sequence.messages[2]).facts, ['API, on its own', 'Step 3 of 4', 'Inside alternatives: it worked']);
  assert.equal(details.message(sequence.messages[3]).facts[2], 'Inside alternatives: it failed');
});

test('a wrapping box says exactly what it wraps', () => {
  const details = sequenceDetails(sequence);
  assert.deepEqual(details.group(sequence.groups[0]), { name: 'up to 3 times', facts: ['Holds 2 messages, from “save” to “saved”', 'Between API and Database'] });
  assert.deepEqual(details.group(sequence.groups[1]).facts, ['Holds 2 messages, from “check” to “mail”', '2 sections: it worked; it failed', 'Between API and Mailer']);
  assert.equal(details.group({ id: 'one', kind: 'opt', from: 'mail', to: 'mail' }).facts[0], 'Holds “mail”');
});

test('participants, activations and boxes name what they involve', () => {
  const details = sequenceDetails(sequence);
  assert.deepEqual(details.participant(sequence.participants[0]).facts, ['Sends 2 messages, receives 1 message and does 1 step itself']);
  assert.deepEqual(details.activation({ participant: 'd', from: 'save', to: 'saved' }), { name: 'Database', facts: ['Busy from “save” to “saved”'] });
  assert.deepEqual(details.box({ label: 'Back end', participants: ['a', 'd'] }), { name: 'Back end', facts: ['API and Database'] });
  assert.deepEqual(sequenceDetails({ participants: [{ id: 'x', label: 'X' }] }).participant({ id: 'x', label: 'X' }).facts, ['Takes no part in these messages']);
});

test('a flow says what leads in and out', () => {
  const item = { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'c', label: 'uses' }, { from: 'b', to: 'c' }] };
  const details = flowDetails(item);
  assert.deepEqual(details.node(item.nodes[2]).facts, ['Comes from A and B', 'It leads nowhere further']);
  assert.deepEqual(details.node(item.nodes[0]).facts, ['Nothing leads into it', 'Goes to C']);
  assert.deepEqual(details.edge(item.edges[0]), { name: 'uses', facts: ['A → C'] });
});
