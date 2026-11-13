// What a draft's improvement review, as the home screen gets it, is waiting for the user to do, in a
// word for its pill: accept or discard a draft preview, decide findings, or, with all decided, ask
// the AI to apply them. Null when it's waiting on nothing from them.
export function actionFor(r) {
  if (!r || r.waitingForAi || r.status !== 'committed') return null;
  if (r.preview) return 'Accept';
  if (r.applied || !r.findings) return null;
  return r.decided < r.findings ? 'Decide' : 'Apply';
}

// What a set of drafts (a variation's, or all of a document's) waits on the user for, in a word or
// two for a pill on home: a draft preview to accept, else what a review needs (Decide, Apply). Null
// when nothing.
export const PREVIEW = 'Draft preview';
export function todoOf(drafts = []) {
  let action = null;
  for (const d of drafts) {
    const r = d.reviews?.improve;
    if (r?.preview && !r.waitingForAi) return PREVIEW;
    const a = actionFor(r);
    if (a && a !== 'Accept') action ??= a;
  }
  return action;
}
// The most pressing of several (a document's variations, a folder's documents): a draft preview
// first, else the first other.
export const firstTodo = (todos) => (todos.includes(PREVIEW) ? PREVIEW : todos.find(Boolean) ?? null);
