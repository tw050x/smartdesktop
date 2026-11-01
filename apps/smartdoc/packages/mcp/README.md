# SmartDoc

Review your documents with your own AI. SmartDoc is a desktop app that shows your document (a PDF); your AI reads it, marks up the text and writes findings, and you decide on each one in the app. The AI then writes the next draft from your decisions.

This package is SmartDoc's MCP server. AI apps start it, and it opens the SmartDoc app for them when they first use it. If the app isn't on your Mac yet, a window asks whether to download it from the [GitHub release](https://github.com/tw050x/smartdoc/releases), then shows how the download is going.

## Claude Code

```sh
claude mcp add --scope user smartdoc -- npx -y @smartdoc/mcp
```

Then start a new session and ask Claude to review your document.

## Claude Desktop

Download the bundle from the [website](https://tw050x.github.io/smartdoc/) and open it.

## Requirements

- macOS (Apple silicon or Intel). Windows is planned.
- For Claude Code and other agents that run this package with `npx`: Node.js 18 or later (`npx` comes with it). Claude Desktop doesn't need Node.js: it runs the bundle itself.

SmartDoc keeps your document and its drafts on your computer. Your agent reads the document through SmartDoc's tools, so what it reads goes wherever your agent sends it.
