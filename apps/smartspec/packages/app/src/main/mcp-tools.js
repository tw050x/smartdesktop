import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches.

const INSTRUCTIONS = `This server is SmartSpec: a desktop app holding the design of a system as schemas, for the user and for other agents to act on. It's about system design at any scale: a schema can describe a whole business, one service, or one module inside a single application.
A schema has a name, a summary and a contract, which are what show when it's collapsed inside another schema, so write them to stand on their own. The contract is its boundary: what it promises and what it needs.
A schema's design is a set of items, each of a kind: document (Markdown), flow (a diagram of nodes and connections), sequence (a diagram of participants and messages), table, or image. Use whichever explain it best, and as many as it needs. Diagrams are data, not a text language: the app lays them out and draws them. Give a description to anything in a diagram whose reason isn't obvious from its label, especially loops, alternatives and activations.
Items link to each other, so a schema is a connected graph. A link is an item's id, or item#part for a part inside it: a document's heading (as a slug), a flow's node or connection, a sequence's participant or message, or a table's row. In Markdown, write [text](item#part). Nodes, connections, participants, messages and rows can each have a link. Any item can list links too, which is the way to link from an image. A link can reach the contract, and the schemas this one embeds, but not inside them. Links that go nowhere are refused.
Schemas embed other schemas: a standard structure, such as machine to machine auth, is one schema, and shows as a single element in each schema that uses it. Each use is pinned to a draft and can only set the parameters the embedded schema declares. To change anything else, propose a new draft of that schema, or a separate schema.
Read only what you need: get_schema lists a schema's items and links without their content, with its uses collapsed. Fetch an item with get_schema_item when you need it, and open further levels by asking for them.
A focus is what the user wants this work to be for: their prompt may say "focusing on" a goal. Keep to it, and pass it to propose_schema as goal, with a short goal_title if you're given one or can name it, so the app can show it. If the user's prompt names a window, call use_window with it first, so that window becomes yours.
Only the user accepts what you propose: propose_schema creates a proposal, and it becomes a draft once they accept it in the app. Send only what changes: the rest carries over. Tell the user straight away to switch to SmartSpec and review it. Each reply gives a wait command, a shell command that ends when they have answered: run it in the background if you can, or call get_schema later to see where it stands. A schema you embed must have an accepted draft, so wait for the acceptance before building on it.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). Every tool works only with the app, on this computer.
const READ_ONLY = new Set(['list_schemas', 'get_schema', 'get_schema_item', 'get_proposal']);
const DESTRUCTIVE = new Set();
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false });

const DEPTH = z.number().int().min(0).max(10).optional();
const LINK = z.string().optional().describe('Where it links: an item id, or item#part');
const EXPLAIN = z.string().optional().describe('What this one does here and why, which the diagram can\'t show by itself. The user sees it on hover, beside the facts the app already works out: who it joins and what it wraps. Don\'t repeat those.');
const ITEM_BASE = {
  id: z.string().describe('Its id within this schema. Sending an id that exists replaces that item.'),
  title: z.string().trim().min(1),
  description: z.string().optional().describe('One line saying what it is, listed by get_schema'),
  links: z.array(z.object({ to: z.string(), label: z.string().optional() })).optional().describe('Links from the item as a whole'),
};
const ITEM = z.discriminatedUnion('kind', [
  z.object({ ...ITEM_BASE, kind: z.literal('document'), markdown: z.string() }),
  z.object({
    ...ITEM_BASE,
    kind: z.literal('flow'),
    direction: z.enum(['TB', 'LR']).optional().describe('Top to bottom (the default, and almost always best: the diagram shares the page with cards either side). Left to right only if it truly reads better.'),
    nodes: z.array(z.object({ id: z.string(), label: z.string(), description: EXPLAIN, link: LINK })),
    edges: z.array(z.object({ id: z.string().optional().describe('Needed if two connections join the same nodes. Default: from-to'), from: z.string(), to: z.string(), label: z.string().optional(), description: EXPLAIN, link: LINK })).optional(),
  }),
  z.object({
    ...ITEM_BASE,
    kind: z.literal('sequence'),
    participants: z.array(z.object({ id: z.string(), label: z.string(), description: EXPLAIN, link: LINK })),
    messages: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), label: z.string(), reply: z.boolean().optional().describe('Drawn dashed, as a reply'), description: EXPLAIN, link: LINK })).optional(),
    groups: z.array(z.object({
      id: z.string(),
      kind: z.enum(['loop', 'alt', 'opt', 'par', 'critical', 'break', 'group']).describe('loop: repeats. alt: one of several sections happens. opt: may not happen. par: sections happen at the same time. critical: must finish as a whole. break: stops the rest. group: just a named set of steps.'),
      label: z.string().optional().describe('The condition or name, such as "up to five times"'),
      from: z.string().describe('The first message inside it'),
      to: z.string().describe('The last message inside it'),
      sections: z.array(z.object({ at: z.string().describe('The message that starts this section'), label: z.string().optional() })).optional().describe('For alt and par: where each further section starts'),
      description: EXPLAIN,
      link: LINK,
    })).optional().describe('Boxes wrapped around messages. They can nest.'),
    activations: z.array(z.object({ id: z.string(), participant: z.string(), from: z.string(), to: z.string(), description: EXPLAIN, link: LINK })).optional().describe('Bars on a lifeline: this participant is busy from one message to another'),
    boxes: z.array(z.object({ id: z.string(), label: z.string().optional(), participants: z.array(z.string()).describe('Next to each other in participants'), description: EXPLAIN, link: LINK })).optional().describe('Boxes around participants that belong together, such as those in one service'),
  }),
  z.object({
    ...ITEM_BASE,
    kind: z.literal('table'),
    columns: z.array(z.object({ id: z.string(), label: z.string() })),
    rows: z.array(z.object({ id: z.string(), cells: z.record(z.string(), z.string()).describe('Column id to value. Values can hold Markdown links.'), link: LINK })).optional(),
  }),
  z.object({
    ...ITEM_BASE,
    kind: z.literal('image'),
    mediaType: z.string().describe('image/svg+xml, image/png, image/jpeg or image/webp'),
    data: z.string().describe('The image as base64, up to 5 MB'),
    alt: z.string().optional().describe('What it shows'),
  }),
]);

// `call(name, args, run)` runs a tool for the session making the request, in its window, giving
// `run` the schemas as that session may use them (see main.js).
export function buildServer(call, { version }) {
  const server = new McpServer({ name: 'smartspec', version }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema, annotations: annotations(name) }, async (args) => {
    try {
      return json(await call(name, args ?? {}, (schemas) => run(args ?? {}, schemas)));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  tool('use_window', 'Takes over a SmartSpec window, when the user\'s prompt names one: this session then works in it. Call it first, before any other tool, or SmartSpec opens a new window for this session.', {
    window_id: z.string().describe('The window named in the prompt, such as w-7f3a'),
  }, ({ window_id }, schemas) => schemas.useWindow(window_id));

  tool('list_schemas', 'Every schema, most recently changed first: its id, name, summary, number of accepted drafts, status, and any proposal waiting for the user.', {}, (_args, schemas) => schemas.list());

  tool('get_schema', 'One schema\'s accepted draft: its name, summary, contract and parameters; its items listed with their id, kind, title and description but not their content; every link between them; and the schemas it embeds, each collapsed to its name, summary, contract and pinned draft, saying if a newer draft exists. Fetch an item with get_schema_item. Open further levels with depth, or by calling this for an embedded schema\'s id and draft. proposal says if a change is waiting for the user.', {
    schema_id: z.string(),
    draft_id: z.string().optional().describe('The draft to read (default: the latest)'),
    depth: DEPTH.describe('How many levels of embedded schemas to open (default 0: all collapsed)'),
  }, ({ schema_id, draft_id, depth }, schemas) => schemas.getSchema(schema_id, { draftId: draft_id, depth }));

  tool('get_schema_item', 'One item\'s full content, with the links out of it and into it.', {
    schema_id: z.string(),
    item_id: z.string(),
    draft_id: z.string().optional().describe('The draft to read (default: the latest)'),
    proposal: z.boolean().optional().describe('Read it from the proposal waiting on the schema instead'),
  }, ({ schema_id, item_id, draft_id, proposal }, schemas) => schemas.getItem(schema_id, item_id, { draftId: draft_id, proposal }));

  tool('get_proposal', 'The change waiting for the user on a schema, in the same form as get_schema, with which items it adds, changes and removes. Fetch an item from it with get_schema_item and proposal. Null if nothing is waiting.', {
    schema_id: z.string(),
    depth: DEPTH.describe('How many levels of embedded schemas to open (default 0: all collapsed)'),
  }, ({ schema_id, depth }, schemas) => schemas.getProposal(schema_id, { depth }));

  tool('propose_schema', 'Proposes a new schema, or with schema_id a change to one, and shows it in the app for the user to accept or discard. For a change, send only what changes: everything else carries over, from the proposal already waiting (which this replaces) or else the latest draft. Links are checked, and the proposal is refused if one goes nowhere.', {
    schema_id: z.string().optional().describe('The schema to change (leave out to propose a new one)'),
    name: z.string().trim().min(1).max(200).optional().describe('Needed for a new schema'),
    summary: z.string().trim().min(1).optional().describe('What this is, in a sentence or two. Shows when it\'s collapsed. Needed for a new schema.'),
    contract: z.string().optional().describe('Markdown: what it promises and what it needs. Shows when it\'s collapsed.'),
    items: z.array(ITEM).optional().describe('Items to add, or to replace by id'),
    remove_items: z.array(z.string()).optional().describe('The ids of items to remove'),
    item_order: z.array(z.string()).optional().describe('Item ids in the order to show them. Any left out follow.'),
    parameters: z.array(z.object({
      name: z.string().trim().min(1),
      description: z.string().optional(),
    })).optional().describe('What each use of this schema can set. Replaces the list.'),
    uses: z.array(z.object({
      id: z.string().describe('Its name within this schema, which links use'),
      schema_id: z.string().describe('The schema to embed, which must have an accepted draft'),
      draft_id: z.string().optional().describe('The draft to pin to (default: its latest)'),
      with: z.record(z.string(), z.string()).optional().describe('Values for the parameters it declares'),
    })).optional().describe('The schemas this one embeds. Replaces the list.'),
    goal: z.string().trim().min(1).optional().describe('The focus the user gave you for this work, in their words'),
    goal_title: z.string().trim().min(1).max(60).optional().describe('A short name for that focus'),
    note: z.string().trim().min(1).describe('What this proposes and why, for the user reviewing it, in a plain sentence or two. The app already says it is a proposal, so no label such as "Proposed change:"'),
  }, ({ schema_id, uses, remove_items, item_order, goal_title, ...proposal }, schemas) => schemas.propose({
    ...proposal,
    goalTitle: goal_title,
    schemaId: schema_id,
    removeItems: remove_items,
    itemOrder: item_order,
    uses: uses?.map(({ schema_id: target, draft_id, ...use }) => ({ ...use, schemaId: target, draftId: draft_id })),
  }));

  return server;
}
