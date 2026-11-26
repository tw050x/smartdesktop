import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Setting up AI apps to reach SmartSpec, shared by the app (its MCP panel, see the app's
// connect.js) and the smartspec command (setup and doctor). Each AI app runs `entry`: SmartSpec's
// MCP launcher (mcp.js), which is inside the app, run with the app's own executable as Node, so
// the AI app needs nothing else installed.

// The entry for an installed app, from its bundle's path.
export function launcherFor(appBundle) {
  return {
    command: path.join(appBundle, 'Contents', 'MacOS', 'SmartSpec'),
    args: [path.join(appBundle, 'Contents', 'Resources', 'cli', 'mcp.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

// A word for a shell, quoted only if it needs it.
const shellWord = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

// Each AI app knows SmartSpec by `name`: smartspec, or smartspec-dev for a development copy, so the
// two can be set up side by side.

// Claude Code's command to add it, for every project (user scope).
export const claudeCodeCommand = ({ command, args, env }, name = 'smartspec') => [
  `claude mcp add --scope user ${name}`,
  ...Object.entries(env).map(([k, v]) => `-e ${shellWord(`${k}=${v}`)}`),
  '--',
  ...[command, ...args].map(shellWord),
].join(' ');

// The JSON config entry that Claude Desktop and most other agents take.
export const configJson = (entry, name = 'smartspec') => JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);

// --- Claude Desktop ---------------------------------------------------------------------------

// Claude Desktop keeps its MCP servers in this file. Tests and development point SmartSpec at
// another with SMARTSPEC_CLAUDE_CONFIG (which the packaged app ignores), so they never touch the
// real one.
export function claudeDesktopConfig({ env = process.env, home = os.homedir(), allowOverride = true } = {}) {
  if (allowOverride && env.SMARTSPEC_CLAUDE_CONFIG) return path.resolve(env.SMARTSPEC_CLAUDE_CONFIG);
  return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

// The config file's contents: {} if there's no file yet; null if it isn't JSON SmartSpec can
// safely change (then it's left alone).
async function readConfig(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    return null;
  }
  if (!text.trim()) return {};
  try {
    const config = JSON.parse(text);
    return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
  } catch {
    return null;
  }
}

// Where Claude Desktop stands: 'not-installed' (no Claude Desktop folder), 'unreadable' (its config
// file isn't JSON), 'not-added', 'added', or 'different' (SmartSpec is set up differently, say from
// before the app moved).
export async function claudeDesktopStatus(file, entry, name = 'smartspec') {
  if (!existsSync(path.dirname(file))) return { state: 'not-installed' };
  const config = await readConfig(file);
  if (!config) return { state: 'unreadable', file };
  const current = config.mcpServers?.[name];
  if (!current) return { state: 'not-added' };
  return { state: isDeepStrictEqual(current, entry) ? 'added' : 'different' };
}

// Adds SmartSpec to Claude Desktop's config file, or brings its entry up to date, keeping
// everything else in the file. The file as it was is copied beside it first.
export async function addToClaudeDesktop(file, entry, name = 'smartspec') {
  const config = await readConfig(file);
  if (!config) throw new Error(`Claude Desktop’s settings file isn’t in a form SmartSpec can safely change, so it was left alone: ${file}`);
  if (existsSync(file)) await fs.copyFile(file, `${file}.before-smartspec`);
  const updated = { ...config, mcpServers: { ...(config.mcpServers ?? {}), [name]: entry } };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(updated, null, 2)}\n`);
  return claudeDesktopStatus(file, entry, name);
}
