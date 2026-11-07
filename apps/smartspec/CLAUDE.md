# SmartSpec

SmartSpec helps plan work. It is a sibling of SmartDoc (`~/Repository/smartdoc/master`), which
reviews and edits PDFs with the user's own AI. The product brief is in `README.md`.

## The brief

1. Generate a schematic for the overall system of a business AND the local system being worked on
   or built from scratch, so another agent can turn up, know what needs to be built, and act on
   the plan.
2. Define contracts between systems and provide a test suite for those contracts outside of the
   codebase.

In both cases an AI uses tool calls to create what the plan needs. Another agent can retrieve
the plan and either delegate it or act on it.

## Naming

The user calls the main thing a **schematic** (they prefer the full word), so everything a person or an
AI sees says schematic: the app, the MCP tools (`get_schematic`, `schematic_id`…) and the docs. Inside
the code and on disk it's still "schema" (`schemas.js`, `store.getSchema`, the `schemas/` folder), so
saved data didn't have to move; keep new user-facing words to "schematic".

## The model

These are decisions the user has made.

- **It's system design, not cloud design.** A schematic can describe a whole business, one service, or
  one module inside a single application. "Overall" and "local" systems are the same structure at
  different zoom levels.
- **A schematic is a contract plus optional internals.** Collapsed, you see its name, summary and
  contract. Opened, you see its design and the schematics it embeds. The contract is the boundary, and
  it's what contract tests test: schematic design and contract testing are one feature, in one view.
- **A schematic is a set of items, not one document.** Each kind of item has its own way of rendering:
  documents (Markdown), flow and sequence diagrams, tables and images, with more kinds to come. No
  fixed set of element types or strict terms inside them. Nothing is placed by hand, and there is no position data. A diagram is embedded as a canvas that
  can be dragged and zoomed, but that view is never stored with the schematic. Writing is embedded as an
  A4 page, laid out at one size and scaled to fill its card, so it never rewraps and resizing the card resizes it. A table or image sits on a surface of its own size, with no card around it either, and a table too wide for it scrolls sideways. The middle's resize grips sit at the middle of the part of its surface in view: a short table's middle, or the window's for a long document (`centreGrips` in `resizers.js`). Opening a card full screen
  gives the same canvas or page the whole window, and there a page has handles at its edges to make it bigger or smaller. A schematic's overview shows every item as a card on a canvas that moves and zooms like a diagram's, laid out in a grid shaped to the window (redrawn when it's resized), the most linked card in the middle and each card near what it links to, with one line for each pair of connected items, however many links they share, run through the gaps between cards and never across one (`layoutCards` in `layout.js`; the user found dagre's left-to-right layout too linear); pointing at a line shows a card of the links behind it (`overview-view.js`). It replaced a List view, which the user found not useful on its own. Under review, what the proposal removes shows striped in red with "Removed" over it, and still opens in Focus, as it was in the draft the proposal changes. Beside the side cards, the window scrolls the middle, title and
  all, with its scrollbar at the window's edge, and the side columns stay in view.
- **Items link to each other, so a schematic is a connected graph.** Any kind links to any other, by one
  format: `item` or `item#part`. Links reach the contract and embedded schematics but not inside them,
  and a change that leaves a link going nowhere is refused.
- **A schematic's page is one item in focus, with what it links to around it.** What links here is on
  the left, what it links to on the right, each sitting level with what it links to where it can, so
  its line runs straight. Lines stop at the focused card's edge, level with the node, row, heading or
  text link they're about (the user tried running them to the thing
  itself and rejected it, as they cross the content); a switch in the top bar, Focus | Overview, changes to the
  overview of everything in the schematic. Back and forward buttons retrace where the window has been, view and all: choosing a card on the overview, or switching view, is a step. With a card focused, the arrow keys move between cards: up and down in its column, left and right to the nearest card in the next (home's two columns and the side columns; on the overview, to the nearest card that way; `arrow-nav.js`). It isn't a canvas: nothing is placed by hand, and positions follow from the links. At most
  two neighbours get a small preview, and only those with two or more links to the focused item. The middle card's title runs alone along its top; what it is and its description are on a card while pointing at the title. Links show no card when pointed at: the user tried one saying where a link goes, and took it out. The overview's line card is the window-wide hover card (`hover-card.js`). A table's card is apart from that: it always gives its totals, under up to two rows the links are about. A side card is a compact version of the overview's card for the same item: both have the kind tag first (none on the contract), the title and description, and below a line a look inside; the overview's card always has the look, and ends with how it's linked.
- **The top bar is global, the bottom bar contextual.** The top bar holds what applies across the app,
  or nearly. The bottom bar is only about the view showing, and only there when there's something to
  say: on its left, plain sentences explaining what's going on (no bold labels, no "Title: …"), and on
  its right, what to do about it. Today that's a proposal waiting or being reviewed.
- **Comments are cards in the side columns, among the link cards.** The user picks something in the
  middle (clicks a diagram part or table row, selects words, or right-clicks anything, links too) and
  a Comment button starts a card level with it, on the side with fewer cards. What has comments is
  marked in the comment colour, and pointing at it lights up its comment cards. Comments don't show
  in hover cards: the user tried that, and took it out. A comment is on a draft or the proposal; on the proposal it stays as
  the AI revises it, moves into the draft on accept, and goes on discard. The AI reads them with
  `get_comments` and answers with `reply_to_comment`. Comments on a removed item stay as cards on
  the overview. Full screen shows none (`comments.js`, the store's `comments.json`).
- **Diagrams are data, drawn by SmartSpec, not Mermaid.** Nodes and connections are sent through tool
  calls, and dagre lays them out each time, top to bottom by default so side cards can line up (only `layout.js` knows about dagre). The user chose not
  to depend on Mermaid. AI-drawn icons in a library are an idea for later.
- **A schematic has two modes, Design and Test,** chosen in the top bar, which holds home, mode and focus side by side, with no separators.
- **A "focus" is the goal of the AI's work, as in SmartDoc,** not the item in the middle of the page.
  The focus button names the draft's focus and opens a card to write a new one and copy a prompt
  for the AI, or run an earlier one again. The prompt names the window, which the AI takes over with
  `use_window`. Items are reached by the cards around the middle and the overview.
  The draft controls sit in the centre of the top bar. Test mode is a placeholder until testing exists.
- **A card's content can be asked for.** An item's card shows its kind tag, title and description
  (the AI's), then below a line either the AI's card lines (an item's optional `card`, up to 4 short
  lines) or, without them, what the app works out. Right-clicking a side card or an overview card
  comments on the card itself (`target.card`), and the AI answers by changing its title, description
  or card lines. A card with comments has a yellow speech bubble (with a count if more than one) right-aligned on its kind tag's line, which opens them in a box
  beside it (`card-comments.js`).
- **Schematics are organised into groups.** A group is a team, a department or a set like "Auth"; the
  user chose the word "group" for now. Ungrouped always exists, first, for schematics in no group. Groups
  only organise the list, so the user makes, renames and deletes them on home and moves schematics by
  dragging or a right-click menu; the AI has `list_groups`, `create_group`, `rename_group` and
  `move_schematic` for when the user asks, and can propose a new schematic into a group.
- **Diagrams have no hover cards.** The user tried a tooltip explaining each element, and took it
  out with the link tips; an AI's descriptions of elements stay in the data, for agents. Sequence
  diagrams have what Mermaid has for wrapping content: loop, alt, opt, par, critical, break and group
  boxes, activations, and boxes around participants.
- **Agents read only what they need.** `get_schematic` lists items and links without content, and
  `get_schematic_item` fetches one. A proposal sends only what changes.
- **Embedding is by reference.** A standard, such as machine to machine auth, is one schematic shown as
  a single element elsewhere. Each use is pinned to a draft by a stable id, and customised only
  through the parameters it declares. A schematic can't contain itself. Clicking one, or a link to it,
  shows its overview in the middle, still in this schematic. Only Open schematic goes into it.
- **Schematics work like SmartDoc's drafts.** They live in the app's data folder, not a git repo. Each
  has a line of drafts; the AI proposes, and only the user's acceptance makes a draft, for every
  change including a schematic's first.
- **The AI does the changing, as in SmartDoc.** The user doesn't edit content: no edit or remove
  buttons, and no forms. They direct the AI with a copied prompt (the focus card, or File › New
  Schematic) and accept or discard what it proposes. A background request to a listening agent is an
  idea for later.
- **Tests are optional, and status is what they show.** A schematic with no implementation or tests is
  still valid. Viewers can see what exists, what's tested and what's passing or failing, and an
  individual uses failures to prioritise. The planned states are design only, implemented, passing,
  failing and out of date. Status rolls up through levels, and a result belongs to a use, not to a
  standard.
- **Tests stay out of the system's repo.** A schematic can link to its implementation. For a service,
  download and run it locally and test against it; for a module, pull the repo and test the code.
  No adapters in the codebase. How module tests call the code, in that language, is still open.
- **Status pills and labels are separate.** Status pills are defined by the app, say what needs
  attention, and sit on the title row if they all fit, else all of them beneath it, never split
  across the two; the normal state shows nothing. Today that's "Waiting for you" and "Newer draft available"; with testing, add "Failing"
  and "Out of date". Labels are defined by the user and sit at the bottom of a card. Labels aren't
  built yet.
- **Teams and CI are out of scope** for now, and may stay that way.

## Current state

- `packages/app` is the Electron app. An AI uses `list_schematics`, `get_schematic`, `get_schematic_item`,
  `get_proposal`, `propose_schematic`, `get_comments`, `reply_to_comment` and the group tools, the user accepts or discards, and opens schematics level by level.
  `items.js` defines the kinds of item and their links, `store.js` holds the schematics, `schemas.js` is
  their interface, `focus-view.js` draws the lines around the focused item and `item-views.js`
  renders each kind. Home has three columns: groups, schematics
  (sortable) and drafts (sortable); a variations column comes when variations do. A column with nothing in it shows fading placeholder rows, as SmartDoc's home does, with no text and no buttons.
- Not built yet: icons, labels, linking implementations, running tests and real status (everything
  is design only), deleting schematics or drafts, and the comment loop (sending comments to the AI in a
  prompt, and the user replying to the AI).
- `packages/cli` is the `smartspec` command: `install`, `setup`, `doctor`, `mcp`, `wait`.
- `.github/workflows` has Prerequisites (on every push) and Release (by hand, a dry run unless
  "publish" is ticked). Release hasn't run yet.
- After changing the tools in `mcp-tools.js`, run `npm run server-snapshot`; a test checks the copy.
- SmartSpec's MCP ports are 47825 (installed) and 47826 (development), so it runs beside SmartDoc.
- The app icon (`resources/icon.svg`, made into icon.png and icon.icns by `npm run icons`) is related to SmartDoc's: the same shape, cards and three colours, but three linked cards instead of a page, since a schematic isn't a document: two across the top, one below, each with a different mark (bar, square, circle).
- The git repo is bare, at `../.git`, with this folder as the `master` worktree.
- The npm scope is assumed to be `@smartspec`. The user said they have the scope, but its exact
  name and ownership haven't been confirmed. npm isn't logged in on this machine.

## Conventions taken from SmartDoc

- JavaScript ES modules, with tests run by `node --test`.
- Layout is `<project>/master`, with packages under `packages/`, scoped like `@smartdoc/cli`.
- Commits have short imperative subjects, such as "Let the user and the AI rename things".
- SmartDoc's CLI and MCP connection in `packages/cli` are the reference for how agents get set up.
