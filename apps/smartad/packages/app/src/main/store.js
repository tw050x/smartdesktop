import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Ads live in the app's data folder, one folder each:
//
//   ads/<ad id>/
//     meta.json              its name, when it was made and last changed, and its line of drafts
//                            (their ids, oldest first)
//     drafts/<n>.json        draft n, one accepted version: { id, n, createdAt, note, goal,
//                            goalTitle, content }; never changed once written
//     proposal.json          the AI's proposal, waiting for the user; not yet a draft
//   proposals/<proposal id>.json   what became of each proposal, for `smartad wait`
//
// An ad's content (its layers, sizes and animation) is the AI's, and opaque here: the store keeps
// it as it's given, once `validate` has passed it (see ad-model.js, which the app gives the store;
// it's the identity until then). Every change is an AI's, and waits as a proposal until the user
// accepts it: an ad's first proposal makes the ad, which has no draft until the user accepts it,
// as SmartSpec's first proposal makes a schematic. A proposal holds the whole content it proposes,
// replacing any proposal waiting.
//
// An ad's icon isn't kept here: it belongs to this Mac (item-icons.js), never to the ad or its
// drafts. Comments will come later, as SmartSpec's.

const FILE_ID = /^[\w-]+$/;
const NAME_MAX = 200;
const REASON_MAX = 300;
const now = () => new Date().toISOString();
const newId = () => randomUUID().slice(0, 8);

// A name as it's kept: trimmed, its spacing squashed. Refused if empty or too long.
function adName(name) {
  const named = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!named) throw new Error('An ad needs a name.');
  if (named.length > NAME_MAX) throw new Error(`An ad's name can be up to ${NAME_MAX} characters.`);
  return named;
}

// A goal's short name: its title, else the goal cut short.
const goalName = (goal, title) => title?.trim() || (goal.trim().length > 48 ? `${goal.trim().slice(0, 47).trimEnd()}…` : goal.trim());

// `validate(content)` checks an ad's content before it's proposed, and gives back what to keep (it
// may tidy it): it throws, saying what's wrong, to refuse it.
export function createStore(root, { events = new EventEmitter(), validate = (content) => content } = {}) {
  const adDir = (id) => {
    if (!FILE_ID.test(String(id))) throw new Error(`No ad ${id}.`);
    return path.join(root, 'ads', id);
  };
  const metaFile = (id) => path.join(adDir(id), 'meta.json');
  const draftFile = (id, n) => path.join(adDir(id), 'drafts', `${n}.json`);
  const proposalFile = (id) => path.join(adDir(id), 'proposal.json');
  const outcomeFile = (id) => {
    if (!FILE_ID.test(String(id))) throw new Error(`No proposal ${id}.`);
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

  const readMeta = (id) => readJson(metaFile(id));
  const writeMeta = (meta) => writeJson(metaFile(meta.id), { ...meta, updatedAt: now() });
  const readProposal = (id) => readJson(proposalFile(id));
  async function requireAd(id) {
    const meta = await readMeta(id);
    if (!meta) throw new Error(`No ad ${id}. list_ads shows the ones there are.`);
    return meta;
  }
  // A draft by its id, or the latest with none given; null if the ad has no such draft.
  async function readDraft(meta, draftId = null) {
    const which = draftId ?? meta.line.at(-1);
    const at = meta.line.indexOf(which);
    if (!which || at < 0) return null;
    return readJson(draftFile(meta.id, at + 1));
  }

  // One change at a time, so two windows or AIs can't both act on the same proposal.
  let tail = Promise.resolve();
  const serial = (change) => {
    const result = tail.then(change);
    tail = result.catch(() => {});
    return result;
  };

  const brief = (proposal) => proposal && { id: proposal.id, note: proposal.note, createdAt: proposal.createdAt };
  const goalOf = (record) => (record?.goal ? { goal: record.goal, goalTitle: record.goalTitle ?? null } : { goal: null, goalTitle: null });
  const recordOutcome = (proposal, outcome, adId, draftId = null) => writeJson(outcomeFile(proposal.id), {
    proposal: proposal.id, ad: adId, outcome, ...(draftId && { draft: draftId }), at: now(),
  });
  const finished = (adId, proposalId) => {
    events.emit('changed', adId);
    if (proposalId) events.emit('proposal', proposalId);
  };

  // Why each part changes, as the AI says it: one short sentence each, keyed by what it's about
  // (a layer's id, say; the content is opaque here, so the keys aren't checked against it).
  function checkReasons(reasons) {
    if (reasons === undefined || reasons === null) return {};
    if (typeof reasons !== 'object' || Array.isArray(reasons)) throw new Error('reasons is an object: what each reason is about, to the reason.');
    for (const [key, reason] of Object.entries(reasons)) {
      if (typeof reason !== 'string' || !reason.trim()) throw new Error(`The reason for ${key} is empty.`);
      if (reason.length > REASON_MAX) throw new Error(`The reason for ${key} is longer than ${REASON_MAX} characters: keep it to a sentence.`);
    }
    return Object.fromEntries(Object.entries(reasons).map(([key, reason]) => [key, reason.trim()]));
  }

  return {
    events,

    // Every ad, most recently changed first: its name, how many drafts it has, and any proposal
    // waiting for the user.
    async list() {
      const names = await readdir(path.join(root, 'ads')).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const rows = await Promise.all(names.filter((name) => FILE_ID.test(name)).map(async (id) => {
        const meta = await readMeta(id);
        if (!meta) return null;
        const proposal = await readProposal(id);
        return {
          id,
          name: meta.name,
          drafts: meta.line.length,
          latestDraftId: meta.line.at(-1) ?? null,
          proposal: brief(proposal),
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        };
      }));
      return rows.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    // An ad's drafts, newest first, for the drafts' card: each with its number, note and goal.
    async listDrafts(id) {
      const meta = await requireAd(id);
      const drafts = await Promise.all(meta.line.map(async (draftId, index) => {
        const { note, createdAt, goal, goalTitle } = await readJson(draftFile(id, index + 1));
        return { id: draftId, number: index + 1, note, createdAt, ...goalOf({ goal, goalTitle }), latest: index === meta.line.length - 1 };
      }));
      return drafts.reverse();
    },

    // One of an ad's drafts (its latest unless told which), with its content, its place in the
    // line, and any proposal waiting on it.
    async get(id, { draftId } = {}) {
      const meta = await requireAd(id);
      if (!meta.line.length) throw new Error(`Ad ${id} has no accepted draft yet: its first is still waiting for the user to accept it. get_proposal reads it.`);
      const draft = await readDraft(meta, draftId ?? null);
      if (!draft) throw new Error(`Ad ${id} has no draft ${draftId}.`);
      return {
        id,
        name: meta.name,
        draftId: draft.id,
        number: draft.n,
        total: meta.line.length,
        note: draft.note,
        ...goalOf(draft),
        createdAt: draft.createdAt,
        content: draft.content,
        proposal: brief(await readProposal(id)),
      };
    },

    // The proposal waiting for the user on an ad, with its content and the draft it's based on;
    // null if there's none.
    async getProposal(id) {
      const meta = await requireAd(id);
      const proposal = await readProposal(id);
      if (!proposal) return null;
      return {
        id,
        proposalId: proposal.id,
        name: meta.name,
        basedOn: proposal.basedOn,
        // The draft it's based on, by number, and how many there are: it becomes draft total + 1.
        basedOnNumber: proposal.basedOn ? meta.line.indexOf(proposal.basedOn) + 1 : null,
        total: meta.line.length,
        note: proposal.note,
        ...goalOf(proposal),
        reasons: proposal.reasons ?? {},
        content: proposal.content,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
      };
    },

    // Proposes a new ad (no `adId`: `name` is needed), or a change to one, for the user to accept
    // or discard. `content` is the whole ad as proposed, replacing any proposal waiting. Reasons
    // given before carry over, those given now replacing them; so does the goal, unless a new one
    // is given.
    propose({ adId = null, name, content, goal, goalTitle, note, reasons } = {}) {
      return serial(async () => {
        const existing = adId ? await requireAd(adId) : null;
        if (!existing && (name === undefined || name === null)) throw new Error('A new ad needs a name.');
        if (existing && name !== undefined && name !== null && adName(name) !== existing.name) throw new Error('A proposal doesn\'t rename an ad: rename_ad does, when the user asks.');
        const said = String(note ?? '').trim();
        if (!said) throw new Error('A proposal needs a note: what it proposes and why, for the user.');
        if (content === undefined || content === null || typeof content !== 'object') throw new Error('A proposal needs the ad\'s content, as an object.');
        const kept = await validate(content);
        const replaced = existing ? await readProposal(existing.id) : null;
        const given = checkReasons(reasons);
        const allReasons = { ...(replaced?.reasons ?? {}), ...given };
        const aim = goal?.trim() ? { goal: goal.trim(), goalTitle: goalName(goal, goalTitle) } : goalOf(replaced);

        const id = existing?.id ?? `${Date.now().toString(36)}-${newId()}`;
        const meta = existing ?? { id, name: adName(name), createdAt: now(), line: [] };
        const at = now();
        const proposal = {
          id: newId(),
          basedOn: meta.line.at(-1) ?? null,
          content: kept,
          goal: aim.goal,
          goalTitle: aim.goalTitle,
          note: said,
          reasons: allReasons,
          createdAt: replaced?.createdAt ?? at,
          updatedAt: at,
        };
        if (replaced) await recordOutcome(replaced, 'replaced', id);
        await writeJson(proposalFile(id), proposal);
        await writeMeta(meta);
        finished(id, replaced?.id);
        return { ad: id, proposal: proposal.id, ...(replaced && { replaced: replaced.id }) };
      });
    },

    // The user accepts the proposal: it becomes the ad's next draft.
    accept(id) {
      return serial(async () => {
        const meta = await requireAd(id);
        const proposal = await readProposal(id);
        if (!proposal) throw new Error('There is no proposal to accept.');
        const n = meta.line.length + 1;
        const draft = { id: newId(), n, createdAt: now(), note: proposal.note, goal: proposal.goal ?? null, goalTitle: proposal.goalTitle ?? null, content: proposal.content };
        await writeJson(draftFile(id, n), draft);
        await writeMeta({ ...meta, line: [...meta.line, draft.id] });
        await rm(proposalFile(id), { force: true });
        await recordOutcome(proposal, 'accepted', id, draft.id);
        finished(id, proposal.id);
        return { ad: id, draft: draft.id, number: n };
      });
    },

    // The user discards the proposal. A new ad with no drafts goes with it.
    discard(id) {
      return serial(async () => {
        const meta = await requireAd(id);
        const proposal = await readProposal(id);
        if (!proposal) throw new Error('There is no proposal to discard.');
        if (meta.line.length) {
          await rm(proposalFile(id), { force: true });
          await writeMeta(meta);
        } else {
          await rm(adDir(id), { recursive: true, force: true });
        }
        await recordOutcome(proposal, 'discarded', id);
        finished(id, proposal.id);
        return { ad: id, removed: !meta.line.length };
      });
    },

    // Renames an ad, straight away (the user on home, or the AI when they ask it to).
    rename(id, name) {
      return serial(async () => {
        const meta = await requireAd(id);
        const named = adName(name);
        await writeMeta({ ...meta, name: named });
        events.emit('changed', id);
        return { ad: id, name: named };
      });
    },

    // An ad goes, with its drafts and proposal (the user deleting it, asked first): an AI waiting
    // on its proposal hears it was discarded.
    delete(id) {
      return serial(async () => {
        await requireAd(id);
        const proposal = await readProposal(id);
        await rm(adDir(id), { recursive: true, force: true });
        if (proposal) await recordOutcome(proposal, 'discarded', id);
        finished(id, proposal?.id);
        return { deleted: id };
      });
    },

    // What became of a proposal: accepted, discarded or replaced; null while it's waiting; throws
    // if there's no such proposal.
    async proposalOutcome(proposalId) {
      const outcome = await readJson(outcomeFile(proposalId));
      if (outcome) return outcome;
      const names = await readdir(path.join(root, 'ads')).catch(() => []);
      for (const name of names) {
        if (!FILE_ID.test(name)) continue;
        if ((await readProposal(name))?.id === proposalId) return null;
      }
      throw new Error(`There's no proposal ${proposalId}.`);
    },
  };
}
