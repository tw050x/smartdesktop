import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Fetching a schematic's implementation and starting it for its checks, then tidying up (see the
// app's implementation.js for what an implementation says). Each kind:
//   running: nothing to start; the checks reach it at its URL.
//   image:   `docker run` with its port published on 127.0.0.1, stopped with `docker rm -f`.
//   compose: the repository fetched, then `docker compose up` of its service, and `down`.
//   git:     the repository fetched into the cache, its commands run there in turn, the last left
//            running (in a process group of its own, so all it starts is stopped with it).
//   archive: downloaded into the cache (its SHA-256 checked, if given), unpacked, then as git.
// `workdir` is a folder on this machine to keep the code of a git repository or Compose file in (a
// workspace, worked on there by people and AIs): cloned into it at the ref if it's empty or not
// there yet, then used as it is, uncommitted changes and all, never fetched or reset again. Logins (`credentials`) are this
// machine's own: git's credential helper, Docker's login.

export class RunError extends Error {}

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

// A git repository at a ref, fetched into the cache (kept between runs, so a build's own caches,
// such as node_modules, stay); the folder it's in.
async function fetchGit(source, { cacheDir, ...context }) {
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
  try {
    await git(`fetch --depth 1 --quiet origin ${quote(source.ref ?? 'HEAD')}`, `git fetch ${source.url} ${source.ref ?? '(its default branch)'}`);
  } catch {
    throw new RunError(`${source.url}${source.ref ? ` at ${source.ref}` : ''} couldn't be fetched: the repository or ref may not exist, or it needs a login this machine doesn't have. git's own words are in the log.`);
  }
  await git('checkout --quiet --force FETCH_HEAD');
  return dir;
}

// A clone to work in, made once: the whole history, at the ref (a branch, tag or commit). A clone
// that fails leaves nothing behind, so the next run tries again.
async function cloneInto(source, dir, context) {
  const empty = !existsSync(dir) || (await readdir(dir)).filter((name) => name !== '.DS_Store').length === 0;
  if (!empty) {
    context.emit({ type: 'log', stream: 'runner', text: `Using the code in ${dir} as it is` });
    return dir;
  }
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
export async function startImplementation(implementation, { jobId, cacheDir = defaultCacheDir(), workdir, emit = () => {}, signal } = {}) {
  const { source, start = {}, stop: stopCommands } = implementation;
  const env = { ...process.env, ...(start.env ?? {}) };
  const context = { emit, signal, env };
  const base = source.kind === 'running' ? source.url.replace(/\/+$/, '') : `http://127.0.0.1:${start.port}`;
  const tidy = [];
  const stop = async () => {
    for (const step of tidy.reverse()) {
      try { await step(); } catch (error) { emit({ type: 'log', stream: 'runner', text: error.message }); }
    }
    tidy.length = 0;
  };
  const name = `smartspec-${String(jobId ?? Date.now()).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`.slice(0, 63);

  try {
    if (workdir && !['git', 'compose'].includes(source.kind)) throw new RunError(`A workdir is for the code of a git repository or Compose file, not ${source.kind === 'running' ? 'something already running' : `${/^[aeiou]/.test(source.kind) ? 'an' : 'a'} ${source.kind}`}.`);
    if (source.kind !== 'running') emit({ type: 'phase', phase: 'fetch' });
    let service;
    switch (source.kind) {
      case 'running':
        break;
      case 'image': {
        await hasDocker(context);
        try {
          await runCommand(`docker image inspect ${quote(source.image)}`, { ...context, emit: () => {}, label: 'docker image inspect' });
        } catch {
          await runCommand(`docker pull ${quote(source.image)}`, { ...context, label: `docker pull ${source.image}` });
        }
        emit({ type: 'phase', phase: 'start' });
        const envFlags = Object.entries(start.env ?? {}).map(([key, value]) => `-e ${quote(`${key}=${value}`)}`).join(' ');
        await runCommand(`docker run -d --rm --name ${name} -p 127.0.0.1:${start.port}:${start.port} ${envFlags} ${quote(source.image)}`, { ...context, label: `docker run ${source.image}` });
        tidy.push(() => runCommand(`docker rm -f ${name}`, { ...context, signal: undefined, emit: () => {}, label: 'docker rm' }));
        const logs = startService(`docker logs -f ${name}`, { ...context, emit: (event) => emit(event.stream === 'runner' ? { ...event, text: '(its log follows)' } : event) });
        tidy.push(() => logs.stop());
        break;
      }
      case 'compose': {
        await hasDocker(context);
        const dir = workdir ? await cloneInto(source, workdir, context) : await fetchGit(source, { cacheDir, ...context });
        emit({ type: 'phase', phase: 'start' });
        const compose = `docker compose -p ${name} ${source.file ? `-f ${quote(source.file)}` : ''}`;
        tidy.push(() => runCommand(`${compose} down --remove-orphans`, { ...context, cwd: dir, signal: undefined, label: 'docker compose down' }));
        await runCommand(`${compose} up -d --build ${quote(source.service)}`, { ...context, cwd: dir, label: `docker compose up ${source.service}` });
        break;
      }
      case 'git':
      case 'archive': {
        const fetched = workdir ? await cloneInto(source, workdir, context)
          : source.kind === 'git' ? await fetchGit(source, { cacheDir, ...context }) : await fetchArchive(source, { cacheDir, ...context });
        const dir = source.dir ? path.join(fetched, source.dir) : fetched;
        if (!existsSync(dir)) throw new RunError(`${source.dir} isn't in the repository.`);
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
    return { base, stop };
  } catch (error) {
    await stop();
    throw error instanceof RunError ? error : new RunError(error.message);
  }
}
