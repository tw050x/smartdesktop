import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ICONS } from './icons.js';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches (npm run server-snapshot writes it again after a change here).

const INSTRUCTIONS = `This server is SmartPrep: a desktop app that helps the user prepare for an interview, or learn a subject they don't know well, with you. Each topic (an interview, a technology, a subject) is a board of cards, which the user arranges and reads; you write every card, and they ask you questions.
Starting a topic: ask what it's for before you write anything. For an interview, the role, the company and the job description, and how much the user already knows; for a subject, why they're learning it and where they're starting from. Make it with create_topic, its goal saying what it's for, and its first cards answering the questions that start it, such as "What will this interview cover?" and "What should I read up on first?".
Every card answers one question: its question, then its answer (content, Markdown). Keep to one idea per card, short, written for the user's level, and give each a short title for its face on the board, and a one-line description. The answer links to the cards that already exist wherever they're relevant, with [text](card-id), or [text](card-id#heading) for a heading in that card's answer: read get_topic for the cards there are. A link that goes nowhere is refused. GitHub-flavoured Markdown works, tables and code blocks included.
Cards go straight onto the board: write_cards adds them, or replaces those with the same ids, and nothing waits to be accepted. The app marks what you add or change as New or Updated until the user has read it. Change a card only when the user asks for it, or a question shows it needs it.
The user asks follow-up questions by picking words in a card (or on a card's title, about the card, or on the board's empty space, about the topic). get_topic says how many are waiting, and get_questions reads them. Answer a question about words with answer_question: a new card whose question is the user's question (tidy its wording if you like, but it stays theirs, with the words they picked as its context), explaining just that, linking back to the card it came from where useful. The app turns the words they asked about into a link to it. Answer in words with reply_to_question only when a card isn't needed. Each answer says how you dealt with it (outcome, a word or two of your own, such as "Answered").
Only remove cards (remove_cards) when the user asks. If the user's prompt names a window, call use_window with it first, so that window becomes yours.
Each topic has an icon, shown on its tab and on the user's home screen so they can tell it apart at a glance: one with no icon of its own (get_topic's and list_topics' icon is null) gets one from you, with create_topic's icon or set_icon.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). Every tool works only with the app, on this computer.
const READ_ONLY = new Set(['list_topics', 'get_topic', 'get_cards', 'get_questions']);
const DESTRUCTIVE = new Set(['remove_cards']);
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false });

const ICON = z.enum(ICONS.map((i) => i.name));
const CARD_FIELDS = {
  title: z.string().trim().min(1).max(120).describe('A short name for the card\'s face on the board, a few words'),
  question: z.string().trim().min(1).max(500).describe('The one question this card answers, shown above its answer'),
  description: z.string().trim().max(300).optional().describe('One line saying what the answer covers, listed by get_topic'),
  content: z.string().trim().min(1).describe('The answer, in Markdown. Link to other cards with [text](card-id) or [text](card-id#heading)'),
};
const CARD = z.object({
  id: z.string().optional().describe('Its id, a short slug such as "event-loop" (lower-case letters, digits and hyphens). Sending an id that exists replaces that card. Leave out for a new card to have one made from its title.'),
  ...CARD_FIELDS,
});

// `call(name, args, run)` runs a tool for the session making the request, in its window, giving
// `run` the topics as that session may use them (see topicsFor in main.js).
export function buildServer(call, { version }) {
  const server = new McpServer({ name: 'smartprep', version }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema, annotations: annotations(name) }, async (args) => {
    try {
      return json(await call(name, args ?? {}, (topics) => run(args ?? {}, topics)));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  tool('use_window', 'Takes over a SmartPrep window, when the user\'s prompt names one: this session then works in it. Call it first, before any other tool, or SmartPrep opens a new window for this session.', {
    window_id: z.string().describe('The window named in the prompt, such as w-7f3a'),
  }, ({ window_id }, topics) => topics.useWindow(window_id));

  tool('list_topics', 'Every topic, most recently changed first: its id, name, goal, icon (null if it has none of its own), how many cards it has and how many the user hasn\'t read yet, and how many of the user\'s questions are waiting for you.', {}, (_args, topics) => topics.list());

  tool('create_topic', 'Makes a new topic, a board of cards, and shows it to the user. Ask what it\'s for first (for an interview: the role, the company, the job description). Its first cards answer the questions that start it.', {
    name: z.string().trim().min(1).max(200).describe('What the user will know it by, such as "Platform engineer at Acme"'),
    goal: z.string().trim().max(2000).optional().describe('What it\'s for, in the user\'s terms: the role and company, the job description\'s main points, or why they\'re learning it'),
    cards: z.array(CARD).optional().describe('Its first cards, each answering one starting question'),
    icon: ICON.optional().describe('Its icon, shown on its tab and on home (see set_icon for the list)'),
  }, ({ name, goal, cards, icon }, topics) => topics.create({ name, goal, cards, icon }));

  tool('get_topic', 'One topic: its name and goal, its icon, and its cards without their answers: each card\'s id, title, question, description, the links out of it, the headings in its answer, and unread (new or updated while the user hasn\'t read it yet; null once they have). questions says how many of the user\'s questions are waiting for you. Read cards\' answers with get_cards.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
  }, ({ topic_id }, topics) => topics.get(topic_id));

  tool('get_cards', 'Cards in full: their question and their answer (content, Markdown).', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    card_ids: z.array(z.string()).min(1).max(50).describe('The cards to read, from get_topic'),
  }, ({ topic_id, card_ids }, topics) => topics.getCards(topic_id, card_ids));

  tool('write_cards', 'Writes cards straight onto the topic\'s board: new ones are added, placed down the side of the board with fewer cards, and those with the id of one there replace it (send the whole card). Every card answers one question. Links are checked, and nothing is written if one goes nowhere.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    cards: z.array(CARD).min(1).max(50),
  }, ({ topic_id, cards }, topics) => topics.writeCards(topic_id, cards));

  tool('remove_cards', 'Takes cards off the topic\'s board, for good. Only use it when the user asks. Refused while another card links to one of them: change those links first.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    card_ids: z.array(z.string()).min(1).max(50),
  }, ({ topic_id, card_ids }, topics) => topics.removeCards(topic_id, card_ids));

  tool('get_questions', 'The user\'s open questions on a topic, oldest first: those not marked "No further action required", unless you ask for all. Each says what it\'s on (target: topic: true for the topic as a whole; else the card and its title, with any words the user picked (quote), the heading they\'re under (part and partName), a point in the card (point: x and y as fractions of it), or none of those for the card as a whole; missing if the card is no longer there), what the user asked, the replies so far, its outcome and noFurtherAction, and answeredBy, the card written for it.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    all: z.boolean().optional().describe('Include the questions marked "No further action required"'),
  }, ({ topic_id, all }, topics) => topics.listQuestions(topic_id, { all }));

  tool('answer_question', 'Answers one of the user\'s questions with a new card, written onto the board. Its question is the user\'s question (tidy its wording if you like, but it stays theirs), with the words they picked as its context; its answer explains just that, linking back to the card it came from where useful. The app turns the words they asked about into a link to the new card, where they appear as written in that card\'s answer; if it can\'t, the result says so (note), so you can add the link yourself with write_cards. The question is then marked as needing nothing more, unless you say otherwise.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    question_id: z.string().describe('From get_questions'),
    reply: z.string().trim().min(1).max(1000).optional().describe('A sentence for the user under their question, if the card doesn\'t say it all'),
    card: z.object({
      id: z.string().optional().describe('The new card\'s id, a short slug (default: made from its title)'),
      ...CARD_FIELDS,
    }).describe('The new card'),
    outcome: z.string().trim().min(1).max(40).optional().describe('How you dealt with it, in a word or two of your own, shown as a tag on the question (default "Answered")'),
    no_further_action: z.boolean().optional().describe('False if the question still needs more after this card (default true: it folds away)'),
  }, ({ topic_id, question_id, reply, card, outcome, no_further_action }, topics) => topics.answerQuestion(topic_id, question_id, { reply, card, outcome, noFurtherAction: no_further_action }));

  tool('reply_to_question', 'Answers one of the user\'s questions in words only, shown under it in the app: for one that needs no card of its own (it\'s answered on a card already, say, so point them to it). Give text, an outcome, or both.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    question_id: z.string().describe('From get_questions'),
    text: z.string().trim().min(1).max(2000).optional().describe('Your reply, in a sentence or two'),
    outcome: z.string().trim().min(1).max(40).optional().describe('How you dealt with it, in a word or two of your own, shown as a tag on the question: such as "Answered", "Noted" or "See its card"'),
    no_further_action: z.boolean().optional().describe('True when nothing more is needed on it: it folds away and get_questions leaves it out. False takes that back. Leave it out to keep it as it is'),
  }, ({ topic_id, question_id, text, outcome, no_further_action }, topics) => {
    if (!text && !outcome) throw new Error('Give text, an outcome, or both.');
    return topics.replyToQuestion(topic_id, question_id, { text, outcome, noFurtherAction: no_further_action });
  });

  tool('rename_topic', 'Renames a topic, or changes what it\'s for (its goal), straight away. Only use it when the user asks.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    name: z.string().trim().min(1).max(200).optional(),
    goal: z.string().trim().max(2000).optional(),
  }, ({ topic_id, name, goal }, topics) => {
    if (name === undefined && goal === undefined) throw new Error('Give a name, a goal, or both.');
    return topics.rename(topic_id, { name, goal });
  });

  tool('set_icon', `Gives a topic an icon, shown on its tab and on the user's home screen, so they can tell it apart at a glance (a tab too narrow for its name shows only its icon). Call it once, when the topic has no icon of its own yet (get_topic and list_topics give its icon, null when it has none): choose the one that best fits what it's about. The user's own choice is never replaced.`, {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    icon: ICON.describe(`One of: ${ICONS.map((i) => `${i.name} (${i.label})`).join(', ')}`),
  }, ({ topic_id, icon }, topics) => topics.setIcon(icon, topic_id));

  tool('show_card', 'Brings a card to the middle of the topic\'s board, in its tab, so the user sees it. Only use it when the user asks to see it.', {
    topic_id: z.string().optional().describe('The topic (default: the one the window shows)'),
    card_id: z.string(),
  }, ({ topic_id, card_id }, topics) => topics.showCard(topic_id, card_id));

  return server;
}
