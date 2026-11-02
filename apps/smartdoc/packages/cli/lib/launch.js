import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_ID, APP_NAME, WEBSITE, appEnv, mcpUrl, ownApp, userDataDir } from './platform.js';

// Makes sure the app is running with its MCP server up, opening it if not. A running app is
// shared: every launcher connects to the same one, and it stays open when they disconnect. The
// app isn't downloaded from here: the user installs it from the website.

const run = promisify(execFile);

const START_TIMEOUT_MS = 90 * 1000;
const POLL_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The token the app's MCP server expects. It's kept in the app's data folder, so it's only
// readable by the user (and only exists once the app has run).
export function readToken({ env = process.env } = {}) {
  try {
    return readFileSync(path.join(userDataDir({ env }), 'mcp-token'), 'utf8').trim();
  } catch {
    return null;
  }
}

// 'up' when the server answers with this token; 'down' when nothing is listening; 'locked' when
// something answers but refuses the token (it may not have been written yet).
export async function probe({ env = process.env } = {}) {
  const token = readToken({ env });
  try {
    // The server only takes POST, so a GET that gets past the token check answers 405.
    const res = await fetch(mcpUrl(env), { headers: token ? { authorization: `Bearer ${token}` } : {} });
    await res.body?.cancel();
    return res.status === 405 ? 'up' : 'locked';
  } catch {
    return 'down';
  }
}

export class NotInstalled extends Error {
  constructor() {
    super(`${APP_NAME} isn't installed on this computer. Tell the user to download it from ${WEBSITE}, open it once, then try again.`);
  }
}

export async function ensureRunning({ env = process.env, log = () => {}, execPath = process.execPath, platform = process.platform } = {}) {
  if ((await probe({ env })) === 'up') return;
  await openApp({ env, log, execPath, platform });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await probe({ env })) === 'up') return;
    await sleep(POLL_MS);
  }
  throw new Error(`${APP_NAME} didn’t start in time. Open it yourself, then try again.`);
}

// Opens the app: the one given by SMARTDOC_APP, else the app this launcher is part of, else the
// installed app, which macOS finds by its ID wherever it is.
async function openApp({ env, log, execPath, platform }) {
  const override = env.SMARTDOC_APP;
  if (override) {
    log(`Opening ${override}…`);
    return start(appCommand(path.resolve(override)), appEnv(env));
  }
  if (platform !== 'darwin') throw new Error(`${APP_NAME} runs on macOS for now.`);
  const own = ownApp(execPath);
  log(`Opening ${own ?? APP_NAME}…`);
  try {
    await run('open', own ? [own] : ['-b', APP_ID], { env: appEnv(env) });
  } catch {
    throw new NotInstalled();
  }
}

// How to start an app given by path: a macOS app bundle, a project folder (run with its own
// Electron, as in development: the nearest one installed, which in a workspace may be above it)
// or an executable.
export function appCommand(target) {
  if (target.endsWith('.app')) return ['open', [target]];
  if (existsSync(target) && statSync(target).isDirectory()) {
    const name = process.platform === 'win32' ? 'electron.cmd' : 'electron';
    for (let dir = target; ; dir = path.dirname(dir)) {
      const electron = path.join(dir, 'node_modules', '.bin', name);
      if (existsSync(electron) || dir === path.dirname(dir)) return [electron, [target]];
    }
  }
  return [target, []];
}

// Detached, so the app outlives this launcher and the AI app that started it.
function start([command, args], env) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
  child.on('error', () => {}); // reported as a timeout by ensureRunning
  child.unref();
}
