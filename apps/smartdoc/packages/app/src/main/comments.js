// Whether anything more is needed on a comment: { by: 'ai' | 'user', at } once it's marked "No
// further action required", else null. The AI marks it when it replies (with an outcome in its own
// words, such as "Actioned" or "Noted"), and the user can mark or clear it. Comments saved before
// this were "resolved" by the app when the AI wrote a new preview: those read as marked by the AI.
export const noFurtherAction = (request) => ('noFurtherAction' in request ? request.noFurtherAction : request.resolved ? { by: 'ai', at: null } : null);
export const isDone = (request) => Boolean(noFurtherAction(request));

// The user's comments on selected text are a review's requests. One made while the AI is still
// reviewing gets a finding or a reply in response; one made once it has finished (afterCommit) is
// carried out with the user's decisions instead.
export const unansweredRequests = (review) => (review.requests ?? [])
  .filter((request) => !request.afterCommit && !isDone(request) && !request.replies?.length && !(review.items ?? []).some((item) => item.inResponseTo === request.id));

// A comment belongs to the version it was written on: the draft the review is of, or one draft
// preview (each the AI writes is a new one). Only a version's own comments count for it. A comment
// on a preview records which (previewAt); older ones without it were on the current preview if
// made since it was written.
export const onCurrentPreview = (request, review) => Boolean(request.onPreview && review.preview
  && (request.previewAt ? request.previewAt === review.preview.at : (request.createdAt ?? '') >= review.preview.at));
export const onEarlierPreview = (request, review) => Boolean(request.onPreview) && !onCurrentPreview(request, review);
// The requests on the version showing: the draft's, or (`preview`) the waiting preview's.
export const onVersion = (request, review, { preview = false } = {}) => (preview ? onCurrentPreview(request, review) : !request.onPreview);
// The requests on the review's current versions (its draft and its waiting preview): what counts.
export const currentRequests = (review) => (review?.requests ?? []).filter((request) => !onEarlierPreview(request, review));

// Not yet answered in any way: no reply, no finding in response, not marked no further action.
export const unanswered = (request, review) => !isDone(request) && !request.replies?.length
  && !(review.items ?? []).some((item) => item.inResponseTo === request.id);

// Comments from before the version showing that nobody has answered, for the window to show as
// earlier comments where their text is still in it (it finds the text; see margin-review.js).
// On a preview: the review's comments on its draft and on earlier previews. On a draft made from
// an accepted preview: every comment of the review that made it (`madeBy`). Each comes with where
// it was written (`from`). Comments about no text don't carry over.
export function earlierComments({ review, preview = false, madeBy = null, draftLabel, previewLabel = 'its preview' }) {
  const pick = (r, keep, from) => (r?.requests ?? [])
    .filter((q) => q.kind === 'comment' && q.anchors?.length && keep(q) && unanswered(q, r))
    .map((q) => ({ id: q.id, note: q.note, anchors: q.anchors, createdAt: q.createdAt, from: from(q) }));
  if (preview) return review ? pick(review, (q) => !onCurrentPreview(q, review), (q) => (q.onPreview ? 'an earlier preview' : draftLabel(review.draftId))) : [];
  return madeBy ? pick(madeBy, () => true, (q) => (q.onPreview ? previewLabel : draftLabel(madeBy.draftId))) : [];
}

// Earlier comments the user hasn't already made again on the version showing (Comment again
// records `from`).
export const notCommentedAgain = (earlier, review) => earlier.filter((e) => !(review?.requests ?? []).some((q) => q.from === e.id));

// Comments on the draft preview itself (onPreview), as opposed to on the draft: their anchors are
// in the preview's text. Those still needing something are what the AI changes the preview for.
export const previewComments = (review) => (review.requests ?? []).filter((request) => onCurrentPreview(request, review) && !isDone(request));

// Comments the waiting draft preview doesn't reflect, because it was written before them.
export const commentsSincePreview = (review) => (review.preview ? (review.requests ?? []).filter((request) => (
  request.afterCommit && !isDone(request) && request.createdAt >= review.preview.at && (!request.onPreview || onCurrentPreview(request, review))
)) : []);

// What to warn about before accepting a draft preview with comments it doesn't reflect; null if none.
export function acceptWarning(review) {
  const comments = commentsSincePreview(review);
  if (!comments.length) return null;
  const notes = comments.slice(0, 5).map((c) => `• ${c.note}`);
  if (comments.length > notes.length) notes.push(`and ${comments.length - notes.length} more`);
  return {
    message: comments.length === 1 ? 'Your AI hasn’t acted on 1 comment. Accept anyway?' : `Your AI hasn’t acted on ${comments.length} comments. Accept anyway?`,
    detail: `This draft preview was written before:\n${notes.join('\n')}\n\nAccepting makes it a draft as it is. Send your AI the prompt first if you want these carried out.`,
  };
}
