import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where things are on this computer. Everything here can be overridden with environment
// variables, which development and tests use to keep away from the user's real app and data:
//   SMARTDOC_APP        the app to open: a SmartDoc.app, an executable, or a project
//                       folder (run with its own Electron), instead of the installed one
//   SMARTDOC_USER_DATA  the app's data folder (passed on to a project-folder app)
//   SMARTDOC_PORT       the port the app's MCP server listens on (likewise)

export const APP_NAME = 'SmartDoc';
export const APP_ID = 'com.tw050x.smartdoc';
export const REPOSITORY = 'tw050x/smartdoc';
export const WEBSITE = 'https://tw050x.github.io/smartdoc/';
export const DEFAULT_PORT = 47815;
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const port = (env = process.env) => Number(env.SMARTDOC_PORT) || DEFAULT_PORT;
export const mcpUrl = (env = process.env) => `http://127.0.0.1:${port(env)}/mcp`;

// The folder Electron gives the app for its data (it holds the MCP server's token).
export function userDataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.SMARTDOC_USER_DATA) return path.resolve(env.SMARTDOC_USER_DATA);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP_NAME);
}

// The app bundle this launcher runs from, when it's the copy inside the app (run by the app's own
// executable, …/SmartDoc.app/Contents/MacOS/SmartDoc, as Node); null when it runs from npm.
export function ownApp(execPath = process.execPath) {
  const match = execPath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return match ? match[1] : null;
}

// The environment for opening the app: without ELECTRON_RUN_AS_NODE, which runs this launcher
// inside the app as Node and would make an Electron app it starts run as Node too.
export function appEnv(env = process.env) {
  const { ELECTRON_RUN_AS_NODE, ...rest } = env;
  return rest;
}
