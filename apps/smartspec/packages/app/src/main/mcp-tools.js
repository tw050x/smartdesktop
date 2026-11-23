import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ICONS } from './icons.js';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches.

const INSTRUCTIONS = `This server is SmartSpec: a desktop app holding the design of a system as schematics, for the user and for other agents to act on. It's about system design at any scale: a schematic can describe a whole business, one service, or one module inside a single application.
A schematic has a name, a summary and a contract, which are what show when it's collapsed inside another schematic, so write them to stand on their own. The contract is its boundary and its public side: what it promises and what it needs, and the only part of it other schematics can see or link to. Write it as a tree, the contract being its root: each node a part of the interface (/orders, with /orders/:id under it; for HTTP give each its path), with Markdown explaining it, the shapes it talks about (JSON Schema, seen by checks there and below), setup steps run before every check there and below (which keep values from their responses, such as an order's id, for requests below to use as {id}), its clauses and its child nodes. A clause is one promise: a title saying it in a line, Markdown explaining it, and the checks that test it (an HTTP request and what the response should be). Nodes, clauses and shapes each have a public id, unique in the contract and set once (other schematics link to it), so moving one in the tree breaks nothing. A branch can be run again on its own. When a promise is worked out in one of the schematic's own items (a sequence of the exchange, a table of endpoints, a row of one), the clause can be defined by it (defined_by): outsiders still link to the clause, never the item, so the item can change without them knowing. A contract can still be plain Markdown, with no clauses to link to or check.
A schematic's implementation says where the code that keeps its contract comes from (a Docker image, a Docker Compose file in a git repository, a git repository or an archive built and run on the machine, or something already running) and how to run it: the port it listens on, its environment, the commands that build and start it, a path that answers once it's ready, and labels for any logins it needs (kept on the machine that runs it, never in the schematic). The contract's checks are run against it. It's private, as items are. A use can name its own implementation, when the embedded schematic is a standard each system implements itself; otherwise the embedded schematic's own is used. Ask the user where the code is before writing one. The code of a git repository (or one holding a Compose file) is kept in the schematic's workspace on the user's Mac, a clone made by the first run of its checks (get_schematic gives its path, as workspace): work on the code there, as the checks run against it as it is, uncommitted changes and all. The user runs the checks from SmartSpec's Test mode (all of them, or a branch's), and you can with run_checks: after changing the code in the workspace, run them (the branch you worked on, then all) to see that the contract is kept, and say which promises are broken and why. get_test_results gives the latest results without running them: read them when the user asks why something fails, or before changing the code or the contract.
A schematic's design is a set of items, each of a kind: document (Markdown), flow (a diagram of nodes and connections), sequence (a diagram of participants and messages), table, or image. Use whichever explain it best, and as many as it needs. Diagrams are data, not a text language: the app lays them out and draws them. Give a description to anything in a diagram whose reason isn't obvious from its label, especially loops, alternatives and activations.
Items link to each other, so a schematic is a connected graph. A link is an item's id, or item#part for a part inside it: a document's heading (as a slug), a flow's node or connection, a sequence's participant or message, or a table's row. In Markdown, write [text](item#part). Nodes, connections, participants, messages and rows can each have a link. Any item can list links too, which is the way to link from an image. A link can reach the contract and its nodes, clauses and shapes (contract#id), and the schematics this one embeds and their contracts' nodes, clauses and shapes (use#id), but never their items. Links that go nowhere are refused.
Schematics embed other schematics: a standard structure, such as machine to machine auth, is one schematic, and shows as a single element in each schematic that uses it. Each use follows the embedded schematic's latest draft, unless it's pinned to one, and can only set the parameters the embedded schematic declares. To change anything else, propose a new draft of that schematic, or a separate schematic.
Read only what you need: get_schematic lists a schematic's items and links without their content, with its uses collapsed. Fetch an item with get_schematic_item when you need it, and open further levels by asking for them.
A focus is what the user wants this work to be for: their prompt may say "focusing on" a goal. Keep to it, and pass it to propose_schematic as goal, with a short goal_title if you're given one or can name it, so the app can show it. If the user's prompt names a window, call use_window with it first, so that window becomes yours.
Only the user accepts what you propose: propose_schematic creates a proposal, and it becomes a draft once they accept it in the app. Send only what changes: the rest carries over. Tell the user straight away to switch to SmartSpec and review it. Each reply gives a wait command, a shell command that ends when they have answered: run it in the background if you can, or call get_schematic later to see where it stands. It also ends when the user sends you their comments on the proposal to deal with before they accept (outcome comments): read them with get_comments (proposal: true), answer each with reply_to_comment, propose again if they need changes, then wait again. A schematic you embed must have an accepted draft, so wait for the acceptance before building on it.
Schematics belong to domains: a domain is a set of schematics owned by one team or one department, such as "Auth". A schematic in none is in No domain. Domains are organised in folders, which nest, so they can follow the organisation (a department's folder holding its teams'). list_domains and list_folders show them. create_domain, rename_domain, move_schematic, create_folder, rename_folder and move_domain take effect straight away, so only use them when the user asks. A new schematic can go straight into a domain with propose_schematic's domain_id.
Each schematic has an icon, shown on its tab and on the user's home screen so they can tell it apart at a glance: one with no icon of its own (get_schematic's icon is null) gets one from you, with propose_schematic's icon for a new one or set_icon for the one the window shows.
The user comments on what you propose, and on drafts: get_schematic and get_proposal say how many are open, and get_comments reads them, each on the whole schematic (schematic: true), an item, a part of it, a point in it or words they quoted. Answer each one with reply_to_comment: say what you changed or why you didn't, and give its outcome, how you dealt with it in a word or two of your own ("Actioned", "Noted", "Answered", "Not changed"). Some comments only need reading. When nothing more is needed, set no_further_action: the comment then folds away and get_comments leaves it out. The user can set or clear that too, so one that comes back open needs another look. A comment whose target has card: true is about the item's card, what shows for it around the schematic: answer it by changing the item's title, description or card lines. One with point is about that place in the item: read the item to see what's there. One on the whole schematic is about all of it, or anything not in one item. Comments on a proposal stay with it as you revise it.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). Every tool works only with the app, on this computer.
const READ_ONLY = new Set(['list_schematics', 'get_schematic', 'get_schematic_item', 'get_proposal', 'get_comments', 'get_test_results', 'list_domains', 'list_folders']);
const DESTRUCTIVE = new Set();
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false });

const DEPTH = z.number().int().min(0).max(10).optional();
const LINK = z.string().optional().describe('Where it links: an item id, or item#part');
const EXPLAIN = z.string().optional().describe('What this one does here and why, which the diagram can\'t show by itself, for agents reading the schematic. Don\'t repeat what the diagram already shows: who it joins and what it wraps.');
const ID_TEXT = z.string().regex(/^[A-Za-z0-9][\w-]*$/);
const TEXT_VALUES = z.record(z.string(), z.string());
const REQUEST = z.object({
  method: z.string().describe('GET, POST, PUT, PATCH, DELETE…'),
  path: z.string().describe('From the implementation\'s base address, starting with /, such as /orders/{id}: {name} is a value a setup step above kept'),
  query: TEXT_VALUES.optional(),
  headers: TEXT_VALUES.optional(),
  body: z.unknown().optional().describe('Sent as JSON. A string "{name}" is a value a setup step above kept'),
});
const EXPECT = z.object({
  status: z.number().int().optional(),
  headers: TEXT_VALUES.optional(),
  body: z.unknown().optional().describe('JSON the response body must contain: every field given, with that value (others may be there too)'),
  shape: z.string().optional().describe('The id of a shape declared on this node or one above it, which the response body must fit'),
}).describe('What the response should be: at least one of status, headers, body or shape');
const CHECK = z.object({
  id: ID_TEXT.describe('Its id within the clause'),
  kind: z.literal('http'),
  title: z.string().optional().describe('What it tries, in a few words'),
  request: REQUEST,
  expect: EXPECT,
});
const CLAUSE = z.object({
  id: ID_TEXT.describe('Its public name, unique in the contract, which other schematics link to (use#id): set once and kept'),
  title: z.string().trim().min(1).describe('The promise, in a line'),
  markdown: z.string().optional().describe('What explains it'),
  defined_by: z.string().optional().describe('The item, or item#part, of this schematic where it\'s worked out: a document, flow, sequence or table'),
  checks: z.array(CHECK).optional().describe('What tests it. A promise with none yet shows as not tested'),
});
const SHAPE = z.object({
  id: ID_TEXT.describe('Its public name, unique in the contract, which checks and links use'),
  title: z.string().optional(),
  description: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).describe('JSON Schema'),
});
const SETUP = z.object({
  id: ID_TEXT.describe('Its id within the node'),
  kind: z.literal('http'),
  title: z.string().optional(),
  request: REQUEST,
  expect: EXPECT.optional().describe('What the response should be for setup to go on (default: any 2xx)'),
  keep: TEXT_VALUES.optional().describe('Values to keep from the response for requests on this node and below, by name: where each is, such as { "id": "body.id" }'),
});
// What the root and every node have; a node also has its id, name and path.
const BRANCH = {
  markdown: z.string().optional().describe('What explains this part'),
  shapes: z.array(SHAPE).optional().describe('The data this part talks about, seen by checks here and below'),
  setup: z.array(SETUP).optional().describe('Steps run, in order, before every check here and below'),
  clauses: z.array(CLAUSE).optional().describe('Its promises'),
};
const NODE = z.object({
  id: ID_TEXT.describe('Its public name, unique in the contract, which other schematics can link to: set once and kept'),
  name: z.string().trim().min(1).describe('The part of the interface it is, as shown: /orders, :id, a module, a function'),
  path: z.string().optional().describe('For HTTP: the path of this branch, such as /orders/:id, under its parent\'s. Every check here must request a path under it'),
  ...BRANCH,
  get children() { return z.array(NODE).optional().describe('The parts under it'); },
});
const CONTRACT_TREE = z.object({
  ...BRANCH,
  children: z.array(NODE).optional().describe('The parts of its interface, each a branch of nodes'),
}).describe('The contract as a tree, the root being the contract itself');

const IMPLEMENTATION = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('image'), image: z.string().describe('A Docker image, by tag or digest, such as ghcr.io/larder/orders:1.4') }),
    z.object({ kind: z.literal('compose'), url: z.string().describe('The git repository holding the Compose file'), ref: z.string().optional().describe('A branch, tag or commit'), file: z.string().optional().describe('The Compose file\'s path in the repository (default compose.yaml)'), service: z.string().describe('The service that keeps the contract') }),
    z.object({ kind: z.literal('git'), url: z.string().describe('The git repository'), ref: z.string().optional().describe('A branch, tag or commit'), dir: z.string().optional().describe('The folder in it to build and run from') }),
    z.object({ kind: z.literal('archive'), url: z.string().describe('An archive to download'), sha256: z.string().optional() }),
    z.object({ kind: z.literal('running'), url: z.string().describe('Its base address, to test as it is') }),
  ]).describe('Where the code comes from'),
  start: z.object({
    port: z.number().int().optional().describe('The port it listens on (needed unless it\'s already running)'),
    env: z.record(z.string(), z.string()).optional().describe('Its environment'),
    commands: z.array(z.string()).optional().describe('For git or an archive: the shell commands that build and start it, the last left running'),
  }).optional().describe('How to run it'),
  ready: z.object({
    path: z.string().describe('A path that answers once it has started, such as /health'),
    status: z.number().int().optional().describe('What it answers with when ready (default 200)'),
    timeout: z.number().int().optional().describe('Seconds to wait for it (default 60)'),
  }).optional(),
  stop: z.object({ commands: z.array(z.string()) }).optional().describe('For git or an archive: shell commands that tidy up afterwards'),
  credentials: z.array(z.string()).optional().describe('Labels for logins it needs to be fetched (a private repository or registry), such as github: kept on the machine that runs it, never here'),
});

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
  tool('list_schematics', 'Every schematic, most recently changed first: its id, name, summary, icon (null if it has none of its own), number of accepted drafts, status, the domain it\'s in (null for No domain), and any proposal waiting for the user.', {}, async (_args, schemas) => (await schemas.list()).map(({ group, ...one }) => ({ ...one, domain: group })));

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

  tool('set_icon', `Gives the schematic the window shows an icon, shown on its tab and on the user's home screen, so they can tell it apart at a glance (a tab too narrow for its name shows only its icon). Call it once, when the schematic has no icon of its own yet (get_schematic and list_schematics give its icon, null when it has none): choose the one that best fits what it is. The user's own choice is never replaced.`, {
    icon: z.enum(ICONS.map((i) => i.name)).describe(`One of: ${ICONS.map((i) => `${i.name} (${i.label})`).join(', ')}`),
  }, ({ icon }, schemas) => schemas.setIcon(icon));

  tool('get_schematic', 'One schematic\'s accepted draft: its name, summary, contract and parameters; its items listed with their id, kind, title and description but not their content; every link between them; and the schematics it embeds, each collapsed to its name, summary, contract and the draft it shows: its latest, or the one it\'s pinned to (pinned), saying if a newer draft exists. Fetch an item with get_schematic_item. Open further levels with depth, or by calling this for an embedded schematic\'s id and draft. proposal says if a change is waiting for the user. implementation says where its code comes from and how to run it; workspace, for a git repository, is where its code is kept on the user\'s Mac to work on (path, cloned, branch, changes: files with uncommitted changes).', {
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

  tool('get_test_results', 'The latest results of a schematic\'s contract checks, on a draft (the latest unless you name one) or the proposal waiting on it, as the user last ran them in SmartSpec\'s Test mode: when, how it went (passed, failed, or error when the code couldn\'t be started, with why and the end of the log), counts, and each check that failed or couldn\'t be run in full (its key clause/check, the promise it tests and the part of the contract it\'s in, its request, what it expects, its setup, and what went wrong); those passing and those not run by key. stale says a proposal changed after it was run; code_from names the workspace it ran against. ran: false if they haven\'t been run.', {
    schematic_id: z.string(),
    draft_id: z.string().optional().describe('The draft whose results to read (default: the latest)'),
    proposal: z.boolean().optional().describe('Read the results of the proposal waiting on it instead'),
  }, ({ schematic_id, draft_id, proposal }, schemas) => schemas.testResults(schematic_id, { draftId: draft_id, proposal }));

  tool('run_checks', 'Runs a schematic\'s contract checks against its implementation, as the user would from SmartSpec\'s Test mode (their window shows it as it goes): all of them, or a branch\'s or clause\'s (only, its id in the contract). For a git repository the code is its workspace on the user\'s Mac as it is, uncommitted changes and all, so run them after changing the code there to see if the contract is kept. Waits up to wait seconds (default 60, at most 300) and gives the results as get_test_results does; if it\'s still running then (a first clone, a long build), call get_test_results later. If a run is already going, it waits for that one. Only an implementation the user has accepted can be run: the proposal\'s only while it\'s the same as the latest draft\'s.', {
    schematic_id: z.string(),
    draft_id: z.string().optional().describe('The draft whose checks to run (default: the latest)'),
    proposal: z.boolean().optional().describe('Run the checks of the proposal waiting on it instead'),
    only: z.string().optional().describe('The id of a node or clause in the contract, to run only its checks'),
    wait: z.number().int().min(5).max(300).optional().describe('Seconds to wait for it to finish (default 60)'),
  }, ({ schematic_id, draft_id, proposal, only, wait }, schemas) => schemas.runChecks(schematic_id, { draftId: draft_id, proposal, only: only ?? null, wait }));

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
    contract: z.union([CONTRACT_TREE, z.string()]).optional().describe('What it promises and what it needs, its public side: a tree of the parts of its interface, each with its promises and their checks (or plain Markdown). Shows when it\'s collapsed. Replaces the whole contract.'),
    implementation: IMPLEMENTATION.nullable().optional().describe('Where the code that keeps the contract comes from and how to run it, for its checks. Private, as items are. Replaces it; null for none.'),
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
      draft_id: z.string().optional().describe('Pins it to this draft. Leave it out (as most uses should) to follow the latest draft, so it changes as that schematic does. Pin only when the user wants this use kept on a version; send it again each time you send uses, or the pin goes.'),
      with: z.record(z.string(), z.string()).optional().describe('Values for the parameters it declares'),
      implementation: IMPLEMENTATION.optional().describe('The code that implements it here, when it isn\'t the embedded schematic\'s own (a standard each system implements itself)'),
    })).optional().describe('The schematics this one embeds. Replaces the list.'),
    domain_id: z.string().optional().describe('For a new schematic: the domain to put it in, from list_domains (default: No domain)'),
    goal: z.string().trim().min(1).optional().describe('The focus the user gave you for this work, in their words'),
    goal_title: z.string().trim().min(1).max(60).optional().describe('A short name for that focus'),
    note: z.string().trim().min(1).describe('What this proposes and why, for the user reviewing it, in a plain sentence or two. The app already says it is a proposal, so no label such as "Proposed change:"'),
    icon: z.enum(ICONS.map((i) => i.name)).optional().describe('For a new schematic: its icon, shown on its tab and on home (see set_icon for the list)'),
    reasons: z.record(z.string(), z.string().trim().min(1).max(300)).optional().describe('Why each item changes, keyed by its id ("contract" for the contract): one short sentence for each item you add, change or remove, shown on that item while the user reviews. Kept when you propose again; send one again to replace it.'),
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
