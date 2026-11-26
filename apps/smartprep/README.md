# SmartPrep

A Mac app for preparing for interviews, and for learning about anything unfamiliar, with your own
AI. It's one of a family with [SmartDoc](https://github.com/tw050x/smartdoc),
[SmartSpec](https://github.com/tw050x/smartspec), [SmartPrep](https://github.com/tw050x/smartprep) and
[SmartDesktop](https://github.com/tw050x/smartdesktop), whose chat runs your AI across them all.

## The brief

- **A topic is a board of cards.** Each topic (an interview, a technology, a subject) is a board,
  SmartSpec's Focus board on its own: cards placed where the user puts them, open at full size in
  the middle and smaller towards the sides, down to cards at the edges.
- **Cards are writing, and they link to each other.** Each card is Markdown, laid out as a page.
  A link in it, `[text](card)` or `[text](card#heading)`, goes to another card, bringing it to
  the middle, so a topic is a connected set of notes rather than one long document.
- **Ask about any line.** A long press on words picked in a card asks about them; on a card's
  title, about the card; on the board's empty space, about the topic. The AI answers with a new
  card explaining it, and the words asked about become a link to it, so the board grows into a
  map of what the user has asked.
- **AI first.** The AI writes and changes the cards through MCP tools, straight onto the board:
  they're study notes, so nothing waits to be accepted. What it adds or changes is marked New or
  Updated until the user has read it. The user doesn't edit the cards; they ask.
- **The family's design.** Windows of tabs, with Home the pinned first tab and each other tab one
  topic. For now Home is a single column of topics.

## Packages

- `packages/app`: the Electron app (`@smartprep/app`).
- `packages/cli`: the `smartprep` command, connecting an AI app by hand (`@smartprep/cli`).

## The website

`site/` is smartprep.tw050x.net, one page, published to GitHub Pages by the Website workflow
(`.github/workflows/pages.yml`) when it changes. It uses the family's `site.css` (keep it the same
as SmartDoc's, SmartSpec's and SmartDesktop's). Its hero's pills show four made-up kinds of user
(as SmartDoc's hero shows its tools), each with a still of the app's window (`site/shots/board-*.webp`
for the Larder backend interview, `product-*`, `talk-*` and `paper-*`, light and dark), made by hand
from a test copy of the app (`SMARTPREP_USER_DATA`, `SMARTPREP_PORT`), and its share picture
(`site/share.png`) by `npm run share-image`.

## Licence

MIT
