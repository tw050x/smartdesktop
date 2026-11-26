#!/usr/bin/env node
// SmartAd's MCP server, as AI apps start it: the copy inside the SmartAd app (run by the app's
// own executable as Node), or `npx @smartad/cli mcp` (see cli.js). It opens the installed SmartAd app when the
// AI first uses it, and passes the AI's messages to it. Only MCP messages go to stdout; progress
// and errors go to stderr.
import { readFileSync } from 'node:fs';
import { runBridge } from './lib/bridge.js';
import { ensureRunning, readToken } from './lib/launch.js';
import { VERSION } from './lib/platform.js';

const log = (message) => process.stderr.write(`[smartad] ${message}\n`);
const offline = JSON.parse(readFileSync(new URL('./lib/server.json', import.meta.url), 'utf8'));

await runBridge({
  ensure: () => ensureRunning({ log }),
  token: () => readToken(),
  log,
  offline,
  version: VERSION,
});
