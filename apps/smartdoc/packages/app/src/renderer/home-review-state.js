// What a draft's improvement review, as the home screen gets it, is waiting for the user to do, in a
// word for its pill: accept or discard a draft preview, decide findings, or, with all decided, ask
// the AI to apply them. Null when it's waiting on nothing from them.
export function actionFor(r) {
  if (!r || r.waitingForAi || r.status !== 'committed') return null;
  if (r.preview) return 'Accept';
  if (r.applied || !r.findings) return null;
  return r.decided < r.findings ? 'Decide' : 'Apply';
}
