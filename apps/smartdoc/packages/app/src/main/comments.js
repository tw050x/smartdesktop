// The user's comments on selected text are a review's requests. One made while the AI is still
// reviewing gets a finding in response; one made once it has finished (afterCommit) is carried out
// with the user's decisions instead.
export const unansweredRequests = (review) => (review.requests ?? [])
  .filter((request) => !request.afterCommit && !(review.items ?? []).some((item) => item.inResponseTo === request.id));

// Comments on the draft preview itself (onPreview), as opposed to on the draft: their anchors are
// in the preview's text. Writing a new preview resolves them.
export const previewComments = (review) => (review.requests ?? []).filter((request) => request.onPreview && !request.resolved);

// Comments the waiting draft preview doesn't reflect, because it was written before them.
export const commentsSincePreview = (review) => (review.preview ? (review.requests ?? []).filter((request) => (
  request.afterCommit && !request.resolved && request.createdAt >= review.preview.at
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
