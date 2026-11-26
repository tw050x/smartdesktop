// Installing SmartDesktop from its GitHub release, for an app that finds it gone (the user's choice,
// 2026-11-26: every app shows a small window with Reinstall if SmartDesktop has gone). The latest
// release's zip for this Mac's chip is downloaded, checked against the release's SHA256SUMS.txt,
// unpacked, and checked to be signed by the same developer team as the app installing it (macOS's
// codesign), then put in /Applications, or ~/Applications if that can't be written to (an old copy
// to the Bin first). Node's own fetch and crypto, and macOS's ditto and codesign: nothing else.
//
// Where releases come from: tw050x/smartdesktop, tags `smartdesktop-v…` (the family's repo);
// SMARTDESKTOP_RELEASES (`owner/repo:tag prefix`) and SMARTDESKTOP_INSTALL_DIR move them, for testing.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const APP = 'SmartDesktop.app';

export function releaseSource() {
  const [repo, prefix = 'smartdesktop-v'] = (process.env.SMARTDESKTOP_RELEASES ?? 'tw050x/smartdesktop:smartdesktop-v').split(':');
  return { repo, prefix };
}

// The newest published release whose tag starts with `prefix`: { version, assets: [{ name, url }] }.
export async function latestRelease({ repo, prefix } = releaseSource(), fetcher = fetch) {
  const res = await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=50`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'SmartDesktop installer' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}'s releases`);
  const releases = (await res.json()).filter((one) => !one.draft && !one.prerelease && one.tag_name.startsWith(prefix));
  const newest = releases.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!newest) throw new Error(`No SmartDesktop release in ${repo} yet`);
  return { version: newest.tag_name.slice(prefix.length), assets: newest.assets.map((one) => ({ name: one.name, url: one.browser_download_url, size: one.size })) };
}

// The zip for this Mac (`arch`: arm64 or x64) and the checksums, from a release's assets.
export function pickAssets(assets, arch = process.arch) {
  const zip = assets.find((one) => new RegExp(`-mac-${arch}\\.zip$`).test(one.name));
  const sums = assets.find((one) => one.name === 'SHA256SUMS.txt');
  if (!zip) throw new Error(`The release has no zip for this Mac (${arch})`);
  if (!sums) throw new Error('The release has no SHA256SUMS.txt to check the download against');
  return { zip, sums };
}

// The checksum SHA256SUMS.txt gives for `name` ("<hex>  <name>" lines), or null.
export function sumFor(text, name) {
  for (const line of text.split('\n')) {
    const [hex, file] = line.trim().split(/\s+\*?/);
    if (file === name && /^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase();
  }
  return null;
}

// The developer team an app (a .app folder) is signed by, after checking its signature holds.
export async function teamOf(appPath) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=2', appPath]);
  return /TeamIdentifier=(\S+)/.exec(stderr)?.[1] ?? null;
}

// The .app this process runs from (the app installing), for its team.
const ownApp = () => {
  const at = process.execPath.indexOf('.app/');
  return at < 0 ? null : process.execPath.slice(0, at + 4);
};

// Where to install: SMARTDESKTOP_INSTALL_DIR, else /Applications if it can be written to, else
// ~/Applications.
async function installDir() {
  if (process.env.SMARTDESKTOP_INSTALL_DIR) return path.resolve(process.env.SMARTDESKTOP_INSTALL_DIR);
  try {
    await access('/Applications', 2); // fs.constants.W_OK
    return '/Applications';
  } catch {
    return path.join(os.homedir(), 'Applications');
  }
}

// Downloads, checks and installs the latest SmartDesktop. `progress({ step, received, total })` as it
// goes; `team`, the team it must be signed by (this app's, by default; a development build, which
// isn't signed, needs it given or skips the check with `team: false`); `trash(path)` for an old copy
// (Electron's shell.trashItem). Gives { path, version }.
export async function installDesktop({ progress = () => {}, team, trash, source = releaseSource(), fetcher = fetch } = {}) {
  progress({ step: 'Finding the latest SmartDesktop' });
  const release = await latestRelease(source, fetcher);
  const { zip, sums } = pickAssets(release.assets);
  const expected = sumFor(await (await fetcher(sums.url)).text(), zip.name);
  if (!expected) throw new Error(`SHA256SUMS.txt doesn't list ${zip.name}`);

  const work = await mkdtemp(path.join(os.tmpdir(), 'smartdesktop-install-'));
  try {
    progress({ step: 'Downloading SmartDesktop', received: 0, total: zip.size });
    const res = await fetcher(zip.url);
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status})`);
    const file = path.join(work, zip.name);
    const hash = createHash('sha256');
    let received = 0;
    const counted = Readable.fromWeb(res.body).on('data', (part) => {
      hash.update(part);
      received += part.length;
      progress({ step: 'Downloading SmartDesktop', received, total: zip.size });
    });
    await pipeline(counted, createWriteStream(file));
    if (hash.digest('hex') !== expected) throw new Error('The download doesn’t match its checksum, so it wasn’t installed');

    progress({ step: 'Checking SmartDesktop' });
    const unpacked = path.join(work, 'unpacked');
    await run('/usr/bin/ditto', ['-x', '-k', file, unpacked]);
    const app = path.join(unpacked, APP);
    if (!existsSync(app)) throw new Error(`The download has no ${APP}`);
    const wanted = team === undefined ? await (async () => {
      const own = ownApp();
      return own ? teamOf(own) : null;
    })() : team;
    if (wanted !== false) {
      if (!wanted) throw new Error('This app isn’t signed, so there’s no team to check SmartDesktop against');
      const theirs = await teamOf(app);
      if (theirs !== wanted) throw new Error(`SmartDesktop is signed by ${theirs ?? 'no one'}, not ${wanted}, so it wasn’t installed`);
    }

    progress({ step: 'Installing SmartDesktop' });
    const dir = await installDir();
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, APP);
    if (existsSync(target)) {
      if (trash) await trash(target);
      else await rm(target, { recursive: true, force: true });
    }
    await rename(app, target).catch(async () => run('/usr/bin/ditto', [app, target]));
    return { path: target, version: release.version };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
