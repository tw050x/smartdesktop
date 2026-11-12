# SmartDesktop

The AI chat for [SmartDoc](https://github.com/tw050x/smartdoc) and
[SmartSpec](https://github.com/tw050x/smartspec), run with your own AI.

SmartDesktop is a Mac app with no window of its own: it lives in the menu bar, and shows its chat in
a window floating over SmartDoc's and SmartSpec's windows while one of them is in front. SmartDoc
and SmartSpec start it when you open their chat. It runs your own Claude (Claude Code) or ChatGPT
(Codex), signed in with your own account on its maker's site, and gives it both apps' tools, so it
can work on whatever you have open in either, in one conversation across them.

It's in beta, so it may change significantly from one version to the next.

## Using it

1. Download SmartDesktop from the [latest release](https://github.com/tw050x/smartdesktop/releases/latest)
   and drag it into Applications, beside SmartDoc or SmartSpec.
2. Open the chat with the button at the top right of a SmartDoc or SmartSpec window.
3. Set up Claude or ChatGPT: the setup window opens the first time, and again from the chat or the
   menu bar icon's **Set Up AI…**. It installs the AI's own command-line tool with its maker's
   installer and opens their sign-in page. SmartDesktop never sees your sign-in.

## How it works

- `packages/app/src/main/hub.js`: the local connection the apps use (127.0.0.1 only; the port and a
  token are in `connect.json` in SmartDesktop's data folder, readable by you alone). An app says
  hello with its MCP server, then tells SmartDesktop about its windows; SmartDesktop tells it back
  what the chat asks of it.
- `packages/app/src/main/agent.js`: runs the AI (`claude -p` or `codex exec`) with every connected
  app's MCP server, each acting on the window of that app you were last in.
- `packages/app/src/main/main.js`: the menu bar icon, the chat's window, and the setup and settings
  windows.
- `packages/app/src/renderer`: the chat, setup and settings windows.

## Developing

```sh
npm install
npm start      # builds the interface and opens the development build
npm test
```

A development build keeps its data in `SmartDesktop Dev` (in Application Support) and listens on
port 47831, so it runs beside the installed one (port 47830). SmartDoc's and SmartSpec's development
builds connect to it; set `SMARTDESKTOP_DEV_DIR` to this repo's `packages/app` folder when starting
them and they start it themselves.

## Licence

MIT
