import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { addToClaudeDesktop, claudeDesktopConfig, claudeDesktopStatus, launcherFor } from './agents.js';
import { appVersion, findApp } from './apps.js';
import { addToClaudeCode, claudeCodeEntry, claudeCodeRuns, hasClaudeCode } from './claude-code.js';
import { appRunning, installDir, installRelease, latestRelease, quitApp } from './install.js';
import { probe } from './launch.js';
import { APP_NAME, DOWNLOAD_PAGE } from './platform.js';

// The smartspec command's install, setup and doctor. install puts the latest release of the app
// in Applications, then offers setup. setup and doctor find the installed app, then look at each
// AI app SmartSpec can set up itself (Claude Desktop and Claude Code): setup adds SmartSpec to them,
// asking first; doctor only looks, and says what to fix. `out` is where they write;
// `ask(question)` resolves true for yes.

const ok = (text) => `  ✓ ${text}`;
const bad = (text) => `  ✗ ${text}`;
const note = (text) => `    ${text}`;

// The installed app and the entry for it, or a reason there's none.
async function installedApp() {
  const app = await findApp();
  if (!app) return { problem: `${APP_NAME} isn't installed. Install it with: npx @smartspec/cli install (or download it from ${DOWNLOAD_PAGE}), then run this again.` };
  const version = await appVersion(app);
  return { app, version, entry: launcherFor(app) };
}

// Asks on the terminal; with --yes, or with no terminal to ask on, says yes.
export function terminalAsk({ yes = false } = {}) {
  return async (question) => {
    if (yes || !process.stdin.isTTY) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    rl.close();
    return answer === '' || answer === 'y' || answer === 'yes';
  };
}

// The download's progress on one line of the terminal, if there is one.
function progressLine(stream = process.stdout) {
  if (!stream.isTTY) return { update() {}, done() {} };
  let shown = -1;
  return {
    update(received, total) {
      const percent = total ? Math.floor((received / total) * 100) : null;
      if (percent === shown) return;
      shown = percent;
      const mb = (n) => Math.round(n / 1e6);
      stream.write(`\r  ${percent ?? '…'}%  ${mb(received)}${total ? ` of ${mb(total)}` : ''} MB   `);
    },
    done: () => stream.write('\r\x1b[K'),
  };
}

export async function install({ out = console.log, ask = terminalAsk() } = {}) {
  if (process.platform !== 'darwin') {
    out(`${APP_NAME} runs on macOS for now.`);
    return 1;
  }
  const { version, zip } = await latestRelease();
  if (!zip) {
    out(`The latest release (${version}) has no build for this Mac (${process.arch}).`);
    return 1;
  }
  const dir = await installDir();
  const target = path.join(dir, `${APP_NAME}.app`);
  const current = existsSync(target) ? await appVersion(target) : null;
  if (current === version) out(ok(`${APP_NAME} ${version} is already installed in ${target}`));
  else {
    if (existsSync(target) && !(await ask(`Replace ${APP_NAME} ${current ?? ''} in ${dir} with ${version}?`))) {
      out('Left as it is.');
      return 0;
    }
    if (await appRunning()) {
      if (!(await ask(`${APP_NAME} is open. Quit it, to install ${version}?`))) {
        out(`Quit ${APP_NAME}, then run this again.`);
        return 1;
      }
      await quitApp();
    }
    out(`Downloading ${APP_NAME} ${version} for this Mac…`);
    const line = progressLine();
    try {
      await installRelease(zip, dir, { progress: line.update });
    } finally {
      line.done();
    }
    out(ok(`Installed ${APP_NAME} ${version} in ${target}`));
  }
  if (await ask('\nSet up Claude Desktop and Claude Code to use it now?')) {
    out('');
    return setup({ out, ask });
  }
  out('Set them up later with: npx @smartspec/cli setup');
  return 0;
}

export async function setup({ out = console.log, ask = terminalAsk() } = {}) {
  const found = await installedApp();
  if (found.problem) {
    out(found.problem);
    return 1;
  }
  out(`Setting up ${APP_NAME} ${found.version} (${found.app}).`);
  let failed = false;

  out('\nClaude Desktop');
  const file = claudeDesktopConfig();
  const desktop = await claudeDesktopStatus(file, found.entry);
  if (desktop.state === 'not-installed') out(note('Not on this Mac.'));
  else if (desktop.state === 'added') out(ok('Already set up.'));
  else if (desktop.state === 'unreadable') {
    out(bad(`Its settings file isn't in a form SmartSpec can safely change, so it was left alone: ${file}`));
    failed = true;
  } else if (await ask(`  ${desktop.state === 'different' ? 'Update SmartSpec in' : 'Add SmartSpec to'} Claude Desktop's settings (a copy of the file is kept)?`)) {
    await addToClaudeDesktop(file, found.entry);
    out(ok('Done. Quit Claude Desktop and open it again to connect.'));
  } else out(note('Skipped.'));

  out('\nClaude Code');
  if (!(await hasClaudeCode())) out(note('Not on this computer (no claude command).'));
  else {
    const details = await claudeCodeEntry();
    if (claudeCodeRuns(details, found.entry)) out(ok('Already set up.'));
    else if (await ask(`  ${details ? 'Replace SmartSpec’s setup in' : 'Add SmartSpec to'} Claude Code, for all your projects?`)) {
      try {
        await addToClaudeCode(found.entry, { replace: Boolean(details) });
        out(ok('Done. Start a new Claude Code session to connect.'));
      } catch (error) {
        out(bad(`Claude Code didn't take it: ${error.stderr?.trim() || error.message}`));
        failed = true;
      }
    } else out(note('Skipped.'));
  }

  out(`\nFor other agents, open ${APP_NAME} and click its MCP server status, at the top right.`);
  return failed ? 1 : 0;
}

export async function doctor({ out = console.log } = {}) {
  let problems = 0;
  const fail = (text, fix) => {
    problems++;
    out(bad(text));
    if (fix) out(note(fix));
  };

  out(`${APP_NAME}`);
  const found = await installedApp();
  if (found.problem) {
    fail(found.problem);
    return 1;
  }
  out(ok(`${APP_NAME} ${found.version} is installed in ${found.app}`));
  const state = await probe();
  if (state === 'up') out(ok(`${APP_NAME} is running, and its MCP server answers`));
  else if (state === 'locked') fail(`Something answers on SmartSpec's port, but not with SmartSpec's token`, 'Quit SmartSpec and open it again.');
  else out(note(`${APP_NAME} isn't running. That's fine: your agent opens it when it needs it.`));

  out('\nClaude Desktop');
  const desktop = await claudeDesktopStatus(claudeDesktopConfig(), found.entry);
  if (desktop.state === 'not-installed') out(note('Not on this Mac.'));
  else if (desktop.state === 'added') out(ok('Set up for SmartSpec where it is now'));
  else if (desktop.state === 'not-added') fail('SmartSpec isn’t set up in Claude Desktop', 'Run: npx @smartspec/cli setup');
  else if (desktop.state === 'different') fail('Claude Desktop is set up for SmartSpec somewhere else (or the old way)', 'Run: npx @smartspec/cli setup');
  else fail(`Its settings file isn't valid JSON: ${desktop.file}`, 'Fix or remove the file, then run: npx @smartspec/cli setup');

  out('\nClaude Code');
  if (!(await hasClaudeCode())) out(note('Not on this computer (no claude command).'));
  else {
    const details = await claudeCodeEntry();
    if (claudeCodeRuns(details, found.entry)) out(ok('Set up for SmartSpec where it is now'));
    else if (details) fail('Claude Code is set up for SmartSpec somewhere else (or the old way)', 'Run: npx @smartspec/cli setup');
    else fail('SmartSpec isn’t set up in Claude Code', 'Run: npx @smartspec/cli setup');
  }

  out(problems ? `\n${problems} thing${problems === 1 ? '' : 's'} to fix.` : '\nAll good.');
  return problems ? 1 : 0;
}
