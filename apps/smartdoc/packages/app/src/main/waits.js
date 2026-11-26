import { EventEmitter } from 'node:events';

// What an AI waits for on a review, with `smartdoc wait`: the user sending their decisions, or
// answering a draft preview. The answer is kept on the review, so one given before the wait began,
// or while nothing was waiting, is still found.

// A wait that can't end, so it's refused rather than left hanging. `status` is the HTTP status the
// server answers with.
export class WaitRefused extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

// What's happened on a review for this wait, or null if it's still to come.
export function reviewOutcome(what, review) {
  if ((review.type ?? 'improve') !== 'improve') throw new WaitRefused(`Review ${review.id} is a highlights review: the user has nothing to decide on it.`);
  if (what === 'decisions') {
    if (review.status !== 'committed') throw new WaitRefused(`Review ${review.id} isn't committed, so the user can't decide on it yet. Call commit_review first.`);
    if (review.decisionsSentAt) return { event: 'decisions-sent', at: review.decisionsSentAt };
    if (review.applications?.length) throw new WaitRefused(`Review ${review.id} has already become a draft, so there's nothing more to decide on it.`);
    return null;
  }
  if (what === 'preview') {
    if (review.previewResult) return { event: `preview-${review.previewResult.outcome}`, ...review.previewResult };
    if (!review.preview) throw new WaitRefused(`Review ${review.id} has no draft preview to wait for. Call apply_review first.`);
    return review.previewCommentsSentAt ? { event: 'preview-comments', at: review.previewCommentsSentAt } : null;
  }
  throw new WaitRefused(`Can't wait for "${what}" on a review.`, 400);
}

// `events` tells of saved reviews and documents, and drafts deleted. `onChange` is called when what
// is being waited for changes, so the app can offer to send it.
export function createWaits({ store, events = new EventEmitter(), onChange = () => {} }) {
  const active = new Set();

  async function outcome(what, reviewId) {
    const found = await store.findReview(reviewId);
    if (!found) throw new WaitRefused(`There's no review ${reviewId}: it may have been deleted with its draft.`, 404);
    const result = reviewOutcome(what, found.review);
    return result && { review: reviewId, document: found.docId, ...result };
  }

  return {
    // { promise, cancel }: the promise gives what happened (null if cancelled), or fails if the wait
    // can't end.
    forReview(what, reviewId) {
      const entry = { what, reviewId };
      let finish;
      let cancel;
      const promise = new Promise((resolve, reject) => {
        const look = () => outcome(what, reviewId).then((result) => result && finish(resolve, result), (error) => finish(reject, error));
        finish = (settle, value) => {
          if (!active.delete(entry)) return;
          for (const name of ['review', 'document', 'recent']) events.off(name, look);
          onChange();
          settle(value);
        };
        cancel = () => finish(resolve, null);
        active.add(entry);
        for (const name of ['review', 'document', 'recent']) events.on(name, look);
        onChange();
        look();
      });
      return { promise, cancel };
    },
    active: () => [...active],
  };
}
