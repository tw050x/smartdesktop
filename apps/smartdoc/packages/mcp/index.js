#!/usr/bin/env node
// SmartDoc's MCP server, as AI apps start it: Claude Code through npx, Claude Desktop from
// the .mcpb bundle. It opens the SmartDoc app (downloading it the first time, with a window
// showing how it's going) and passes the AI's messages to it. Only MCP messages go to stdout;
// progress and errors go to stderr.
import { readFileSync } from 'node:fs';
import { runBridge } from './lib/bridge.js';
import { createDownload } from './lib/download.js';
import { ensureRunning, readToken } from './lib/launch.js';
import { VERSION } from './lib/platform.js';

const log = (message) => process.stderr.write(`[smartdoc] ${message}\n`);
const offline = JSON.parse(readFileSync(new URL('./lib/server.json', import.meta.url), 'utf8'));
const download = createDownload();

await runBridge({
  ensure: () => ensureRunning({ log, download }),
  token: () => readToken(),
  log,
  offline,
  version: VERSION,
  downloading: () => download.describe(),
});
