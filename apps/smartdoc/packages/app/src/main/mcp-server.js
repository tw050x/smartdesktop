import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
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
export async function startMcpServer(ai, userData) {
  const token = await mcpToken(userData);
  const http = createServer(async (req, res) => {
    const deny = (code, message) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
    if (req.headers.origin) return deny(403, 'Browser requests are not allowed.');
    // Says what this server is, so another copy of the app that finds the port taken can tell the user.
    if (req.url === '/whoami') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ app: 'SmartDoc', development: !app.isPackaged, version: app.getVersion() }));
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, 'Missing or wrong token.');
    if (!req.url?.startsWith('/mcp')) return deny(404, 'Not found.');
    if (req.method !== 'POST') return deny(405, 'Only POST is supported.');
    const caller = { session: req.headers['x-smartdoc-session'], client: req.headers['x-smartdoc-client'], startedApp: req.headers['x-smartdoc-started-app'] === '1' };
    // From the launcher, about the session itself.
    if (req.url.startsWith('/mcp/alive') || req.url.startsWith('/mcp/end')) {
      req.resume();
      if (req.url.startsWith('/mcp/end')) ai.ended(caller);
      else ai.alive(caller);
      return res.writeHead(204).end();
    }

    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return deny(400, 'Invalid JSON.');
    }
    // From `smartdoc wait`: answered once what it's waiting for has happened, however long that is.
    if (req.url.startsWith('/mcp/wait')) {
      try {
        const wait = ai.wait(body);
        res.on('close', wait.cancel);
        const result = await wait.promise;
        if (result) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        deny(error.status ?? 500, error.message);
      }
      return;
    }
    const server = buildServer((name, args, run) => ai.call(caller, name, args, run), { version: app.getVersion(), waitCommand: ai.waitCommand });
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

// What's listening on the port, when the server finds it taken: another SmartDoc (which says so at
// /whoami), else the name of the program holding it (from lsof), else nothing known.
export async function portHolder(port = MCP_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(1500) });
    const who = await res.json();
    if (who?.app === 'SmartDoc') return { kind: 'smartdoc', development: Boolean(who.development) };
  } catch {}
  const name = await new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fc'], { timeout: 2000 }, (error, stdout) => {
      resolve(error ? null : stdout.split('\n').find((line) => line.startsWith('c'))?.slice(1) || null);
    });
  });
  // Copies of SmartDoc from before /whoami still show as SmartDoc (or Electron, in development).
  if (name === 'SmartDoc' || name === 'Electron') return { kind: 'smartdoc', development: name === 'Electron' };
  return name ? { kind: 'other', name } : { kind: 'unknown' };
}
