import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { promptNamingWindow } from '../packages/app/src/renderer/take-over-note.js';
import { acceptWarning, commentsSincePreview, currentRequests, earlierComments, isDone, noFurtherAction, notCommentedAgain, onCurrentPreview, onVersion, previewComments, unansweredRequests } from '../packages/app/src/main/comments.js';

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
    const review = { preview: { at }, requests: [request('a', { onPreview: true, previewAt: at }), request('b', { onPreview: true, previewAt: at, resolved: true }), request('c', { afterCommit: true })] };
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

  test('a comment marked no further action is done, by the AI or the user', () => {
    assert.equal(isDone(request('a')), false);
    assert.equal(isDone(request('a', { noFurtherAction: { by: 'ai', at } })), true);
    assert.equal(isDone(request('a', { noFurtherAction: { by: 'user', at } })), true);
    assert.equal(isDone(request('a', { noFurtherAction: null })), false);
  });

  test('a comment resolved before outcomes existed reads as needing no further action from the AI', () => {
    assert.deepEqual(noFurtherAction(request('a', { resolved: true })), { by: 'ai', at: null });
    // Cleared since, it's open again whatever the old field says.
    assert.equal(noFurtherAction(request('a', { resolved: true, noFurtherAction: null })), null);
  });

  test('a comment the AI replied to, or marked no further action, is answered without a finding', () => {
    const review = { requests: [request('a', { replies: [{ who: 'ai', outcome: 'Noted' }] }), request('b', { noFurtherAction: { by: 'user', at } }), request('c')], items: [] };
    assert.deepEqual(unansweredRequests(review).map((r) => r.id), ['c']);
  });

  test('comments on the draft preview needing no further action aren’t for the AI to change it', () => {
    const review = { preview: { at }, requests: [request('a', { onPreview: true, previewAt: at }), request('b', { onPreview: true, previewAt: at, noFurtherAction: { by: 'ai', at } }), request('c', { onPreview: true, previewAt: at, replies: [{ who: 'ai', outcome: 'Partly done' }] })] };
    assert.deepEqual(previewComments(review).map((r) => r.id), ['a', 'c']);
  });

  describe('belong to the version they were written on', () => {
    const anchors = [{ page: 1, start: 0, end: 5, text: 'Hello' }];
    const review = {
      draftId: 'd3',
      preview: { at: later },
      items: [{ id: 'f', inResponseTo: 'answered-by-finding' }],
      requests: [
        request('draft', { anchors, afterCommit: true, createdAt: earlier }),
        request('old-preview', { anchors, afterCommit: true, onPreview: true, previewAt: at, createdAt: at }),
        request('legacy-old', { anchors, afterCommit: true, onPreview: true, createdAt: at }),
        request('this-preview', { anchors, afterCommit: true, onPreview: true, previewAt: later, createdAt: later }),
        request('legacy-new', { anchors, afterCommit: true, onPreview: true, createdAt: '2026-11-02T12:00:00.000Z' }),
      ],
    };
    const ids = (list) => list.map((r) => r.id);

    test('a preview’s comments are its own, older ones without previewAt by when they were made', () => {
      assert.deepEqual(ids(review.requests.filter((q) => onCurrentPreview(q, review))), ['this-preview', 'legacy-new']);
      assert.deepEqual(ids(review.requests.filter((q) => onVersion(q, review))), ['draft']);
      assert.deepEqual(ids(review.requests.filter((q) => onVersion(q, review, { preview: true }))), ['this-preview', 'legacy-new']);
    });

    test('an earlier preview’s comments count for nothing on this one', () => {
      assert.deepEqual(ids(currentRequests(review)), ['draft', 'this-preview', 'legacy-new']);
      assert.deepEqual(ids(previewComments(review)), ['this-preview', 'legacy-new']);
      const r = { ...review, requests: [...review.requests, request('old-but-late', { afterCommit: true, onPreview: true, previewAt: at, createdAt: '2026-11-02T13:00:00.000Z' })] };
      assert.equal(ids(commentsSincePreview(r)).includes('old-but-late'), false);
      assert.equal(acceptWarning({ preview: { at: later }, requests: [request('x', { afterCommit: true, onPreview: true, previewAt: at, createdAt: '2026-11-02T13:00:00.000Z' })] }), null);
    });

    test('on a preview, the draft’s and earlier previews’ unanswered comments are offered', () => {
      const r = { ...review, requests: [
        ...review.requests,
        request('replied', { anchors, onPreview: true, previewAt: at, replies: [{ who: 'ai', outcome: 'Noted' }] }),
        request('flagged', { anchors, noFurtherAction: { by: 'user', at } }),
        request('answered-by-finding', { anchors }),
        request('no-text', { onPreview: true, previewAt: at, anchors: [] }),
        { ...request('a-keep', { anchors }), kind: 'keep' },
      ] };
      const offered = earlierComments({ review: r, preview: true, draftLabel: () => 'Draft 3' });
      assert.deepEqual(offered.map((e) => [e.id, e.from]), [['draft', 'Draft 3'], ['old-preview', 'an earlier preview'], ['legacy-old', 'an earlier preview']]);
    });

    test('on a draft, the comments of the review that made it are offered', () => {
      const offered = earlierComments({ madeBy: review, draftLabel: (id) => `Draft for ${id}`, previewLabel: 'Draft 4 preview' });
      assert.deepEqual(offered.map((e) => [e.id, e.from]), [
        ['draft', 'Draft for d3'], ['old-preview', 'Draft 4 preview'], ['legacy-old', 'Draft 4 preview'], ['this-preview', 'Draft 4 preview'], ['legacy-new', 'Draft 4 preview'],
      ]);
      assert.deepEqual(earlierComments({ draftLabel: String }), []);
    });

    test('an earlier comment made again on this version stops showing', () => {
      const offered = earlierComments({ madeBy: review, draftLabel: String });
      const now = { requests: [request('again', { from: 'draft' })] };
      assert.equal(notCommentedAgain(offered, now).some((e) => e.id === 'draft'), false);
      assert.equal(notCommentedAgain(offered, null).length, offered.length);
    });
  });

  test('a prompt copied from a window names it, for the AI to take over', () => {
    assert.equal(promptNamingWindow('Do this.', 'w-7f3a'), 'Do this. Take over SmartDoc window w-7f3a with use_window first.');
  });
});
