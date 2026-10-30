import readline from 'node:readline';
import { mcpUrl } from './platform.js';

// Carries MCP messages between an AI app, which talks to this launcher over stdio (one JSON-RPC
// message per line), and the app's MCP server over HTTP. Messages wait until the app is
// running. If the app goes away (say the user quits it), the next message opens it again.
//
// `ensure()` makes sure the app is running; `token()` reads its current token.
export function runBridge({ input = process.stdin, output = process.stdout, env = process.env, ensure, token, log = () => {} }) {
  let ready = null;
  const whenReady = () => (ready ??= ensure().catch((error) => {
    ready = null; // try again with the next message
    throw error;
  }));

  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const fail = (id, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code: -32000, message } });

  async function post(line) {
    const res = await fetch(mcpUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token() ?? ''}` },
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
    const job = forward(line, message).catch((error) => {
      log(error.message);
      fail(message.id, error.message);
    });
    pending.add(job);
    job.finally(() => pending.delete(job));
  });

  // Start the app straight away, rather than waiting for the first message.
  whenReady().catch((error) => log(error.message));

  return new Promise((resolve) => lines.on('close', () => Promise.allSettled([...pending]).then(resolve)));
}
