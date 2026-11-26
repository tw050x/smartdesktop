#!/usr/bin/env node
// The smartspec command (npx @smartspec/cli <command>): installs the SmartSpec app, sets up AI apps to
// use it, checks the connection, and runs SmartSpec's MCP connection for agents set up with npx.

const HELP = `Usage: npx @smartspec/cli <command>

Commands:
  install [--yes] Download the latest SmartSpec app into Applications, then offer setup
  setup [--yes]   Add SmartSpec to Claude Desktop and Claude Code (asks first; --yes doesn't)
  doctor          Check SmartSpec and its connections, and say what to fix
  mcp             Run SmartSpec's MCP connection (what agents set up with npx run)
  wait            Stay until the user has done what an AI is waiting for (wait --help)

SmartSpec itself is a Mac app: install it with the install command, or download it from
https://github.com/tw050x/smartspec/releases/latest.`;

const [command, ...rest] = process.argv.slice(2);

if (command === 'mcp') {
  await import('./mcp.js');
} else if (command === 'wait') {
  const { WAIT_HELP, wait } = await import('./lib/wait.js');
  if (rest.includes('--help') || rest.includes('-h')) console.log(WAIT_HELP);
  else process.exitCode = await wait(rest);
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
