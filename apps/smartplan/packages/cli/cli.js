#!/usr/bin/env node
// The smartplan command (npx @smartplan/cli <command>): installs the SmartPlan app, sets up AI apps to
// use it, checks the connection, and runs SmartPlan's MCP connection for agents set up with npx.

const HELP = `Usage: npx @smartplan/cli <command>

Commands:
  install [--yes] Download the latest SmartPlan app into Applications, then offer setup
  setup [--yes]   Add SmartPlan to Claude Desktop and Claude Code (asks first; --yes doesn't)
  doctor          Check SmartPlan and its connections, and say what to fix
  mcp             Run SmartPlan's MCP connection (what agents set up with npx run)

SmartPlan itself is a Mac app: install it with the install command, or download it from
https://github.com/tw050x/smartplan/releases/latest.`;

const [command, ...rest] = process.argv.slice(2);

if (command === 'mcp') {
  await import('./mcp.js');
} else if (['install', 'setup', 'doctor'].includes(command)) {
  const commands = await import('./lib/commands.js');
  const ask = commands.terminalAsk({ yes: rest.includes('--yes') || rest.includes('-y') });
  try {
    process.exitCode = await commands[command]({ ask });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  console.log(HELP);
  process.exitCode = command && !['help', '--help', '-h'].includes(command) ? 1 : 0;
}
