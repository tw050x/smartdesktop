import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as folders from './folders.js';
import { CONTRACT, checkItem, checkLinks, connectionDetails, itemChanges, linkGraph, parseLink, partName, partsOf } from './items.js';

// Schemas live in the app's data folder, one folder each:
//
//   schemas/<schema id>/
//     schema.json              its line of drafts, oldest first, and when it last changed
//     drafts/<draft id>.json   one accepted version; never changed once written
//     proposal.json            the change the AI proposes, waiting for the user; not yet a draft
//     comments.json            the user's comments, and the AI's replies (see below)
//   proposals/<proposal id>.json   what became of each proposal, for `smartspec wait`
//   groups.json                    the domains schemas belong to (see below)
//   folders.json                   the folders domains are organised in (see folders.js)
//
// A draft holds a name, a summary and a contract, which are what show when it's collapsed inside
// another schema; its items (see items.js); the parameters a use of it can set; and the schemas it
// embeds, each pinned to one of their drafts; and its focus, if the AI was given one: the goal the
// user set it, which belongs to that draft and isn't carried to the next. Every change is an
// AI's, and waits as a proposal until the user accepts it.
//
// Schemas belong to domains: a set of schemas owned by one team or one department, such as "Auth".
// Everything a person or an AI sees says domain; here and on disk it's a group, so saved data didn't
// have to move. A schema is in one group, named in its schema.json, or in none ("No domain"), which
// always exists. Groups are organised in folders, which nest; neither changes anything about a
// schema's design.
//
// A comment is the user's, on one thing in a draft or the proposal: the whole schematic, an item, a
// part of it, a point in it, words they selected in it, quoted, or its card (its title, description
// and card lines). The AI reads them and replies. A comment on the proposal stays with it
// as the AI revises it, goes with it into the draft it becomes, and goes when it's discarded.
// When the AI replies it can say how it dealt with the comment in its own words (outcome: "Actioned",
// "Noted"…), and that nothing more is needed (noFurtherAction: { by, at }), which the user can also
// set or clear. Only comments without that flag count as open.
//
// A comment applies only to what it was written on. The next draft, or a proposal, shows the ones on
// the draft it came from that nobody answered, where what they're on is still there, as earlier
// comments: the user can comment again with the same words (a new comment, `from` the old one), and
// they count for nothing on what's showing.

const USE_ID = /^[a-z0-9][\w-]*$/i;
const FILE_ID = /^[\w-]+$/;
const now = () => new Date().toISOString();
const newId = () => randomUUID().slice(0, 8);
const OUTCOME_MAX = 40; // a comment's outcome, in the AI's words: a word or two

// Until implementations can be linked and tested, every schema is a design.
const STATUS = 'design-only';

// A focus's name: its title, else its goal cut short.
const focusTitle = (goal, title) => title?.trim() || (goal.trim().length > 48 ? `${goal.trim().slice(0, 47).trimEnd()}…` : goal.trim());

// The words of something, as they read: every piece of text in it, Markdown links reduced to their
// words, Markdown's marks taken out and spacing squashed, so words selected in the app can be looked for in it.
const plainWords = (text) => String(text).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|~]/g, '').replace(/\s+/g, ' ').trim();
function plainText(thing) {
  const pieces = [];
  const walk = (value) => {
    if (typeof value === 'string') pieces.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(thing);
  return pieces.map(plainWords).join(' ');
}

export function createStore(root, { events = new EventEmitter() } = {}) {
  const schemaDir = (id) => {
    if (!FILE_ID.test(id)) throw new Error(`No schematic ${id}.`);
    return path.join(root, 'schemas', id);
  };
  const draftFile = (schemaId, draftId) => {
    if (!FILE_ID.test(draftId)) throw new Error(`No draft ${draftId}.`);
    return path.join(schemaDir(schemaId), 'drafts', `${draftId}.json`);
  };
  const proposalFile = (schemaId) => path.join(schemaDir(schemaId), 'proposal.json');
  const commentsFile = (schemaId) => path.join(schemaDir(schemaId), 'comments.json');
  const outcomeFile = (id) => {
    if (!FILE_ID.test(id)) throw new Error(`No proposal ${id}.`);
    return path.join(root, 'proposals', `${id}.json`);
  };

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

  const readSchema = (id) => readJson(path.join(schemaDir(id), 'schema.json'));
  const groupsFile = path.join(root, 'groups.json');
  const readGroups = async () => (await readJson(groupsFile))?.groups ?? [];
  const writeGroups = (groups) => writeJson(groupsFile, { groups });
  const groupName = (name) => {
    const named = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!named) throw new Error('A domain needs a name.');
    if (named.length > 80) throw new Error('A domain\'s name can be up to 80 characters.');
    if (/^(no domain|ungrouped)$/i.test(named)) throw new Error('No domain is where schematics in no domain are, so a domain can\'t take that name.');
    return named;
  };
  // The folders groups are organised in, written whole each time (see folders.js).
  const foldersFile = path.join(root, 'folders.json');
  const readFolderState = async () => folders.readFolders(await readJson(foldersFile));
  const changeFolders = async (next) => {
    await writeJson(foldersFile, next);
    events.emit('changed', null);
    return next;
  };
  const folderPath = (state, folderId) => folders.pathOf(state, folderId).map((f) => f.name).join(' / ') || null;
  const requireGroup = async (id) => {
    const group = (await readGroups()).find((one) => one.id === id);
    if (!group) throw new Error(`There's no domain ${id}. list_domains shows the ones there are.`);
    return group;
  };
  const readDraft = (schemaId, draftId) => readJson(draftFile(schemaId, draftId));
  const readProposal = (schemaId) => readJson(proposalFile(schemaId));
  const readComments = async (schemaId) => (await readJson(commentsFile(schemaId)))?.comments ?? [];
  const writeComments = (schemaId, comments) => writeJson(commentsFile(schemaId), { comments });
  // What a comment is on: the proposal, or a draft by its id.
  const ON_PROPOSAL = 'proposal';
  const commentsOn = async (schemaId, on) => (await readComments(schemaId)).filter((comment) => comment.on === on);
  // The comments something still needs doing about: those without "No further action required".
  const openCount = async (schemaId, on) => (await commentsOn(schemaId, on)).filter((comment) => !comment.noFurtherAction).length;
  // A comment is waiting for the AI until it has answered it, unless it needs nothing more.
  const forTheAi = (comment) => !comment.noFurtherAction && !comment.replies?.length;
  // Where the user's comments on a proposal stand: how many the AI hasn't answered, and whether the
  // user has sent it them (see sendComments) and some of those are still unanswered.
  async function commentsWaiting(schemaId, proposal) {
    const open = (await commentsOn(schemaId, ON_PROPOSAL)).filter(forTheAi);
    const sent = proposal.commentsSent?.comments ?? [];
    return { waiting: open.length, sent: open.filter((comment) => sent.includes(comment.id)).length };
  }
  const writeSchema = (schema) => writeJson(path.join(schemaDir(schema.id), 'schema.json'), { ...schema, updatedAt: now() });

  async function requireSchema(id) {
    const schema = await readSchema(id);
    if (!schema) throw new Error(`No schematic ${id}. list_schematics shows the ones there are.`);
    return schema;
  }

  // One change at a time, so two windows or AIs can't both act on the same proposal.
  let tail = Promise.resolve();
  const serial = (change) => {
    const result = tail.then(change);
    tail = result.catch(() => {});
    return result;
  };

  const brief = (proposal) => proposal && { id: proposal.id, note: proposal.note, createdAt: proposal.createdAt };
  const itemBrief = ({ id, kind, title, description, mediaType, card }) => ({ id, kind, title, ...(description && { description }), ...(mediaType && { mediaType }), ...(card && { card }) });

  // What a schema shows for a record (a draft or a proposal): its items listed but not their
  // content, the links between them, and each use collapsed, or with `depth` levels opened.
  async function describe(record, depth) {
    return {
      name: record.name,
      summary: record.summary,
      contract: record.contract,
      parameters: record.parameters,
      note: record.note,
      focus: record.focus ?? null,
      createdAt: record.createdAt,
      status: STATUS,
      items: record.items.map(itemBrief),
      links: linkGraph(record),
      uses: await Promise.all(record.uses.map((use) => describeUse(use, depth))),
    };
  }

  async function describeUse(use, depth) {
    const schema = await readSchema(use.schemaId);
    const draft = schema && await readDraft(use.schemaId, use.draftId);
    if (!draft) return { id: use.id, schemaId: use.schemaId, draftId: use.draftId, with: use.with, missing: true };
    const latest = schema.line.at(-1);
    const collapsed = {
      id: use.id,
      schemaId: use.schemaId,
      draftId: use.draftId,
      number: schema.line.indexOf(use.draftId) + 1,
      with: use.with,
      name: draft.name,
      summary: draft.summary,
      contract: draft.contract,
      status: STATUS,
      newerDraftId: latest === use.draftId ? null : latest,
    };
    if (depth <= 0) return collapsed;
    const { parameters, items, links, uses } = await describe(draft, depth - 1);
    return { ...collapsed, parameters, items, links, uses };
  }

  // Whether a record embeds a schema, at any depth.
  async function embeds(record, schemaId) {
    for (const use of record.uses) {
      if (use.schemaId === schemaId) return true;
      const draft = await readDraft(use.schemaId, use.draftId);
      if (draft && await embeds(draft, schemaId)) return true;
    }
    return false;
  }

  // Each use, checked and pinned: to the draft it names, else the target's latest draft.
  async function pinUses(uses) {
    const seen = new Set();
    const pinned = [];
    for (const use of uses) {
      if (!USE_ID.test(use.id)) throw new Error(`"${use.id}" can't be a use's id: use letters, numbers, - and _.`);
      if (seen.has(use.id)) throw new Error(`Two uses are called ${use.id}.`);
      seen.add(use.id);
      const target = await requireSchema(use.schemaId);
      const draftId = use.draftId ?? target.line.at(-1);
      if (!draftId) throw new Error(`Schematic ${use.schemaId} has no accepted draft yet, so it can't be embedded. The user has to accept its proposal first.`);
      if (!target.line.includes(draftId)) throw new Error(`Schematic ${use.schemaId} has no draft ${draftId}.`);
      const draft = await readDraft(use.schemaId, draftId);
      const declared = new Set(draft.parameters.map((parameter) => parameter.name));
      for (const key of Object.keys(use.with ?? {})) {
        if (!declared.has(key)) throw new Error(`${draft.name} has no parameter "${key}". A use can only set the parameters its schematic declares: ${[...declared].join(', ') || 'it has none'}.`);
      }
      pinned.push({ id: use.id, schemaId: use.schemaId, draftId, with: use.with ?? {} });
    }
    return pinned;
  }

  // A complete record: `base` with `change` applied, and checked. What a change leaves out stays as
  // it was. `items` are added, or replace the item with that id in its place; `removeItems` go; and
  // `itemOrder` puts the items it names first.
  async function buildRecord(base, { name, summary, contract, parameters, uses, items = [], removeItems = [], itemOrder, note }) {
    const record = {
      name: name?.trim() || base?.name,
      summary: summary?.trim() || base?.summary,
      contract: contract ?? base?.contract ?? '',
      parameters: parameters ?? base?.parameters ?? [],
      uses: uses ? await pinUses(uses) : base?.uses ?? [],
      items: base?.items ?? [],
      note,
    };
    if (!record.name || !record.summary) throw new Error('A schematic needs a name and a summary.');
    const names = record.parameters.map((parameter) => parameter.name);
    if (new Set(names).size !== names.length) throw new Error('Two parameters have the same name.');

    for (const id of removeItems) {
      if (!record.items.some((item) => item.id === id)) throw new Error(`There's no item ${id} to remove.`);
    }
    const next = record.items.filter((item) => !removeItems.includes(item.id));
    for (const item of items) {
      if (!USE_ID.test(item.id ?? '')) throw new Error(`"${item.id}" can't be an item's id: use letters, numbers, - and _.`);
      if (item.id === CONTRACT) throw new Error(`"${CONTRACT}" is the schematic's contract, so it can't be an item's id.`);
      if (items.filter((other) => other.id === item.id).length > 1) throw new Error(`Two items have the id ${item.id}.`);
      checkItem(item);
      const at = next.findIndex((other) => other.id === item.id);
      if (at === -1) next.push(item);
      else next[at] = item;
    }
    if (itemOrder) {
      for (const id of itemOrder) if (!next.some((item) => item.id === id)) throw new Error(`There's no item ${id} to put in order.`);
      const rank = (item) => (itemOrder.includes(item.id) ? itemOrder.indexOf(item.id) : itemOrder.length);
      next.sort((a, b) => rank(a) - rank(b));
    }
    record.items = next;
    for (const use of record.uses) {
      if (record.items.some((item) => item.id === use.id)) throw new Error(`An item and an embedded schematic are both called ${use.id}. Give each its own id.`);
    }
    checkLinks(record);
    return record;
  }

  const recordOutcome = (proposal, outcome, schemaId, draftId = null) => writeJson(outcomeFile(proposal.id), {
    proposal: proposal.id, schema: schemaId, outcome, ...(draftId && { draft: draftId }), at: now(),
  });

  // Each change a proposal makes, as the user approves it: an item's id, or `contract`.
  const changeKeys = (changes) => [...Object.keys(changes.items), ...changes.removed.map((one) => one.id), ...(changes.contract ? [CONTRACT] : [])];
  // Whether a change is as it was in the proposal replaced (an item the same, or still gone).
  const sameChange = (before, after, key) => {
    if (key === CONTRACT) return before.contract === after.contract;
    const was = before.items.find((item) => item.id === key);
    const is = after.items.find((item) => item.id === key);
    return JSON.stringify(was ?? null) === JSON.stringify(is ?? null);
  };
  const finished = (schemaId, proposalId) => {
    events.emit('changed', schemaId);
    if (proposalId) events.emit('proposal', proposalId);
  };

  // What a new comment is on, checked against `record`: the whole schematic (`schematic`, with where
  // it was put on the overview, `at`, as fractions of it), or an item: its card (`card`, its title,
  // description and card lines), a part of it (`part`), words in it (`quote`, with the part they're
  // in), a point in its content (`point`, as fractions of it), or all of it.
  function commentTarget(record, target) {
    const fraction = (value) => Math.min(1, Math.max(0, Number(value) || 0));
    const at = (value) => value && typeof value === 'object' && { x: fraction(value.x), y: fraction(value.y) };
    if (target?.schematic) return { schematic: true, ...(at(target.at) && { at: at(target.at) }) };
    const item = String(target?.item ?? '');
    if (item !== CONTRACT && !record.items.some((one) => one.id === item) && !record.uses.some((use) => use.id === item)) throw new Error(`There's no ${item} to comment on.`);
    if (target.card) return { item, card: true };
    if (target.point && !target.part && !target.quote) return { item, point: at(target.point) };
    return { item, ...(target.part && { part: String(target.part) }), ...(target.quote?.trim() && { quote: target.quote.trim().slice(0, 500) }) };
  }

  // A comment's target in words, from the record it's on: what the item is called, and the part,
  // or that it's no longer there.
  function describeTarget(record, target) {
    if (target.schematic) return { ...target, title: record.name };
    if (target.item === CONTRACT) return { ...target, title: 'Contract' };
    const use = record.uses.find((one) => one.id === target.item);
    if (use) return { ...target, title: use.id };
    const item = record.items.find((one) => one.id === target.item);
    if (!item) return { ...target, missing: true };
    const found = !target.part || partsOf(item).includes(target.part);
    return { ...target, title: item.title, ...(target.part && found && { partName: partName(item, target.part) }), ...(!found && { partMissing: true }) };
  }

  // Whether what a comment is on is still in `record`: the item, its part, and the words it quotes.
  function stillThere(record, target) {
    if (target.schematic) return true;
    const described = describeTarget(record, target);
    if (described.missing || described.partMissing) return false;
    if (!target.quote || target.card) return true;
    const thing = target.item === CONTRACT ? { contract: record.contract, parameters: record.parameters }
      : record.items.find((one) => one.id === target.item) ?? record.uses.find((one) => one.id === target.item);
    return plainText(thing).includes(plainWords(target.quote));
  }

  async function latestRecord(schema) {
    const latest = schema.line.at(-1);
    return latest ? readDraft(schema.id, latest) : null;
  }

  return {
    events,

    async list() {
      const names = await readdir(path.join(root, 'schemas')).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const groups = new Set((await readGroups()).map((group) => group.id));
      const rows = await Promise.all(names.filter((name) => FILE_ID.test(name)).map(async (id) => {
        const schema = await readSchema(id);
        if (!schema) return null;
        const proposal = await readProposal(id);
        const latest = schema.line.at(-1);
        const record = latest ? await readDraft(id, latest) : proposal;
        return {
          id,
          name: record.name,
          summary: record.summary,
          drafts: schema.line.length,
          latestDraftId: latest ?? null,
          proposal: brief(proposal),
          status: STATUS,
          group: groups.has(schema.group) ? schema.group : null,
          updatedAt: schema.updatedAt,
        };
      }));
      return rows.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    // The groups, by name, each with when it was made, how many schemas are in it and the folder it's
    // in (null for the top level, with its path); and the count of schemas in none.
    async listGroups() {
      const groups = await readGroups();
      const names = await readdir(path.join(root, 'schemas')).catch(() => []);
      const counts = new Map();
      for (const name of names.filter((one) => FILE_ID.test(one))) {
        const schema = await readSchema(name);
        if (!schema) continue;
        const group = groups.some((one) => one.id === schema.group) ? schema.group : null;
        counts.set(group, (counts.get(group) ?? 0) + 1);
      }
      const state = await readFolderState();
      return {
        groups: groups.map(({ id, name, createdAt }) => {
          const folder = state.placement[id] ?? null;
          return { id, name, createdAt, schemas: counts.get(id) ?? 0, folder, path: folderPath(state, folder) };
        }).sort((a, b) => a.name.localeCompare(b.name)),
        ungrouped: counts.get(null) ?? 0,
      };
    },

    // A new group, at the top level or in a folder.
    createGroup(name, folderId = null) {
      return serial(async () => {
        const named = groupName(name);
        const groups = await readGroups();
        if (groups.some((group) => group.name.toLowerCase() === named.toLowerCase())) throw new Error(`There's already a domain called ${named}.`);
        const state = await readFolderState();
        const group = { id: newId(), name: named, createdAt: now() };
        const placed = folderId ? folders.moveDomain(state, group.id, folderId) : null; // checks the folder first
        await writeGroups([...groups, group]);
        if (placed) await writeJson(foldersFile, placed);
        events.emit('changed', null);
        return { id: group.id, name: group.name, folder: folderId ?? null, path: folderPath(state, folderId) };
      });
    },

    renameGroup(id, name) {
      return serial(async () => {
        const named = groupName(name);
        const groups = await readGroups();
        const group = groups.find((one) => one.id === id);
        if (!group) throw new Error(`There's no domain ${id}. list_domains shows the ones there are.`);
        if (groups.some((one) => one.id !== id && one.name.toLowerCase() === named.toLowerCase())) throw new Error(`There's already a domain called ${named}.`);
        group.name = named;
        await writeGroups(groups);
        events.emit('changed', null);
        return { id, name: named };
      });
    },

    // A group goes; its schemas go to none, and nothing else changes.
    deleteGroup(id) {
      return serial(async () => {
        const groups = await readGroups();
        if (!groups.some((one) => one.id === id)) throw new Error(`There's no domain ${id}. list_domains shows the ones there are.`);
        await writeGroups(groups.filter((one) => one.id !== id));
        const state = await readFolderState();
        if (id in state.placement) await writeJson(foldersFile, folders.removeDomain(state, id));
        events.emit('changed', null);
        return { deleted: id };
      });
    },

    // Puts a schema in a group, or in none (null). Only the list changes, so it isn't a change to the
    // schema, and doesn't make it the most recently changed.
    moveSchema(schemaId, groupId) {
      return serial(async () => {
        const schema = await requireSchema(schemaId);
        if (groupId && !(await readGroups()).some((one) => one.id === groupId)) throw new Error(`There's no domain ${groupId}. list_domains shows the ones there are.`);
        const { group, ...rest } = schema;
        await writeJson(path.join(schemaDir(schemaId), 'schema.json'), groupId ? { ...rest, group: groupId } : rest);
        events.emit('changed', schemaId);
        return { schema: schemaId, group: groupId ?? null };
      });
    },

    // --- Folders, organising the groups (see folders.js) ---

    folders: () => readFolderState(),

    // Every folder, for the AI: its path and how much is directly in it.
    async listFolders() {
      const state = await readFolderState();
      return state.folders.map((f) => ({
        id: f.id,
        name: f.name,
        path: folderPath(state, f.id),
        folders: state.folders.filter((one) => one.parentId === f.id).length,
        domains: Object.values(state.placement).filter((folderId) => folderId === f.id).length,
      }));
    },

    createFolder(name, parentId = null) {
      return serial(async () => {
        const state = await readFolderState();
        const id = `folder-${newId()}`;
        const next = await changeFolders(folders.createFolder(state, { id, name, parentId: parentId ?? null }));
        return { id, name: next.folders.find((f) => f.id === id).name, path: folderPath(next, id) };
      });
    },

    renameFolder(id, name) {
      return serial(async () => {
        const next = await changeFolders(folders.renameFolder(await readFolderState(), id, name));
        return { id, name: next.folders.find((f) => f.id === id).name };
      });
    },

    // What was in it moves up a level.
    deleteFolder(id) {
      return serial(async () => {
        await changeFolders(folders.deleteFolder(await readFolderState(), id));
        return { deleted: id };
      });
    },

    moveFolder(id, parentId) {
      return serial(async () => {
        const next = await changeFolders(folders.moveFolder(await readFolderState(), id, parentId ?? null));
        return { id, folder: parentId ?? null, path: folderPath(next, id) };
      });
    },

    // Puts a group in a folder, or at the top level (null).
    moveGroup(groupId, folderId) {
      return serial(async () => {
        const group = await requireGroup(groupId);
        const next = await changeFolders(folders.moveDomain(await readFolderState(), groupId, folderId ?? null));
        return { id: groupId, name: group.name, folder: folderId ?? null, path: folderPath(next, folderId ?? null) };
      });
    },

    // A schema's drafts, newest first, for browsing them.
    async listDrafts(id) {
      const schema = await requireSchema(id);
      const drafts = await Promise.all(schema.line.map(async (draftId, index) => {
        const { note, createdAt } = await readDraft(id, draftId);
        return { id: draftId, number: index + 1, note, createdAt, latest: index === schema.line.length - 1 };
      }));
      return drafts.reverse();
    },

    // The focuses to show for a draft of a schema (or the proposal): its own, and the goals of the
    // drafts before it, newest first and each once, to run again.
    async listFocuses(id, { draftId, proposal = false } = {}) {
      const schema = await requireSchema(id);
      const end = proposal ? schema.line.length : schema.line.indexOf(draftId ?? schema.line.at(-1)) + 1;
      const own = proposal ? (await readProposal(id))?.focus : end ? (await readDraft(id, schema.line[end - 1])).focus : null;
      const seen = new Set(own ? [own.goal] : []);
      const earlier = [];
      for (let i = (proposal ? end : end - 1) - 1; i >= 0; i--) {
        const { focus } = await readDraft(id, schema.line[i]);
        if (!focus || seen.has(focus.goal)) continue;
        seen.add(focus.goal);
        earlier.push({ ...focus, draft: `Draft ${i + 1}` });
      }
      return { current: own ?? null, earlier };
    },

    // A schema's draft (its latest unless told which): its items listed, its links, its uses
    // collapsed or `depth` levels open, its place in the line, and any proposal waiting on it.
    async getSchema(id, { draftId, depth = 0 } = {}) {
      const schema = await requireSchema(id);
      const proposal = await readProposal(id);
      const which = draftId ?? schema.line.at(-1);
      if (!which) throw new Error(`Schematic ${id} has no accepted draft yet: its first is still waiting for the user to accept it.`);
      if (!schema.line.includes(which)) throw new Error(`Schematic ${id} has no draft ${which}.`);
      const record = await readDraft(id, which);
      return {
        id,
        draftId: which,
        number: schema.line.indexOf(which) + 1,
        total: schema.line.length,
        line: schema.line,
        ...(await describe(record, depth)),
        comments: await openCount(id, which),
        proposal: brief(proposal),
      };
    },

    // The change waiting for the user on a schema, in the same shape, with what it changes from the
    // latest draft; null if there's none.
    async getProposal(id, { depth = 0 } = {}) {
      const schema = await requireSchema(id);
      const proposal = await readProposal(id);
      if (!proposal) return null;
      const changes = itemChanges(await latestRecord(schema), proposal);
      return {
        id,
        proposalId: proposal.id,
        basedOn: proposal.basedOn,
        total: schema.line.length,
        line: schema.line,
        ...(await describe(proposal, depth)),
        comments: await openCount(id, ON_PROPOSAL),
        forTheAi: await commentsWaiting(id, proposal),
        changes,
        // Why each item changes, as the AI said: only for what does change.
        reasons: Object.fromEntries(Object.entries(proposal.reasons ?? {}).filter(([itemId]) => (itemId === CONTRACT ? changes.contract || !schema.line.length : changes.items[itemId] || changes.removed.some((one) => one.id === itemId)))),
        // The changes the user has approved (see approveChange), of those there are.
        approved: (proposal.approved ?? []).filter((key) => changeKeys(changes).includes(key)),
      };
    },

    // One item's content, from a draft (its latest unless told which) or the waiting proposal, with
    // the links out of it and into it.
    async getItem(schemaId, itemId, { draftId, proposal = false } = {}) {
      const schema = await requireSchema(schemaId);
      const record = proposal ? await readProposal(schemaId) : await readDraft(schemaId, draftId ?? schema.line.at(-1) ?? 'none');
      if (!record) throw new Error(proposal ? `Schematic ${schemaId} has no proposal waiting.` : `Schematic ${schemaId} has no such draft.`);
      const item = record.items.find((each) => each.id === itemId);
      if (!item) throw new Error(`Schematic ${schemaId} has no item ${itemId}. get_schematic lists its items.`);
      const links = linkGraph(record);
      return {
        ...item,
        linksOut: links.filter(({ from }) => parseLink(from).target === itemId),
        linkedFrom: links.filter(({ to }) => parseLink(to).target === itemId),
      };
    },

    // What's behind each connected pair in a draft or the waiting proposal, in words (see
    // connectionDetails). It needs the items' content, which the app's list hasn't otherwise loaded.
    async getConnections(schemaId, { draftId, proposal = false } = {}) {
      const schema = await requireSchema(schemaId);
      const record = proposal ? await readProposal(schemaId) : await readDraft(schemaId, draftId ?? schema.line.at(-1) ?? 'none');
      if (!record) throw new Error(proposal ? `Schematic ${schemaId} has no proposal waiting.` : `Schematic ${schemaId} has no such draft.`);
      const uses = await Promise.all(record.uses.map((use) => describeUse(use, 0)));
      return connectionDetails({ items: record.items, uses, links: linkGraph(record) });
    },

    // Proposes a new schema, or a change to one (`schemaId`), for the user to accept or discard. A
    // change builds on the proposal already waiting, which it replaces, or else the latest draft.
    propose({ schemaId, note, goal, goalTitle, groupId, ...change }) {
      return serial(async () => {
        const existing = schemaId ? await requireSchema(schemaId) : null;
        if (groupId && !(await readGroups()).some((group) => group.id === groupId)) throw new Error(`There's no domain ${groupId}. list_domains shows the ones there are.`);
        const replaced = existing ? await readProposal(schemaId) : null;
        const { reasons: given, ...changes } = change;
        const base = replaced ?? (existing && await latestRecord(existing));
        const record = await buildRecord(base, { ...changes, note });
        // Why each item changes, for the user reviewing it: those given before carry over, those
        // given now replace them. Each is about an item there is, or was, or the contract.
        const known = new Set([CONTRACT, ...record.items.map((item) => item.id), ...(base?.items ?? []).map((item) => item.id)]);
        for (const id of Object.keys(given ?? {})) if (!known.has(id)) throw new Error(`There's no item ${id} for a reason to be about.`);
        const reasons = { ...(replaced?.reasons ?? {}), ...(given ?? {}) };
        if (Object.keys(reasons).length) record.reasons = reasons;
        // What the user approved stays approved while the AI leaves it as it was.
        const approved = (replaced?.approved ?? []).filter((key) => sameChange(replaced, record, key));
        if (approved.length) record.approved = approved;
        const focus = goal?.trim() ? { goal: goal.trim(), title: focusTitle(goal, goalTitle) } : replaced?.focus;
        if (focus) record.focus = focus;
        if (existing && await embeds(record, existing.id)) throw new Error(`${record.name} can't embed itself, directly or through another schematic.`);

        const id = existing?.id ?? `${Date.now().toString(36)}-${newId()}`;
        if (!existing) await writeSchema({ id, createdAt: now(), line: [], ...(groupId && { group: groupId }) });
        if (replaced) await recordOutcome(replaced, 'replaced', id);
        const proposal = { ...record, id: newId(), createdAt: now(), basedOn: existing?.line.at(-1) ?? null };
        await writeJson(proposalFile(id), proposal);
        if (existing) await writeSchema(existing);
        finished(id, replaced?.id);
        return { schema: id, proposal: proposal.id, ...(replaced && { replaced: replaced.id }) };
      });
    },

    // The user accepts the proposal: it becomes the schema's next draft.
    accept(schemaId) {
      return serial(async () => {
        const schema = await requireSchema(schemaId);
        const proposal = await readProposal(schemaId);
        if (!proposal) throw new Error('There is no proposed change to accept.');
        const { id: proposalId, basedOn, commentsSent, reasons, approved, ...record } = proposal; // (why each item changed, and what the user approved, were for the review)
        const draftId = newId();
        await writeJson(draftFile(schemaId, draftId), { ...record, id: draftId, parentId: schema.line.at(-1) ?? null, createdAt: now() });
        await writeSchema({ ...schema, line: [...schema.line, draftId] });
        await rm(proposalFile(schemaId), { force: true });
        const comments = await readComments(schemaId);
        if (comments.some((comment) => comment.on === ON_PROPOSAL)) await writeComments(schemaId, comments.map((comment) => (comment.on === ON_PROPOSAL ? { ...comment, on: draftId } : comment)));
        await recordOutcome(proposal, 'accepted', schemaId, draftId);
        finished(schemaId, proposalId);
        return { schema: schemaId, draft: draftId };
      });
    },

    // The user asks the AI to deal with their comments on the proposal before they accept it: the
    // AI's wait ends saying so (see proposalOutcome), and it answers them, revising the proposal if
    // it needs to. The comments sent are those it hasn't answered yet.
    sendComments(schemaId) {
      return serial(async () => {
        await requireSchema(schemaId);
        const proposal = await readProposal(schemaId);
        if (!proposal) throw new Error('There is no proposed change to comment on.');
        const open = (await commentsOn(schemaId, ON_PROPOSAL)).filter(forTheAi);
        if (!open.length) throw new Error('There are no comments waiting for the AI.');
        await writeJson(proposalFile(schemaId), { ...proposal, commentsSent: { at: now(), comments: open.map((comment) => comment.id) } });
        finished(schemaId, proposal.id);
        return { schema: schemaId, proposal: proposal.id, comments: open.length };
      });
    },

    // The user approves one of the proposal's changes (an item's id, or `contract`), or takes that
    // back. Like a SmartDoc decision, it's the user's say on it before the whole is accepted; what
    // isn't approved is accepted as proposed. The AI isn't told: it's the user's own checklist.
    approveChange(schemaId, key, flag) {
      return serial(async () => {
        const schema = await requireSchema(schemaId);
        const proposal = await readProposal(schemaId);
        if (!proposal) throw new Error('There is no proposed change to approve.');
        if (!changeKeys(itemChanges(await latestRecord(schema), proposal)).includes(key)) throw new Error(`The proposal doesn't change ${key}.`);
        const approved = new Set(proposal.approved ?? []);
        if (flag) approved.add(key);
        else approved.delete(key);
        await writeJson(proposalFile(schemaId), { ...proposal, approved: [...approved] });
        events.emit('changed', schemaId);
        return { approved: [...approved] };
      });
    },

    // The user discards the proposal. A new schema with no drafts goes with it.
    discard(schemaId) {
      return serial(async () => {
        const schema = await requireSchema(schemaId);
        const proposal = await readProposal(schemaId);
        if (!proposal) throw new Error('There is no proposed change to discard.');
        if (schema.line.length) {
          await rm(proposalFile(schemaId), { force: true });
          const comments = await readComments(schemaId);
          if (comments.some((comment) => comment.on === ON_PROPOSAL)) await writeComments(schemaId, comments.filter((comment) => comment.on !== ON_PROPOSAL));
          await writeSchema(schema);
        } else {
          await rm(schemaDir(schemaId), { recursive: true, force: true });
        }
        await recordOutcome(proposal, 'discarded', schemaId);
        finished(schemaId, proposal.id);
        return { schema: schemaId, removed: !schema.line.length };
      });
    },

    // The comments on a draft (its latest unless told which) or the proposal, oldest first, each
    // saying what it's on: the item and its title, the part and what it's called, and any words quoted.
    async listComments(schemaId, { draftId, proposal = false } = {}) {
      const schema = await requireSchema(schemaId);
      const on = proposal ? ON_PROPOSAL : draftId ?? schema.line.at(-1);
      const record = proposal ? await readProposal(schemaId) : on && await readDraft(schemaId, on);
      if (!record) throw new Error(proposal ? `Schematic ${schemaId} has no proposal waiting.` : `Schematic ${schemaId} has no such draft.`);
      return (await commentsOn(schemaId, on)).map((comment) => ({ ...comment, target: describeTarget(record, comment.target) }));
    },

    // The unanswered comments on the draft that a draft, or the proposal, came from, where what each
    // is on is still there, oldest first: for the user to see, and comment again if they want to.
    // Each says which draft it's from. One the user has commented again is left out.
    async listEarlierComments(schemaId, { draftId, proposal = false } = {}) {
      const schema = await requireSchema(schemaId);
      const on = proposal ? ON_PROPOSAL : draftId ?? schema.line.at(-1);
      const record = proposal ? await readProposal(schemaId) : on && schema.line.includes(on) && await readDraft(schemaId, on);
      if (!record) return [];
      const earlier = proposal ? record.basedOn : schema.line[schema.line.indexOf(on) - 1];
      if (!earlier) return [];
      const comments = await readComments(schemaId);
      const again = new Set(comments.filter((comment) => comment.on === on && comment.from).map((comment) => comment.from));
      const draft = schema.line.indexOf(earlier) + 1;
      return comments
        .filter((comment) => comment.on === earlier && !comment.noFurtherAction && !comment.replies?.length && !again.has(comment.id) && stillThere(record, comment.target))
        .map((comment) => ({ ...comment, target: describeTarget(record, comment.target), earlier: { draftId: earlier, draft } }));
    },

    // The user comments on something in a draft or the proposal: `from`, an earlier comment they're
    // saying again here (see listEarlierComments).
    addComment(schemaId, { draftId, proposal = false, target, text, from }) {
      return serial(async () => {
        const schema = await requireSchema(schemaId);
        const on = proposal ? ON_PROPOSAL : draftId ?? schema.line.at(-1);
        const record = proposal ? await readProposal(schemaId) : on && schema.line.includes(on) && await readDraft(schemaId, on);
        if (!record) throw new Error(proposal ? 'There is no proposal to comment on.' : `Schematic ${schemaId} has no such draft.`);
        const said = String(text ?? '').trim();
        if (!said) throw new Error('A comment needs something said.');
        const comment = {
          id: newId(),
          on,
          target: commentTarget(record, target),
          text: said,
          ...(typeof from === 'string' && from && { from }),
          createdAt: now(),
          replies: [],
        };
        await writeComments(schemaId, [...await readComments(schemaId), comment]);
        events.emit('changed', schemaId);
        return comment;
      });
    },

    // The user takes back one of their comments, with any replies to it.
    deleteComment(schemaId, commentId) {
      return serial(async () => {
        const comments = await readComments(schemaId);
        if (!comments.some((comment) => comment.id === commentId)) throw new Error(`There's no comment ${commentId}.`);
        await writeComments(schemaId, comments.filter((comment) => comment.id !== commentId));
        events.emit('changed', schemaId);
        return { deleted: commentId };
      });
    },

    // The AI answers a comment. `author` is who it is, as the user would know it. It says something,
    // or how it dealt with the comment in a word or two (`outcome`, its own words), or both; with
    // `noFurtherAction` true it judges nothing more is needed, and false takes that back.
    replyToComment(schemaId, commentId, { text, outcome, noFurtherAction, author = 'AI' }) {
      return serial(async () => {
        const comments = await readComments(schemaId);
        const comment = comments.find((one) => one.id === commentId);
        if (!comment) throw new Error(`There's no comment ${commentId} on schematic ${schemaId}. get_comments lists them.`);
        const said = String(text ?? '').trim();
        const how = String(outcome ?? '').trim().replace(/\s+/g, ' ');
        if (!said && !how) throw new Error('A reply needs something said, or an outcome.');
        if (how.length > OUTCOME_MAX) throw new Error(`An outcome is a word or two: ${OUTCOME_MAX} characters at most.`);
        const reply = { id: newId(), author, ...(said && { text: said }), ...(how && { outcome: how }), createdAt: now() };
        comment.replies = [...(comment.replies ?? []), reply];
        if (how) comment.outcome = how;
        if (noFurtherAction === true) comment.noFurtherAction = { by: 'ai', at: now() };
        else if (noFurtherAction === false) comment.noFurtherAction = null;
        await writeComments(schemaId, comments);
        events.emit('changed', schemaId);
        return { comment: commentId, reply: reply.id, ...(comment.outcome && { outcome: comment.outcome }), noFurtherAction: Boolean(comment.noFurtherAction) };
      });
    },

    // The user marks a comment as needing no further action, or takes that back to reopen it.
    setNoFurtherAction(schemaId, commentId, flag) {
      return serial(async () => {
        const comments = await readComments(schemaId);
        const comment = comments.find((one) => one.id === commentId);
        if (!comment) throw new Error(`There's no comment ${commentId}.`);
        comment.noFurtherAction = flag ? { by: 'user', at: now() } : null;
        await writeComments(schemaId, comments);
        events.emit('changed', schemaId);
        return { comment: commentId, noFurtherAction: Boolean(comment.noFurtherAction) };
      });
    },

    // What became of a proposal: accepted, discarded or replaced, or comments the user has sent the AI
    // and it hasn't answered; null while it's waiting; throws if there's no such proposal.
    async proposalOutcome(id) {
      const outcome = await readJson(outcomeFile(id));
      if (outcome) return outcome;
      const names = await readdir(path.join(root, 'schemas')).catch(() => []);
      for (const name of names) {
        if (!FILE_ID.test(name)) continue;
        const proposal = await readProposal(name);
        if (proposal?.id !== id) continue;
        // Still waiting, unless the user has sent the AI comments it hasn't answered yet.
        const { sent } = await commentsWaiting(name, proposal);
        if (!sent) return null;
        return {
          proposal: id,
          schema: name,
          outcome: 'comments',
          comments: sent,
          at: proposal.commentsSent.at,
          next: 'The user wants their comments dealt with before they accept. Read them with get_comments (proposal: true), answer each with reply_to_comment, and propose_schematic again if they need changes. Then wait again.',
        };
      }
      throw new Error(`There's no proposal ${id}.`);
    },
  };
}
