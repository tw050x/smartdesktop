import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Fetching a schematic's implementation and starting it for its checks, then tidying up (see the
// app's implementation.js for what an implementation says). Each kind:
//   running: nothing to start; the checks reach it at its URL.
//   image:   `docker run` with its port published on 127.0.0.1, stopped with `docker rm -f`.
//   compose: the repository fetched, its commands run there (each to its end), then `docker compose
//            up` of its service and those `with` it, and `down`.
//   git:     the repository fetched into the cache, its commands run there in turn, the last left
//            running (in a process group of its own, so all it starts is stopped with it).
//   archive: downloaded into the cache (its SHA-256 checked, if given), unpacked, then as git.
// `workdir` is a folder on this machine to keep the code of a git repository or Compose file in (a
// workspace, worked on there by people and AIs): cloned into it at the ref if it's empty or not
// there yet, then used as it is, uncommitted changes and all, never fetched or reset again. Logins (`credentials`) are this
// machine's own: git's credential helper, Docker's login. `secrets`, the values of the
// implementation's secrets ({ name, value, env?, files? } each), given by whoever made the job: an
// environment variable is set for its commands (or Compose, or passed into the container), never on
// a command line; a file is written into its code just before it starts (only its owner can read
// it) and taken away again afterwards, whatever was there before put back, so a workspace is left
// as it was.

export class RunError extends Error {}

const SOURCE_WORDS = { image: 'a Docker image', archive: 'an archive', running: 'something already running' };

const STOP_GRACE = 5000;

export function defaultCacheDir() {
  if (process.env.SMARTSPEC_RUNNER_CACHE) return process.env.SMARTSPEC_RUNNER_CACHE;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'SmartSpec Runner');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'smartspec-runner');
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// Lines a process writes, each sent as a log event.
function forward(stream, name, emit) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop();
    for (const text of lines) emit({ type: 'log', stream: name, text });
  });
  stream.on('end', () => { if (rest) emit({ type: 'log', stream: name, text: rest }); });
}

// A command run to its end; throws saying which failed.
export function runCommand(command, { cwd, env, emit, signal, label = command }) {
  return new Promise((resolve, reject) => {
    emit({ type: 'log', stream: 'runner', text: `$ ${label}` });
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    forward(child.stdout, 'stdout', emit);
    forward(child.stderr, 'stderr', emit);
    const abort = () => kill(child, 'SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => reject(new RunError(`${label} couldn't be run: ${error.message}.`)));
    child.on('close', (code, by) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new RunError('Stopped.'));
      else if (code === 0) resolve();
      else reject(new RunError(`${label} failed (${by ? `stopped by ${by}` : `exit ${code}`}).`));
    });
  });
}

function kill(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

// A command left running: its process group stopped with stop().
function startService(command, { cwd, env, emit }) {
  emit({ type: 'log', stream: 'runner', text: `$ ${command}` });
  const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  forward(child.stdout, 'stdout', emit);
  forward(child.stderr, 'stderr', emit);
  const exited = new Promise((resolve) => child.on('close', (code, by) => resolve({ code, by })));
  child.on('error', () => {});
  return {
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      kill(child, 'SIGTERM');
      // Its grace timer cleared once it has gone, or it would hold the runner open that long.
      let timer;
      const done = await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), STOP_GRACE); })]);
      clearTimeout(timer);
      if (!done) { kill(child, 'SIGKILL'); await exited; }
    },
  };
}

async function hasDocker(context) {
  try {
    await runCommand('docker version --format "{{.Server.Version}}"', { ...context, emit: () => {}, label: 'docker version' });
  } catch {
    throw new RunError('Docker isn\'t running on this machine: start Docker Desktop (or install it), then run the checks again.');
  }
}

const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// git's answer, or null: for what the run reports, never for doing anything.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' };
const gitOut = (cwd, args, env = process.env) => new Promise((resolve) => {
  execFile('git', args, { cwd, env: { ...env, ...NO_PROMPT }, timeout: 20_000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout.trim()));
});

// The commit checked out in a folder: { commit, subject }.
async function headOf(dir, env) {
  const line = await gitOut(dir, ['log', '-1', '--format=%H%x09%s'], env);
  if (!line) return {};
  const [commit, subject] = line.split('\t');
  return { commit, subject };
}

// What the code run against is, in words: "main at 1a2b3c4", "the workspace on feature-x at 1a2b3c4,
// 2 files not committed".
export function codeLabel(code) {
  const at = code.commit ? ` at ${code.commit.slice(0, 7)}` : '';
  if (code.kind === 'workspace') return `the workspace${code.ref ? ` on ${code.ref}` : ''}${at}${code.changes ? `, ${code.changes} ${code.changes === 1 ? 'file' : 'files'} not committed` : ''}`;
  if (code.kind === 'git') return `${code.ref ?? 'its default branch'}${at}`;
  return code.label ?? code.kind;
}

// A git repository at a ref, fetched into the cache (kept between runs, so a build's own caches,
// such as node_modules, stay); the folder it's in.
// `ref` is the branch, tag or commit to fetch; none, the repository's default branch (its name
// found out, so the run can say which). Gives { dir, code }.
async function fetchGit(source, { cacheDir, ref, ...context }) {
  const dir = path.join(cacheDir, 'git', hashOf(source.url));
  await mkdir(dir, { recursive: true });
  // Never asks for a login (nobody could answer, and it would wait for good): this machine's own
  // (git's credential helper) is used, or it fails saying so.
  const env = { ...context.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' };
  const git = (args, label) => runCommand(`git ${args}`, { ...context, env, cwd: dir, label: label ?? `git ${args}` });
  if (!existsSync(path.join(dir, '.git'))) {
    await git('init --quiet');
    await git(`remote add origin ${quote(source.url)}`);
  } else {
    await git(`remote set-url origin ${quote(source.url)}`);
  }
  // The default branch is what the repository's HEAD names: never guessed (the user's choice), so
  // with nothing named it has to be.
  let name = ref;
  if (!name) {
    const head = await gitOut(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], context.env);
    if (head === null) throw new RunError(`${source.url} couldn't be read: the repository may not exist, or it needs a login this machine doesn't have.`);
    name = head.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null;
    if (!name) throw new RunError(`${source.url} doesn't say which branch is its default, so there's none to run: name the branch, tag or commit to run.`);
  }
  try {
    await git(`fetch --depth 1 --quiet origin ${quote(name ?? 'HEAD')}`, `git fetch ${source.url} ${name ?? '(its default branch)'}`);
  } catch {
    throw new RunError(`${source.url}${name ? ` at ${name}` : ''} couldn't be fetched: ${name ? `there may be no branch, tag or commit called ${name}, or the repository` : 'the repository'} may not exist, or it needs a login this machine doesn't have. git's own words are in the log.`);
  }
  await git('checkout --quiet --force FETCH_HEAD');
  return { dir, code: { kind: 'git', ref: name, ...(await headOf(dir, context.env)), ...(ref ? {} : { defaultBranch: true }) } };
}

// A clone to work in, made once: the whole history, at the ref (a branch, tag or commit). A clone
// that fails leaves nothing behind, so the next run tries again.
async function cloneInto(source, dir, context) {
  const empty = !existsSync(dir) || (await readdir(dir)).filter((name) => name !== '.DS_Store').length === 0;
  if (!empty) {
    context.emit({ type: 'log', stream: 'runner', text: `Using the code in ${dir} as it is` });
    return dir;
  }
  return cloneFresh(source, dir, context);
}

// What a workspace holds: its branch, commit and the files not committed.
async function workspaceCode(dir, env) {
  const [branch, status] = await Promise.all([gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env), gitOut(dir, ['status', '--porcelain'], env)]);
  return { kind: 'workspace', ref: branch && branch !== 'HEAD' ? branch : null, ...(await headOf(dir, env)), changes: status ? status.split('\n').length : 0 };
}

async function cloneFresh(source, dir, context) {
  await mkdir(path.dirname(dir), { recursive: true });
  const env = { ...context.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' };
  try {
    await runCommand(`git clone --quiet ${quote(source.url)} ${quote(dir)}`, { ...context, env, cwd: path.dirname(dir), label: `git clone ${source.url} into ${dir}` });
    if (source.ref) await runCommand(`git checkout --quiet ${quote(source.ref)}`, { ...context, env, cwd: dir, label: `git checkout ${source.ref}` });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new RunError(`${source.url}${source.ref ? ` at ${source.ref}` : ''} couldn't be cloned: the repository or ref may not exist, or it needs a login this machine doesn't have. git's own words are in the log.`);
  }
  return dir;
}

async function fetchArchive(source, { cacheDir, emit, signal }) {
  const key = hashOf(`${source.url}#${source.sha256 ?? ''}`);
  const file = path.join(cacheDir, 'archives', `${key}${path.extname(new URL(source.url).pathname) || '.tar'}`);
  const dir = path.join(cacheDir, 'archives', key);
  await mkdir(path.dirname(file), { recursive: true });
  emit({ type: 'log', stream: 'runner', text: `Downloading ${source.url}` });
  let response;
  try {
    response = await fetch(source.url, { signal });
  } catch (error) {
    throw new RunError(`${source.url} couldn't be downloaded: ${error.cause?.message ?? error.message}.`);
  }
  if (!response.ok) throw new RunError(`${source.url} couldn't be downloaded: it answered ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  if (source.sha256) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    const actual = hash.digest('hex');
    if (actual !== source.sha256.toLowerCase()) throw new RunError(`${source.url} isn't the archive the schematic names: its SHA-256 is ${actual}, not ${source.sha256}.`);
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await runCommand(`tar -xf ${quote(file)} -C ${quote(dir)}`, { emit, signal, cwd: dir, label: `unpacking ${path.basename(file)}` });
  // An archive holding one folder is that folder's code.
  const entries = (await readdir(dir)).filter((name) => !name.startsWith('.'));
  if (entries.length === 1 && (await stat(path.join(dir, entries[0]))).isDirectory()) return path.join(dir, entries[0]);
  return dir;
}

// Writes each secret's files into the code (`root`, its repository's top); resolves to what puts
// everything back: each file as it was before (or gone, if there was none), and the folders made for
// them removed if they're empty.
async function placeSecrets(root, secrets, emit) {
  const undo = [];
  const restore = async () => {
    for (const step of undo.reverse()) {
      try { await step(); } catch { /* left as it is */ }
    }
  };
  try {
    for (const secret of secrets) {
      for (const file of secret.files ?? []) {
        const target = path.resolve(root, file);
        if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new RunError(`The secret ${secret.name}'s file ${file} isn't inside its code.`);
        // Made folder by folder, so each one made can be taken away again.
        const folders = [];
        for (let dir = path.dirname(target); dir !== path.resolve(root) && !existsSync(dir); dir = path.dirname(dir)) folders.unshift(dir);
        for (const dir of folders) {
          await mkdir(dir);
          undo.push(() => rmdir(dir).catch(() => {}));
        }
        let before = null;
        try {
          const info = await lstat(target);
          if (info.isSymbolicLink() || !info.isFile()) throw new RunError(`The secret ${secret.name} can't be written to ${file}: something other than a file is there.`);
          before = { data: await readFile(target), mode: info.mode & 0o777 };
        } catch (error) {
          if (error instanceof RunError) throw error;
        }
        undo.push(() => (before ? writeFile(target, before.data).then(() => chmod(target, before.mode)) : rm(target, { force: true })));
        await writeFile(target, secret.value, { mode: 0o600 });
        await chmod(target, 0o600);
        emit({ type: 'log', stream: 'runner', text: `Wrote the secret ${secret.name} to ${file}${before ? ' (what was there goes back afterwards)' : ''}` });
      }
    }
  } catch (error) {
    await restore();
    throw error instanceof RunError ? error : new RunError(`The secrets couldn't be written into its code: ${error.message}.`);
  }
  return restore;
}

// Whether it has started: its ready path answering as it should, else its port taking connections.
async function waitReady(implementation, base, { signal, service, emit }) {
  const { ready } = implementation;
  const timeout = (ready?.timeout ?? 60) * 1000;
  const until = Date.now() + timeout;
  const url = new URL(base);
  let last = '';
  emit({ type: 'log', stream: 'runner', text: ready ? `Waiting for ${ready.path} to answer ${ready.status ?? 200}` : `Waiting for port ${url.port || (url.protocol === 'https:' ? 443 : 80)}` });
  while (Date.now() < until) {
    if (signal?.aborted) throw new RunError('Stopped.');
    if (service) {
      const exited = await Promise.race([service.exited, wait(0).then(() => null)]);
      if (exited) throw new RunError(`It stopped before it was ready (${exited.by ? `stopped by ${exited.by}` : `exit ${exited.code}`}). Its output is in the log.`);
    }
    if (ready) {
      try {
        const response = await fetch(new URL(ready.path, `${base}/`), { signal: AbortSignal.timeout(2000), redirect: 'manual' });
        await response.arrayBuffer();
        if (response.status === (ready.status ?? 200)) return;
        last = `, ${ready.path} answering ${response.status}`;
      } catch { /* not yet */ }
    } else if (await portOpen(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) {
      return;
    }
    await wait(250, signal);
  }
  throw new RunError(`It wasn't ready after ${timeout / 1000} s${last}.`);
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Starts it and waits until it's ready: { base, stop }, stop() tidying up whatever happened.
// `ref`, the branch, tag or commit of a git repository's (or Compose file's) code to run (none:
// the source's ref, else the repository's default branch); `workdir`, a workspace to run as it is
// instead. What was run is told as a `code` event ({ kind, ref, commit, subject, changes, label }).
export async function startImplementation(implementation, { jobId, cacheDir = defaultCacheDir(), workdir, ref, secrets = [], emit = () => {}, signal } = {}) {
  const { source, start = {}, stop: stopCommands } = implementation;
  const secretEnv = Object.fromEntries(secrets.filter((one) => one.env).map((one) => [one.env, one.value]));
  const env = { ...process.env, ...(start.env ?? {}), ...secretEnv };
  const context = { emit, signal, env };
  const base = source.kind === 'running' ? source.url.replace(/\/+$/, '') : `http://127.0.0.1:${start.port}`;
  const tidy = [];
  const stop = async () => {
    for (const step of tidy.reverse()) {
      try { await step(); } catch (error) { emit({ type: 'log', stream: 'runner', text: error.message }); }
    }
    tidy.length = 0;
  };
  // Its secrets' files, written into its code once it's there, and put back as it was afterwards.
  const withFiles = secrets.filter((one) => one.files?.length);
  const place = async (root) => {
    if (!withFiles.length) return;
    tidy.push(await placeSecrets(root, withFiles, emit));
  };
  const name = `smartspec-${String(jobId ?? Date.now()).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`.slice(0, 63);
  let code = null;
  const told = (what) => {
    code = { ...what, label: codeLabel(what) };
    emit({ type: 'code', ...code });
  };
  // A git repository's code: the workspace as it is (cloned first if need be), or a ref fetched.
  const codeFor = async (from, { workdir: space, ref: at, cacheDir: cache, context: ctx }) => {
    if (space) {
      const dir = await cloneInto(from, space, ctx);
      told(await workspaceCode(dir, ctx.env));
      return dir;
    }
    const fetched = await fetchGit(from, { cacheDir: cache, ref: at ?? from.ref, ...ctx });
    told(fetched.code);
    return fetched.dir;
  };

  try {
    if (ref && !['git', 'compose'].includes(source.kind)) throw new RunError(`Only a git repository's code (or a Compose file's) can be run at a branch, tag or commit; this is ${SOURCE_WORDS[source.kind]}.`);
    if (workdir && ref) throw new RunError('Run the workspace as it is, or a branch, tag or commit: not both.');
    if (workdir && !['git', 'compose'].includes(source.kind)) throw new RunError(`A workdir is for the code of a git repository or Compose file, not ${source.kind === 'running' ? 'something already running' : `${/^[aeiou]/.test(source.kind) ? 'an' : 'a'} ${source.kind}`}.`);
    if (secrets.length && source.kind === 'running') throw new RunError('Something already running can\'t be given secrets.');
    if (withFiles.length && source.kind === 'image') throw new RunError('A Docker image has no folder of code to write secrets into: give them as environment variables.');
    if (source.kind !== 'running') emit({ type: 'phase', phase: 'fetch' });
    let service;
    switch (source.kind) {
      case 'running':
        told({ kind: 'running', label: source.url });
        break;
      case 'image': {
        await hasDocker(context);
        told({ kind: 'image', label: source.image });
        try {
          await runCommand(`docker image inspect ${quote(source.image)}`, { ...context, emit: () => {}, label: 'docker image inspect' });
        } catch {
          await runCommand(`docker pull ${quote(source.image)}`, { ...context, label: `docker pull ${source.image}` });
        }
        emit({ type: 'phase', phase: 'start' });
        // Secrets by name only (`-e NAME`, its value from docker's own environment), never on the command line.
        const envFlags = [...Object.entries(start.env ?? {}).map(([key, value]) => `-e ${quote(`${key}=${value}`)}`), ...Object.keys(secretEnv).map((key) => `-e ${key}`)].join(' ');
        await runCommand(`docker run -d --rm --name ${name} -p 127.0.0.1:${start.port}:${start.port} ${envFlags} ${quote(source.image)}`, { ...context, label: `docker run ${source.image}` });
        tidy.push(() => runCommand(`docker rm -f ${name}`, { ...context, signal: undefined, emit: () => {}, label: 'docker rm' }));
        const logs = startService(`docker logs -f ${name}`, { ...context, emit: (event) => emit(event.stream === 'runner' ? { ...event, text: '(its log follows)' } : event) });
        tidy.push(() => logs.stop());
        break;
      }
      case 'compose': {
        await hasDocker(context);
        const dir = await codeFor(source, { workdir, ref, cacheDir, context });
        emit({ type: 'phase', phase: 'start' });
        // Its commands first (installing, writing configuration), so none of them writes over a secret's file.
        for (const command of start.commands ?? []) await runCommand(command, { ...context, cwd: dir });
        await place(dir);
        const compose = `docker compose -p ${name} ${source.file ? `-f ${quote(source.file)}` : ''}`;
        const services = [source.service, ...(source.with ?? [])];
        tidy.push(() => runCommand(`${compose} down --remove-orphans`, { ...context, cwd: dir, signal: undefined, label: 'docker compose down' }));
        await runCommand(`${compose} up -d --build ${services.map(quote).join(' ')}`, { ...context, cwd: dir, label: `docker compose up ${services.join(' ')}` });
        break;
      }
      case 'git':
      case 'archive': {
        const fetched = source.kind === 'git' ? await codeFor(source, { workdir, ref, cacheDir, context }) : await fetchArchive(source, { cacheDir, ...context });
        if (source.kind === 'archive') told({ kind: 'archive', label: source.url });
        const dir = source.dir ? path.join(fetched, source.dir) : fetched;
        if (!existsSync(dir)) throw new RunError(`${source.dir} isn't in the repository.`);
        await place(fetched);
        emit({ type: 'phase', phase: 'start' });
        if (stopCommands) tidy.push(async () => { for (const command of stopCommands.commands) await runCommand(command, { ...context, cwd: dir, signal: undefined }); });
        const commands = start.commands;
        for (const command of commands.slice(0, -1)) await runCommand(command, { ...context, cwd: dir });
        service = startService(commands.at(-1), { ...context, cwd: dir });
        tidy.push(() => service.stop());
        break;
      }
      default:
        throw new RunError(`A source of kind ${source.kind} can't be run.`);
    }
    emit({ type: 'phase', phase: 'ready' });
    await waitReady(implementation, base, { signal, service, emit });
    return { base, stop, code };
  } catch (error) {
    await stop();
    throw error instanceof RunError ? error : new RunError(error.message);
  }
}
