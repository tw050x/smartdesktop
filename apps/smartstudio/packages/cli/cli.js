#!/usr/bin/env node
// The smartstudio command (npx @smartstudio/cli <command>): installs the SmartStudio app, sets up AI apps to
// use it, checks the connection, and runs SmartStudio's MCP connection for agents set up with npx.

const HELP = `Usage: npx @smartstudio/cli <command>

Commands:
  install [--yes] Download the latest SmartStudio app into Applications, then offer setup
  setup [--yes]   Add SmartStudio to Claude Desktop and Claude Code (asks first; --yes doesn't)
  doctor          Check SmartStudio and its connections, and say what to fix
  mcp             Run SmartStudio's MCP connection (what agents set up with npx run)

SmartStudio itself is a Mac app: install it with the install command, or download it from
https://github.com/tw050x/smartdesktop/releases/latest.`;

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
