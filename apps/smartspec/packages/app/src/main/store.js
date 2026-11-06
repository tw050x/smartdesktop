import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACT, checkItem, checkLinks, connectionDetails, itemChanges, linkGraph, parseLink } from './items.js';

// Schemas live in the app's data folder, one folder each:
//
//   schemas/<schema id>/
//     schema.json              its line of drafts, oldest first, and when it last changed
//     drafts/<draft id>.json   one accepted version; never changed once written
//     proposal.json            the change the AI proposes, waiting for the user; not yet a draft
//   proposals/<proposal id>.json   what became of each proposal, for `smartspec wait`
//
// A draft holds a name, a summary and a contract, which are what show when it's collapsed inside
// another schema; its items (see items.js); the parameters a use of it can set; and the schemas it
// embeds, each pinned to one of their drafts; and its focus, if the AI was given one: the goal the
// user set it, which belongs to that draft and isn't carried to the next. Every change is an
// AI's, and waits as a proposal until the user accepts it.

const USE_ID = /^[a-z0-9][\w-]*$/i;
const FILE_ID = /^[\w-]+$/;
const now = () => new Date().toISOString();
const newId = () => randomUUID().slice(0, 8);

// Until implementations can be linked and tested, every schema is a design.
const STATUS = 'design-only';

// A focus's name: its title, else its goal cut short.
const focusTitle = (goal, title) => title?.trim() || (goal.trim().length > 48 ? `${goal.trim().slice(0, 47).trimEnd()}…` : goal.trim());

export function createStore(root, { events = new EventEmitter() } = {}) {
  const schemaDir = (id) => {
    if (!FILE_ID.test(id)) throw new Error(`No schema ${id}.`);
    return path.join(root, 'schemas', id);
  };
  const draftFile = (schemaId, draftId) => {
    if (!FILE_ID.test(draftId)) throw new Error(`No draft ${draftId}.`);
    return path.join(schemaDir(schemaId), 'drafts', `${draftId}.json`);
  };
  const proposalFile = (schemaId) => path.join(schemaDir(schemaId), 'proposal.json');
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
  const readDraft = (schemaId, draftId) => readJson(draftFile(schemaId, draftId));
  const readProposal = (schemaId) => readJson(proposalFile(schemaId));
  const writeSchema = (schema) => writeJson(path.join(schemaDir(schema.id), 'schema.json'), { ...schema, updatedAt: now() });

  async function requireSchema(id) {
    const schema = await readSchema(id);
    if (!schema) throw new Error(`No schema ${id}. list_schemas shows the ones there are.`);
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
  const itemBrief = ({ id, kind, title, description, mediaType }) => ({ id, kind, title, ...(description && { description }), ...(mediaType && { mediaType }) });

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
      if (!draftId) throw new Error(`Schema ${use.schemaId} has no accepted draft yet, so it can't be embedded. The user has to accept its proposal first.`);
      if (!target.line.includes(draftId)) throw new Error(`Schema ${use.schemaId} has no draft ${draftId}.`);
      const draft = await readDraft(use.schemaId, draftId);
      const declared = new Set(draft.parameters.map((parameter) => parameter.name));
      for (const key of Object.keys(use.with ?? {})) {
        if (!declared.has(key)) throw new Error(`${draft.name} has no parameter "${key}". A use can only set the parameters its schema declares: ${[...declared].join(', ') || 'it has none'}.`);
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
    if (!record.name || !record.summary) throw new Error('A schema needs a name and a summary.');
    const names = record.parameters.map((parameter) => parameter.name);
    if (new Set(names).size !== names.length) throw new Error('Two parameters have the same name.');

    for (const id of removeItems) {
      if (!record.items.some((item) => item.id === id)) throw new Error(`There's no item ${id} to remove.`);
    }
    const next = record.items.filter((item) => !removeItems.includes(item.id));
    for (const item of items) {
      if (!USE_ID.test(item.id ?? '')) throw new Error(`"${item.id}" can't be an item's id: use letters, numbers, - and _.`);
      if (item.id === CONTRACT) throw new Error(`"${CONTRACT}" is the schema's contract, so it can't be an item's id.`);
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
      if (record.items.some((item) => item.id === use.id)) throw new Error(`An item and an embedded schema are both called ${use.id}. Give each its own id.`);
    }
    checkLinks(record);
    return record;
  }

  const recordOutcome = (proposal, outcome, schemaId, draftId = null) => writeJson(outcomeFile(proposal.id), {
    proposal: proposal.id, schema: schemaId, outcome, ...(draftId && { draft: draftId }), at: now(),
  });

  const finished = (schemaId, proposalId) => {
    events.emit('changed', schemaId);
    if (proposalId) events.emit('proposal', proposalId);
  };

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
          updatedAt: schema.updatedAt,
        };
      }));
      return rows.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
      if (!which) throw new Error(`Schema ${id} has no accepted draft yet: its first is still waiting for the user to accept it.`);
      if (!schema.line.includes(which)) throw new Error(`Schema ${id} has no draft ${which}.`);
      const record = await readDraft(id, which);
      return {
        id,
        draftId: which,
        number: schema.line.indexOf(which) + 1,
        total: schema.line.length,
        line: schema.line,
        ...(await describe(record, depth)),
        proposal: brief(proposal),
      };
    },

    // The change waiting for the user on a schema, in the same shape, with what it changes from the
    // latest draft; null if there's none.
    async getProposal(id, { depth = 0 } = {}) {
      const schema = await requireSchema(id);
      const proposal = await readProposal(id);
      if (!proposal) return null;
      return {
        id,
        proposalId: proposal.id,
        basedOn: proposal.basedOn,
        total: schema.line.length,
        line: schema.line,
        ...(await describe(proposal, depth)),
        changes: itemChanges(await latestRecord(schema), proposal),
      };
    },

    // One item's content, from a draft (its latest unless told which) or the waiting proposal, with
    // the links out of it and into it.
    async getItem(schemaId, itemId, { draftId, proposal = false } = {}) {
      const schema = await requireSchema(schemaId);
      const record = proposal ? await readProposal(schemaId) : await readDraft(schemaId, draftId ?? schema.line.at(-1) ?? 'none');
      if (!record) throw new Error(proposal ? `Schema ${schemaId} has no proposal waiting.` : `Schema ${schemaId} has no such draft.`);
      const item = record.items.find((each) => each.id === itemId);
      if (!item) throw new Error(`Schema ${schemaId} has no item ${itemId}. get_schema lists its items.`);
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
      if (!record) throw new Error(proposal ? `Schema ${schemaId} has no proposal waiting.` : `Schema ${schemaId} has no such draft.`);
      const uses = await Promise.all(record.uses.map((use) => describeUse(use, 0)));
      return connectionDetails({ items: record.items, uses, links: linkGraph(record) });
    },

    // Proposes a new schema, or a change to one (`schemaId`), for the user to accept or discard. A
    // change builds on the proposal already waiting, which it replaces, or else the latest draft.
    propose({ schemaId, note, goal, goalTitle, ...change }) {
      return serial(async () => {
        const existing = schemaId ? await requireSchema(schemaId) : null;
        const replaced = existing ? await readProposal(schemaId) : null;
        const record = await buildRecord(replaced ?? (existing && await latestRecord(existing)), { ...change, note });
        const focus = goal?.trim() ? { goal: goal.trim(), title: focusTitle(goal, goalTitle) } : replaced?.focus;
        if (focus) record.focus = focus;
        if (existing && await embeds(record, existing.id)) throw new Error(`${record.name} can't embed itself, directly or through another schema.`);

        const id = existing?.id ?? `${Date.now().toString(36)}-${newId()}`;
        if (!existing) await writeSchema({ id, createdAt: now(), line: [] });
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
        const { id: proposalId, basedOn, ...record } = proposal;
        const draftId = newId();
        await writeJson(draftFile(schemaId, draftId), { ...record, id: draftId, parentId: schema.line.at(-1) ?? null, createdAt: now() });
        await writeSchema({ ...schema, line: [...schema.line, draftId] });
        await rm(proposalFile(schemaId), { force: true });
        await recordOutcome(proposal, 'accepted', schemaId, draftId);
        finished(schemaId, proposalId);
        return { schema: schemaId, draft: draftId };
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
          await writeSchema(schema);
        } else {
          await rm(schemaDir(schemaId), { recursive: true, force: true });
        }
        await recordOutcome(proposal, 'discarded', schemaId);
        finished(schemaId, proposal.id);
        return { schema: schemaId, removed: !schema.line.length };
      });
    },

    // What became of a proposal; null while it's waiting; throws if there's no such proposal.
    async proposalOutcome(id) {
      const outcome = await readJson(outcomeFile(id));
      if (outcome) return outcome;
      const names = await readdir(path.join(root, 'schemas')).catch(() => []);
      for (const name of names) {
        if (FILE_ID.test(name) && (await readProposal(name))?.id === id) return null;
      }
      throw new Error(`There's no proposal ${id}.`);
    },
  };
}
