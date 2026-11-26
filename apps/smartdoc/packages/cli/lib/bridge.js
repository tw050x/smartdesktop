import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { mcpUrl } from './platform.js';

// Carries MCP messages between an AI app, which talks to this launcher over stdio (one JSON-RPC
// message per line), and the app's MCP server over HTTP. The first message the app has to
// answer opens it, and waits until it's running. If the app goes away (say the user quits it),
// the next message opens it again.
//
// `ensure()` makes sure the app is running; `token()` reads its current token.
//
// With `offline` (server.json: what the app's server says about itself, see
// scripts/server-snapshot.mjs), the bridge answers the AI app's handshake itself, and its requests
// for the lists of tools and prompts until the app is running, so an AI app isn't kept waiting,
// and nothing is opened until the AI uses a tool.
export function runBridge({ input = process.stdin, output = process.stdout, env = process.env, ensure, token, log = () => {}, offline = null, version = '0.0.0', heartbeatMs = 20000 }) {
  let ready = null;
  let running = false;
  // This connection's session, which keeps its own window in the app; the AI app's name for itself,
  // to show there; and whether this launcher started the app, so the session has the window it opened.
  const session = randomUUID();
  let client = null;
  let startedApp = false;
  let heartbeat = null;
  const whenReady = () => (ready ??= ensure().then((started) => {
    running = true;
    if (started) startedApp = true;
    heartbeat ??= setInterval(() => notify('alive').catch(() => {}), heartbeatMs);
    heartbeat.unref?.();
  }, (error) => {
    ready = null; // try again with the next message
    throw error;
  }));

  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const fail = (id, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  const answer = (id, result) => write({ jsonrpc: '2.0', id, result });

  // The reply the bridge gives itself, if it does, to a message the app would otherwise answer.
  function local(message) {
    if (!offline) return undefined;
    const { method, params } = message;
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return {
        protocolVersion: offline.protocolVersions.includes(asked) ? asked : offline.protocolVersions[0],
        capabilities: offline.capabilities,
        serverInfo: { name: 'smartdoc', version },
        instructions: offline.instructions,
      };
    }
    if (running) return undefined;
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: offline.tools };
    if (method === 'prompts/list') return { prompts: offline.prompts };
    return undefined;
  }

  const sessionHeaders = () => ({
    'x-smartdoc-session': session,
    ...(client && { 'x-smartdoc-client': client }),
    ...(startedApp && { 'x-smartdoc-started-app': '1' }),
  });
  // Tells the app about the session itself, once it's running.
  async function notify(what) {
    const res = await fetch(`${mcpUrl(env)}/${what}`, { method: 'POST', headers: { authorization: `Bearer ${token()}`, ...sessionHeaders() } });
    await res.body?.cancel();
  }

  async function post(line) {
    const res = await fetch(mcpUrl(env), {
      method: 'POST',
      headers: { ...sessionHeaders(), 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token() ?? ''}` },
      body: line,
    });
    return { status: res.status, text: (await res.text()).trim() };
  }

  async function forward(line, message) {
    await whenReady();
    let reply;
    try {
      reply = await post(line);
    } catch {
      // Nothing listening: the app was closed since. Open it again and retry once.
      ready = null;
      running = false;
      await whenReady();
      reply = await post(line);
    }
    if (reply.status >= 400) {
      let reason = `The app refused the request (HTTP ${reply.status}).`;
      try {
        reason = JSON.parse(reply.text).error ?? reason;
      } catch {}
      return fail(message.id, reason);
    }
    if (reply.text) output.write(`${reply.text}\n`);
  }

  const pending = new Set();
  const lines = readline.createInterface({ input });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // Notifications (no id) mean nothing to the app's server until it's running: it keeps no state
    // between requests.
    if (offline && message.id === undefined && !running) return;
    if (message.method === 'initialize' && typeof message.params?.clientInfo?.name === 'string') {
      client = message.params.clientInfo.name.replace(/[^\w .-]/g, '').slice(0, 60) || null;
    }
    const reply = local(message);
    if (reply !== undefined) return answer(message.id, reply);
    const job = forward(line, message).catch((error) => {
      log(error.message);
      // A tool call gets the reason as its result, which the AI reads and can pass on (say, that
      // the app isn't installed).
      if (message.method === 'tools/call') answer(message.id, { isError: true, content: [{ type: 'text', text: error.message }] });
      else fail(message.id, error.message);
    });
    pending.add(job);
    job.finally(() => pending.delete(job));
  });

  // The AI app has gone: so has this session.
  return new Promise((resolve) => lines.on('close', () => Promise.allSettled([...pending]).then(async () => {
    clearInterval(heartbeat);
    if (running) await notify('end').catch(() => {});
    resolve();
  })));
}
