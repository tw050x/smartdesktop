import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { addToClaudeDesktop, claudeDesktopConfig, claudeDesktopStatus, launcherFor } from './agents.js';
import { appVersion, findApp, hasLauncher } from './apps.js';
import { addToClaudeCode, claudeCodeEntry, claudeCodeRuns, hasClaudeCode } from './claude-code.js';
import { appRunning, installDir, installRelease, latestRelease, quitApp } from './install.js';
import { probe } from './launch.js';
import { APP_NAME, WEBSITE } from './platform.js';

// The smartdoc command's install, setup and doctor. install puts the latest release of the app
// in Applications, then offers setup. setup and doctor find the installed app, then look at each
// AI app SmartDoc can set up itself (Claude Desktop and Claude Code): setup adds SmartDoc to them,
// asking first; doctor only looks, and says what to fix. `out` is where they write;
// `ask(question)` resolves true for yes.

const ok = (text) => `  ✓ ${text}`;
const bad = (text) => `  ✗ ${text}`;
const note = (text) => `    ${text}`;

// The installed app and the entry for it, or a reason there's none.
async function installedApp() {
  const app = await findApp();
  if (!app) return { problem: `${APP_NAME} isn't installed. Install it with: npx @smartdoc/cli install (or download it from ${WEBSITE}), then run this again.` };
  const version = await appVersion(app);
  if (!hasLauncher(app)) return { app, version, problem: `${APP_NAME} ${version ?? ''} in ${app} is too old to connect this way. Update it with: npx @smartdoc/cli install, then run this again.` };
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
  out('Set them up later with: npx @smartdoc/cli setup');
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
    out(bad(`Its settings file isn't in a form SmartDoc can safely change, so it was left alone: ${file}`));
    failed = true;
  } else if (await ask(`  ${desktop.state === 'different' ? 'Update SmartDoc in' : 'Add SmartDoc to'} Claude Desktop's settings (a copy of the file is kept)?`)) {
    await addToClaudeDesktop(file, found.entry);
    out(ok('Done. Quit Claude Desktop and open it again to connect.'));
  } else out(note('Skipped.'));
  if (desktop.extension) out(note('SmartDoc is also installed as an extension in Claude Desktop. Remove it in Settings → Extensions, so its tools don’t show twice.'));

  out('\nClaude Code');
  if (!(await hasClaudeCode())) out(note('Not on this computer (no claude command).'));
  else {
    const details = await claudeCodeEntry();
    if (claudeCodeRuns(details, found.entry)) out(ok('Already set up.'));
    else if (await ask(`  ${details ? 'Replace SmartDoc’s setup in' : 'Add SmartDoc to'} Claude Code, for all your projects?`)) {
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
  else if (state === 'locked') fail(`Something answers on SmartDoc's port, but not with SmartDoc's token`, 'Quit SmartDoc and open it again.');
  else out(note(`${APP_NAME} isn't running. That's fine: your agent opens it when it needs it.`));

  out('\nClaude Desktop');
  const desktop = await claudeDesktopStatus(claudeDesktopConfig(), found.entry);
  if (desktop.state === 'not-installed') out(note('Not on this Mac.'));
  else if (desktop.state === 'added') out(ok('Set up for SmartDoc where it is now'));
  else if (desktop.state === 'not-added') fail('SmartDoc isn’t set up in Claude Desktop', 'Run: npx @smartdoc/cli setup');
  else if (desktop.state === 'different') fail('Claude Desktop is set up for SmartDoc somewhere else (or the old way)', 'Run: npx @smartdoc/cli setup');
  else fail(`Its settings file isn't valid JSON: ${desktop.file}`, 'Fix or remove the file, then run: npx @smartdoc/cli setup');
  if (desktop.extension) fail('SmartDoc is also installed as an extension, so its tools may show twice', 'Remove it in Claude Desktop’s Settings → Extensions.');

  out('\nClaude Code');
  if (!(await hasClaudeCode())) out(note('Not on this computer (no claude command).'));
  else {
    const details = await claudeCodeEntry();
    if (claudeCodeRuns(details, found.entry)) out(ok('Set up for SmartDoc where it is now'));
    else if (details) fail('Claude Code is set up for SmartDoc somewhere else (or the old way)', 'Run: npx @smartdoc/cli setup');
    else fail('SmartDoc isn’t set up in Claude Code', 'Run: npx @smartdoc/cli setup');
  }

  out(problems ? `\n${problems} thing${problems === 1 ? '' : 's'} to fix.` : '\nAll good.');
  return problems ? 1 : 0;
}
