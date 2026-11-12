// Where SmartDoc and SmartSpec connect to SmartDesktop: a small HTTP server on 127.0.0.1 only. An app
// says hello with its MCP server (so the chat's AI can use its tools), then tells SmartDesktop about
// its windows (what each shows, which is in front, the lines of context for the chat) with
// messages, and hears back over a stream (server-sent events) what the chat asks of it.
//
// Only programs that can read SmartDesktop's data folder can connect: the port and a token are
// written to connect.json there, readable by the user alone, and every request but /whoami needs
// the token. Requests from web pages (with an Origin header) are refused.
//
//   GET  /whoami                   what this is (no token needed)
//   POST /hello    { app, name, version, mcp: { url, token } } → { client }
//   GET  /events?client=<id>       the stream of what the chat asks of the app; closing it
//                                  disconnects the app
//   POST /message  { client, type, … } → whatever onMessage returns
//
// No Electron here, so it can be tested on its own.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const APPS = new Set(['smartdoc', 'smartspec']);
const HEARTBEAT_MS = 15 * 1000;

export async function startHub({ userData, port, about, onHello = () => {}, onMessage = () => null, onGone = () => {} }) {
  const token = randomBytes(24).toString('hex');
  const clients = new Map(); // client id → { id, app, name, version, mcp, stream }

  const reply = (res, code, value) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value ?? null));
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };

  const server = createServer(async (req, res) => {
    if (req.headers.origin) return reply(res, 403, { error: 'Browser requests are not allowed.' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/whoami') return reply(res, 200, about);
    if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { error: 'Missing or wrong token.' });

    if (req.method === 'GET' && url.pathname === '/events') {
      const client = clients.get(url.searchParams.get('client'));
      if (!client) return reply(res, 404, { error: 'Say hello first.' });
      client.stream?.end();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      client.stream = res;
      const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
      req.on('close', () => {
        clearInterval(beat);
        if (client.stream !== res) return; // replaced by a newer stream
        clients.delete(client.id);
        onGone(client);
      });
      return;
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'Only POST is supported.' });
    let body;
    try {
      body = await readBody(req);
    } catch {
      return reply(res, 400, { error: 'Invalid JSON.' });
    }
    if (url.pathname === '/hello') {
      if (!APPS.has(body.app) || !body.mcp?.url || !body.mcp?.token) return reply(res, 400, { error: 'An app, and its MCP server, are needed.' });
      const client = { id: `c-${randomUUID().slice(0, 8)}`, app: body.app, name: body.name ?? body.app, version: body.version ?? null, mcp: { url: body.mcp.url, token: body.mcp.token }, stream: null };
      clients.set(client.id, client);
      onHello(client);
      return reply(res, 200, { client: client.id });
    }
    if (url.pathname === '/message') {
      const client = clients.get(body.client);
      if (!client) return reply(res, 404, { error: 'Not connected: say hello again.' });
      try {
        return reply(res, 200, await onMessage(client, body));
      } catch (error) {
        return reply(res, 500, { error: error.message });
      }
    }
    return reply(res, 404, { error: 'Not found.' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  // Where the apps find it, readable by the user alone.
  const file = path.join(userData, 'connect.json');
  await mkdir(userData, { recursive: true });
  await writeFile(file, JSON.stringify({ port: address.port, token, pid: process.pid }), { mode: 0o600 });

  return {
    port: address.port,
    clients,
    // Tells one app something (an event on its stream).
    send(clientId, event) {
      const client = clients.get(clientId);
      client?.stream?.write(`data: ${JSON.stringify(event)}\n\n`);
      return Boolean(client?.stream);
    },
    // Tells every app.
    broadcast(event) {
      for (const client of clients.values()) client.stream?.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      for (const client of clients.values()) client.stream?.end();
      server.close();
    },
  };
}
