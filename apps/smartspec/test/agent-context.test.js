import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextFor, withSuggestions } from '../packages/app/src/main/agent.js';

test('what the user did since their last message goes with their next one', () => {
  const messages = [
    { role: 'event', kind: 'context', text: 'Looking at “Old”' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'Hi' },
    { role: 'event', kind: 'context', text: 'Looking at “Profile count”', detail: 'Looking at finding f3, “Profile count”' },
    { role: 'event', kind: 'context', text: 'Accepted “Tone”' },
    { role: 'event', text: 'New session with Claude' },
  ];
  const context = contextFor(messages);
  assert.match(context, /^\[What I've done in the app since my last message, for context:\n/);
  assert.match(context, /- Looking at finding f3, “Profile count”\n- Accepted “Tone”\]\n\n$/);
  assert.doesNotMatch(context, /Old|New session/);
  assert.equal(contextFor([...messages, { role: 'user', text: 'why?' }]), '');
  assert.equal(contextFor([]), '');
});

test('follow-up questions the AI suggests are taken out of its reply and kept', () => {
  const message = withSuggestions({ role: 'assistant', text: 'It reads better now.\n\n<suggest>Why that word?</suggest>\n<suggest>  Can it be\n shorter? </suggest>' });
  assert.equal(message.text, 'It reads better now.');
  assert.deepEqual(message.suggestions, ['Why that word?', 'Can it be shorter?']);
  const plain = { role: 'assistant', text: 'Nothing to suggest.' };
  assert.equal(withSuggestions(plain), plain);
  const user = { role: 'user', text: '<suggest>not mine</suggest>' };
  assert.equal(withSuggestions(user), user);
  const many = withSuggestions({ role: 'assistant', text: 'a<suggest>1</suggest><suggest>2</suggest><suggest>3</suggest><suggest>4</suggest>' });
  assert.deepEqual(many.suggestions, ['1', '2', '3']);
});
