import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildServer } from './mcp-tools.js';

// Fixed, so AI apps always know where to find it. A development copy uses another, so it can run
// beside the installed app, and tests another again (SMARTDOC_PORT; ignored in packaged builds).
export const MCP_PORT = app.isPackaged ? 47815 : Number(process.env.SMARTDOC_PORT) || 47816;

// The token clients send as "Authorization: Bearer <token>". Created once and kept with the app's
// data, so a configured client keeps working.
export async function mcpToken(userData) {
  const file = path.join(userData, 'mcp-token');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const token = randomBytes(24).toString('hex');
    await writeFile(file, token, { mode: 0o600 });
    return token;
  }
}

// Streamable HTTP on 127.0.0.1 only, stateless (a fresh server per request), JSON responses.
// Requests carrying an Origin header come from a web page and are refused, as are requests
// without the token. `documents` lists and opens documents for the AI (it needs the window).
export async function startMcpServer(workspace, userData, { documents } = {}) {
  const token = await mcpToken(userData);
  const http = createServer(async (req, res) => {
    const deny = (code, message) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
    if (req.headers.origin) return deny(403, 'Browser requests are not allowed.');
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, 'Missing or wrong token.');
    if (!req.url?.startsWith('/mcp')) return deny(404, 'Not found.');
    if (req.method !== 'POST') return deny(405, 'Only POST is supported.');

    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return deny(400, 'Invalid JSON.');
    }
    const server = buildServer(workspace, documents, { version: app.getVersion() });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(MCP_PORT, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${MCP_PORT}/mcp`, token, close: () => http.close() };
}
