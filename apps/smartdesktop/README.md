# SmartDesktop

The AI chat for [SmartDoc](https://github.com/tw050x/smartdoc) and
[SmartSpec](https://github.com/tw050x/smartspec), run with your own AI.

SmartDesktop is a Mac app that lives in the menu bar, with no Dock icon. Its one window is the
chat: several chats in tabs, side by side in columns if you like, each a conversation of its own.
SmartDoc and SmartSpec start it when you open the chat. It runs your own Claude (Claude Code) or
ChatGPT (Codex), signed in with your own account on its maker's site, and gives it both apps' tools,
so a chat can work on documents and schematics in either, in one conversation across them. Each
chat works in tabs of its own in the apps.

It's in beta, so it may change significantly from one version to the next.

## Using it

1. Download SmartDesktop from the [latest release](https://github.com/tw050x/smartdesktop/releases/latest)
   and drag it into Applications, beside SmartDoc or SmartSpec.
2. Open the chat from a SmartDoc or SmartSpec window: Window › Show the Chat (⇧⌘C), or Open Chat in
   a tab's right-click menu.
3. Set up Claude or ChatGPT: the setup window opens the first time, and again from the chat or the
   menu bar icon's **Set Up AI…**. It installs the AI's own command-line tool with its maker's
   installer and opens their sign-in page. SmartDesktop never sees your sign-in.

## How it works

- `packages/app/src/main/hub.js`: the local connection the apps use (127.0.0.1 only; the port and a
  token are in `connect.json` in SmartDesktop's data folder, readable by you alone). An app says
  hello with its MCP server, then tells SmartDesktop about its windows; SmartDesktop tells it back
  what the chat asks of it.
- `packages/app/src/main/agent.js`: the chats (`chats/<id>.json` in the data folder), each running
  its own AI (`claude -p` or `codex exec`) with every connected app's MCP server, acting on that
  chat's own tabs in the apps.
- `packages/app/src/main/chat-layout.js`: the chat window's columns and the chats' tabs in them.
- `packages/app/src/main/main.js`: the menu bar icon, the chat's window, and the setup and settings
  windows.
- `packages/app/src/renderer`: the chat, setup and settings windows.

## The website

`site/` is smartdesktop.tw050x.net, one page, published to GitHub Pages by the Website workflow
(`.github/workflows/pages.yml`) when it changes. It uses SmartDoc's and SmartSpec's `site.css` (keep
it the same as theirs). Its still of the chat window (`site/shots/chat-dark.webp`, `-light.webp`) is
made by hand from a test copy of the app with made-up chats (`SMARTDESKTOP_USER_DATA`,
`SMARTDESKTOP_PORT`), never from real ones.

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
