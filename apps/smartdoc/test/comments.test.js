import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { promptNamingWindow } from '../packages/app/src/renderer/take-over-note.js';
import { acceptWarning, commentsSincePreview, previewComments, unansweredRequests } from '../packages/app/src/main/comments.js';

describe('the user’s comments', () => {
  const request = (id, extra = {}) => ({ id, kind: 'comment', note: id, ...extra });

  test('one with no finding in response is unanswered', () => {
    const review = { requests: [request('a'), request('b')], items: [{ id: 'f', inResponseTo: 'a' }] };
    assert.deepEqual(unansweredRequests(review).map((r) => r.id), ['b']);
  });

  test('one added after the review finished needs no finding: it goes in with the decisions', () => {
    assert.deepEqual(unansweredRequests({ requests: [request('a', { afterCommit: true })], items: [] }), []);
  });

  test('a review with no comments has nothing unanswered, even from older files', () => {
    assert.deepEqual(unansweredRequests({ items: [] }), []);
    assert.deepEqual(unansweredRequests({ requests: [], items: [{ id: 'f' }] }), []);
  });

  const at = '2026-11-02T10:00:00.000Z';
  const later = '2026-11-02T11:00:00.000Z';
  const earlier = '2026-11-02T09:00:00.000Z';

  test('only unresolved comments on the draft preview count as being on it', () => {
    const review = { requests: [request('a', { onPreview: true }), request('b', { onPreview: true, resolved: true }), request('c', { afterCommit: true })] };
    assert.deepEqual(previewComments(review).map((r) => r.id), ['a']);
  });

  test('a draft preview doesn’t reflect comments made since it was written', () => {
    const review = { preview: { at }, requests: [
      request('old', { afterCommit: true, createdAt: earlier }),
      request('new', { afterCommit: true, createdAt: later }),
      request('done', { afterCommit: true, onPreview: true, resolved: true, createdAt: later }),
      request('answered', { createdAt: later }),
    ] };
    assert.deepEqual(commentsSincePreview(review).map((r) => r.id), ['new']);
    assert.deepEqual(commentsSincePreview({ requests: review.requests }), []);
  });

  test('accepting warns only about comments the draft preview doesn’t reflect', () => {
    assert.equal(acceptWarning({ preview: { at }, requests: [] }), null);
    assert.equal(acceptWarning({ preview: { at }, requests: [request('old', { afterCommit: true, createdAt: earlier })] }), null);
    const warning = acceptWarning({ preview: { at }, requests: [request('Shorten this', { afterCommit: true, onPreview: true, createdAt: later })] });
    assert.match(warning.message, /1 comment/);
    assert.match(warning.detail, /Shorten this/);
  });

  test('a prompt copied from a window names it, for the AI to take over', () => {
    assert.equal(promptNamingWindow('Do this.', 'w-7f3a'), 'Do this. Take over SmartDoc window w-7f3a with use_window first.');
  });
});
