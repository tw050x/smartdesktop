// The values of schematics' secrets, kept on this Mac (the user's choice: only they enter values,
// though their AI may have one made at random where the schematic says it can be; it never sees a
// value). A schematic's implementation names its secrets and how the code gets each (see
// implementation.js); the values are here, encrypted with a key macOS keeps in the Keychain
// (Electron's safeStorage), in secrets.json in the app's data, never in a schematic, a run, a log or
// anything the AI is sent. The runner is given them in its job, on its stdin.
//
// Each value is kept apart from what it's for, so one value can serve several schematics: `values`
// holds each value by an id of its own, and `bound` says which value each scope's secret uses, by
// scope and name: 'schematic:<id>' for a schematic's own, 'shared:<id>' for a shared secret's (its
// one name, 'value'). Shared secrets (the user's choice, 2026-11-25: named ones of their own, made
// and managed in Settings, rather than one schematic's borrowed by another) are `shared`, each a
// name; a schematic's secret using one is in `links`, by scope and name, and has no value of its own.
//   { version: 1, values: { <id>: { data, by, at } }, bound: { <scope>: { <name>: <id> } },
//     shared: { <id>: { name, at } }, links: { <scope>: { <name>: <shared id> } } }
// `by` is 'user' (entered) or 'random' (made here, at the user's or the AI's asking).
import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RANDOM, secretsOf } from './implementation.js';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// A random value as a secret's `random` says (its format and length in characters).
export function randomValue(random = {}) {
  // 64 hex characters, else 43 characters: 32 random bytes' worth either way (alphanumeric a little less).
  const format = random.format ?? DEFAULT_RANDOM.format;
  const length = random.length ?? (format === 'hex' ? DEFAULT_RANDOM.length : 43);
  switch (format) {
    case 'alphanumeric':
      return Array.from({ length }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]).join('');
    case 'base64':
    case 'base64url':
    case 'hex':
      return randomBytes(Math.ceil(length * (format === 'hex' ? 0.5 : 0.75)) + 1).toString(format).replace(/=+$/, '').slice(0, length);
    default:
      throw new Error(`There's no random format called ${format}.`);
  }
}

const scopeOf = (schemaId) => `schematic:${schemaId}`;
const sharedScope = (sharedId) => `shared:${sharedId}`;
const VALUE = 'value';

// `cipher`: { available(), encrypt(text) → Buffer, decrypt(Buffer) → text } (safeStorage in the app;
// tests pass their own). `onChange(schemaId)`, told when a schematic's values change (one shared
// secret's changing tells each schematic using it); `onShared()`, when the shared secrets do.
export function createSecrets(userData, { cipher, onChange = () => {}, onShared = () => {} }) {
  const file = path.join(userData, 'secrets.json');
  let kept;
  const load = () => {
    if (kept) return kept;
    try {
      kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      kept = { version: 1, values: {}, bound: {} };
    }
    kept.shared ??= {};
    kept.links ??= {};
    return kept;
  };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(kept, null, 2), { mode: 0o600 });
  };
  const needCipher = () => {
    if (!cipher.available()) throw new Error('This Mac can\'t keep secrets for SmartSpec right now: its Keychain isn\'t available.');
  };
  const newId = () => randomBytes(8).toString('hex');

  // The shared secret a schematic's secret uses, if it uses one: its id, or null.
  const linkOf = (schemaId, name) => {
    const all = load();
    const sharedId = all.links[scopeOf(schemaId)]?.[name];
    return sharedId && all.shared[sharedId] ? sharedId : null;
  };
  // The value a scope's secret has: { id, entry } or null.
  const valueIn = (scope, name) => {
    const all = load();
    const id = all.bound[scope]?.[name];
    return id && all.values[id] ? { id, entry: all.values[id] } : null;
  };
  // The value a schematic's secret uses (a shared secret's, if it uses one): { id, entry } or null.
  const boundTo = (schemaId, name) => {
    const sharedId = linkOf(schemaId, name);
    return sharedId ? valueIn(sharedScope(sharedId), VALUE) : valueIn(scopeOf(schemaId), name);
  };
  // Letting go of a scope's value, which goes too once nothing else uses it.
  const unbind = (scope, name) => {
    const all = load();
    const id = all.bound[scope]?.[name];
    if (!id) return;
    delete all.bound[scope][name];
    if (!Object.keys(all.bound[scope]).length) delete all.bound[scope];
    if (!Object.values(all.bound).some((names) => Object.values(names).includes(id))) delete all.values[id];
  };
  const unlink = (schemaId, name) => {
    const all = load();
    const scope = scopeOf(schemaId);
    if (!all.links[scope]?.[name]) return;
    delete all.links[scope][name];
    if (!Object.keys(all.links[scope]).length) delete all.links[scope];
  };
  // The schematics using a shared secret: [{ schemaId, name }].
  const usersOf = (sharedId) => Object.entries(load().links).flatMap(([scope, names]) => Object.entries(names)
    .filter(([, id]) => id === sharedId).map(([name]) => ({ schemaId: scope.slice('schematic:'.length), name })));
  const tellUsers = (sharedId) => {
    for (const schemaId of new Set(usersOf(sharedId).map((one) => one.schemaId))) onChange(schemaId);
    onShared();
  };

  function store(scope, name, value, by) {
    needCipher();
    const all = load();
    const id = all.bound[scope]?.[name] ?? newId();
    all.values[id] = { data: cipher.encrypt(value).toString('base64'), by, at: new Date().toISOString() };
    all.bound[scope] = { ...all.bound[scope], [name]: id };
  }

  function put(schemaId, name, value, by) {
    if (linkOf(schemaId, name)) throw new Error(`${name} uses a shared secret: change its value in Settings › Shared Secrets, or stop using it here first.`);
    store(scopeOf(schemaId), name, value, by);
    save();
    onChange(schemaId);
  }

  const requireShared = (sharedId) => {
    const found = load().shared[sharedId];
    if (!found) throw new Error('There\'s no such shared secret: it may have been deleted.');
    return found;
  };
  const checkName = (name, except = null) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('A shared secret needs a name.');
    if (trimmed.length > 80) throw new Error('That name is too long: 80 characters at most.');
    const taken = Object.entries(load().shared).find(([id, one]) => id !== except && one.name.toLowerCase() === trimmed.toLowerCase());
    if (taken) throw new Error(`There's already a shared secret called ${taken[1].name}.`);
    return trimmed;
  };

  return {
    // How each of an implementation's secrets stands on this Mac, without its value: what the
    // window and the AI are given. [{ name, description, env, files, random, set, by, at }].
    statusOf(schemaId, implementation) {
      return secretsOf(implementation).map((secret) => {
        const found = boundTo(schemaId, secret.name);
        const sharedId = linkOf(schemaId, secret.name);
        return {
          ...secret, set: Boolean(found), ...(found ? { by: found.entry.by, at: found.entry.at } : {}),
          ...(sharedId ? { shared: { id: sharedId, name: load().shared[sharedId].name } } : {}),
        };
      });
    },

    // The user entering a value.
    set(schemaId, name, value) {
      if (typeof value !== 'string' || !value.length) throw new Error('A secret needs a value.');
      put(schemaId, name, value, 'user');
    },

    // A value made at random for a secret that can be (its `random`), replacing any it had.
    generate(schemaId, secret) {
      if (!secret.random) throw new Error(`${secret.name} can't be made at random: the schematic doesn't say it can be. Its value has to be entered in Test mode.`);
      put(schemaId, secret.name, randomValue(secret.random), 'random');
    },

    // Clearing a schematic's secret: its own value goes, or it stops using a shared secret.
    clear(schemaId, name) {
      if (!linkOf(schemaId, name) && !valueIn(scopeOf(schemaId), name)) return;
      unlink(schemaId, name);
      unbind(scopeOf(schemaId), name);
      save();
      onChange(schemaId);
    },

    // The shared secrets, by name: [{ id, name, set, by, at, usedBy: [{ schemaId, name }] }], never a value.
    sharedList() {
      return Object.entries(load().shared).map(([id, one]) => {
        const found = valueIn(sharedScope(id), VALUE);
        return { id, name: one.name, set: Boolean(found), ...(found ? { by: found.entry.by, at: found.entry.at } : {}), usedBy: usersOf(id) };
      }).sort((a, b) => a.name.localeCompare(b.name));
    },

    // A new shared secret, with a value entered (`value`) or made at random (`random`, as an
    // implementation's secret says it; {} for the default). Its id.
    createShared({ name, value = null, random = null }) {
      const named = checkName(name);
      if (value === null && !random) throw new Error('A shared secret needs a value, entered or made at random.');
      if (value !== null && (typeof value !== 'string' || !value.length)) throw new Error('A secret needs a value.');
      needCipher();
      const id = newId();
      const all = load();
      store(sharedScope(id), VALUE, value ?? randomValue(random), value !== null ? 'user' : 'random');
      all.shared[id] = { name: named, at: new Date().toISOString() };
      save();
      onShared();
      return id;
    },

    // A shared secret's new value, entered or made at random: every schematic using it has it.
    setShared(sharedId, value) {
      requireShared(sharedId);
      if (typeof value !== 'string' || !value.length) throw new Error('A secret needs a value.');
      store(sharedScope(sharedId), VALUE, value, 'user');
      save();
      tellUsers(sharedId);
    },
    generateShared(sharedId, random = {}) {
      requireShared(sharedId);
      store(sharedScope(sharedId), VALUE, randomValue(random), 'random');
      save();
      tellUsers(sharedId);
    },
    renameShared(sharedId, name) {
      const one = requireShared(sharedId);
      one.name = checkName(name, sharedId);
      save();
      tellUsers(sharedId);
    },
    // Deleting a shared secret: its value goes, and the schematics' secrets that used it are not set.
    // Which were using it.
    deleteShared(sharedId) {
      requireShared(sharedId);
      const users = usersOf(sharedId);
      for (const one of users) unlink(one.schemaId, one.name);
      unbind(sharedScope(sharedId), VALUE);
      delete load().shared[sharedId];
      save();
      for (const schemaId of new Set(users.map((one) => one.schemaId))) onChange(schemaId);
      onShared();
      return users;
    },

    // A schematic's secret using a shared secret, in place of any value of its own (which goes).
    useShared(schemaId, name, sharedId) {
      requireShared(sharedId);
      unbind(scopeOf(schemaId), name);
      const all = load();
      all.links[scopeOf(schemaId)] = { ...all.links[scopeOf(schemaId)], [name]: sharedId };
      save();
      onChange(schemaId);
      onShared();
    },

    // A schematic's own value made a shared secret, named `sharedName`, which it then uses: for a
    // value others need too. The new shared secret's id.
    shareOwn(schemaId, name, sharedName) {
      const own = valueIn(scopeOf(schemaId), name);
      if (!own) throw new Error(`${name} has no value of its own to share.`);
      const named = checkName(sharedName);
      const all = load();
      const id = newId();
      all.bound[sharedScope(id)] = { [VALUE]: own.id };
      delete all.bound[scopeOf(schemaId)][name];
      if (!Object.keys(all.bound[scopeOf(schemaId)]).length) delete all.bound[scopeOf(schemaId)];
      all.shared[id] = { name: named, at: new Date().toISOString() };
      all.links[scopeOf(schemaId)] = { ...all.links[scopeOf(schemaId)], [name]: id };
      save();
      onChange(schemaId);
      onShared();
      return id;
    },

    // For a run: each secret with its value, for the runner's job, and the names of any not set.
    valuesFor(schemaId, implementation) {
      const secrets = secretsOf(implementation);
      const missing = secrets.filter((secret) => !boundTo(schemaId, secret.name)).map((secret) => secret.name);
      if (missing.length) return { values: [], missing };
      if (secrets.length) needCipher();
      return {
        missing,
        values: secrets.map((secret) => ({
          name: secret.name,
          value: cipher.decrypt(Buffer.from(boundTo(schemaId, secret.name).entry.data, 'base64')),
          ...(secret.env ? { env: secret.env } : {}),
          ...(secret.files ? { files: secret.files } : {}),
        })),
      };
    },
  };
}
