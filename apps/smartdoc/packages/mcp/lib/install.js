import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { APP_NAME, CHECKSUMS, VERSION, assetName, cacheDir, downloadBase } from './platform.js';

// Fetches the app build matching this launcher's version from the GitHub release, checks it
// against the release's checksums, and unpacks it into the cache, once per version. Two
// launchers starting at the same time (say Claude Desktop and Claude Code) share one download:
// the first takes a lock and the other waits for it to finish. `progress` hears how the download
// is going, as (received, total) in bytes, total null if the server doesn't say; `signal` cancels it.

const run = promisify(execFile);
const LOCK_STALE_MS = 10 * 60 * 1000;
const WAIT_STEP_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class UnsupportedPlatformError extends Error {}

export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

// Whether the app for this version still has to be downloaded: it isn't installed, and no other
// launcher is downloading it.
export function needsDownload({ env = process.env } = {}) {
  if (!assetName()) return false;
  const dir = path.join(cacheDir({ env }), VERSION);
  return !existsSync(path.join(dir, `${APP_NAME}.app`)) && !existsSync(`${dir}.lock`);
}

// How big the download is, in bytes, or null if the release doesn't say in time.
export async function downloadSize({ env = process.env } = {}) {
  try {
    const res = await fetch(`${downloadBase({ env })}/${assetName()}`, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
    return (res.ok && Number(res.headers.get('content-length'))) || null;
  } catch {
    return null;
  }
}

// The installed app for this version, downloading it first if needed. Resolves to its path.
export async function ensureInstalled({ env = process.env, log = () => {}, progress = () => {}, signal } = {}) {
  const asset = assetName();
  if (!asset) throw new UnsupportedPlatformError(`${APP_NAME} isn’t available for ${process.platform} (${process.arch}) yet. It runs on macOS for now.`);
  const root = cacheDir({ env });
  const dir = path.join(root, VERSION);
  const appPath = path.join(dir, `${APP_NAME}.app`);
  if (existsSync(appPath)) return appPath;

  await mkdir(root, { recursive: true });
  const lock = `${dir}.lock`;
  while (!(await takeLock(lock))) {
    if (existsSync(appPath)) return appPath;
    signal?.throwIfAborted();
    await sleep(WAIT_STEP_MS);
  }
  try {
    if (existsSync(appPath)) return appPath;
    const base = downloadBase({ env });
    log(`Downloading ${APP_NAME} ${VERSION}…`);
    progress(0, null);
    const sums = parseChecksums(await (await get(`${base}/${CHECKSUMS}`, signal)).text());
    const expected = sums.get(asset);
    if (!expected) throw new Error(`The release has no checksum for ${asset}.`);

    const zip = `${dir}.download.zip`;
    let actual;
    try {
      actual = await download(`${base}/${asset}`, zip, { progress, signal });
    } catch (error) {
      await rm(zip, { force: true });
      throw signal?.aborted ? signal.reason : error; // cancelled: say why
    }
    if (actual !== expected) {
      await rm(zip, { force: true });
      throw new Error(`The download of ${asset} didn’t match the release’s checksum, so it wasn’t used.`);
    }

    // ditto keeps the app's code signature, permissions and symlinks intact.
    const unpacked = `${dir}.partial`;
    await rm(unpacked, { recursive: true, force: true });
    await mkdir(unpacked);
    await run('ditto', ['-x', '-k', zip, unpacked]);
    await rm(zip, { force: true });
    if (!existsSync(path.join(unpacked, `${APP_NAME}.app`))) throw new Error(`${asset} doesn’t contain ${APP_NAME}.app.`);
    await rename(unpacked, dir);
    log(`Installed ${APP_NAME} ${VERSION}.`);
    return appPath;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// A lock is a folder: creating it is atomic. One left behind by a launcher that died mid-download
// is taken over once it's old enough.
async function takeLock(lock) {
  try {
    await mkdir(lock);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const { mtimeMs } = await stat(lock).catch(() => ({ mtimeMs: 0 }));
    if (Date.now() - mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
    return false;
  }
}

async function get(url, signal) {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok) throw new Error(`Couldn’t download ${url} (HTTP ${res.status}).`);
  return res;
}

// Streams a download to a file, hashing it on the way. Resolves to its SHA-256.
async function download(url, file, { progress, signal }) {
  const res = await get(url, signal);
  const total = Number(res.headers.get('content-length')) || null;
  const hash = createHash('sha256');
  let received = 0;
  const tap = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      progress(received, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(file), { signal });
  return hash.digest('hex');
}
