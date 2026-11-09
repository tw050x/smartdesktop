import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches.

const INSTRUCTIONS = `This server is SmartSpec: a desktop app holding the design of a system as schematics, for the user and for other agents to act on. It's about system design at any scale: a schematic can describe a whole business, one service, or one module inside a single application.
A schematic has a name, a summary and a contract, which are what show when it's collapsed inside another schematic, so write them to stand on their own. The contract is its boundary: what it promises and what it needs.
A schematic's design is a set of items, each of a kind: document (Markdown), flow (a diagram of nodes and connections), sequence (a diagram of participants and messages), table, or image. Use whichever explain it best, and as many as it needs. Diagrams are data, not a text language: the app lays them out and draws them. Give a description to anything in a diagram whose reason isn't obvious from its label, especially loops, alternatives and activations.
Items link to each other, so a schematic is a connected graph. A link is an item's id, or item#part for a part inside it: a document's heading (as a slug), a flow's node or connection, a sequence's participant or message, or a table's row. In Markdown, write [text](item#part). Nodes, connections, participants, messages and rows can each have a link. Any item can list links too, which is the way to link from an image. A link can reach the contract, and the schematics this one embeds, but not inside them. Links that go nowhere are refused.
Schematics embed other schematics: a standard structure, such as machine to machine auth, is one schematic, and shows as a single element in each schematic that uses it. Each use is pinned to a draft and can only set the parameters the embedded schematic declares. To change anything else, propose a new draft of that schematic, or a separate schematic.
Read only what you need: get_schematic lists a schematic's items and links without their content, with its uses collapsed. Fetch an item with get_schematic_item when you need it, and open further levels by asking for them.
A focus is what the user wants this work to be for: their prompt may say "focusing on" a goal. Keep to it, and pass it to propose_schematic as goal, with a short goal_title if you're given one or can name it, so the app can show it. If the user's prompt names a window, call use_window with it first, so that window becomes yours.
Only the user accepts what you propose: propose_schematic creates a proposal, and it becomes a draft once they accept it in the app. Send only what changes: the rest carries over. Tell the user straight away to switch to SmartSpec and review it. Each reply gives a wait command, a shell command that ends when they have answered: run it in the background if you can, or call get_schematic later to see where it stands. It also ends when the user sends you their comments on the proposal to deal with before they accept (outcome comments): read them with get_comments (proposal: true), answer each with reply_to_comment, propose again if they need changes, then wait again. A schematic you embed must have an accepted draft, so wait for the acceptance before building on it.
Schematics belong to domains: a domain is a set of schematics owned by one team or one department, such as "Auth". A schematic in none is in No domain. Domains are organised in folders, which nest, so they can follow the organisation (a department's folder holding its teams'). list_domains and list_folders show them. create_domain, rename_domain, move_schematic, create_folder, rename_folder and move_domain take effect straight away, so only use them when the user asks. A new schematic can go straight into a domain with propose_schematic's domain_id.
The user comments on what you propose, and on drafts: get_schematic and get_proposal say how many are open, and get_comments reads them, each on the whole schematic (schematic: true), an item, a part of it, a point in it or words they quoted. Answer each one with reply_to_comment: say what you changed or why you didn't, and give its outcome, how you dealt with it in a word or two of your own ("Actioned", "Noted", "Answered", "Not changed"). Some comments only need reading. When nothing more is needed, set no_further_action: the comment then folds away and get_comments leaves it out. The user can set or clear that too, so one that comes back open needs another look. A comment whose target has card: true is about the item's card, what shows for it around the schematic: answer it by changing the item's title, description or card lines. One with point is about that place in the item: read the item to see what's there. One on the whole schematic is about all of it, or anything not in one item. Comments on a proposal stay with it as you revise it.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). Every tool works only with the app, on this computer.
const READ_ONLY = new Set(['list_schematics', 'get_schematic', 'get_schematic_item', 'get_proposal', 'get_comments', 'list_domains', 'list_folders']);
const DESTRUCTIVE = new Set();
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false });

const DEPTH = z.number().int().min(0).max(10).optional();
const LINK = z.string().optional().describe('Where it links: an item id, or item#part');
const EXPLAIN = z.string().optional().describe('What this one does here and why, which the diagram can\'t show by itself, for agents reading the schematic. Don\'t repeat what the diagram already shows: who it joins and what it wraps.');
const ITEM_BASE = {
  id: z.string().describe('Its id within this schematic. Sending an id that exists replaces that item.'),
  title: z.string().trim().min(1),
  description: z.string().optional().describe('One line saying what it is, listed by get_schematic'),
  links: z.array(z.object({ to: z.string(), label: z.string().optional() })).optional().describe('Links from the item as a whole'),
  card: z.array(z.string()).max(4).optional().describe('Up to 4 short lines for the item\'s card, the summary shown wherever it appears around the schematic, below its title and description. Instead of what the app works out (such as a table\'s row count), so write them when the user asks for details there, or when a few facts say more. Leave out to let the app summarise.'),
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

  // A domain is a group in the store: everything the AI sees says domain.
  tool('list_schematics', 'Every schematic, most recently changed first: its id, name, summary, number of accepted drafts, status, the domain it\'s in (null for No domain), and any proposal waiting for the user.', {}, async (_args, schemas) => (await schemas.list()).map(({ group, ...one }) => ({ ...one, domain: group })));

  tool('list_domains', 'The domains schematics belong to, by name: each with its id, name, how many schematics are in it and the folder it\'s in (null for the top level, with the folder\'s path), and how many schematics are in No domain.', {}, async (_args, schemas) => {
    const { groups, ungrouped } = await schemas.listGroups();
    return { domains: groups.map(({ schemas: count, ...domain }) => ({ ...domain, schematics: count })), noDomain: ungrouped };
  });

  tool('create_domain', 'Makes a domain, a set of schematics owned by one team or one department, such as "Auth", straight away: at the top level or in a folder. Only use it when the user asks.', {
    name: z.string().trim().min(1).max(80),
    folder_id: z.string().optional().describe('The folder to put it in, from list_folders (default: the top level)'),
  }, ({ name, folder_id }, schemas) => schemas.createGroup(name, folder_id ?? null));

  tool('rename_domain', 'Renames a domain, straight away. Only use it when the user asks.', {
    domain_id: z.string().describe('From list_domains'),
    name: z.string().trim().min(1).max(80),
  }, ({ domain_id, name }, schemas) => schemas.renameGroup(domain_id, name));

  tool('move_schematic', 'Puts a schematic in a domain, or in No domain, straight away. Only its place on the list changes: its drafts stay as they are. Only use it when the user asks.', {
    schematic_id: z.string(),
    domain_id: z.string().nullable().describe('From list_domains, or null for No domain'),
  }, async ({ schematic_id, domain_id }, schemas) => {
    const { schema, group } = await schemas.moveSchema(schematic_id, domain_id);
    return { schematic: schema, domain: group };
  });

  tool('list_folders', 'The folders organising the domains in the app: each with its id, name, path and how many folders and domains are directly in it.', {}, (_args, schemas) => schemas.listFolders());

  tool('create_folder', 'Makes a folder to organise domains in, at the top level or inside another, straight away. Only use it when the user asks.', {
    name: z.string().trim().min(1).max(80),
    parent_folder_id: z.string().optional().describe('The folder to put it in, from list_folders (default: the top level)'),
  }, ({ name, parent_folder_id }, schemas) => schemas.createFolder(name, parent_folder_id ?? null));

  tool('rename_folder', 'Renames a folder, straight away. Only use it when the user asks.', {
    folder_id: z.string().describe('From list_folders'),
    name: z.string().trim().min(1).max(80),
  }, ({ folder_id, name }, schemas) => schemas.renameFolder(folder_id, name));

  tool('move_domain','Moves a domain into a folder, or back to the top level, straight away. Only its place on the list changes: its schematics stay as they are. Only use it when the user asks.', {
    domain_id: z.string().describe('From list_domains'),
    folder_id: z.string().nullable().describe('The folder, from list_folders, or null for the top level'),
  }, ({ domain_id, folder_id }, schemas) => schemas.moveGroup(domain_id, folder_id));

  tool('get_schematic', 'One schematic\'s accepted draft: its name, summary, contract and parameters; its items listed with their id, kind, title and description but not their content; every link between them; and the schematics it embeds, each collapsed to its name, summary, contract and pinned draft, saying if a newer draft exists. Fetch an item with get_schematic_item. Open further levels with depth, or by calling this for an embedded schematic\'s id and draft. proposal says if a change is waiting for the user.', {
    schematic_id: z.string(),
    draft_id: z.string().optional().describe('The draft to read (default: the latest)'),
    depth: DEPTH.describe('How many levels of embedded schematics to open (default 0: all collapsed)'),
  }, ({ schematic_id, draft_id, depth }, schemas) => schemas.getSchema(schematic_id, { draftId: draft_id, depth }));

  tool('get_schematic_item', 'One item\'s full content, with the links out of it and into it.', {
    schematic_id: z.string(),
    item_id: z.string(),
    draft_id: z.string().optional().describe('The draft to read (default: the latest)'),
    proposal: z.boolean().optional().describe('Read it from the proposal waiting on the schematic instead'),
  }, ({ schematic_id, item_id, draft_id, proposal }, schemas) => schemas.getItem(schematic_id, item_id, { draftId: draft_id, proposal }));

  tool('get_proposal', 'The change waiting for the user on a schematic, in the same form as get_schematic, with which items it adds, changes and removes. Fetch an item from it with get_schematic_item and proposal. Null if nothing is waiting.', {
    schematic_id: z.string(),
    depth: DEPTH.describe('How many levels of embedded schematics to open (default 0: all collapsed)'),
  }, ({ schematic_id, depth }, schemas) => schemas.getProposal(schematic_id, { depth }));

  tool('get_comments', 'The user\'s open comments on a schematic\'s draft (the latest unless you name one) or on the proposal waiting on it, oldest first: those not marked "No further action required", unless you ask for all. Each says what it\'s on (target: schematic: true for the schematic as a whole; else the item and its title, with the part and its name, any words the user quoted, a point in the item\'s content (point: x and y as fractions of it, the item as a whole being the context), or card: true for the item\'s card; missing or partMissing if that\'s no longer there), what the user said, the replies so far, its outcome (how it was last dealt with) and noFurtherAction (who marked it so, and when).', {
    schematic_id: z.string(),
    draft_id: z.string().optional().describe('The draft whose comments to read (default: the latest)'),
    proposal: z.boolean().optional().describe('Read the comments on the proposal waiting on the schematic instead'),
    all: z.boolean().optional().describe('Include the comments marked "No further action required"'),
  }, async ({ schematic_id, draft_id, proposal, all }, schemas) => {
    const comments = await schemas.listComments(schematic_id, { draftId: draft_id, proposal });
    return (all ? comments : comments.filter((comment) => !comment.noFurtherAction)).map((comment) => ({ ...comment, outcome: comment.outcome ?? null, noFurtherAction: comment.noFurtherAction ?? null }));
  });

  tool('reply_to_comment', 'Answers one of the user\'s comments, shown under it in the app: say what you changed, or why you didn\'t, and how you dealt with it. Give text, an outcome, or both. A comment can have several replies, so reply again after a further revision.', {
    schematic_id: z.string(),
    comment_id: z.string(),
    text: z.string().trim().min(1).optional().describe('Your reply, in a sentence or two. Can be left out when the outcome says it all, such as "Noted"'),
    outcome: z.string().trim().min(1).max(40).optional().describe('How you dealt with it, in a word or two of your own, shown as a tag on the comment: such as "Actioned", "Noted", "Answered", "Partly done" or "Not changed"'),
    no_further_action: z.boolean().optional().describe('True when nothing more is needed on it (a comment that only needed reading, or one you\'ve fully dealt with): it folds away and get_comments leaves it out. False takes that back. Leave it out to keep it as it is'),
  }, ({ schematic_id, comment_id, text, outcome, no_further_action }, schemas) => {
    if (!text && !outcome) throw new Error('Give text, an outcome, or both.');
    return schemas.replyToComment(schematic_id, comment_id, { text, outcome, noFurtherAction: no_further_action });
  });

  tool('propose_schematic', 'Proposes a new schematic, or with schematic_id a change to one, and shows it in the app for the user to accept or discard. For a change, send only what changes: everything else carries over, from the proposal already waiting (which this replaces) or else the latest draft. Links are checked, and the proposal is refused if one goes nowhere.', {
    schematic_id: z.string().optional().describe('The schematic to change (leave out to propose a new one)'),
    name: z.string().trim().min(1).max(200).optional().describe('Needed for a new schematic'),
    summary: z.string().trim().min(1).optional().describe('What this is, in a sentence or two. Shows when it\'s collapsed. Needed for a new schematic.'),
    contract: z.string().optional().describe('Markdown: what it promises and what it needs. Shows when it\'s collapsed.'),
    items: z.array(ITEM).optional().describe('Items to add, or to replace by id'),
    remove_items: z.array(z.string()).optional().describe('The ids of items to remove'),
    item_order: z.array(z.string()).optional().describe('Item ids in the order to show them. Any left out follow.'),
    parameters: z.array(z.object({
      name: z.string().trim().min(1),
      description: z.string().optional(),
    })).optional().describe('What each use of this schematic can set. Replaces the list.'),
    uses: z.array(z.object({
      id: z.string().describe('Its name within this schematic, which links use'),
      schematic_id: z.string().describe('The schematic to embed, which must have an accepted draft'),
      draft_id: z.string().optional().describe('The draft to pin to (default: its latest)'),
      with: z.record(z.string(), z.string()).optional().describe('Values for the parameters it declares'),
    })).optional().describe('The schematics this one embeds. Replaces the list.'),
    domain_id: z.string().optional().describe('For a new schematic: the domain to put it in, from list_domains (default: No domain)'),
    goal: z.string().trim().min(1).optional().describe('The focus the user gave you for this work, in their words'),
    goal_title: z.string().trim().min(1).max(60).optional().describe('A short name for that focus'),
    note: z.string().trim().min(1).describe('What this proposes and why, for the user reviewing it, in a plain sentence or two. The app already says it is a proposal, so no label such as "Proposed change:"'),
  }, ({ schematic_id, uses, remove_items, item_order, goal_title, domain_id, ...proposal }, schemas) => schemas.propose({
    ...proposal,
    groupId: domain_id,
    goalTitle: goal_title,
    schemaId: schematic_id,
    removeItems: remove_items,
    itemOrder: item_order,
    uses: uses?.map(({ schematic_id: target, draft_id, ...use }) => ({ ...use, schemaId: target, draftId: draft_id })),
  }));

  return server;
}
