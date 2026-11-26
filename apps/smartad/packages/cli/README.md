# SmartAd

Design adverts for the web with your own AI. SmartAd is a desktop app that your AI connects to over MCP.

This package is the `smartad` command.

SmartAd must be installed in your Applications folder: that's where `setup` and your agents expect it. If you download it from the [releases](https://github.com/tw050x/smartad/releases/latest), drag it into Applications.

## Install the app

```sh
npx @smartad/cli install
```

Downloads the latest SmartAd for your Mac from the project's [GitHub releases](https://github.com/tw050x/smartad/releases), checks it against the release's checksum, and puts it in Applications (asking before it replaces an older one), then offers to set up your agents. Once installed, SmartAd keeps itself up to date.

## Set up your agents

```sh
npx @smartad/cli setup
```

Finds SmartAd in your Applications folder and adds it to Claude Desktop and Claude Code, asking before each. (`--yes` doesn't ask.) Claude Desktop's settings file keeps everything else in it, and a copy of the file as it was is saved beside it. Agents run the connection built into the app, so they don't need Node.js once they're set up. You can do the same from the app: click its MCP server status, at the top right.

## Wait for the user

```sh
npx @smartad/cli wait proposal --id <id>
```

Stays until the user has accepted or discarded a proposal, then prints what happened and exits. AI apps that can run commands in the background use it to carry on as soon as the user is done; SmartAd's tools give them the exact command. `wait --help` lists its exit codes.

## Check the connection

```sh
npx @smartad/cli doctor
```

Checks that SmartAd is installed and answering, and that Claude Desktop and Claude Code are set up for it where it is now, and says what to fix.

## Run the connection with npx

For agents you'd rather set up with `npx`, the command `npx -y @smartad/cli mcp` runs SmartAd's MCP connection. It opens the installed app when your agent first uses it, wherever the app is, and if the app isn't installed it tells your agent where to send you. For example:

```sh
claude mcp add --scope user smartad -- npx -y @smartad/cli mcp
```

## Requirements

- macOS (Apple silicon or Intel); Windows is planned.
- Node.js 18 or later, which runs `npx`.
