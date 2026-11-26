# SmartDoc

Review your documents with your own AI. SmartDoc is a Mac app that shows your document (a PDF) beside a chat with your own Claude or ChatGPT: your AI suggests changes or picks out what matters, and you decide on each one. It then writes a draft preview of the next draft from your decisions, which becomes a draft once you accept it.

This package is the `smartdoc` command. You don't need it to use SmartDoc with Claude or ChatGPT: open the chat in the app and choose one, and SmartDoc installs it and opens its sign-in page for you. Use this package to install the app from a terminal, or to connect another AI app to SmartDoc by hand: Claude Desktop, Claude Code, or any app that runs MCP servers.

SmartDoc must be installed in your Applications folder: that's where `setup` and your AI apps expect it. If you download it from the website, drag it into Applications.

## Install the app

```sh
npx @smartdoc/cli install
```

Downloads the latest SmartDoc for your Mac from the project's [GitHub releases](https://github.com/tw050x/smartdoc/releases), checks it against the release's checksum, and puts it in Applications (asking before it replaces an older one), then offers to set up your agents. Or download it from the [website](https://smartdoc.tw050x.net/). Once installed, SmartDoc keeps itself up to date.

## Connect another AI app

```sh
npx @smartdoc/cli setup
```

Finds SmartDoc in your Applications folder and adds it to Claude Desktop and Claude Code, asking before each. (`--yes` doesn't ask.) Claude Desktop's settings file keeps everything else in it, and a copy of the file as it was is saved beside it. They run the connection built into the app, so they don't need Node.js once they're set up. You can do the same from the app: click its status at the top left, then **Connect another AI app yourself**.

## Wait for the user

```sh
npx @smartdoc/cli wait decisions --review <id>
```

Stays until the user has done what an AI is waiting for, then prints what happened and exits. AI apps that can run commands in the background use it to carry on as soon as the user is done; SmartDoc's tools give them the exact command. `wait --help` lists what it can wait for and its exit codes.

## Check the connection

```sh
npx @smartdoc/cli doctor
```

Checks that SmartDoc is installed and answering, and that Claude Desktop and Claude Code are connected to it where it is now, and says what to fix.

## Run the connection with npx

For AI apps you'd rather set up with `npx`, the command `npx -y @smartdoc/cli mcp` runs SmartDoc's MCP connection. It opens the installed app when your AI first uses it, wherever the app is, and if the app isn't installed it tells your AI to send you to the website. For example:

```sh
claude mcp add --scope user smartdoc -- npx -y @smartdoc/cli mcp
```

## Requirements

- macOS (Apple silicon or Intel); Windows is planned.
- Node.js 18 or later, which runs `npx`.

SmartDoc keeps your document and its drafts on your computer. Your AI reads the document through SmartDoc's tools, so what it reads goes wherever your AI sends it.
