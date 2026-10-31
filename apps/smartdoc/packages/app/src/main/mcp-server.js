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

const INSTRUCTIONS = `This server is SmartDoc: a desktop app showing the user's document (a PDF). You review it with the user in rounds:
0. Open: get_document reads the document open in the app. If none is open, or the user means a different one, open it with open_document: by document_id from list_documents (documents the user has opened before), by path (a PDF on the user's computer, which the user confirms in the app), or with neither so the user picks the file in the app. When open_document reports waiting_for_user, tell the user straight away to switch to the SmartDoc app and answer there, then call get_document, which waits for them.
1. Review: read the document with get_document and the current review with get_review (it may already hold the user's requests: text they marked to rewrite, comment on, keep, remove, add to, or ask about). Read get_history too: what earlier reviews of this document raised and what the user decided. Don't raise again anything the user rejected or chose to keep, unless that text has changed since or you have a new reason (say so in the finding), and don't ask questions they've already answered: use their answers. Changes they accepted that are still not in the document can be raised again. If the user asks for a fresh review, ignore the history. Decorate text with add_annotation and add findings with add_finding. Every finding offers the user a decision: a proposed change, a choice of options, a question, a structural move, a design change, or a flag to acknowledge. Respond to each user request with a finding that has in_response_to set. Finish with commit_review; the user then decides in the app.
2. Decide: the user works through the findings, and may write changes of their own. Read their choices with get_decisions.
3. Apply: carry out what was accepted and the user's own changes (and use the user's answers and comments) by writing the complete updated document as HTML and calling apply_review. The app draws it to PDF as the next draft. Never apply anything the user rejected, and leave text marked "keep" unchanged.
Text is referenced by quoting it exactly from get_document (whitespace-insensitive), with the page number.`;

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

  tool('open_document', 'Opens a document in the app. With document_id: one from list_documents, opened straight away. With path: a PDF on the user\'s computer, which the user must confirm in the app first. With neither: the app asks the user to pick a file. The last two return waiting_for_user: tell the user to switch to the SmartDoc app and answer, then call get_document, which waits for them.', {
    document_id: z.string().optional(),
    path: z.string().optional().describe('Absolute path to a PDF (~ is allowed)'),
  }, (a) => documents.open(a));

  tool('get_document', 'The open document: its name, which draft is showing, and the text of each page (quote from this when referencing text). If the user is still answering an open_document request, this waits for them first.', {}, async () => {
    await documents.settle();
    return workspace.getDocument();
  });

  tool('get_review', 'The current draft\'s review: status (open or committed), the user\'s requests, findings with their decisions, annotations and history. Null if there is none yet.', {}, () => workspace.getReview());

  tool('get_history', 'Earlier reviews of this document, across all its drafts, oldest first: each finding with what the user decided (status, chosen option, answer, edit, comment), their requests and their own changes, and what became of each review (applied as which draft, decided but not applied, or never committed). Leaves out the current review.', {}, () => workspace.getHistory());

  tool('start_review', 'Starts a new review on the current draft (returns the existing one if it is still open).', {}, () => workspace.startReview('ai'));

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

  tool('commit_review', 'Commits the review: no more findings can be added, and the user can now make their decisions in the app.', {
    summary: z.string().optional().describe('A short overview shown at the top of the report'),
  }, ({ summary }) => workspace.commitReview(summary).then((r) => ({ committed: r.id, findings: r.items.length })));

  tool('get_decisions', 'The user\'s decisions on the current review: each finding\'s status (pending, accepted, rejected, answered, acknowledged), chosen option, answers, edited wording and comments, plus their requests and the changes they wrote themselves (changes: carry these out too).', {}, () => workspace.getDecisions());

  tool('apply_review', 'Applies the committed review: supply the complete updated document as self-contained HTML (inline CSS, no scripts or external resources). Keep the current draft\'s look, and lay the content out in reading order without absolute positioning, so the PDF\'s text reads in the right order. It becomes the next draft. If the current draft isn\'t the newest, later drafts are set aside.', {
    html: z.string().min(1),
    summary: z.string().optional().describe('What changed, shown with the draft'),
    applied_item_ids: z.array(z.string()).optional().describe('The findings this draft carries out'),
  }, ({ html, summary, applied_item_ids }) => workspace.applyReview({ html, summary, appliedItemIds: applied_item_ids }));

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

// The AI apps that have connected, one entry per app (its name from the MCP handshake) with when
// it last connected. Kept with the app's data so it outlasts a restart. The server is stateless,
// so there's no telling when an app disconnects: only when it last connected.
const CLIENT_LABELS = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude Desktop', 'codex-mcp-client': 'Codex', 'cursor-vscode': 'Cursor' };
async function clientLog(userData, onChange) {
  const file = path.join(userData, 'mcp-clients.json');
  let clients = {};
  try {
    clients = JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  return {
    list: () => Object.values(clients).sort((a, b) => b.connectedAt.localeCompare(a.connectedAt)),
    async connected(info) {
      const name = typeof info?.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 100) : 'unknown';
      clients[name] = {
        name,
        label: CLIENT_LABELS[name] ?? (typeof info?.title === 'string' && info.title.trim() ? info.title.trim().slice(0, 100) : name),
        version: typeof info?.version === 'string' ? info.version.slice(0, 50) : null,
        connectedAt: new Date().toISOString(),
      };
      await writeFile(file, JSON.stringify(clients, null, 2)).catch(() => {});
      onChange?.();
    },
  };
}

// Streamable HTTP on 127.0.0.1 only, stateless (a fresh server per request), JSON responses.
// Requests carrying an Origin header come from a web page and are refused, as are requests
// without the token. `documents` lists and opens documents for the AI (it needs the window);
// `onClients` is called whenever an AI app connects.
export async function startMcpServer(workspace, userData, { documents, onClients } = {}) {
  const token = await mcpToken(userData);
  const clients = await clientLog(userData, onClients);
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
    for (const message of [body].flat()) {
      if (message?.method === 'initialize') clients.connected(message.params?.clientInfo);
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
  return { url: `http://127.0.0.1:${MCP_PORT}/mcp`, token, clients: clients.list, close: () => http.close() };
}
