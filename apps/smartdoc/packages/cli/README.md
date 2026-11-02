# SmartDoc

Review your documents with your own AI. SmartDoc is a desktop app that shows your document (a PDF); your AI reads it, marks up the text and writes findings, and you decide on each one in the app. The AI then writes the next draft from your decisions.

This package is the `smartdoc` command.

## Install the app

```sh
npx @smartdoc/cli install
```

Downloads the latest SmartDoc for your Mac from the project's [GitHub releases](https://github.com/tw050x/smartdoc/releases), checks it against the release's checksum, and puts it in Applications (asking before it replaces an older one), then offers to set up your agents. Or download it from the [website](https://tw050x.github.io/smartdoc/). Once installed, SmartDoc keeps itself up to date.

## Set up your agents

```sh
npx @smartdoc/cli setup
```

Finds SmartDoc on your Mac and adds it to Claude Desktop and Claude Code, asking before each. (`--yes` doesn't ask.) Claude Desktop's settings file keeps everything else in it, and a copy of the file as it was is saved beside it. Agents run the connection built into the app, so they don't need Node.js once they're set up. You can do the same from the app: click its MCP server status, at the top right.

## Check the connection

```sh
npx @smartdoc/cli doctor
```

Checks that SmartDoc is installed and answering, and that Claude Desktop and Claude Code are set up for it where it is now, and says what to fix.

## Run the connection with npx

For agents you'd rather set up with `npx`, the command `npx -y @smartdoc/cli mcp` runs SmartDoc's MCP connection. It opens the installed app when your agent first uses it, wherever the app is, and if the app isn't installed it tells your agent to send you to the website. For example:

```sh
claude mcp add --scope user smartdoc -- npx -y @smartdoc/cli mcp
```

## Requirements

- macOS (Apple silicon or Intel); Windows is planned.
- Node.js 18 or later, which runs `npx`.

SmartDoc keeps your document and its drafts on your computer. Your agent reads the document through SmartDoc's tools, so what it reads goes wherever your agent sends it.
