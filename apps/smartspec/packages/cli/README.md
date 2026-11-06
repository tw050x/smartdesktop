# SmartSpec

Plan systems and define the contracts between them, with your own AI. SmartSpec is a desktop app that your AI connects to over MCP.

This package is the `smartspec` command.

SmartSpec must be installed in your Applications folder: that's where `setup` and your agents expect it. If you download it from the [releases](https://github.com/tw050x/smartspec/releases/latest), drag it into Applications.

## Install the app

```sh
npx @smartspec/cli install
```

Downloads the latest SmartSpec for your Mac from the project's [GitHub releases](https://github.com/tw050x/smartspec/releases), checks it against the release's checksum, and puts it in Applications (asking before it replaces an older one), then offers to set up your agents. Once installed, SmartSpec keeps itself up to date.

## Set up your agents

```sh
npx @smartspec/cli setup
```

Finds SmartSpec in your Applications folder and adds it to Claude Desktop and Claude Code, asking before each. (`--yes` doesn't ask.) Claude Desktop's settings file keeps everything else in it, and a copy of the file as it was is saved beside it. Agents run the connection built into the app, so they don't need Node.js once they're set up. You can do the same from the app: click its MCP server status, at the top right.

## Wait for the user

```sh
npx @smartspec/cli wait proposal --id <id>
```

Stays until the user has accepted or discarded a proposal, then prints what happened and exits. AI apps that can run commands in the background use it to carry on as soon as the user is done; SmartSpec's tools give them the exact command. `wait --help` lists its exit codes.

## Check the connection

```sh
npx @smartspec/cli doctor
```

Checks that SmartSpec is installed and answering, and that Claude Desktop and Claude Code are set up for it where it is now, and says what to fix.

## Run the connection with npx

For agents you'd rather set up with `npx`, the command `npx -y @smartspec/cli mcp` runs SmartSpec's MCP connection. It opens the installed app when your agent first uses it, wherever the app is, and if the app isn't installed it tells your agent where to send you. For example:

```sh
claude mcp add --scope user smartspec -- npx -y @smartspec/cli mcp
```

## Requirements

- macOS (Apple silicon or Intel); Windows is planned.
- Node.js 18 or later, which runs `npx`.
