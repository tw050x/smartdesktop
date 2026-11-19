import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Boards live in the app's data folder, one file each:
//
//   boards/<board id>/board.json   { id, name, description, createdAt, updatedAt, lists }
//
// A board is lists of cards, in order, as Trello's is. A list is { id, name, cards }; a card is
// { id, title, description, labels, due, checklist, createdAt, updatedAt, unread }:
//   - description, Markdown;
//   - labels, [{ name, color }], color one of LABEL_COLORS;
//   - due, a date (YYYY-MM-DD) or null;
//   - checklist, [{ text, done }];
//   - unread, 'new' or 'updated' while the AI has added or changed it and the user hasn't opened
//     it since, else null.
// Ids are short and made here (`l-…` for lists, `c-…` for cards), unique within the board.
//
// The AI writes the cards. The user arranges them: dragging a card to another place or list is
// theirs (`by: 'user'`), which marks nothing unread. Nor is a board's icon kept here
// (item-icons.js).

export const LABEL_COLORS = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'grey'];
const FILE_ID = /^[\w-]+$/;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const TITLE_MAX = 300;
const CARD_TEXT_MAX = 50_000;
const LABEL_MAX = 40;
const LABELS_MOST = 10;
const CHECKLIST_MOST = 100;
const ITEM_MAX = 300;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const now = () => new Date().toISOString();
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 6);

const squash = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');

function named(name, what, max = NAME_MAX) {
  const said = squash(name);
  if (!said) throw new Error(`${what} needs a name.`);
  if (said.length > max) throw new Error(`${what}'s name can be up to ${max} characters.`);
  return said;
}
function boardDescription(description) {
  const said = String(description ?? '').trim();
  if (said.length > DESCRIPTION_MAX) throw new Error(`A board's description can be up to ${DESCRIPTION_MAX} characters.`);
  return said;
}

// A card's fields as the AI sent them, checked, each mistake said with where it is (`where`, such
// as cards[2]). Only the fields given are returned, so a change leaves the rest as they are.
function cardFields(card, where, { whole = false } = {}) {
  if (!card || typeof card !== 'object') throw new Error(`${where} isn't a card.`);
  const fields = {};
  if (whole || card.title !== undefined) {
    const title = squash(card.title);
    if (!title) throw new Error(`${where}.title is missing.`);
    if (title.length > TITLE_MAX) throw new Error(`${where}.title is longer than ${TITLE_MAX} characters: put the rest in its description.`);
    fields.title = title;
  }
  if (card.description !== undefined || whole) {
    const description = String(card.description ?? '').trim();
    if (description.length > CARD_TEXT_MAX) throw new Error(`${where}.description is too long.`);
    fields.description = description;
  }
  if (card.labels !== undefined || whole) {
    const labels = card.labels ?? [];
    if (!Array.isArray(labels) || labels.length > LABELS_MOST) throw new Error(`${where}.labels is a list of up to ${LABELS_MOST} labels.`);
    fields.labels = labels.map((label, i) => {
      const name = squash(label?.name);
      if (!name || name.length > LABEL_MAX) throw new Error(`${where}.labels[${i}].name is a word or two, up to ${LABEL_MAX} characters.`);
      const color = label.color ?? 'grey';
      if (!LABEL_COLORS.includes(color)) throw new Error(`${where}.labels[${i}].color is one of ${LABEL_COLORS.join(', ')}.`);
      return { name, color };
    });
  }
  if (card.due !== undefined || whole) {
    const due = card.due ?? null;
    if (due !== null && (!DATE.test(due) || Number.isNaN(Date.parse(due)))) throw new Error(`${where}.due is a date, YYYY-MM-DD, or null for none.`);
    fields.due = due;
  }
  if (card.checklist !== undefined || whole) {
    const checklist = card.checklist ?? [];
    if (!Array.isArray(checklist) || checklist.length > CHECKLIST_MOST) throw new Error(`${where}.checklist is a list of up to ${CHECKLIST_MOST} items.`);
    fields.checklist = checklist.map((item, i) => {
      const text = squash(item?.text);
      if (!text || text.length > ITEM_MAX) throw new Error(`${where}.checklist[${i}].text is missing or longer than ${ITEM_MAX} characters.`);
      return { text, done: Boolean(item.done) };
    });
  }
  return fields;
}

// Where in a list something goes: `position` counted from 0, or the end if it's left out (or past it).
const at = (position, length) => (position === undefined || position === null ? length : Math.max(0, Math.min(Math.floor(position), length)));

export function createStore(root, { events = new EventEmitter() } = {}) {
  const boardFile = (id) => {
    if (!FILE_ID.test(String(id))) throw new Error(`No board ${id}.`);
    return path.join(root, 'boards', id, 'board.json');
  };

  // Written beside the file then moved over it, so a crash never leaves half a file.
  async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${shortId()}.tmp`;
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
  async function requireBoard(id) {
    const board = await readJson(boardFile(id));
    if (!board) throw new Error(`No board ${id}. list_boards shows the ones there are.`);
    return board;
  }

  // One change at a time, so two windows or AIs can't both write the same board.
  let tail = Promise.resolve();
  const serial = (change) => {
    const result = tail.then(change);
    tail = result.catch(() => {});
    return result;
  };
  // A change to a board: `change(board)` changes it in place and gives the result, then it's saved.
  const changing = (id, change) => serial(async () => {
    const board = await requireBoard(id);
    const result = await change(board);
    board.updatedAt = now();
    await writeJson(boardFile(id), board);
    events.emit('changed', id);
    return result;
  });

  // Every id on the board, lists' and cards', so a new one is never the same as any.
  const idsOn = (board) => new Set(board.lists.flatMap((list) => [list.id, ...list.cards.map((card) => card.id)]));
  const freshId = (prefix, taken) => {
    let id;
    do id = `${prefix}-${shortId()}`; while (taken.has(id));
    taken.add(id);
    return id;
  };
  const newCard = (fields, taken) => {
    const time = now();
    return { id: freshId('c', taken), ...fields, createdAt: time, updatedAt: time, unread: 'new' };
  };
  function findList(board, listId) {
    const list = board.lists.find((one) => one.id === listId);
    if (!list) throw new Error(`No list ${listId} on this board. Its lists: ${board.lists.map((one) => `${one.id} (${one.name})`).join(', ') || 'none yet'}.`);
    return list;
  }
  function findCard(board, cardId) {
    for (const list of board.lists) {
      const card = list.cards.find((one) => one.id === cardId);
      if (card) return { list, card };
    }
    throw new Error(`No card ${cardId} on this board.`);
  }
  // A list as the AI sent it, with any cards it starts with.
  function makeList(list, where, taken) {
    const name = named(list?.name, where);
    const cards = (list.cards ?? []).map((card, i) => newCard(cardFields(card, `${where}.cards[${i}]`, { whole: true }), taken));
    return { id: freshId('l', taken), name, cards };
  }
  const madeList = (list) => ({ id: list.id, name: list.name, cards: list.cards.map((card) => card.id) });

  const summary = (board) => {
    const cards = board.lists.flatMap((list) => list.cards);
    return {
      id: board.id,
      name: board.name,
      description: board.description || null,
      lists: board.lists.map((list) => ({ id: list.id, name: list.name, cards: list.cards.length })),
      cards: cards.length,
      unread: cards.filter((card) => card.unread).length,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    };
  };

  return {
    events,

    // Every board, most recently changed first.
    async list() {
      let ids = [];
      try {
        ids = (await readdir(path.join(root, 'boards'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && FILE_ID.test(entry.name)).map((entry) => entry.name);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const boards = (await Promise.all(ids.map((id) => readJson(boardFile(id))))).filter(Boolean);
      return boards.map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    // A new board: its name, what it's for, and the lists (and cards) it starts with. With no
    // lists, it gets three: To do, Doing, Done.
    create({ name, description = '', lists } = {}) {
      return serial(async () => {
        const taken = new Set();
        const time = now();
        const board = {
          id: `${Date.now().toString(36)}-${shortId()}`,
          name: named(name, 'A board'),
          description: boardDescription(description),
          createdAt: time,
          updatedAt: time,
          lists: (lists?.length ? lists : [{ name: 'To do' }, { name: 'Doing' }, { name: 'Done' }]).map((list, i) => makeList(list, `lists[${i}]`, taken)),
        };
        await writeJson(boardFile(board.id), board);
        events.emit('changed', board.id);
        return { board: board.id, lists: board.lists.map(madeList) };
      });
    },

    // The whole board: its lists in order, each with its cards in full.
    async get(id) {
      const board = await requireBoard(id);
      return { ...summary(board), lists: board.lists };
    },

    rename(id, { name, description }) {
      return changing(id, (board) => {
        if (name !== undefined) board.name = named(name, 'A board');
        if (description !== undefined) board.description = boardDescription(description);
        return { board: id, name: board.name, description: board.description || null };
      });
    },

    delete: (id) => serial(async () => {
      await requireBoard(id);
      await rm(path.dirname(boardFile(id)), { recursive: true, force: true });
      events.emit('changed', id);
    }),

    // --- Lists ---

    addLists(id, lists, { position } = {}) {
      return changing(id, (board) => {
        const taken = idsOn(board);
        const made = lists.map((list, i) => makeList(list, `lists[${i}]`, taken));
        board.lists.splice(at(position, board.lists.length), 0, ...made);
        return { lists: made.map(madeList) };
      });
    },

    updateList(id, listId, { name, position }) {
      return changing(id, (board) => {
        const list = findList(board, listId);
        if (name !== undefined) list.name = named(name, 'A list');
        if (position !== undefined) {
          board.lists.splice(board.lists.indexOf(list), 1);
          board.lists.splice(at(position, board.lists.length), 0, list);
        }
        return { list: list.id, name: list.name, position: board.lists.indexOf(list) };
      });
    },

    // A list goes with its cards, for good.
    removeList(id, listId) {
      return changing(id, (board) => {
        const list = findList(board, listId);
        board.lists.splice(board.lists.indexOf(list), 1);
        return { removed: list.id, cards: list.cards.length };
      });
    },

    // --- Cards ---

    addCards(id, listId, cards, { position } = {}) {
      return changing(id, (board) => {
        const list = findList(board, listId);
        const taken = idsOn(board);
        const made = cards.map((card, i) => newCard(cardFields(card, `cards[${i}]`, { whole: true }), taken));
        list.cards.splice(at(position, list.cards.length), 0, ...made);
        return { list: list.id, cards: made.map((card) => card.id) };
      });
    },

    // Only the fields given change. By the AI, it's marked updated until the user opens it.
    updateCard(id, cardId, changes) {
      return changing(id, (board) => {
        const { card } = findCard(board, cardId);
        const fields = cardFields(changes, 'card');
        if (!Object.keys(fields).length) throw new Error('Give at least one of title, description, labels, due or checklist.');
        Object.assign(card, fields, { updatedAt: now() });
        if (card.unread !== 'new') card.unread = 'updated';
        return { card: card.id };
      });
    },

    // Cards moved, in the order given, to a list (another, or the same one) at `position` among
    // the cards that stay there (the end if left out). The user's own drags (`by: 'user'`) mark
    // nothing.
    moveCards(id, cardIds, listId, { position, by = 'ai' } = {}) {
      return changing(id, (board) => {
        const to = findList(board, listId);
        const moving = [...new Set(cardIds)].map((cardId) => findCard(board, cardId));
        for (const { list, card } of moving) list.cards.splice(list.cards.indexOf(card), 1);
        const index = at(position, to.cards.length);
        to.cards.splice(index, 0, ...moving.map(({ card }) => card));
        if (by !== 'user') for (const { card } of moving) card.updatedAt = now();
        return { list: to.id, cards: moving.map(({ card }) => card.id), position: index, from: moving.map(({ list }) => list.id) };
      });
    },

    removeCards(id, cardIds) {
      return changing(id, (board) => {
        const found = [...new Set(cardIds)].map((cardId) => findCard(board, cardId));
        for (const { list, card } of found) list.cards.splice(list.cards.indexOf(card), 1);
        return { removed: found.map(({ card }) => card.id) };
      });
    },

    // The user opened a card: it's no longer new or updated.
    markRead(id, cardId) {
      return changing(id, (board) => {
        const { card } = findCard(board, cardId);
        card.unread = null;
        return { card: card.id };
      });
    },
  };
}
