import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DownloadDeclined } from './download.js';
import { downloadSize, ensureInstalled, needsDownload } from './install.js';
import { APP_NAME, mcpUrl, userDataDir } from './platform.js';

// Makes sure the app is running with its MCP server up, opening it if not. A running app is
// shared: every launcher connects to the same one, and it stays open when they disconnect.

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

// `download` (see download.js) shows the user how a first-time download is going.
export async function ensureRunning({ env = process.env, log = () => {}, download = null } = {}) {
  if ((await probe({ env })) === 'up') return;
  try {
    await openApp({ env, log, download });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await probe({ env })) === 'up') return;
      await sleep(POLL_MS);
    }
    throw new Error(`${APP_NAME} didn’t start in time. Open it yourself, then try again.`);
  } finally {
    download?.finish();
  }
}

async function install({ env, log, download }) {
  if (!download) return ensureInstalled({ env, log });
  const signal = download.begin();
  try {
    if (needsDownload({ env }) && !(await download.ask(await downloadSize({ env })))) throw new DownloadDeclined();
    const appPath = await ensureInstalled({ env, log, signal, progress: download.progress });
    download.installed();
    return appPath;
  } catch (error) {
    throw download.failed(error);
  }
}

async function openApp({ env, log, download }) {
  const override = env.SMARTDOC_APP;
  if (override) {
    log(`Opening ${override}…`);
    return start(appCommand(path.resolve(override)), env);
  }
  const appPath = await install({ env, log, download });
  log(`Opening ${APP_NAME}…`);
  return start(['open', [appPath]], env);
}

// How to start an app given by path: a macOS app bundle, a project folder (run with its own
// Electron, as in development) or an executable.
export function appCommand(target) {
  if (target.endsWith('.app')) return ['open', [target]];
  if (existsSync(target) && statSync(target).isDirectory()) {
    const electron = path.join(target, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    return [electron, [target]];
  }
  return [target, []];
}

// Detached, so the app outlives this launcher and the AI app that started it.
function start([command, args], env) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
  child.on('error', () => {}); // reported as a timeout by ensureRunning
  child.unref();
}
