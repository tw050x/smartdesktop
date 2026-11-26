import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import * as agents from '../packages/cli/lib/agents.js';
import { createConnect } from '../packages/app/src/main/connect.js';
import { claudeCodeRuns } from '../packages/cli/lib/claude-code.js';

// Claude Desktop's config file here is always a temporary one: never the user's.
const temp = mkdtempSync(path.join(os.tmpdir(), 'smartplan-connect-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
function claudeFolder() {
  const dir = path.join(temp, `Claude-${n++}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'claude_desktop_config.json');
}

// An app installed in Applications.
const installed = (claudeConfig) => createConnect({
  isPackaged: true,
  execPath: '/Applications/SmartPlan.app/Contents/MacOS/SmartPlan',
  resourcesPath: '/Applications/SmartPlan.app/Contents/Resources',
  env: {},
  agents,
  claudeConfig,
});
const entry = {
  command: '/Applications/SmartPlan.app/Contents/MacOS/SmartPlan',
  args: ['/Applications/SmartPlan.app/Contents/Resources/cli/mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

describe('setup for each AI app', () => {
  test('runs the launcher inside the app, with the app as Node', async () => {
    const setups = await installed(claudeFolder()).setups();
    assert.deepEqual(JSON.parse(setups.config), { mcpServers: { smartplan: entry } });
    assert.deepEqual(agents.launcherFor('/Applications/SmartPlan.app'), entry); // what smartplan setup writes
    assert.equal(setups['claude-code'], 'claude mcp add --scope user smartplan -e ELECTRON_RUN_AS_NODE=1 -- /Applications/SmartPlan.app/Contents/MacOS/SmartPlan /Applications/SmartPlan.app/Contents/Resources/cli/mcp.js');
  });

  test('quotes paths with spaces for the shell', async () => {
    const { setups } = createConnect({ isPackaged: true, execPath: '/Users/a/My Apps/SmartPlan.app/Contents/MacOS/SmartPlan', resourcesPath: '/Users/a/My Apps/SmartPlan.app/Contents/Resources', env: {}, agents, claudeConfig: claudeFolder() });
    assert.match((await setups())['claude-code'], / -- '\/Users\/a\/My Apps\/SmartPlan\.app\/Contents\/MacOS\/SmartPlan' '\/Users\/a\/My Apps\/SmartPlan\.app\/Contents\/Resources\/cli\/mcp\.js'$/);
  });
});

describe('a development copy', () => {
  test('sets itself up as smartplan-dev, with its own data folder and port, beside the installed app', async () => {
    const file = claudeFolder();
    writeFileSync(file, JSON.stringify({ mcpServers: { smartplan: entry } }));
    const dev = createConnect({ isPackaged: false, execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', appPath: '/repo/packages/app', userData: '/Users/a/Library/Application Support/SmartPlan Dev', port: 47846, env: {}, agents, claudeConfig: file });
    assert.equal((await dev.claudeDesktopStatus()).state, 'not-added');
    await dev.addToClaudeDesktop();
    const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
    assert.deepEqual(servers.smartplan, entry); // the installed app's, untouched
    assert.deepEqual(servers['smartplan-dev'].env, { ELECTRON_RUN_AS_NODE: '1', SMARTPLAN_APP: '/repo/packages/app', SMARTPLAN_USER_DATA: '/Users/a/Library/Application Support/SmartPlan Dev', SMARTPLAN_PORT: '47846' });
    assert.match((await dev.setups())['claude-code'], /^claude mcp add --scope user smartplan-dev /);
  });
});

describe('Claude Desktop', () => {
  test('knows when Claude Desktop isn’t installed', async () => {
    const connect = installed(path.join(temp, 'no-claude', 'claude_desktop_config.json'));
    assert.deepEqual(await connect.claudeDesktopStatus(), { state: 'not-installed' });
  });

  test('adds SmartPlan, keeping everything else in the file and a copy of it as it was', async () => {
    const file = claudeFolder();
    const before = { preferences: { theme: 'dark' }, mcpServers: { other: { command: 'other-server' } } };
    writeFileSync(file, JSON.stringify(before));
    const connect = installed(file);
    assert.equal((await connect.claudeDesktopStatus()).state, 'not-added');
    assert.equal((await connect.addToClaudeDesktop()).state, 'added');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...before, mcpServers: { other: { command: 'other-server' }, smartplan: entry } });
    assert.deepEqual(JSON.parse(readFileSync(`${file}.before-smartplan`, 'utf8')), before);
  });

  test('makes the file if Claude Desktop has none yet', async () => {
    const file = claudeFolder();
    const connect = installed(file);
    assert.equal((await connect.addToClaudeDesktop()).state, 'added');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mcpServers: { smartplan: entry } });
    assert.ok(!existsSync(`${file}.before-smartplan`));
  });

  test('notices SmartPlan set up from somewhere else, and brings it up to date', async () => {
    const file = claudeFolder();
    writeFileSync(file, JSON.stringify({ mcpServers: { smartplan: { command: 'npx', args: ['-y', '@smartplan/cli', 'mcp'] } } }));
    const connect = installed(file);
    assert.equal((await connect.claudeDesktopStatus()).state, 'different');
    assert.equal((await connect.addToClaudeDesktop()).state, 'added');
  });

  test('leaves a file it can’t read alone', async () => {
    const file = claudeFolder();
    writeFileSync(file, '{ "mcpServers": { oops');
    const connect = installed(file);
    assert.equal((await connect.claudeDesktopStatus()).state, 'unreadable');
    await assert.rejects(connect.addToClaudeDesktop(), /left alone/);
    assert.equal(readFileSync(file, 'utf8'), '{ "mcpServers": { oops');
  });
});

describe('Claude Code', () => {
  test('recognises its entry for the app where it is now, from `claude mcp get`', () => {
    const details = `smartplan:\n  Scope: User config\n  Type: stdio\n  Command: ${entry.command}\n  Args: ${entry.args[0]}\n`;
    assert.equal(claudeCodeRuns(details, entry), true);
    assert.equal(claudeCodeRuns('smartplan:\n  Command: npx\n  Args: -y @smartplan/mcp\n', entry), false);
    assert.equal(claudeCodeRuns(null, entry), false);
  });
});
