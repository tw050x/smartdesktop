# SmartPlan

A Mac app for planning work on boards of lists and cards, as Trello's are, with your own AI and
without the rest of Atlassian. It's one of a family with [SmartDoc](https://github.com/tw050x/smartdoc),
[SmartSpec](https://github.com/tw050x/smartspec), [SmartAd](https://github.com/tw050x/smartad),
[SmartPrep](https://github.com/tw050x/smartprep) and [SmartDesktop](https://github.com/tw050x/smartdesktop),
whose chat runs your AI across them all.

## The brief

- **A board is lists of cards.** Each board (a project, a launch, a move) is lists side by side,
  such as To do, Doing and Done, each a column of cards in order.
- **A card is a piece of work**: a title, and optionally a description (Markdown), labels in
  colours, a due date and a checklist.
- **AI first.** The AI makes boards and lists and writes and changes the cards through MCP tools,
  straight onto the board. What it adds or changes is marked New or Updated until the user opens
  the card. The user doesn't edit a card's words; they ask.
- **The user moves the work on.** Cards are dragged within and between lists; the AI hears of
  each move as a line of context, and leaves the user's moves alone.
- **The family's design.** Windows of tabs, with Home the pinned first tab and each other tab one
  board. For now Home is a single column of boards.

## Packages

- `packages/app`: the Electron app (`@smartplan/app`). MCP server on 47845 (installed) and 47846
  (development); data in `SmartPlan` / `SmartPlan Dev` (`SMARTPLAN_USER_DATA`, `SMARTPLAN_PORT`).
- `packages/cli`: the `smartplan` command, connecting an AI app by hand (`@smartplan/cli`).
- `site`: the website, smartplan.tw050x.net, one page published by the Website workflow
  (`.github/workflows/pages.yml`). Its stills (`site/shots`) are of a test copy of the app with
  made-up boards, light and dark; `share.png`, the picture a shared link shows, is made by
  `npm run share-image`.

## Running it

```sh
npm install
npm start     # builds the renderer and opens the app
npm test
```

After changing the tools in `mcp-tools.js`, run `npm run server-snapshot`.
