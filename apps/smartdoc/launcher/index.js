#!/usr/bin/env node
// Shortlist Dock's MCP server, as AI apps start it: Claude Code through npx, Claude Desktop from
// the .mcpb bundle. It opens the Shortlist Dock app (downloading it the first time) and passes
// the AI's messages to it. Only MCP messages go to stdout; progress and errors go to stderr.
import { runBridge } from './lib/bridge.js';
import { ensureRunning, readToken } from './lib/launch.js';

const log = (message) => process.stderr.write(`[shortlist-dock] ${message}\n`);

await runBridge({
  ensure: () => ensureRunning({ log }),
  token: () => readToken(),
  log,
});
