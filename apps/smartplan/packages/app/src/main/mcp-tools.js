import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ICONS } from './icons.js';
import { LABEL_COLORS } from './store.js';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches (npm run server-snapshot writes it again after a change here).

const INSTRUCTIONS = `This server is SmartPlan: a desktop app of boards for planning work with the user, as Trello's are. A board is lists of cards in order (such as To do, Doing, Done), and each card is a piece of work: a short title, a description in Markdown, labels, a due date and a checklist, all optional but the title.
You write and change the cards; the user reads them and drags them between lists as the work moves on. Ask what a new board is for before making it, then create_board with its lists and first cards (with no lists, it gets To do, Doing and Done). Read get_board before changing a board: it gives every list and card by id, and each card's unread (new or updated while the user hasn't opened it yet; null once they have). Cards the user moved since you last looked were moved by them: don't move them back unless they ask.
add_cards adds cards to a list, update_card changes only the fields you send, and move_cards moves cards to a list (another, or the same one, to reorder it). Only remove cards or lists (remove_cards, remove_list) when the user asks.
If the user's prompt names a window, call use_window with it first, so that window becomes yours.
Each board has an icon, shown on its tab and on the user's home screen so they can tell it apart at a glance: one with no icon of its own (get_board's and list_boards' icon is null) gets one from you, with create_board's icon or set_icon.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). Every tool works only with the app, on this computer.
const READ_ONLY = new Set(['list_boards', 'get_board']);
const DESTRUCTIVE = new Set(['remove_cards', 'remove_list']);
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false });

const ICON = z.enum(ICONS.map((i) => i.name));
const BOARD_ID = z.string().optional().describe('The board (default: the one the window shows)');
const POSITION = z.number().int().min(0).optional().describe('Where it goes, counted from 0 (default: the end)');
const LABEL = z.object({
  name: z.string().trim().min(1).max(40).describe('A word or two, such as "Bug" or "Design"'),
  color: z.enum(LABEL_COLORS).optional().describe('Its colour (default grey). Use the same colour for the same label across the board'),
});
const CARD_FIELDS = {
  title: z.string().trim().min(1).max(300).describe('What the work is, in a few words'),
  description: z.string().max(50_000).optional().describe('The details, in Markdown (GitHub-flavoured: lists, tables, code)'),
  labels: z.array(LABEL).max(10).optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('When it\'s due, YYYY-MM-DD (null for none)'),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(300), done: z.boolean().optional() })).max(100).optional().describe('Steps to tick off. Send the whole list: it replaces the one there'),
};
const CARD = z.object(CARD_FIELDS);
const LIST = z.object({
  name: z.string().trim().min(1).max(200).describe('Such as "To do", "Doing", "Done", or a stage of the work'),
  cards: z.array(CARD).max(100).optional().describe('The cards it starts with, in order'),
});

// `call(name, args, run)` runs a tool for the session making the request, in its window, giving
// `run` the boards as that session may use them (see boardsFor in main.js).
export function buildServer(call, { version }) {
  const server = new McpServer({ name: 'smartplan', version }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema, annotations: annotations(name) }, async (args) => {
    try {
      return json(await call(name, args ?? {}, (boards) => run(args ?? {}, boards)));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  tool('use_window', 'Takes over a SmartPlan window, when the user\'s prompt names one: this session then works in it. Call it first, before any other tool, or SmartPlan opens a new window for this session.', {
    window_id: z.string().describe('The window named in the prompt, such as w-7f3a'),
  }, ({ window_id }, boards) => boards.useWindow(window_id));

  tool('list_boards', 'Every board, most recently changed first: its id, name, description, icon (null if it has none of its own), its lists (id, name and how many cards), how many cards it has and how many the user hasn\'t opened since you added or changed them.', {}, (_args, boards) => boards.list());

  tool('create_board', 'Makes a new board and shows it to the user. Ask what it\'s for first. With no lists, it gets To do, Doing and Done. Gives the ids of its lists and cards.', {
    name: z.string().trim().min(1).max(200).describe('What the user will know it by, such as "Website relaunch"'),
    description: z.string().trim().max(2000).optional().describe('What it\'s for, in a sentence or two'),
    lists: z.array(LIST).max(30).optional(),
    icon: ICON.optional().describe('Its icon, shown on its tab and on home (see set_icon for the list)'),
  }, ({ name, description, lists, icon }, boards) => boards.create({ name, description, lists, icon }));

  tool('get_board', 'One board in full: its name, description and icon, and its lists in order, each with its cards in order (id, title, description, labels, due, checklist, unread, createdAt, updatedAt).', {
    board_id: BOARD_ID,
  }, ({ board_id }, boards) => boards.get(board_id));

  tool('rename_board', 'Renames a board, or changes its description, straight away. Only use it when the user asks.', {
    board_id: BOARD_ID,
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
  }, ({ board_id, name, description }, boards) => {
    if (name === undefined && description === undefined) throw new Error('Give a name, a description, or both.');
    return boards.rename(board_id, { name, description });
  });

  tool('add_lists', 'Adds lists to a board, with any cards they start with.', {
    board_id: BOARD_ID,
    lists: z.array(LIST).min(1).max(30),
    position: POSITION,
  }, ({ board_id, lists, position }, boards) => boards.addLists(board_id, lists, { position }));

  tool('update_list', 'Renames a list, or moves it to another place on the board.', {
    board_id: BOARD_ID,
    list_id: z.string(),
    name: z.string().trim().min(1).max(200).optional(),
    position: POSITION,
  }, ({ board_id, list_id, name, position }, boards) => {
    if (name === undefined && position === undefined) throw new Error('Give a name, a position, or both.');
    return boards.updateList(board_id, list_id, { name, position });
  });

  tool('remove_list', 'Takes a list off the board, with every card in it, for good. Only use it when the user asks; move the cards first if they should stay.', {
    board_id: BOARD_ID,
    list_id: z.string(),
  }, ({ board_id, list_id }, boards) => boards.removeList(board_id, list_id));

  tool('add_cards', 'Adds cards to a list, in order. They show to the user as New until opened.', {
    board_id: BOARD_ID,
    list_id: z.string().describe('From get_board'),
    cards: z.array(CARD).min(1).max(100),
    position: POSITION,
  }, ({ board_id, list_id, cards, position }, boards) => boards.addCards(board_id, list_id, cards, { position }));

  tool('update_card', 'Changes a card: only the fields sent change. It shows to the user as Updated until opened.', {
    board_id: BOARD_ID,
    card_id: z.string(),
    ...Object.fromEntries(Object.entries(CARD_FIELDS).map(([key, schema]) => [key, schema.optional()])),
  }, ({ board_id, card_id, ...changes }, boards) => boards.updateCard(board_id, card_id, changes));

  tool('move_cards', 'Moves cards, in the order given, to a list: another, or the same one to reorder it. position counts among the cards that stay in that list.', {
    board_id: BOARD_ID,
    card_ids: z.array(z.string()).min(1).max(100),
    list_id: z.string(),
    position: POSITION,
  }, ({ board_id, card_ids, list_id, position }, boards) => boards.moveCards(board_id, card_ids, list_id, { position }));

  tool('remove_cards', 'Takes cards off the board, for good. Only use it when the user asks.', {
    board_id: BOARD_ID,
    card_ids: z.array(z.string()).min(1).max(100),
  }, ({ board_id, card_ids }, boards) => boards.removeCards(board_id, card_ids));

  tool('set_icon', `Gives a board an icon, shown on its tab and on the user's home screen, so they can tell it apart at a glance (a tab too narrow for its name shows only its icon). Call it once, when the board has no icon of its own yet (get_board and list_boards give its icon, null when it has none): choose the one that best fits what it's about. The user's own choice is never replaced.`, {
    board_id: BOARD_ID,
    icon: ICON.describe(`One of: ${ICONS.map((i) => `${i.name} (${i.label})`).join(', ')}`),
  }, ({ board_id, icon }, boards) => boards.setIcon(icon, board_id));

  tool('show_card', 'Opens a card on the board, in its tab, so the user sees it. Only use it when the user asks to see it.', {
    board_id: BOARD_ID,
    card_id: z.string(),
  }, ({ board_id, card_id }, boards) => boards.showCard(board_id, card_id));

  return server;
}
