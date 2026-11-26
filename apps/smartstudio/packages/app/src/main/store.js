import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Projects live in the app's data folder, one folder each:
//
//   projects/<project id>/project.json        { id, name, description, createdAt, updatedAt, takes }
//   projects/<project id>/media/<take id>.<ext>   what each finished take made
//   projects/<project id>/media/<take id>.level.json   how loud it is over time (see setLevels)
//
// A project is something being made (a song, a clip, an advert's soundtrack), and its takes are
// what was asked for and what came back, oldest first. A take is
// { id, kind, prompt, lyrics, seconds, seed, by, status, job, file, error, createdAt, startedAt,
//   finishedAt, unread, from, planSeed, notes }:
//   - kind, 'music' or 'video' (KINDS);
//   - prompt, what to make; lyrics, a song's words (music only, '' for instrumental);
//   - seconds, how long; seed, the number that makes a take again the same way;
//   - by, 'user' (asked for in the project's tab) or 'ai' (through the MCP server);
//   - status, 'queued' (not yet sent), 'running' (sent to the generation server, its `job`
//     { server, promptId } there), 'done' (`file` in media/) or 'failed' (`error` says why);
//   - unread, 'new' once a take the AI asked for has finished, until the user has seen it;
//   - from, for a take that remakes part of another (music only, so far): { take, start, end },
//     the take it remade and the stretch, in seconds, made again; the rest is that take's. null
//     for a take made from nothing;
//   - planSeed, the seed the song's plan was made with (ACE-Step's language model plans the song
//     before it's rendered): the take's own seed, or for a remade part the plan of the take it
//     remade, so the new part follows the song as it was planned (see workflows.js);
//   - notes, what the user (or the AI) said about stretches of it: { id, start, end, text, by, at },
//     in seconds, by 'user' or 'ai' (`n-…` ids).
// Ids are short and made here (`t-…` for takes). A project's icon isn't kept here
// (item-icons.js), nor how far along a running take is: generator.js says so as it goes.

export const KINDS = ['music', 'video'];
export const STATUSES = ['queued', 'running', 'done', 'failed'];
// How long a take can be, in seconds, for each kind (workflows.js holds the details).
export const LIMITS = { music: { min: 5, max: 240, default: 60 }, video: { min: 2, max: 20, default: 5 } };
const FILE_ID = /^[\w-]+$/;
const MEDIA_FILE = /^t-\w+\.(flac|mp3|wav|ogg|opus|mp4|webm|mov|png|webp)$/;
const TAKE_ID = /^t-\w+$/;
const NOTE_MAX = 2000;
const NOTES_MAX = 200; // on one take
// A remade part is at least this long, in seconds: shorter, and there's nothing to remake.
export const MIN_PART = 1;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const PROMPT_MAX = 4000;
const LYRICS_MAX = 10_000;
const ERROR_MAX = 2000;
const now = () => new Date().toISOString();
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 6);

const squash = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');

function named(name, what = 'A project') {
  const said = squash(name);
  if (!said) throw new Error(`${what} needs a name.`);
  if (said.length > NAME_MAX) throw new Error(`${what}'s name can be up to ${NAME_MAX} characters.`);
  return said;
}
function projectDescription(description) {
  const said = String(description ?? '').trim();
  if (said.length > DESCRIPTION_MAX) throw new Error(`A project's description can be up to ${DESCRIPTION_MAX} characters.`);
  return said;
}

// A name for a project from the first thing asked of it: its first few words.
export function nameFrom(prompt) {
  const words = squash(prompt).split(' ').filter(Boolean);
  if (!words.length) return 'Untitled project';
  const short = words.slice(0, 6).join(' ').replace(/[,.;:!?-]+$/, '');
  const name = short.length > 60 ? `${short.slice(0, 57)}…` : short;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// What's asked for in a take, checked, each mistake said plainly.
export function takeFields({ kind, prompt, lyrics = '', seconds, seed, by = 'user', from = null, planSeed = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`A take's kind is one of ${KINDS.join(' or ')}.`);
  const said = String(prompt ?? '').trim();
  if (!said) throw new Error('Say what to make: the prompt is empty.');
  if (said.length > PROMPT_MAX) throw new Error(`The prompt can be up to ${PROMPT_MAX} characters.`);
  const words = kind === 'music' ? String(lyrics ?? '').trim() : '';
  if (words.length > LYRICS_MAX) throw new Error(`The lyrics can be up to ${LYRICS_MAX} characters.`);
  const { min, max, default: usual } = LIMITS[kind];
  const length = seconds === undefined || seconds === null ? usual : Number(seconds);
  if (!Number.isFinite(length) || length < min || length > max) throw new Error(`A ${kind} take is ${min} to ${max} seconds long.`);
  const number = seed === undefined || seed === null ? Math.floor(Math.random() * 2 ** 32) : Number(seed);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('The seed is a whole number, 0 or more.');
  const total = Math.round(length * 10) / 10;
  let part = null;
  if (from) {
    if (kind !== 'music') throw new Error('Only music can have part of it made again, so far.');
    part = { take: String(from.take ?? ''), ...stretch(from.start, from.end, total, 'The part to make again') };
    if (!TAKE_ID.test(part.take)) throw new Error('Say which take to make part of again.');
    if (part.end - part.start < MIN_PART) throw new Error(`The part to make again is at least ${MIN_PART} second long.`);
  }
  const plan = planSeed === null || planSeed === undefined ? number : Number(planSeed);
  if (!Number.isSafeInteger(plan) || plan < 0) throw new Error('The plan seed is a whole number, 0 or more.');
  return { kind, prompt: said, lyrics: words, seconds: total, seed: number, by: by === 'ai' ? 'ai' : 'user', from: part, planSeed: plan };
}

// A stretch of a take, in seconds from its start (to a tenth), checked against how long it is.
export function stretch(start, end, seconds, what = 'The stretch') {
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`${what} needs a start and an end, in seconds.`);
  if (from < 0 || to > seconds + 0.05) throw new Error(`${what} is within the take: 0 to ${seconds} seconds.`);
  if (to <= from) throw new Error(`${what} ends after it starts.`);
  return { start: Math.round(from * 10) / 10, end: Math.round(Math.min(to, seconds) * 10) / 10 };
}

// How loud a take is over time, as the app measured it from its sound (studio.js, as it draws the
// take's waveform): `rate` measures a second, each the loudest moment (`peak`) and the average
// (`rms`), as amplitudes from 0 to 1. analysis.js reads them.
export function levelsFields({ rate, peak, rms } = {}) {
  const per = Number(rate);
  if (!Number.isFinite(per) || per <= 0 || per > 1000) throw new Error('Levels need a rate: measures a second.');
  const list = (values) => {
    if (!Array.isArray(values) || values.length > 240 * 1000) throw new Error('Levels are lists of amplitudes.');
    return values.map((value) => Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 10000) / 10000);
  };
  const levels = { rate: per, peak: list(peak), rms: list(rms) };
  if (levels.peak.length !== levels.rms.length) throw new Error('Levels need as many peaks as averages.');
  return levels;
}

export function createStore(root, { events = new EventEmitter() } = {}) {
  const folderOf = (id) => {
    if (!FILE_ID.test(String(id))) throw new Error(`No project ${id}.`);
    return path.join(root, 'projects', id);
  };
  const projectFile = (id) => path.join(folderOf(id), 'project.json');

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
  async function requireProject(id) {
    const project = await readJson(projectFile(id));
    if (!project) throw new Error(`No project ${id}. list_projects shows the ones there are.`);
    return project;
  }

  // One change at a time, so two windows, the AI and the generator can't both write a project.
  let tail = Promise.resolve();
  const serial = (change) => {
    const result = tail.then(change);
    tail = result.catch(() => {});
    return result;
  };
  // A change to a project: `change(project)` changes it in place and gives the result, then it's
  // saved. `touch`: whether it counts as the project changing (home lists the latest first).
  const changing = (id, change, { touch = true } = {}) => serial(async () => {
    const project = await requireProject(id);
    const result = await change(project);
    if (touch) project.updatedAt = now();
    await writeJson(projectFile(id), project);
    events.emit('changed', id);
    return result;
  });
  function findTake(project, takeId) {
    const take = project.takes.find((one) => one.id === takeId);
    if (!take) throw new Error(`No take ${takeId} in this project.`);
    return take;
  }

  const summary = (project) => {
    const last = project.takes.at(-1) ?? null;
    return {
      id: project.id,
      name: project.name,
      description: project.description || null,
      takes: project.takes.length,
      kinds: KINDS.filter((kind) => project.takes.some((take) => take.kind === kind)),
      running: project.takes.filter((take) => take.status === 'queued' || take.status === 'running').length,
      unread: project.takes.filter((take) => take.unread).length,
      last: last && { kind: last.kind, status: last.status, prompt: last.prompt },
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  };

  async function list() {
    let ids = [];
    try {
      ids = (await readdir(path.join(root, 'projects'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && FILE_ID.test(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return (await Promise.all(ids.map((id) => readJson(projectFile(id))))).filter(Boolean);
  }

  return {
    events,

    // Every project, most recently changed first.
    list: async () => (await list()).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),

    create({ name, description = '' } = {}) {
      return serial(async () => {
        const time = now();
        const project = {
          id: `${Date.now().toString(36)}-${shortId()}`,
          name: named(name ?? 'Untitled project'),
          description: projectDescription(description),
          createdAt: time,
          updatedAt: time,
          takes: [],
        };
        await writeJson(projectFile(project.id), project);
        events.emit('changed', project.id);
        return { project: project.id, name: project.name };
      });
    },

    // The whole project: its takes, oldest first.
    async get(id) {
      const project = await requireProject(id);
      // (Takes made before notes and remade parts were kept have neither.)
      return { ...summary(project), takes: project.takes.map((take) => ({ from: null, planSeed: take.seed, notes: [], ...take })) };
    },

    rename(id, { name, description }) {
      return changing(id, (project) => {
        if (name !== undefined) project.name = named(name);
        if (description !== undefined) project.description = projectDescription(description);
        return { project: id, name: project.name, description: project.description || null };
      });
    },

    delete: (id) => serial(async () => {
      await requireProject(id);
      await rm(folderOf(id), { recursive: true, force: true });
      events.emit('changed', id);
    }),

    // --- Takes ---

    // A new take, queued: the generator sends it on. A project still called what it was made as
    // ("Untitled project") is named after its first take.
    addTake(id, fields) {
      return changing(id, (project) => {
        const taken = new Set(project.takes.map((take) => take.id));
        let takeId;
        do takeId = `t-${shortId()}`; while (taken.has(takeId));
        const take = { id: takeId, ...takeFields(fields), status: 'queued', job: null, file: null, error: null, createdAt: now(), startedAt: null, finishedAt: null, unread: null, notes: [] };
        if (take.from) {
          const source = findTake(project, take.from.take);
          if (source.kind !== take.kind || source.status !== 'done' || !source.file) throw new Error(`Take ${source.id} isn't a finished ${take.kind} take, so part of it can't be made again.`);
        }
        project.takes.push(take);
        if (project.name === 'Untitled project' && project.takes.length === 1) project.name = nameFrom(take.prompt);
        return { ...take };
      });
    },

    // The generator's progress on a take: sent, finished (with its file) or failed (with why).
    updateTake(id, takeId, change) {
      const finishing = change.status === 'done' || change.status === 'failed';
      return changing(id, (project) => {
        const take = findTake(project, takeId);
        if (change.status !== undefined) {
          if (!STATUSES.includes(change.status)) throw new Error(`A take's status is one of ${STATUSES.join(', ')}.`);
          take.status = change.status;
          if (change.status === 'running' && !take.startedAt) take.startedAt = now();
          if (finishing) {
            take.finishedAt = now();
            if (take.by === 'ai') take.unread = 'new';
          }
        }
        if (change.job !== undefined) take.job = change.job;
        if (change.file !== undefined) {
          if (change.file !== null && !MEDIA_FILE.test(change.file)) throw new Error(`Not a take's file: ${change.file}`);
          take.file = change.file;
        }
        if (change.error !== undefined) take.error = change.error === null ? null : String(change.error).slice(0, ERROR_MAX);
        return { ...take };
      }, { touch: finishing });
    },

    // The user has seen a take the AI asked for.
    markSeen(id, takeId) {
      return changing(id, (project) => {
        findTake(project, takeId).unread = null;
        return { take: takeId };
      }, { touch: false });
    },

    // A note on a stretch of a take: what's wrong there, or right. Gives the note.
    addNote(id, takeId, { start, end, text, by = 'user' } = {}) {
      return changing(id, (project) => {
        const take = findTake(project, takeId);
        const said = String(text ?? '').trim();
        if (!said) throw new Error('Say what the note is: it\'s empty.');
        if (said.length > NOTE_MAX) throw new Error(`A note can be up to ${NOTE_MAX} characters.`);
        take.notes ??= [];
        if (take.notes.length >= NOTES_MAX) throw new Error(`A take can have up to ${NOTES_MAX} notes.`);
        const taken = new Set(take.notes.map((note) => note.id));
        let noteId;
        do noteId = `n-${shortId()}`; while (taken.has(noteId));
        const note = { id: noteId, ...stretch(start, end, take.seconds, 'A note'), text: said, by: by === 'ai' ? 'ai' : 'user', at: now() };
        take.notes.push(note);
        take.notes.sort((a, b) => a.start - b.start || a.end - b.end);
        return { take: takeId, ...note };
      }, { touch: false });
    },

    removeNote(id, takeId, noteId) {
      return changing(id, (project) => {
        const take = findTake(project, takeId);
        const before = (take.notes ?? []).length;
        take.notes = (take.notes ?? []).filter((note) => note.id !== noteId);
        if (take.notes.length === before) throw new Error(`No note ${noteId} on take ${takeId}.`);
        return { take: takeId, removed: noteId };
      }, { touch: false });
    },

    // How loud a take is over time (levelsFields), kept beside its file; null until measured.
    async setLevels(id, takeId, levels) {
      if (!TAKE_ID.test(String(takeId))) throw new Error(`No take ${takeId}.`);
      findTake(await requireProject(id), takeId);
      await writeJson(path.join(folderOf(id), 'media', `${takeId}.level.json`), levelsFields(levels));
      return { take: takeId };
    },
    async levels(id, takeId) {
      if (!TAKE_ID.test(String(takeId))) throw new Error(`No take ${takeId}.`);
      return readJson(path.join(folderOf(id), 'media', `${takeId}.level.json`));
    },

    // Where a take's file is kept. Only takes' file names are taken, so nothing outside a
    // project's media folder can be asked for.
    mediaPath(id, file) {
      if (!MEDIA_FILE.test(String(file))) throw new Error(`Not a take's file: ${file}`);
      return path.join(folderOf(id), 'media', file);
    },

    // Takes not finished, in every project: what the generator picks up again as the app starts.
    async unfinished() {
      return (await list()).flatMap((project) => project.takes.filter((take) => take.status === 'queued' || take.status === 'running').map((take) => ({ projectId: project.id, take })));
    },
  };
}
