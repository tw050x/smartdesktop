import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { access, constants, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { APP_ID, APP_NAME, REPOSITORY } from './platform.js';

// Installing the app, for the smartdoc command's install: the latest release's build for this
// Mac, as the app's own updater finds it (latest-mac.yml lists each zip with its SHA-512), checked
// and unpacked into Applications. Tests point it at a stand-in release (SMARTDOC_DOWNLOADS) and
// another folder (SMARTDOC_INSTALL_DIR).

const run = promisify(execFile);

export const downloadBase = (env = process.env) => (env.SMARTDOC_DOWNLOADS ?? `https://github.com/${REPOSITORY}/releases/latest/download`).replace(/\/$/, '');

// The release's version and files, from latest-mac.yml (the few lines electron-builder writes).
export function parseLatest(text) {
  const files = [];
  let version = null;
  for (const line of text.split(/\r?\n/)) {
    const field = line.match(/^\s*(-\s+)?(\w+):\s*'?([^']*?)'?\s*$/);
    if (!field) continue;
    const [, item, key, value] = field;
    if (!item && !line.startsWith(' ') && key === 'version') version = value;
    else if (item && key === 'url') files.push({ url: value });
    else if (line.startsWith('    ') && files.length && (key === 'sha512' || key === 'size')) files.at(-1)[key] = key === 'size' ? Number(value) : value;
  }
  return { version, files };
}

// The zip for this Mac: arm64 or x64 in its name.
export function zipFor(files, arch = process.arch) {
  return files.find((f) => f.url.endsWith('.zip') && f.url.includes(`-mac-${arch}`)) ?? null;
}

// Where the app goes: Applications if the user can write there, else ~/Applications.
export async function installDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.SMARTDOC_INSTALL_DIR) return path.resolve(env.SMARTDOC_INSTALL_DIR);
  try {
    await access('/Applications', constants.W_OK);
    return '/Applications';
  } catch {
    return path.join(home, 'Applications');
  }
}

async function get(url, signal) {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok) throw new Error(`Couldn’t download ${url} (HTTP ${res.status}).`);
  return res;
}

// What the latest release offers this Mac: { version, zip } (zip null if there's no build for it).
export async function latestRelease({ env = process.env, arch = process.arch } = {}) {
  const { version, files } = parseLatest(await (await get(`${downloadBase(env)}/latest-mac.yml`)).text());
  if (!version) throw new Error('The latest release doesn’t say its version.');
  return { version, zip: zipFor(files, arch) };
}

// Downloads and checks the zip, unpacks it, and puts the app in `dir` (replacing one there). Calls
// `progress(received, total)` as it downloads. Resolves to the app's path.
export async function installRelease(zip, dir, { env = process.env, progress = () => {} } = {}) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'smartdoc-install-'));
  try {
    const file = path.join(work, path.basename(zip.url));
    const res = await get(`${downloadBase(env)}/${zip.url}`);
    const total = Number(res.headers.get('content-length')) || zip.size || null;
    const hash = createHash('sha512');
    let received = 0;
    const tap = new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        received += chunk.length;
        progress(received, total);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(file));
    if (hash.digest('base64') !== zip.sha512) throw new Error(`The download of ${zip.url} didn’t match the release’s checksum, so it wasn’t used.`);

    // ditto keeps the app's code signature, permissions and links intact.
    const unpacked = path.join(work, 'unpacked');
    await run('ditto', ['-x', '-k', file, unpacked]);
    const built = path.join(unpacked, `${APP_NAME}.app`);
    if (!existsSync(built)) throw new Error(`${zip.url} doesn’t contain ${APP_NAME}.app.`);

    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `${APP_NAME}.app`);
    await rm(target, { recursive: true, force: true });
    try {
      await rename(built, target);
    } catch {
      await run('ditto', [built, target]); // another disk: copied instead
    }
    return target;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Whether the app is open (macOS knows it by its ID), and quitting it.
export async function appRunning() {
  try {
    const { stdout } = await run('osascript', ['-e', `application id "${APP_ID}" is running`]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
export async function quitApp() {
  await run('osascript', ['-e', `tell application id "${APP_ID}" to quit`]);
  for (let i = 0; i < 40 && (await appRunning()); i++) await new Promise((r) => setTimeout(r, 250));
}
