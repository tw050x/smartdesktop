import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where things are on this computer, and which build of the app it needs. Everything here can be
// overridden with environment variables, which development and tests use to keep away from the
// user's real app and data:
//   SHORTLIST_DOCK_APP        the app to open: a Shortlist Dock.app, an executable, or a project
//                             folder (run with its own Electron), instead of the downloaded one
//   SHORTLIST_DOCK_USER_DATA  the app's data folder (passed on to a project-folder app)
//   SHORTLIST_DOCK_PORT       the port the app's MCP server listens on (likewise)
//   SHORTLIST_DOCK_CACHE      where downloaded builds are kept
//   SHORTLIST_DOCK_DOWNLOADS  the base URL builds are downloaded from (a release's download URL)

export const APP_NAME = 'Shortlist Dock';
export const REPOSITORY = 'tw050x/shortlist-dock';
export const DEFAULT_PORT = 47815;
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const port = (env = process.env) => Number(env.SHORTLIST_DOCK_PORT) || DEFAULT_PORT;
export const mcpUrl = (env = process.env) => `http://127.0.0.1:${port(env)}/mcp`;

// The folder Electron gives the app for its data (it holds the MCP server's token).
export function userDataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.SHORTLIST_DOCK_USER_DATA) return path.resolve(env.SHORTLIST_DOCK_USER_DATA);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP_NAME);
}

// Downloaded builds live here, one folder per version.
export function cacheDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.SHORTLIST_DOCK_CACHE) return path.resolve(env.SHORTLIST_DOCK_CACHE);
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'shortlist-dock');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'shortlist-dock', 'Cache');
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'shortlist-dock');
}

// The release file holding the app for this computer, as named by the release build
// (electron-builder's artifactName in the app's package.json). Null where there's no build yet.
export function assetName({ version = VERSION, platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `shortlist-dock-${version}-mac-${arch}.zip`;
  return null;
}

export const downloadBase = ({ env = process.env, version = VERSION } = {}) =>
  (env.SHORTLIST_DOCK_DOWNLOADS ?? `https://github.com/${REPOSITORY}/releases/download/v${version}`).replace(/\/$/, '');

export const CHECKSUMS = 'SHA256SUMS.txt';
