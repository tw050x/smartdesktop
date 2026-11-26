import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Claude Code, through its own `claude mcp` commands (it keeps its MCP servers itself).

const run = promisify(execFile);

// Whether the claude command is on this computer.
export async function hasClaudeCode() {
  try {
    await run('claude', ['--version']);
    return true;
  } catch {
    return false;
  }
}

// SmartDoc's entry in Claude Code: null if there's none, else what `claude mcp get` says about it.
export async function claudeCodeEntry() {
  try {
    const { stdout } = await run('claude', ['mcp', 'get', 'smartdoc'], { timeout: 60 * 1000 });
    return stdout;
  } catch {
    return null; // `claude mcp get` fails when there's no such server
  }
}

// Whether that entry runs `entry`.
export const claudeCodeRuns = (details, entry) => Boolean(details?.includes(entry.command) && details.includes(entry.args[0]));

// Adds SmartDoc for every project (user scope), replacing an entry it had.
export async function addToClaudeCode(entry, { replace = false } = {}) {
  if (replace) await run('claude', ['mcp', 'remove', 'smartdoc']);
  await run('claude', ['mcp', 'add-json', '--scope', 'user', 'smartdoc', JSON.stringify({ type: 'stdio', ...entry })]);
}
