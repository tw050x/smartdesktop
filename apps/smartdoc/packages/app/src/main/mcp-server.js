import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// Fixed, so AI apps always know where to find it. Development and tests can move it (ignored in
// packaged builds), so a test copy of the app can run beside the real one.
export const MCP_PORT = (!app.isPackaged && Number(process.env.SMARTDOC_PORT)) || 47815;

const INSTRUCTIONS = `This server is SmartDoc: a desktop app showing the user's document (a PDF). You review it with the user, in one of two kinds of review, and the app shows the current review beside the document. The app has a tool for each kind: "Review and draft" (improve) and "Review and highlight" (highlights). Only the active tool's review shows, and get_review returns it; start_review switches to its kind's tool, and switch_tool switches without starting one (for example to show the user an earlier review of the other kind). A draft can have several highlights reviews, one per goal, called focuses (e.g. "Recruiter skim", "The career gap"): list_focuses shows them, with earlier drafts' goals not yet run on this draft, and switch_focus shows one. A new draft starts with none. An improvement review can have a focus too: a goal, and a short name for it (title); the user may send one from the app ("…suggest improvements, focusing on: …"). Without one it's a general review.
Open: get_document_info and get_document read the document open in the app. If none is open, or the user means a different one (the user may name it with its document id), open it with open_document: by document_id from list_documents (documents the user has opened before), by path (a PDF on the user's computer, which the user confirms in the app), or with neither so the user picks the file in the app. When open_document reports waiting_for_user, tell the user straight away to switch to the SmartDoc app and answer there, then call get_document_info, which waits for them.
Read: start with get_document_info to see the document's size and outline. A small document can be read whole with get_document. A large one is read a range of pages at a time (get_document with pages), using the outline, each page's first line and find_text to go to what matters; for a highlights review, read what the goal needs rather than everything.
Settle the goal first: read the document, get_review and get_history, then decide with the user what the review is for before calling start_review. Either they want the document improved (type "improve"), or they want to understand it: the key information in it for their purpose (type "highlights"). If it isn't clear which, or what they're after, ask. Pass the agreed goal to start_review in their terms.
An improvement review, in rounds:
1. Review: the current review may already hold the user's requests: text they marked to rewrite, comment on, keep, remove, add to, or ask about. The history shows what earlier reviews raised and what the user decided. Don't raise again anything the user rejected or chose to keep, unless that text has changed since or you have a new reason (say so in the finding), and don't ask questions they've already answered: use their answers. Changes they accepted that are still not in the document can be raised again. If the user asks for a fresh review, ignore the history. Decorate text with add_annotation and add findings with add_finding. Every finding offers the user a decision: a proposed change, a choice of options, a question, a structural move, a design change, or a flag to acknowledge. Respond to each user request with a finding that has in_response_to set. Finish with commit_review; the user then decides in the app.
2. Decide: the user works through the findings, and may write changes of their own. Read their choices with get_decisions.
3. Apply: carry out what was accepted and the user's own changes (and use the user's answers and comments) by writing the complete updated document as HTML and calling apply_review. The app draws it to PDF as the next draft. Never apply anything the user rejected, and leave text marked "keep" unchanged.
A highlights review: you decide what's key, for the user's goal. Before starting, having read the document, ask the user what they're looking for and anything about the document that changes what matters (for example which party they are in a contract, or what decision they're making); keep it to the few questions that count. Check list_focuses first: if a focus already has this goal, carry it on or switch to it rather than starting a near-duplicate; if the user wants an earlier draft's focus run again, reuse its goal and name. Start the review with the goal, a short name for it as a focus (title, a few words in the user's terms), and what you learned (context). Then add_highlight for each piece of key information: quote its text, put it in a category you choose for this document (a handful, named in the user's terms, such as "Payment", "Deadlines", "Your obligations", "Risks"), say in the note why it matters for their goal, and rate its importance. Also add what the user would expect but the document doesn't say, as a highlight without quotes. Be selective: what matters for the goal, not a summary of everything. Finish with commit_review, with a summary that answers their goal in a few sentences. The user can mark each highlight useful or not and comment; get_review shows that feedback, and get_history shows it for earlier reviews, so a later review can build on it. Nothing is decided or applied, and the document doesn't change.
Text is referenced by quoting it exactly from get_document or find_text (whitespace-insensitive), with the page number.`;

const quote = z.object({
  page: z.number().int().min(1).describe('Page number, from 1'),
  quote: z.string().min(1).describe('Exact text from that page (whitespace-insensitive)'),
  occurrence: z.number().int().min(1).optional().describe('Which match, if the text appears more than once (default 1)'),
});
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function buildServer(workspace, documents) {
  const server = new McpServer({ name: 'smartdoc', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return json(await run(args ?? {}));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  tool('list_documents', 'Documents the user has opened in the app before, newest first, with the one that is open now marked. Open one with open_document and its id.', {}, () => documents.list());

  tool('open_document', 'Opens a document in the app. With document_id: one from list_documents, opened straight away. With path: a PDF on the user\'s computer, which the user must confirm in the app first. With neither: the app asks the user to pick a file. The last two return waiting_for_user: tell the user to switch to the SmartDoc app and answer, then call get_document_info, which waits for them.', {
    document_id: z.string().optional(),
    path: z.string().optional().describe('Absolute path to a PDF (~ is allowed)'),
  }, (a) => documents.open(a));

  tool('get_document_info', 'The open document\'s size and shape, to plan how to read it: page count; word, character, line and (estimated) paragraph counts; estimated tokens and whether it can be read whole; the PDF\'s own details (title, author, dates); its outline (bookmarks) with page numbers; and the same counts for each page, with its first line. If the user is still answering an open_document request, this waits for them first.', {}, async () => {
    await documents.settle();
    return workspace.getDocumentInfo();
  });

  tool('get_document', 'The text of the open document (its id, name and which draft is showing), whole or the pages asked for. Quote from this when referencing text. A document too large to read at once must be read a range of pages at a time. If the user is still answering an open_document request, this waits for them first.', {
    pages: z.string().optional().describe('Pages to read, e.g. "3", "5-9" or "1-3, 12". Leave out to read the whole document.'),
  }, async (a) => {
    await documents.settle();
    return workspace.getDocument(a);
  });

  tool('find_text', 'Finds a word or phrase in the open document (case and spacing ignored): each match with its page, the exact text matched (quotable as it is) and the text around it.', {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional().describe('Most matches to return (default and maximum 50)'),
  }, (a) => workspace.findText(a));

  tool('list_focuses', 'The highlight tool\'s focuses on the current draft (one highlights review per goal), newest first, with the one showing marked; and the goals of earlier drafts\' focuses not yet run on this draft.', {}, () => workspace.listFocuses('highlights'));

  tool('switch_focus', 'Shows one of the current draft\'s highlights reviews (a focus from list_focuses), switching the app to the highlight tool.', {
    review_id: z.string(),
  }, ({ review_id }) => workspace.setFocus(review_id));

  tool('switch_tool', 'Switches the app to one of its two tools, showing the current draft\'s newest review of that kind (or none): "improve" (Review and draft) or "highlights" (Review and highlight). start_review switches by itself.', {
    tool: z.enum(['improve', 'highlights']),
  }, ({ tool: next }) => workspace.setTool(next));

  tool('get_review', 'The current draft\'s review in the active tool: its type (improve or highlights), goal and status (open or committed), then for an improvement review the user\'s requests, findings with their decisions and annotations, or for a highlights review the highlights with the user\'s feedback. Null if there is none yet.', {}, () => workspace.getReview());

  tool('get_history', 'Earlier reviews of this document, across all its drafts, oldest first, of both types: for highlights reviews, the goal and each highlight with the user\'s feedback; for improvement reviews, each finding with what the user decided (status, chosen option, answer, edit, comment), their requests and their own changes, and what became of each review (applied as which draft, decided but not applied, or never committed). Leaves out the current review.', {}, () => workspace.getHistory());

  tool('start_review', 'Starts a review of the current draft, once you and the user have agreed what it\'s for. type "improve" suggests changes for the user to decide on; "highlights" picks out the key information for the user\'s goal (goal required). An open review of the same type carries on (taking any new goal); one of the other type is left unfinished.', {
    type: z.enum(['improve', 'highlights']),
    goal: z.string().optional().describe('What the user wants from the review, in their terms. Required for highlights, where a new goal starts a new focus.'),
    title: z.string().optional().describe('The focus\'s short name, a few words (e.g. "Recruiter skim"); give one whenever there\'s a goal'),
    context: z.string().optional().describe('What you learned about the document from the user, e.g. which party they are (highlights)'),
  }, (a) => workspace.startReview('ai', a));

  tool('add_annotation', 'Decorates text in the document (shown on the page; hovering it in the report highlights it).', {
    quotes: z.array(quote).min(1),
    style: z.enum(['highlight', 'underline', 'strike']).optional(),
    note: z.string().optional(),
  }, (a) => workspace.addAnnotation(a));

  tool('add_finding', 'Adds a finding to the open review. Each finding gives the user a decision. kind: change (proposal.before/after), options (2+ options), question (question), move or design (proposal.description), flag (no action, just to acknowledge).', {
    kind: z.enum(['change', 'options', 'question', 'move', 'design', 'flag']),
    title: z.string().min(1),
    body: z.string().optional().describe('Why it matters'),
    severity: z.enum(['high', 'medium', 'low']).optional(),
    quotes: z.array(quote).optional().describe('The text this finding is about'),
    in_response_to: z.string().optional().describe('The id of the user request this answers'),
    proposal: z.object({ before: z.string().optional(), after: z.string().optional(), description: z.string().optional() }).optional(),
    options: z.array(z.object({ label: z.string(), text: z.string() })).min(2).optional(),
    question: z.string().optional(),
  }, (f) => workspace.addFinding(f));

  tool('remove_finding', 'Removes a finding from the open review.', { id: z.string() }, ({ id }) => workspace.removeFinding(id).then(() => ({ removed: id })));

  tool('add_highlight', 'Adds a piece of key information to the open highlights review. Quote the text it\'s in; leave quotes out for something the user would expect that the document doesn\'t have.', {
    category: z.string().min(1).describe('A category you choose for this document, in the user\'s terms; reuse the same few'),
    title: z.string().min(1).describe('The key information in a few words, e.g. "Payment due 30 days after invoice"'),
    note: z.string().optional().describe('Why it matters for the user\'s goal'),
    importance: z.enum(['high', 'medium', 'low']).optional(),
    quotes: z.array(quote).optional().describe('The text it\'s in'),
  }, (h) => workspace.addHighlight(h));

  tool('remove_highlight', 'Removes a highlight from the open highlights review.', { id: z.string() }, ({ id }) => workspace.removeHighlight(id).then(() => ({ removed: id })));

  tool('commit_review', 'Finishes the review: nothing more can be added. For an improvement review the user can now make their decisions in the app; for a highlights review, the summary should answer their goal.', {
    summary: z.string().optional().describe('A short overview shown at the top of the review'),
  }, ({ summary }) => workspace.commitReview(summary).then((r) => ({ committed: r.id, ...(r.type === 'highlights' ? { highlights: r.highlights.length } : { findings: r.items.length }) })));

  tool('get_decisions', 'The user\'s decisions on the current review: each finding\'s status (pending, accepted, rejected, answered, acknowledged), chosen option, answers, edited wording and comments, plus their requests and the changes they wrote themselves (changes: carry these out too).', {}, () => workspace.getDecisions());

  tool('apply_review', 'Applies the committed review: supply the complete updated document as self-contained HTML (inline CSS, no scripts or external resources). Keep the current draft\'s look, and lay the content out in reading order without absolute positioning, so the PDF\'s text reads in the right order. It becomes the next draft. If the current draft isn\'t the newest, later drafts are set aside.', {
    html: z.string().min(1),
    summary: z.string().optional().describe('What changed, shown with the draft'),
    applied_item_ids: z.array(z.string()).optional().describe('The findings this draft carries out'),
  }, ({ html, summary, applied_item_ids }) => workspace.applyReview({ html, summary, appliedItemIds: applied_item_ids }));

  // Ready-made requests the user can start a conversation with (Claude Code lists them as slash
  // commands): the kind of review, and optionally the file to open and what they're after.
  const prompt = (name, title, description, text) => server.registerPrompt(name, {
    title,
    description,
    argsSchema: {
      file: z.string().optional().describe('Path to the PDF to open (leave out to use the open document)'),
      goal: z.string().optional().describe('What you want from the review'),
    },
  }, ({ file, goal }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: text({ file: file?.trim(), goal: goal?.trim() }) } }],
  }));

  prompt('improve', 'Improve a document', 'Review a document in SmartDoc and suggest changes for you to decide on.', ({ file, goal }) => [
    `Review ${file ? `the PDF at ${file}` : 'my document'} in SmartDoc and suggest improvements.`,
    goal && `What I want: ${goal}.`,
    file && 'Open it with open_document first.',
    'Agree the goal with me before you start the review.',
  ].filter(Boolean).join(' '));

  prompt('highlights', 'Find the key information', 'Have the AI pick out the key information in a document for what you need.', ({ file, goal }) => [
    `Go through ${file ? `the PDF at ${file}` : 'my document'} in SmartDoc and highlight the key information for me.`,
    goal && `What I'm looking for: ${goal}.`,
    file && 'Open it with open_document first.',
    'Read it, then ask me what you need to know before you start the highlights review.',
  ].filter(Boolean).join(' '));

  return server;
}

// The token clients send as "Authorization: Bearer <token>". Created once and kept with the app's
// data, so a configured client keeps working.
export async function mcpToken(userData) {
  const file = path.join(userData, 'mcp-token');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const token = randomBytes(24).toString('hex');
    await writeFile(file, token, { mode: 0o600 });
    return token;
  }
}

// Streamable HTTP on 127.0.0.1 only, stateless (a fresh server per request), JSON responses.
// Requests carrying an Origin header come from a web page and are refused, as are requests
// without the token. `documents` lists and opens documents for the AI (it needs the window).
export async function startMcpServer(workspace, userData, { documents } = {}) {
  const token = await mcpToken(userData);
  const http = createServer(async (req, res) => {
    const deny = (code, message) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
    if (req.headers.origin) return deny(403, 'Browser requests are not allowed.');
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, 'Missing or wrong token.');
    if (!req.url?.startsWith('/mcp')) return deny(404, 'Not found.');
    if (req.method !== 'POST') return deny(405, 'Only POST is supported.');

    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return deny(400, 'Invalid JSON.');
    }
    const server = buildServer(workspace, documents);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(MCP_PORT, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${MCP_PORT}/mcp`, token, close: () => http.close() };
}
