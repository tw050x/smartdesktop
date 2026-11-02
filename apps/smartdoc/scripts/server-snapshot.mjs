// Writes packages/cli/lib/server.json: what the app's MCP server says about itself (its
// instructions, capabilities, tools and prompts), which the launcher answers AI apps with before
// the app is running (until the AI first uses a tool, which opens it). Run with `npm run server-snapshot` after
// changing the tools (packages/app/src/main/mcp-tools.js); a test checks the copy is up to date.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../packages/app/src/main/mcp-tools.js';

export const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/cli/lib/server.json');

// The server's own answers, from a copy of it with nothing open (listing needs neither).
export async function snapshot() {
  const server = buildServer(null, null, { version: '0.0.0' });
  const client = new Client({ name: 'snapshot', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    return {
      protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
      prompts: (await client.listPrompts()).prompts,
    };
  } finally {
    await client.close();
  }
}

export const format = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SNAPSHOT, format(await snapshot()));
  console.log(`Wrote ${SNAPSHOT}`);
}
