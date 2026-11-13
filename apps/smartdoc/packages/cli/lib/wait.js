import http from 'node:http';
import { parseArgs } from 'node:util';
import { readToken } from './launch.js';
import { mcpUrl } from './platform.js';

// `smartdoc wait`: stays until something the AI asked of the user has happened, then says what and
// exits. An AI runs it in the background, and its ending wakes the AI. It asks the app, which holds
// the request open until then; it uses http, as fetch gives up on a reply after five minutes.

export const EXIT = { happened: 0, usage: 1, timedOut: 2, refused: 3, noApp: 4 };

export const WAIT_HELP = `Usage: npx @smartdoc/cli wait <what> <id> [--timeout <seconds>]

  decisions --review <id>   The user has sent their decisions on this review
  preview --review <id>     The user has accepted, discarded or commented on this review's draft preview
  open --request <id>       The user has answered this open_document request
  delete --request <id>     The user has answered this delete_document request

Prints what happened as JSON. Exits with 0 when it has happened, 1 if the command is wrong, 2 if
the timeout passed, 3 if the app says this can never happen, and 4 if the app isn't running or quits.
If the app restarts to install an update meanwhile, it says so and goes on waiting once it's back.`;

export async function wait(argv, { env = process.env, out = console.log, err = console.error, restartWaitMs = RESTART_WAIT_MS, retryMs = RETRY_MS } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { review: { type: 'string' }, request: { type: 'string' }, timeout: { type: 'string' } } }));
  } catch (error) {
    err(error.message);
    return EXIT.usage;
  }
  const [what] = positionals;
  const timeout = values.timeout === undefined ? null : Number(values.timeout);
  const byRequest = what === 'open' || what === 'delete';
  const id = byRequest ? values.request : values.review;
  if (positionals.length !== 1 || !['decisions', 'preview', 'open', 'delete'].includes(what) || !id || (timeout !== null && !(timeout > 0))) {
    err(WAIT_HELP);
    return EXIT.usage;
  }
  const token = readToken({ env });
  if (!token) {
    err("SmartDoc hasn't been run on this computer yet.");
    return EXIT.noApp;
  }

  // Asked again while the app restarts to install an update (it says so as it quits), until it's
  // back, so the AI's wait carries on by itself; told it has quit, or not back in time, it stops.
  const started = Date.now();
  let backBy = null;
  let reply;
  for (;;) {
    const left = timeout === null ? null : timeout - (Date.now() - started) / 1000;
    if (left !== null && left <= 0) {
      reply = { timedOut: true };
      break;
    }
    reply = await ask(`${mcpUrl(env)}/wait`, readToken({ env }) ?? token, { what, ...(byRequest ? { request: id } : { review: id }) }, left);
    const ended = reply.status === 503 ? parsed(reply.text) : null;
    if (ended?.restarting) {
      if (backBy === null) err('SmartDoc is restarting to install an update. Waiting for it to come back…');
      backBy ??= Date.now() + restartWaitMs;
    } else if (!(reply.lost && backBy !== null)) break;
    if (Date.now() > backBy) {
      err('SmartDoc hasn’t come back since restarting. Open it, then wait again.');
      return EXIT.noApp;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  if (reply.timedOut) {
    err(`Nothing yet after ${timeout} seconds.`);
    return EXIT.timedOut;
  }
  if (reply.lost) {
    err('SmartDoc isn’t running. Open it, then wait again.');
    return EXIT.noApp;
  }
  if (reply.status === 503 && parsed(reply.text)?.quit) {
    err(parsed(reply.text).error);
    return EXIT.noApp;
  }
  if (reply.status === 200) {
    out(reply.text);
    return EXIT.happened;
  }
  let reason = `SmartDoc refused the request (HTTP ${reply.status}).`;
  try {
    reason = JSON.parse(reply.text).error ?? reason;
  } catch {}
  err(reason);
  return reply.status === 401 || reply.status === 403 ? EXIT.noApp : EXIT.refused;
}

const RESTART_WAIT_MS = 2 * 60 * 1000; // how long a restarting app has to come back
const RETRY_MS = 1500;
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function ask(url, token, body, timeoutSeconds) {
  return new Promise((resolve) => {
    let timer = null;
    const done = (reply) => {
      clearTimeout(timer);
      resolve(reply);
    };
    const request = http.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8').trim() }));
      res.on('error', () => done({ lost: true }));
    });
    request.on('error', () => done({ lost: true }));
    if (timeoutSeconds !== null) {
      timer = setTimeout(() => {
        done({ timedOut: true });
        request.destroy();
      }, timeoutSeconds * 1000);
    }
    request.end(JSON.stringify(body));
  });
}
