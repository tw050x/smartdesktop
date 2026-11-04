# SmartSpec

SmartSpec helps plan work. It is a sibling of SmartDoc (`~/Repository/smartdoc/master`), which
reviews and edits PDFs with the user's own AI. The product brief is in `README.md`.

## The brief

1. Generate a schema for the overall system of a business AND the local system being worked on
   or built from scratch, so another agent can turn up, know what needs to be built, and act on
   the plan.
2. Define contracts between systems and provide a test suite for those contracts outside of the
   codebase.

In both cases an AI uses tool calls to create what the plan needs. Another agent can retrieve
the plan and either delegate it or act on it.

## Current state

- `packages/app` is an Electron app copied from SmartDoc with its document features removed: a
  window with a placeholder home screen, settings (appearance, updates), the MCP panel, and the MCP
  server. Its only tool is `get_app_info`, until the planning tools exist.
- `packages/cli` is the `smartspec` command: `install`, `setup`, `doctor`, `mcp`.
- `.github/workflows` has Prerequisites (on every push) and Release (by hand, a dry run unless
  "publish" is ticked). Neither has run on GitHub yet.
- After changing the tools in `mcp-tools.js`, run `npm run server-snapshot`; a test checks the copy.
- SmartSpec's MCP ports are 47825 (installed) and 47826 (development), so it runs beside SmartDoc.
- The app icon is SmartDoc's, as a placeholder.
- The git repo is bare, at `../.git`, with this folder as the `master` worktree. `tw050x/smartspec`
  exists on GitHub and is empty.
- The npm scope is assumed to be `@smartspec`. The user said they have the scope, but its exact
  name and ownership haven't been confirmed. npm isn't logged in on this machine.

## Open decisions

These are recommendations made to the user. The user has NOT agreed to them yet, so confirm
them before building on them.

1. **Where a plan lives:** plain files in their own git repo, not an app database. Agents can
   fetch a plan without an app running, history and review come free, and contract tests get a
   home outside any one codebase.
2. **How contracts are tested:** a contract defines the request and response shapes between two
   systems, and a SmartSpec runner checks them against a running system's URL. This is
   independent of each system's language and code, but only covers systems reachable while
   running. Event queues and similar would need their own support later.

Next step once these are settled: design the plan format, since the tools and tests depend on it.

Decided: v1 is a desktop app, with an MCP server and a CLI.

## Conventions taken from SmartDoc

- JavaScript ES modules, with tests run by `node --test`.
- Layout is `<project>/master`, with packages under `packages/`, scoped like `@smartdoc/cli`.
- Commits have short imperative subjects, such as "Let the user and the AI rename things".
- SmartDoc's CLI and MCP connection in `packages/cli` are the reference for how agents get set up.
