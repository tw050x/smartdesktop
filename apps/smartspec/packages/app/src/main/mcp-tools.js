import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches.

const INSTRUCTIONS = `This server is SmartSpec: a desktop app for planning systems and the contracts between them. Each AI session has a SmartSpec window of its own, opened by its first tool call. SmartSpec is at an early stage: its planning tools aren't built yet, so for now it can only say what it is, with get_app_info.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). Every tool works only with the app, on this computer.
const READ_ONLY = new Set(['get_app_info']);
const DESTRUCTIVE = new Set();
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false });

// `call(name, args, run)` runs a tool for the session making the request, in its window.
export function buildServer(call, { version }) {
  const server = new McpServer({ name: 'smartspec', version }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema, annotations: annotations(name) }, async (args) => {
    try {
      return json(await call(name, args ?? {}, () => run(args ?? {})));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  tool('get_app_info', 'The app\'s name and version.', {}, () => ({ name: 'SmartSpec', version }));

  return server;
}
