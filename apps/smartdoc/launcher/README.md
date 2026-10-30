# Shortlist Dock

Review your CV with your own AI. Shortlist Dock is a desktop app that shows your CV; your AI reads it, marks up the text and writes findings, and you decide on each one in the app. The AI then writes the next draft from your decisions.

This package is Shortlist Dock's MCP server. AI apps start it, and it opens the Shortlist Dock app for them (downloading it from the [GitHub release](https://github.com/tw050x/shortlist-dock/releases) the first time).

## Claude Code

```sh
claude mcp add --scope user shortlist-dock -- npx -y shortlist-dock
```

Then start a new session and ask Claude to review your CV.

## Claude Desktop

Download the bundle from the [website](https://tw050x.github.io/shortlist-dock/) and open it.

## Requirements

- macOS (Apple silicon or Intel). Windows is planned.
- Node.js 18 or later.

Your CV stays on your computer. The AI only sees what it reads through Shortlist Dock's tools.
