// What an AI is doing, from the SmartDoc tool it calls, as the user would say it: each step the
// chat shows (main/agent.js), and the website demo's (its director). No Node here, so the demo can
// use it too.

export function describeStep(name, input = {}) {
  const tool = name.replace(/^mcp__smartdoc__/, '');
  const quoted = (text) => `“${String(text).length > 60 ? `${String(text).slice(0, 57)}…` : text}”`;
  switch (tool) {
    case 'get_document_info': return 'Looking over the document';
    case 'get_document': return input.pages ? `Reading pages ${input.pages}` : 'Reading the document';
    case 'find_text': return input.text ? `Looking for ${quoted(input.text)}` : 'Searching the document';
    case 'get_review': return 'Reading the review';
    case 'get_history': return 'Looking at earlier reviews';
    case 'list_focuses': return 'Checking the focuses';
    case 'start_review': return 'Starting a review';
    case 'add_finding': return input.title ? `Raising ${quoted(input.title)}` : 'Raising a finding';
    case 'add_highlight': return input.title ? `Picking out ${quoted(input.title)}` : 'Picking out key information';
    case 'add_annotation': return 'Marking the text';
    case 'remove_item': return 'Taking out a finding';
    case 'commit_review': return 'Finishing the review';
    case 'revise_finding': return 'Improving this finding';
    case 'reply_to_comment': return 'Answering your comment';
    case 'get_draft_preview': return 'Reading the draft preview';
    case 'apply_review': return 'Writing the next draft';
    case 'switch_draft': return 'Switching draft';
    case 'open_document': return 'Opening a document';
    case 'use_window': return 'Joining this window';
    default: return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}
