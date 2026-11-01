import readline from 'node:readline';
import { mcpUrl } from './platform.js';

const NEWS_EVERY_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// and nothing is opened (or downloaded) until the AI uses a tool. `downloading()` says how a
// first-time download is going, or that the user is being asked whether to download (or null):
// tool calls are answered with that meanwhile, so the AI can tell the user.
export function runBridge({ input = process.stdin, output = process.stdout, env = process.env, ensure, token, log = () => {}, offline = null, version = '0.0.0', downloading = () => null }) {
  let ready = null;
  let running = false;
  const whenReady = () => (ready ??= ensure().then(() => {
    running = true;
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

  // For a tool call while the app isn't running: opens it, and waits until it's running (resolves
  // null) or there's news of a download to tell the AI (resolves to it).
  async function news() {
    const told = downloading();
    if (told) return told;
    const opening = whenReady();
    // Once the AI has the news, how it ends reaches the AI another way: the user sees a failure in
    // the window, and declining or cancelling is the next call's news.
    opening.catch(() => {});
    while (!running) {
      const status = downloading();
      if (status) return status;
      await Promise.race([opening, sleep(NEWS_EVERY_MS)]);
    }
    return null;
  }

  async function post(line) {
    const res = await fetch(mcpUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token() ?? ''}` },
      body: line,
    });
    return { status: res.status, text: (await res.text()).trim() };
  }

  async function forward(line, message) {
    if (offline && message.method === 'tools/call' && !running) {
      const status = await news();
      if (status) return answer(message.id, { isError: true, content: [{ type: 'text', text: status }] });
    }
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
    const reply = local(message);
    if (reply !== undefined) return answer(message.id, reply);
    const job = forward(line, message).catch((error) => {
      log(error.message);
      fail(message.id, error.message);
    });
    pending.add(job);
    job.finally(() => pending.delete(job));
  });

  return new Promise((resolve) => lines.on('close', () => Promise.allSettled([...pending]).then(resolve)));
}
