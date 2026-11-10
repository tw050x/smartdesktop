import assert from 'node:assert/strict';
import { test } from 'node:test';
import { olderDraftRefusal } from '../packages/app/src/main/older-drafts.js';
import { chatIdOf } from '../packages/app/src/main/agent.js';

const line = ['original', 'd1', 'd2'];
const on = (draft) => ({ line, currentDraftId: draft, variationName: 'Original' });

test('the newest draft can be improved', () => {
  assert.equal(olderDraftRefusal(on('d2'), null, 'start_review', { type: 'improve' }), null);
  assert.equal(olderDraftRefusal(on('d2'), 'improve', 'apply_review'), null);
});

test('an older draft can be read and highlighted, but no AI can improve it', () => {
  const refusal = olderDraftRefusal(on('d1'), null, 'start_review', { type: 'improve' });
  assert.match(refusal, /^Draft 1 is an older draft: Draft 2 is the newest of Original\./);
  assert.match(refusal, /create_variation with draft 1/);
  assert.match(refusal, /create_document_from_draft/);
  assert.ok(olderDraftRefusal(on('original'), null, 'start_review', {}).startsWith('Original is an older draft'));
  for (const name of ['add_finding', 'add_annotation', 'revise_finding', 'remove_item', 'commit_review', 'apply_review']) {
    assert.ok(olderDraftRefusal(on('d1'), 'improve', name), name);
  }
  assert.equal(olderDraftRefusal(on('d1'), null, 'start_review', { type: 'highlights', goal: 'Skim' }), null);
  assert.equal(olderDraftRefusal(on('d1'), 'highlights', 'commit_review'), null);
  assert.equal(olderDraftRefusal(on('d1'), 'improve', 'get_document'), null);
  assert.equal(olderDraftRefusal(on('d1'), 'improve', 'reply_to_comment'), null);
});

test('each draft of each variation has a chat of its own', () => {
  const doc = { id: 'doc', variationId: 'original', currentDraftId: 'd1' };
  assert.equal(chatIdOf(doc), 'doc/original/d1');
  assert.notEqual(chatIdOf({ ...doc, currentDraftId: 'd2' }), chatIdOf(doc));
  assert.notEqual(chatIdOf({ ...doc, variationId: 'v-acme' }), chatIdOf(doc));
  assert.equal(chatIdOf(null), null);
});
