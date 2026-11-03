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

Prints what happened as JSON. Exits with 0 when it has happened, 1 if the command is wrong, 2 if
the timeout passed, 3 if the app says this can never happen, and 4 if the app isn't running or quits.`;

export async function wait(argv, { env = process.env, out = console.log, err = console.error } = {}) {
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
  const id = what === 'open' ? values.request : values.review;
  if (positionals.length !== 1 || !['decisions', 'preview', 'open'].includes(what) || !id || (timeout !== null && !(timeout > 0))) {
    err(WAIT_HELP);
    return EXIT.usage;
  }
  const token = readToken({ env });
  if (!token) {
    err("SmartDoc hasn't been run on this computer yet.");
    return EXIT.noApp;
  }

  const reply = await ask(`${mcpUrl(env)}/wait`, token, { what, ...(what === 'open' ? { request: id } : { review: id }) }, timeout);
  if (reply.timedOut) {
    err(`Nothing yet after ${timeout} seconds.`);
    return EXIT.timedOut;
  }
  if (reply.lost) {
    err('SmartDoc isn’t running. Open it, then wait again.');
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
