// A schematic's implementation: where the code that keeps its contract comes from, and how to run it
// for the contract's checks (the user's choice: part of the schematic, so any runner can take it and
// test it with nothing else). Plain data and no Node or Electron, as the store and the interface both
// use it. It's private, as the schematic's items are: not part of the contract, and never seen by
// what embeds it, which relies on the promises, not on where the code lives. A use can name its own
// (a standard such as machine to machine auth has none of its own, or a reference one, and each
// system embedding it says which code implements it there); a use naming none is tested against the
// embedded schematic's.
//
//   { source, start?, ready?, stop?, credentials?, secrets? }
// `source`, where the code comes from, a kind each:
//   image:   { kind, image }                      a Docker image, by tag or digest
//   compose: { kind, url, ref?, file?, service }  a Docker Compose file in a git repository
//   git:     { kind, url, ref?, dir? }            a git repository, built and run on the machine
//                                                  (its url may be file:// for one on this machine)
//   archive: { kind, url, sha256? }               an archive at a URL, built and run on the machine
//   running: { kind, url }                        something already running, to test as it is
// `start`, how to run it: the port it listens on, its environment, and for git and archive the
// commands that build and start it (the last left running). `ready`, how to tell it has started: a
// path answering (200 unless `status` says), waited for up to `timeout` seconds (60). `stop`,
// commands that tidy up afterwards (what was started is stopped regardless). `credentials`, labels
// for the logins it needs to be fetched (a private repository or registry), kept on the machine that
// runs it (this Mac's Keychain), never in the schematic. `secrets`, what the code needs to run that
// isn't in its repository and mustn't be (keys, passwords): each named, with what it is and how the
// code gets it (an environment variable, files at paths in its code, or both), and whether it can be
// random (`random`: its format and length, so a value can be made for it). Only names: the values are
// kept on the machine that runs it (main/secrets.js), never here, as the AI reads every word of this.
//   { name, description?, env?, files?, random?: { format?, length? } }

export const SOURCE_KINDS = ['image', 'compose', 'git', 'archive', 'running'];
// The kinds whose code is kept in a workspace on this Mac, to be worked on there (see workspaces.js).
export const WORKSPACE_KINDS = ['git', 'compose'];
export const SOURCE_LABELS = { image: 'Docker image', compose: 'Docker Compose', git: 'Git repository', archive: 'Archive', running: 'Already running' };
const BUILT = ['git', 'archive'];
const LABEL = /^[\w.-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TIMEOUT = 60;
export const RANDOM_FORMATS = ['hex', 'base64', 'base64url', 'alphanumeric'];
export const DEFAULT_RANDOM = { format: 'hex', length: 64 };
// The kinds whose code is in a folder, where a secret can be written as a file.
const HAS_FILES = ['git', 'compose', 'archive'];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;

function fail(message) {
  throw new Error(message);
}

function checkUrl(value, where, schemes) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${where} needs a URL, such as ${schemes.includes('ssh:') ? 'https://github.com/larder/orders.git' : 'https://orders.example.com'}.`);
  }
  if (!schemes.includes(url.protocol)) fail(`${where}'s URL should start ${schemes.map((one) => one.replace(':', '://')).join(' or ')}.`);
}

function checkSource(source, where) {
  if (!isObject(source)) fail(`${where} needs a source: where the code comes from.`);
  if (!SOURCE_KINDS.includes(source.kind)) fail(`${where}'s source is of an unknown kind, "${source.kind}". The kinds are: ${SOURCE_KINDS.join(', ')}.`);
  const at = `${where}'s source`;
  switch (source.kind) {
    case 'image':
      if (!text(source.image) || /\s/.test(source.image)) fail(`${at} needs the image, such as ghcr.io/larder/orders:1.4.`);
      break;
    case 'compose':
      checkUrl(source.url, at, ['https:', 'ssh:', 'git:', 'http:', 'file:']);
      if (!text(source.service)) fail(`${at} needs the service in the Compose file that keeps the contract.`);
      if (source.file !== undefined && !text(source.file)) fail(`${at}'s file should be the Compose file's path in the repository.`);
      break;
    case 'git':
      checkUrl(source.url, at, ['https:', 'ssh:', 'git:', 'http:', 'file:']);
      if (source.dir !== undefined && (!text(source.dir) || source.dir.startsWith('/') || source.dir.split('/').includes('..'))) fail(`${at}'s dir should be a folder inside the repository, such as services/orders.`);
      break;
    case 'archive':
      checkUrl(source.url, at, ['https:', 'http:']);
      if (source.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(source.sha256)) fail(`${at}'s sha256 should be the archive's SHA-256, 64 hexadecimal characters.`);
      break;
    case 'running':
      checkUrl(source.url, at, ['https:', 'http:']);
      break;
  }
  if (source.ref !== undefined && !['compose', 'git'].includes(source.kind)) fail(`${at} is ${SOURCE_LABELS[source.kind].toLowerCase()}, which has no ref.`);
  if (source.ref !== undefined && !text(source.ref)) fail(`${at}'s ref should be a branch, tag or commit.`);
}

// Throws saying what's wrong with an implementation; null or undefined is none.
export function checkImplementation(implementation, where = 'The implementation') {
  if (implementation === undefined || implementation === null) return;
  if (!isObject(implementation)) fail(`${where} should say where the code comes from and how to run it.`);
  checkSource(implementation.source, where);
  const { kind } = implementation.source;
  const { start, ready, stop, credentials, secrets } = implementation;
  if (kind === 'running' && (start !== undefined || stop !== undefined)) fail(`${where} is already running, so it has no start or stop: it's tested as it is.`);
  if (start !== undefined) {
    if (!isObject(start)) fail(`${where}'s start should say its port, environment and commands.`);
    if (start.port !== undefined && !(Number.isInteger(start.port) && start.port > 0 && start.port < 65536)) fail(`${where}'s port should be a port number, such as 3000.`);
    if (start.env !== undefined) {
      if (!isObject(start.env)) fail(`${where}'s env should be names and their values.`);
      for (const [name, value] of Object.entries(start.env)) {
        if (!ENV_NAME.test(name)) fail(`${where}'s env has "${name}", which can't be an environment variable's name.`);
        if (typeof value !== 'string') fail(`${where}'s env ${name} should be text.`);
      }
    }
    if (start.commands !== undefined) {
      if (!BUILT.includes(kind)) fail(`${where} is ${SOURCE_LABELS[kind].toLowerCase()}, which runs as it is: commands are for a git repository or an archive, built and run on the machine.`);
      if (!Array.isArray(start.commands) || !start.commands.length || !start.commands.every(text)) fail(`${where}'s commands should be a list of shell commands, the last starting it (left running).`);
    }
  }
  if (kind !== 'running' && !Number.isInteger(start?.port)) fail(`${where} needs start.port: the port it listens on, so the checks can reach it.`);
  if (BUILT.includes(kind) && !start?.commands) fail(`${where} is built and run on the machine, so it needs start.commands: the shell commands that build and start it, the last left running.`);
  if (ready !== undefined) {
    if (!isObject(ready) || typeof ready.path !== 'string' || !ready.path.startsWith('/')) fail(`${where}'s ready should give a path that answers once it has started, such as /health.`);
    if (ready.status !== undefined && !(Number.isInteger(ready.status) && ready.status >= 100 && ready.status <= 599)) fail(`${where}'s ready status should be an HTTP status.`);
    if (ready.timeout !== undefined && !(Number.isInteger(ready.timeout) && ready.timeout > 0 && ready.timeout <= 1800)) fail(`${where}'s ready timeout should be seconds, up to 1800.`);
  }
  if (stop !== undefined) {
    if (!isObject(stop) || !Array.isArray(stop.commands) || !stop.commands.length || !stop.commands.every(text)) fail(`${where}'s stop should give commands, shell commands that tidy up afterwards.`);
    if (!BUILT.includes(kind)) fail(`${where} is ${SOURCE_LABELS[kind].toLowerCase()}, so it's stopped by Docker: stop commands are for a git repository or an archive.`);
  }
  if (credentials !== undefined) {
    if (!Array.isArray(credentials) || !credentials.every((label) => typeof label === 'string' && LABEL.test(label))) fail(`${where}'s credentials should be labels for logins kept on the machine that runs it, such as github or ghcr: letters, numbers, ., - and _.`);
  }
  if (secrets !== undefined) checkSecrets(secrets, kind, start, where);
}

function checkSecrets(secrets, kind, start, where) {
  if (!Array.isArray(secrets)) fail(`${where}'s secrets should be a list, each with its name and how the code gets it.`);
  if (secrets.length && kind === 'running') fail(`${where} is already running, so nothing can be given to it: it has no secrets.`);
  const names = new Set();
  const envs = new Set(Object.keys(start?.env ?? {}));
  const files = new Set();
  for (const secret of secrets) {
    if (!isObject(secret) || typeof secret.name !== 'string' || !LABEL.test(secret.name)) fail(`Each of ${where.toLowerCase()}'s secrets needs a name, such as jwt-key: letters, numbers, ., - and _.`);
    const at = `${where}'s secret ${secret.name}`;
    if (names.has(secret.name)) fail(`${where} has two secrets called ${secret.name}.`);
    names.add(secret.name);
    if (secret.description !== undefined && typeof secret.description !== 'string') fail(`${at}'s description should be text.`);
    if (secret.env === undefined && secret.files === undefined) fail(`${at} needs env (an environment variable to set) or files (paths in its code to write it to), or both: how the code gets it.`);
    if (secret.env !== undefined) {
      if (typeof secret.env !== 'string' || !ENV_NAME.test(secret.env)) fail(`${at}'s env should be an environment variable's name, such as JWT_SECRET.`);
      if (envs.has(secret.env)) fail(`${at} sets ${secret.env}, which ${Object.hasOwn(start?.env ?? {}, secret.env) ? 'start.env sets too' : 'another secret sets'}.`);
      envs.add(secret.env);
    }
    if (secret.files !== undefined) {
      if (!HAS_FILES.includes(kind)) fail(`${at} is written to files, but ${where.toLowerCase()} is ${SOURCE_LABELS[kind].toLowerCase()}, which has no folder of code to write them in: give it as env instead.`);
      if (!Array.isArray(secret.files) || !secret.files.length) fail(`${at}'s files should be a list of paths in its code, such as service/auth/.secret/jwt.secret-key.`);
      for (const file of secret.files) {
        if (!text(file) || file.startsWith('/') || file.split('/').some((part) => part === '..' || part === '.git') || file.endsWith('/')) fail(`${at}'s file "${file}" should be a path to a file inside its code (from the repository's top), such as service/auth/.secret/jwt.secret-key.`);
        if (files.has(file)) fail(`${at} is written to ${file}, as another secret is.`);
        files.add(file);
      }
    }
    if (secret.random !== undefined) {
      if (!isObject(secret.random)) fail(`${at}'s random should say its format and length, such as { format: 'hex', length: 64 }.`);
      if (secret.random.format !== undefined && !RANDOM_FORMATS.includes(secret.random.format)) fail(`${at}'s random format should be one of ${RANDOM_FORMATS.join(', ')}.`);
      if (secret.random.length !== undefined && !(Number.isInteger(secret.random.length) && secret.random.length >= 8 && secret.random.length <= 1024)) fail(`${at}'s random length should be how many characters, 8 to 1024.`);
    }
  }
}

// Its secrets, as the schematic gives them (none: an empty list).
export const secretsOf = (implementation) => implementation?.secrets ?? [];

// Where the checks reach it: what's running's own address, else this machine at its port.
export function baseUrlOf(implementation) {
  if (!implementation) return null;
  if (implementation.source.kind === 'running') return implementation.source.url.replace(/\/+$/, '');
  return `http://127.0.0.1:${implementation.start.port}`;
}

export const readyTimeout = (implementation) => implementation?.ready?.timeout ?? DEFAULT_TIMEOUT;

// Where it comes from, in a line: "ghcr.io/larder/orders:1.4", "github.com/larder/orders at v2, in services/orders".
export function sourceLine(source) {
  const at = (url) => url.replace(/^[a-z+]+:\/\//, '').replace(/\.git$/, '');
  switch (source.kind) {
    case 'image': return source.image;
    case 'compose': return `${source.service} in ${at(source.url)}${source.ref ? ` at ${source.ref}` : ''}${source.file ? `, ${source.file}` : ''}`;
    case 'git': return `${at(source.url)}${source.ref ? ` at ${source.ref}` : ''}${source.dir ? `, in ${source.dir}` : ''}`;
    case 'archive': return at(source.url);
    case 'running': return source.url;
    default: return '';
  }
}
