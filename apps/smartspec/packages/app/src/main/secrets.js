// The values of schematics' secrets, kept on this Mac (the user's choice: only they enter values,
// though their AI may have one made at random where the schematic says it can be; it never sees a
// value). A schematic's implementation names its secrets and how the code gets each (see
// implementation.js); the values are here, encrypted with a key macOS keeps in the Keychain
// (Electron's safeStorage), in secrets.json in the app's data, never in a schematic, a run, a log or
// anything the AI is sent. The runner is given them in its job, on its stdin.
//
// Each value is kept apart from what it's for, so one value can later serve several schematics (the
// user expects secrets to be shared in time): `values` holds each value by an id of its own, and
// `bound` says which value each schematic's secret uses, by scope ('schematic:<id>' for now; a shared
// scope later) and name.
//   { version: 1, values: { <id>: { data, by, at } }, bound: { <scope>: { <name>: <id> } } }
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

// `cipher`: { available(), encrypt(text) → Buffer, decrypt(Buffer) → text } (safeStorage in the app;
// tests pass their own). `onChange(schemaId)`, told when a schematic's values change.
export function createSecrets(userData, { cipher, onChange = () => {} }) {
  const file = path.join(userData, 'secrets.json');
  let kept;
  const load = () => {
    if (kept) return kept;
    try {
      kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      kept = { version: 1, values: {}, bound: {} };
    }
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

  // The value a schematic's secret uses: { id, entry } or null.
  const boundTo = (schemaId, name) => {
    const all = load();
    const id = all.bound[scopeOf(schemaId)]?.[name];
    return id && all.values[id] ? { id, entry: all.values[id] } : null;
  };

  function put(schemaId, name, value, by) {
    needCipher();
    const all = load();
    const scope = scopeOf(schemaId);
    // A value shared later would be changed for all it serves: today each is one schematic's.
    const id = all.bound[scope]?.[name] ?? newId();
    all.values[id] = { data: cipher.encrypt(value).toString('base64'), by, at: new Date().toISOString() };
    all.bound[scope] = { ...all.bound[scope], [name]: id };
    save();
    onChange(schemaId);
  }

  return {
    // How each of an implementation's secrets stands on this Mac, without its value: what the
    // window and the AI are given. [{ name, description, env, files, random, set, by, at }].
    statusOf(schemaId, implementation) {
      return secretsOf(implementation).map((secret) => {
        const found = boundTo(schemaId, secret.name);
        return { ...secret, set: Boolean(found), ...(found ? { by: found.entry.by, at: found.entry.at } : {}) };
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

    clear(schemaId, name) {
      const all = load();
      const scope = scopeOf(schemaId);
      const id = all.bound[scope]?.[name];
      if (!id) return;
      delete all.bound[scope][name];
      if (!Object.keys(all.bound[scope]).length) delete all.bound[scope];
      // A value nothing else uses goes with it.
      if (!Object.values(all.bound).some((names) => Object.values(names).includes(id))) delete all.values[id];
      save();
      onChange(schemaId);
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
