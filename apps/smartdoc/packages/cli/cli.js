#!/usr/bin/env node
// The smartdoc command (npx @smartdoc/cli <command>): installs the SmartDoc app, sets up AI apps to
// use it, checks the connection, and runs SmartDoc's MCP connection for agents set up with npx.

const HELP = `Usage: npx @smartdoc/cli <command>

Commands:
  install [--yes] Download the latest SmartDoc app into Applications, then offer setup
  setup [--yes]   Add SmartDoc to Claude Desktop and Claude Code (asks first; --yes doesn't)
  doctor          Check SmartDoc and its connections, and say what to fix
  mcp             Run SmartDoc's MCP connection (what agents set up with npx run)

SmartDoc itself is a Mac app: install it with the install command, or download it from
https://tw050x.github.io/smartdoc/.`;

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
