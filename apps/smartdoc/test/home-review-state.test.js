import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { actionFor } from '../packages/app/src/main/home-review-state.js';

const review = (over) => ({ status: 'committed', findings: 3, decided: 1, applied: false, preview: false, waitingForAi: false, ...over });

describe('a review on the home screen', () => {
  test('asks the user to decide findings', () => {
    assert.equal(actionFor(review()), 'Decide');
  });
  test('asks the user to apply them, once all are decided', () => {
    assert.equal(actionFor(review({ decided: 3 })), 'Apply');
  });
  test('asks the user to accept a draft preview', () => {
    assert.equal(actionFor(review({ decided: 3, preview: true })), 'Accept');
  });
  test('asks nothing while the AI has it', () => {
    assert.equal(actionFor(review({ status: 'open' })), null);
    assert.equal(actionFor(review({ status: 'open', waitingForAi: true, findings: 0, decided: 0 })), null);
  });
  test('asks nothing once the next draft is written, or with nothing found', () => {
    assert.equal(actionFor(review({ applied: true })), null);
    assert.equal(actionFor(review({ findings: 0, decided: 0 })), null);
  });
  test('asks nothing when there is no review', () => {
    assert.equal(actionFor(undefined), null);
  });
});
