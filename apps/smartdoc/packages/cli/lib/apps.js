import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_ID, APP_NAME } from './platform.js';

// Finding the installed SmartDoc app, for the smartdoc command's setup and doctor.

const run = promisify(execFile);

// Copies that aren't installed: on a disk image, in the Bin, or a download kept by an earlier
// version's launcher.
const notInstalled = (p) => p.startsWith('/Volumes/') || p.includes('/.Trash/') || p.includes('/Library/Caches/');

// The installed app's bundle: the one in Applications if there is one, else wherever macOS has
// seen one (Spotlight, by the app's ID). Null if there's none.
export async function findApp({ home = os.homedir() } = {}) {
  for (const p of [`/Applications/${APP_NAME}.app`, path.join(home, 'Applications', `${APP_NAME}.app`)]) {
    if (existsSync(p)) return p;
  }
  try {
    const { stdout } = await run('mdfind', [`kMDItemCFBundleIdentifier == '${APP_ID}'`]);
    return stdout.split('\n').map((p) => p.trim()).find((p) => p.endsWith('.app') && !notInstalled(p)) ?? null;
  } catch {
    return null;
  }
}

// The app's version, from its Info.plist; null if it can't be read.
export async function appVersion(appBundle) {
  try {
    const { stdout } = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appBundle, 'Contents', 'Info.plist')]);
    return stdout.trim();
  } catch {
    return null;
  }
}

// Whether the app carries the MCP launcher AI apps run (SmartDoc 0.4.0 and later).
export const hasLauncher = (appBundle) => existsSync(path.join(appBundle, 'Contents', 'Resources', 'cli', 'mcp.js'));
