// An older draft can't be improved, whoever asks (any AI, through the MCP server): the drafts after
// it follow on from it. The AI is told to ask the user to fork it first, into a new variation or a
// new document, which it can do once they agree. Reading it, highlights reviews (which don't change
// the document) and answering comments are fine.

const IMPROVING = ['start_review', 'add_annotation', 'add_finding', 'remove_item', 'revise_finding', 'commit_review', 'apply_review'];
const label = (number) => (number === 0 ? 'Original' : `Draft ${number}`);

// Why the AI tool `name` can't run on the draft showing, or null if it can. `reviewType` is the
// open review's kind ('improve' or 'highlights'), if there is one.
export function olderDraftRefusal({ line, currentDraftId, variationName }, reviewType, name, args = {}) {
  if (!IMPROVING.includes(name)) return null;
  const type = name === 'start_review' ? args.type ?? 'improve' : reviewType;
  if (type !== 'improve') return null;
  const number = line.indexOf(currentDraftId);
  const newest = line.length - 1;
  if (number < 0 || number >= newest) return null;
  return `${label(number)} is an older draft: Draft ${newest} is the newest of ${variationName}. Older drafts can't be changed, as the drafts after them follow on from them, so nothing was changed (reading it is fine). To work on it, ask the user whether to fork it: a new variation from it (create_variation with draft ${number}) or a new document from it (create_document_from_draft). Once they agree, do that, and carry on there.`;
}
