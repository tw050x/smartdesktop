import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brokenLinks, cardIdFrom, DESCRIPTION_MAX, headingSlugs, headingsOf, ID, linkQuote, linksOf, QUESTION_MAX, slug, TITLE_MAX } from './cards.js';

// Topics live in the app's data folder, one folder each:
//
//   topics/<topic id>/
//     topic.json       its name, its goal (what it's for: the role and company, say), and when it
//                      was made and last changed
//     cards.json       its cards, in the order they were written (see below)
//     questions.json   the user's questions, and the AI's answers to them (see below)
//
// A card answers one question: { id, title, question, description, content, createdAt, updatedAt,
// unread, answers }. Its id is a short slug, which links use; its title is short, for its face at
// the edge of the board, and its question is shown above its answer (content, Markdown). The AI
// writes cards straight onto the board (the user's choice: they're study notes, so nothing waits
// to be accepted), and what it adds or changes is marked `unread` ('new' or 'updated') until the
// user has read it. `answers` is the question it was written for, if it was.
//
// A question is the user's, on a card (words they picked in it, `quote`, with the heading they're
// under, `part`; when they picked several passages apart, `quotes` holds each and `quote` all of
// them joined with " … "; a heading, `part`; a point in it, `point`; or the card as a whole) or on the topic
// (`topic`, with where on the board it was asked, `at`): { id, target, text, createdAt, replies,
// outcome, noFurtherAction, answeredBy }. The AI answers it with a new card (answeredBy), the words
// asked about becoming a link to it, or in words; either way it says how, as SmartSpec's comments
// do (outcome, in its own words, and "No further action required"). Questions are never removed:
// they're the trail of what was asked.
//
// Where the user has put each card on the board isn't kept here: it belongs to this Mac
// (layouts.js), never to the topic. Nor is a topic's icon (item-icons.js).

const FILE_ID = /^[\w-]+$/;
const NAME_MAX = 200;
const GOAL_MAX = 2000;
const CONTENT_MAX = 100_000;
const TEXT_MAX = 4000;
const OUTCOME_MAX = 40; // a question's outcome, in the AI's words: a word or two
const QUOTE_MAX = 500;
const QUOTES_MOST = 20; // passages picked apart in one question
const now = () => new Date().toISOString();
const newId = () => randomUUID().slice(0, 8);

const squash = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');

function topicName(name) {
  const named = squash(name);
  if (!named) throw new Error('A topic needs a name.');
  if (named.length > NAME_MAX) throw new Error(`A topic's name can be up to ${NAME_MAX} characters.`);
  return named;
}
function topicGoal(goal) {
  const said = String(goal ?? '').trim();
  if (said.length > GOAL_MAX) throw new Error(`A topic's goal can be up to ${GOAL_MAX} characters.`);
  return said;
}

// A card as the AI sent it, checked, each mistake said with where it is (`where`, such as
// cards[2]). Its id is checked by the caller, who knows which there are.
function checkCard(card, where) {
  if (!card || typeof card !== 'object') throw new Error(`${where} isn't a card.`);
  const title = squash(card.title);
  const question = squash(card.question);
  const description = squash(card.description);
  const content = String(card.content ?? '').trim();
  if (!title) throw new Error(`${where}.title is missing: a short name for the card's face.`);
  if (title.length > TITLE_MAX) throw new Error(`${where}.title is longer than ${TITLE_MAX} characters: keep it short, the question says the rest.`);
  if (!question) throw new Error(`${where}.question is missing: every card answers one question.`);
  if (question.length > QUESTION_MAX) throw new Error(`${where}.question is longer than ${QUESTION_MAX} characters.`);
  if (description.length > DESCRIPTION_MAX) throw new Error(`${where}.description is longer than ${DESCRIPTION_MAX} characters: it's one line.`);
  if (!content) throw new Error(`${where}.content is missing: the answer, in Markdown.`);
  if (content.length > CONTENT_MAX) throw new Error(`${where}.content is too long: split it into cards that link to each other.`);
  return { title, question, description, content };
}

export function createStore(root, { events = new EventEmitter() } = {}) {
  const topicDir = (id) => {
    if (!FILE_ID.test(String(id))) throw new Error(`No topic ${id}.`);
    return path.join(root, 'topics', id);
  };
  const topicFile = (id) => path.join(topicDir(id), 'topic.json');
  const cardsFile = (id) => path.join(topicDir(id), 'cards.json');
  const questionsFile = (id) => path.join(topicDir(id), 'questions.json');

  // Written beside the file then moved over it, so a crash never leaves half a file.
  async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${newId()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, file);
  }
  async function readJson(file) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  const readTopic = (id) => readJson(topicFile(id));
  const readCards = async (id) => (await readJson(cardsFile(id)))?.cards ?? [];
  const readQuestions = async (id) => (await readJson(questionsFile(id)))?.questions ?? [];
  const writeCards = (id, cards) => writeJson(cardsFile(id), { cards });
  const writeQuestions = (id, questions) => writeJson(questionsFile(id), { questions });
  const touch = (topic) => writeJson(topicFile(topic.id), { ...topic, updatedAt: now() });
  async function requireTopic(id) {
    const topic = await readTopic(id);
    if (!topic) throw new Error(`No topic ${id}. list_topics shows the ones there are.`);
    return topic;
  }

  // One change at a time, so two windows or AIs can't both write the same topic.
  let tail = Promise.resolve();
  const serial = (change) => {
    const result = tail.then(change);
    tail = result.catch(() => {});
    return result;
  };
  const changed = (id) => events.emit('changed', id);

  // A question is waiting for the AI until it has answered it, unless it needs nothing more; it's
  // open (get_questions lists it) until it's marked "No further action required".
  const forTheAi = (question) => !question.noFurtherAction && !question.replies?.length;
  const isOpen = (question) => !question.noFurtherAction;

  // Cards merged into `cards`: each replacing the card with its id, or added with an id of its own
  // (the AI's, or made from its title). What's new or changed is marked unread. Every link among
  // them must go somewhere, or nothing is written. `where(i)` names the i-th as the AI sent it.
  // Returns the cards as they'll be, and what became of each sent.
  function mergeCards(cards, sent, where = (i) => `cards[${i}]`, extra = {}) {
    if (!Array.isArray(sent) || !sent.length) throw new Error('Send at least one card.');
    const next = [...cards];
    const taken = new Set(next.map((card) => card.id));
    const seen = new Set();
    const results = [];
    const at = new Map(); // a card's id → where it was sent, for saying where a link is
    sent.forEach((card, i) => {
      const checked = checkCard(card, where(i));
      let id = card?.id === undefined || card?.id === null || card?.id === '' ? null : String(card.id);
      if (id !== null && !ID.test(id)) throw new Error(`${where(i)}.id "${id}" isn't a card id: lower-case letters, digits and hyphens, starting with a letter or digit, up to 60.`);
      if (id === null) {
        const base = cardIdFrom(checked.title);
        id = base;
        for (let n = 2; taken.has(id) || seen.has(id); n++) id = `${base}-${n}`;
      }
      if (seen.has(id)) throw new Error(`${where(i)}.id ${id} is sent twice: each card once.`);
      seen.add(id);
      at.set(id, where(i));
      const old = next.findIndex((one) => one.id === id);
      const time = now();
      if (old === -1) {
        next.push({ id, ...checked, createdAt: time, updatedAt: time, unread: 'new', answers: null, ...extra });
        taken.add(id);
        results.push({ id, made: 'new' });
      } else {
        const was = next[old];
        const same = ['title', 'question', 'description', 'content'].every((key) => (was[key] ?? '') === checked[key]);
        if (same) {
          results.push({ id, made: 'unchanged' });
          return;
        }
        next[old] = { ...was, ...checked, updatedAt: time, unread: was.unread === 'new' ? 'new' : 'updated' };
        results.push({ id, made: 'updated' });
      }
    });
    const broken = brokenLinks(next);
    if (broken.length) {
      const said = broken.map(({ card, link, why }) => `- ${at.get(card) ?? `card ${card}`}${at.has(card) ? '' : ' (already on the board)'}.content: ${link}: ${why}`);
      throw new Error(`Nothing was written: these links go nowhere. Link to a card's id, or to card#heading for a heading in its answer.\n${said.join('\n')}`);
    }
    return { next, results };
  }

  // What a new question is on, checked against the topic's cards: the topic as a whole (`topic`,
  // with where it was asked on the board, `at`), or a card: words in it (`quote`, with the heading
  // they're under), a heading (`part`), a point in it (`point`, as fractions of it), or all of it.
  // The board names a card `item`, and its title `card: true` (as SmartSpec's do): both are the card.
  function questionTarget(cards, target) {
    const fraction = (value) => Math.min(1, Math.max(0, Number(value) || 0));
    const point = (value) => value && typeof value === 'object' && { x: fraction(value.x), y: fraction(value.y) };
    if (target?.topic || target?.schematic) return { topic: true, ...(point(target.at) && { at: point(target.at) }) };
    const card = String((typeof target?.card === 'string' ? target.card : target?.item) ?? '');
    if (!cards.some((one) => one.id === card)) throw new Error(`There's no card ${card} to ask about.`);
    const quotes = Array.isArray(target.quotes) ? target.quotes.map((one) => squash(one).slice(0, QUOTE_MAX)).filter(Boolean).slice(0, QUOTES_MOST) : [];
    const quote = quotes.length > 1 ? quotes.join(' … ').slice(0, QUOTE_MAX) : squash(quotes[0] ?? target.quote).slice(0, QUOTE_MAX);
    if (target.point && !target.part && !quote) return { card, point: point(target.point) };
    return { card, ...(target.part && { part: String(target.part) }), ...(quote && { quote }), ...(quotes.length > 1 && { quotes }) };
  }

  // A question's target in words: the card's title and the heading's, or that it's gone. `item`
  // is the card again, for the board (comments.js).
  function describeTarget(cards, target) {
    if (target.topic) return { ...target };
    const card = cards.find((one) => one.id === target.card);
    if (!card) return { ...target, item: target.card, missing: true };
    const headings = headingsOf(card.content);
    const heading = target.part ? headings.find((text) => slug(text) === target.part) : null;
    return { ...target, item: target.card, title: card.title, ...(heading && { partName: heading }), ...(target.part && !heading && { partMissing: true }) };
  }
  const describeQuestion = (cards, question) => ({ ...question, target: describeTarget(cards, question.target) });

  // A card as listed, without its answer: what get_topic gives.
  const brief = (card) => ({ id: card.id, title: card.title, question: card.question, description: card.description || null, links: linksOf(card).map((link) => link.to), headings: headingSlugs(card.content), unread: card.unread ?? null, ...(card.answers && { answers: card.answers }) });

  async function summary(topic) {
    const [cards, questions] = await Promise.all([readCards(topic.id), readQuestions(topic.id)]);
    return {
      id: topic.id,
      name: topic.name,
      goal: topic.goal || null,
      cards: cards.length,
      unread: cards.filter((card) => card.unread).length,
      questions: { waiting: questions.filter(forTheAi).length, open: questions.filter(isOpen).length },
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
    };
  }

  return {
    events,

    // Every topic, most recently changed first.
    async list() {
      let ids = [];
      try {
        ids = (await readdir(path.join(root, 'topics'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && FILE_ID.test(entry.name)).map((entry) => entry.name);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const topics = (await Promise.all(ids.map(readTopic))).filter(Boolean);
      const listed = await Promise.all(topics.map(summary));
      return listed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    // A new topic: its name, what it's for, and the cards it starts with, if any.
    create({ name, goal = '', cards = [] }) {
      return serial(async () => {
        const id = `${Date.now().toString(36)}-${newId()}`;
        const time = now();
        const topic = { id, name: topicName(name), goal: topicGoal(goal), createdAt: time, updatedAt: time };
        const { next, results } = cards?.length ? mergeCards([], cards) : { next: [], results: [] };
        await writeJson(topicFile(id), topic);
        await writeCards(id, next);
        await writeQuestions(id, []);
        changed(id);
        return { topic: id, name: topic.name, cards: results };
      });
    },

    // A topic: its name and goal, its cards without their answers, and how its questions stand.
    async get(id) {
      const topic = await requireTopic(id);
      const [cards, questions] = await Promise.all([readCards(id), readQuestions(id)]);
      return {
        id,
        name: topic.name,
        goal: topic.goal || null,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
        cards: cards.map(brief),
        questions: { waiting: questions.filter(forTheAi).length, open: questions.filter(isOpen).length, total: questions.length },
      };
    },

    // Cards in full, with their answers: those asked for, or all of them.
    async getCards(id, ids = null) {
      await requireTopic(id);
      const cards = await readCards(id);
      if (!ids?.length) return cards;
      const missing = ids.filter((one) => !cards.some((card) => card.id === one));
      if (missing.length) throw new Error(`No card ${missing.join(', ')} in this topic. get_topic lists its cards.`);
      return ids.map((one) => cards.find((card) => card.id === one));
    },

    // Cards written straight onto the board: added, or replacing those with the same ids.
    writeCards(id, sent) {
      return serial(async () => {
        const topic = await requireTopic(id);
        const { next, results } = mergeCards(await readCards(id), sent);
        if (results.every((one) => one.made === 'unchanged')) return { topic: id, cards: results };
        await writeCards(id, next);
        await touch(topic);
        changed(id);
        return { topic: id, cards: results };
      });
    },

    // Cards taken off the board (only when the user asks), refused while another links to one.
    removeCards(id, ids) {
      return serial(async () => {
        const topic = await requireTopic(id);
        const cards = await readCards(id);
        const missing = ids.filter((one) => !cards.some((card) => card.id === one));
        if (missing.length) throw new Error(`No card ${missing.join(', ')} in this topic. get_topic lists its cards.`);
        const left = cards.filter((card) => !ids.includes(card.id));
        const broken = brokenLinks(left);
        if (broken.length) {
          throw new Error(`Nothing was removed: other cards link to these. Change those links with write_cards first, or remove those cards too.\n${broken.map(({ card, link }) => `- card ${card}.content: ${link}`).join('\n')}`);
        }
        await writeCards(id, left);
        await touch(topic);
        changed(id);
        return { topic: id, removed: ids };
      });
    },

    // The user has read a card: it's no longer marked New or Updated.
    markRead(id, cardId) {
      return serial(async () => {
        const cards = await readCards(id);
        const card = cards.find((one) => one.id === cardId);
        if (!card?.unread) return { card: cardId, unread: null };
        card.unread = null;
        await writeCards(id, cards);
        changed(id);
        return { card: cardId, unread: null };
      });
    },

    rename(id, { name, goal } = {}) {
      return serial(async () => {
        const topic = await requireTopic(id);
        const next = { ...topic, ...(name !== undefined && { name: topicName(name) }), ...(goal !== undefined && { goal: topicGoal(goal) }) };
        await touch(next);
        changed(id);
        return { topic: id, name: next.name, goal: next.goal || null };
      });
    },

    // A topic goes, with its cards and questions (the user deleting it from home).
    delete(id) {
      return serial(async () => {
        await requireTopic(id);
        await rm(topicDir(id), { recursive: true, force: true });
        changed(id);
        return { deleted: id };
      });
    },

    // The user's questions, oldest first: the open ones, or all.
    async listQuestions(id, { all = true } = {}) {
      await requireTopic(id);
      const [cards, questions] = await Promise.all([readCards(id), readQuestions(id)]);
      return questions.filter((question) => all || isOpen(question)).map((question) => describeQuestion(cards, question));
    },

    // The user asks about something on the board.
    addQuestion(id, { target, text }) {
      return serial(async () => {
        const topic = await requireTopic(id);
        const cards = await readCards(id);
        const said = String(text ?? '').trim();
        if (!said) throw new Error('A question needs something asked.');
        if (said.length > TEXT_MAX) throw new Error(`A question can be up to ${TEXT_MAX} characters.`);
        const question = { id: newId(), target: questionTarget(cards, target), text: said, createdAt: now(), replies: [] };
        await writeQuestions(id, [...await readQuestions(id), question]);
        await touch(topic);
        changed(id);
        return describeQuestion(cards, question);
      });
    },

    // The AI answers a question with a new card, written for it. The words the user asked about
    // become a link to it, where they first appear unlinked in the card's answer as written; if
    // they can't be found there (picked across formatting, or from the card's question), the result
    // says so, for the AI to add the link itself. The question gets the AI's reply and outcome, and
    // is marked as needing nothing more unless the AI says otherwise.
    answerQuestion(id, questionId, { reply, card, outcome = 'Answered', noFurtherAction = true, author = 'AI' }) {
      return serial(async () => {
        const topic = await requireTopic(id);
        const questions = await readQuestions(id);
        const question = questions.find((one) => one.id === questionId);
        if (!question) throw new Error(`There's no question ${questionId} in this topic. get_questions lists them.`);
        const how = squash(outcome);
        if (how.length > OUTCOME_MAX) throw new Error(`An outcome is a word or two: ${OUTCOME_MAX} characters at most.`);
        const said = String(reply ?? '').trim();
        const cards = await readCards(id);
        const { next, results } = mergeCards(cards, [card], () => 'card', { answers: questionId });
        const made = results[0];
        if (made.made !== 'new') throw new Error(`card.id ${made.id} is a card already: an answer is a new card. Leave out its id, or give it one of its own.`);
        // The words asked about, linked to the new card.
        let linked = false;
        let note = null;
        const { target } = question;
        if (target.quote && target.card) {
          const source = next.find((one) => one.id === target.card);
          // Each passage picked, linked in turn (several, if the user picked them apart).
          const missed = [];
          if (source) {
            for (const quote of target.quotes ?? [target.quote]) {
              const linkedContent = linkQuote(source.content, quote, made.id);
              if (linkedContent) {
                source.content = linkedContent;
                source.updatedAt = now();
                linked = true;
              } else missed.push(quote);
            }
          }
          if (!source) note = `The card the question was on (${target.card}) is no longer on the board, so nothing was linked.`;
          else if (missed.length) {
            note = `The words ${missed.map((quote) => `“${quote}”`).join(', ')} weren't found as written in ${target.card}'s answer (they may cross formatting such as a link, or be in its question), so ${missed.length === 1 ? 'they weren\'t' : 'those weren\'t'} linked. Link them to ${made.id} yourself with write_cards, if they're in its answer.`;
          }
        } else if (target.card) {
          note = `The question was on the card ${target.card} as a whole, so nothing was linked. Link to ${made.id} from it with write_cards where it helps.`;
        }
        const replyRecord = { id: newId(), author, ...(said && { text: said }), ...(how && { outcome: how }), card: made.id, createdAt: now() };
        question.replies = [...(question.replies ?? []), replyRecord];
        if (how) question.outcome = how;
        question.answeredBy = made.id;
        if (noFurtherAction !== false) question.noFurtherAction = { by: 'ai', at: now() };
        await writeCards(id, next);
        await writeQuestions(id, questions);
        await touch(topic);
        changed(id);
        return { topic: id, question: questionId, card: made.id, linked, ...(linked && { linkedIn: target.card }), ...(note && { note }), outcome: question.outcome ?? null, noFurtherAction: Boolean(question.noFurtherAction) };
      });
    },

    // The AI answers a question in words only, when it needs no card: something said, or how it
    // dealt with it in a word or two (`outcome`), or both; `noFurtherAction` true when nothing more
    // is needed, false to take that back.
    replyToQuestion(id, questionId, { text, outcome, noFurtherAction, author = 'AI' }) {
      return serial(async () => {
        const questions = await readQuestions(id);
        const question = questions.find((one) => one.id === questionId);
        if (!question) throw new Error(`There's no question ${questionId} in this topic. get_questions lists them.`);
        const said = String(text ?? '').trim();
        const how = squash(outcome);
        if (!said && !how) throw new Error('A reply needs something said, or an outcome.');
        if (how.length > OUTCOME_MAX) throw new Error(`An outcome is a word or two: ${OUTCOME_MAX} characters at most.`);
        const reply = { id: newId(), author, ...(said && { text: said }), ...(how && { outcome: how }), createdAt: now() };
        question.replies = [...(question.replies ?? []), reply];
        if (how) question.outcome = how;
        if (noFurtherAction === true) question.noFurtherAction = { by: 'ai', at: now() };
        else if (noFurtherAction === false) question.noFurtherAction = null;
        await writeQuestions(id, questions);
        changed(id);
        return { question: questionId, reply: reply.id, outcome: question.outcome ?? null, noFurtherAction: Boolean(question.noFurtherAction) };
      });
    },

    // The user marks a question as needing nothing more, or opens it again.
    setNoFurtherAction(id, questionId, flag) {
      return serial(async () => {
        const questions = await readQuestions(id);
        const question = questions.find((one) => one.id === questionId);
        if (!question) throw new Error(`There's no question ${questionId}.`);
        question.noFurtherAction = flag ? { by: 'user', at: now() } : null;
        await writeQuestions(id, questions);
        changed(id);
        return { question: questionId, noFurtherAction: Boolean(question.noFurtherAction) };
      });
    },
  };
}
