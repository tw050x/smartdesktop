import { pathText, validate } from './schema.js';

// One check of a contract, run over HTTP: the setup steps above it in turn (each kept value named
// for what follows), then its request, its response compared with what it expects.
//   { key, title?, setup: [{ id?, title?, request, expect?, keep? }], request, expect }
// request: { method, path, port?, query?, headers?, body? | form? }, `{name}` anywhere in it standing
// for a value a setup step kept; `port`, another port on the implementation's host (another service
// of the run); `form`, fields sent form-encoded, as a browser's form is. keep: names and where each is
// ('body.id', 'headers.location'), or { from, match?, decode? }: `match` a regular expression whose
// first group (else all it matched) is kept, `decode` 'url' or 'html' for what was escaped. Cookies a
// response sets are sent with the check's later requests (to any port of the host, as a browser does),
// so a check can sign in and go on signed in. expect: { status?, headers?, body?, shape? }: the body is matched as far as it
// goes (an object's other fields are left alone; an array's items are matched one for one), a shape
// by its JSON Schema (`shapes`, the contract's, by id).
// Gives { outcome: 'passed' | 'failed' | 'error', detail?, ms, status? }: failed when it answered
// otherwise than promised, error when it couldn't be checked (no answer, setup failing).

const PLACEHOLDER = /\{([^{}\s]+)\}/g;
const DEFAULT_TIMEOUT = 30_000;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

class Unchecked extends Error {}

// A value with each `{name}` put in: a string that is only `{name}` becomes the value itself (a
// number stays a number in a body); in a path, values are encoded.
export function fill(value, kept, { encode = false } = {}) {
  if (typeof value === 'string') {
    const only = value.match(/^\{([^{}\s]+)\}$/);
    if (only && !encode) return valueOf(only[1], kept);
    return value.replace(PLACEHOLDER, (_, name) => {
      const one = valueOf(name, kept);
      const text = typeof one === 'string' ? one : JSON.stringify(one);
      return encode ? encodeURIComponent(text) : text;
    });
  }
  if (Array.isArray(value)) return value.map((one) => fill(one, kept, { encode }));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one, kept, { encode })]));
  return value;
}

function valueOf(name, kept) {
  if (!(name in kept)) throw new Unchecked(`Nothing was kept as {${name}}: the setup step that keeps it didn't run.`);
  return kept[name];
}

// What's at `body.items.0.id`, `headers.location` or `status` in a response.
export function pick(response, where) {
  const [first, ...rest] = where.split('.');
  if (first === 'status') return response.status;
  if (first === 'headers') return response.headers[rest.join('.').toLowerCase()];
  let value = response.body;
  for (const step of rest) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[Array.isArray(value) ? Number(step) : step];
  }
  return value;
}

// Where an actual body first differs from what's expected, or null.
export function bodyDiffers(actual, expected, path = []) {
  const show = (value) => (value === undefined ? 'nothing' : JSON.stringify(value));
  const at = path.length ? `body.${pathText(path)}` : 'the body';
  if (isObject(expected)) {
    if (!isObject(actual)) return `${at} should be an object, not ${show(actual)}`;
    for (const [key, one] of Object.entries(expected)) {
      const found = bodyDiffers(actual[key], one, [...path, key]);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at} should be a list, not ${show(actual)}`;
    if (actual.length !== expected.length) return `${at} should have ${expected.length} ${expected.length === 1 ? 'item' : 'items'}, not ${actual.length}`;
    for (const [index, one] of expected.entries()) {
      const found = bodyDiffers(actual[index], one, [...path, index]);
      if (found) return found;
    }
    return null;
  }
  return actual === expected ? null : `${at} should be ${show(expected)}, not ${show(actual)}`;
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeHtml = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => (code[0] === '#'
  ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
  : HTML_ENTITIES[code.toLowerCase()] ?? all));

// What a setup step keeps from a response, by its keep's `where` (see above); undefined if it isn't there.
export function keepFrom(response, where) {
  if (typeof where === 'string') return pick(response, where);
  let value = pick(response, where.from);
  if (value === undefined) return undefined;
  if (where.match) {
    const found = new RegExp(where.match).exec(typeof value === 'string' ? value : JSON.stringify(value));
    if (!found) return undefined;
    value = found[1] ?? found[0];
  }
  if (where.decode === 'url') value = decodeURIComponent(String(value));
  if (where.decode === 'html') value = decodeHtml(String(value));
  return value;
}

// The cookies a response sets, kept in `jar` (a Map of name to value); one set to expire goes.
function takeCookies(headers, jar) {
  for (const line of headers.getSetCookie?.() ?? []) {
    const [pair, ...attributes] = line.split(';');
    const at = pair.indexOf('=');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim();
    const gone = attributes.some((one) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(one) || (/^\s*expires\s*=/i.test(one) && Date.parse(one.split('=').slice(1).join('=')) < Date.now()));
    if (gone) jar.delete(name);
    else jar.set(name, pair.slice(at + 1).trim());
  }
}

async function send(base, request, kept, { signal, timeout, cookies = new Map() }) {
  const root = new URL(`${base}/`);
  if (request.port) root.port = String(request.port);
  const url = new URL(fill(request.path, kept, { encode: true }), root);
  for (const [name, value] of Object.entries(fill(request.query ?? {}, kept))) url.searchParams.set(name, String(value));
  const headers = { ...fill(request.headers ?? {}, kept) };
  if (cookies.size && !Object.keys(headers).some((name) => name.toLowerCase() === 'cookie')) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  let body;
  if (request.form !== undefined) {
    body = new URLSearchParams(Object.entries(fill(request.form, kept)).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)])).toString();
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (request.body !== undefined) {
    const filled = fill(request.body, kept);
    if (typeof filled === 'string') body = filled;
    else {
      body = JSON.stringify(filled);
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }
  }
  const stop = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean));
  let response;
  try {
    response = await fetch(url, { method: request.method, headers, body, signal: stop, redirect: 'manual' });
  } catch (error) {
    if (signal?.aborted) throw error;
    const cause = error.cause?.code ?? error.name;
    throw new Unchecked(cause === 'TimeoutError' ? `${request.method} ${url.pathname} had no answer in ${timeout / 1000} s.` : `${request.method} ${url.pathname} couldn't be sent: ${cause === 'ECONNREFUSED' ? 'nothing is listening there' : error.cause?.message ?? error.message}.`);
  }
  takeCookies(response.headers, cookies);
  const text = await response.text();
  let parsed = text;
  if (/json/i.test(response.headers.get('content-type') ?? '') || /^\s*[[{]/.test(text)) {
    try { parsed = JSON.parse(text); } catch { /* left as text */ }
  }
  return { status: response.status, headers: Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value])), body: text === '' ? undefined : parsed, url };
}

// What doesn't match in a response, or null.
function mismatch(response, expect, kept, shapes) {
  if (!expect) return null;
  if (expect.status !== undefined && response.status !== expect.status) return `Expected status ${expect.status}, got ${response.status}${briefBody(response.body)}.`;
  for (const [name, value] of Object.entries(fill(expect.headers ?? {}, kept))) {
    const actual = response.headers[name.toLowerCase()];
    if (actual === undefined) return `Expected a ${name} header, and there was none.`;
    if (actual !== String(value)) return `Expected ${name}: ${value}, got ${actual}.`;
  }
  if (expect.body !== undefined) {
    const found = bodyDiffers(response.body, fill(expect.body, kept));
    if (found) return `${found[0].toUpperCase()}${found.slice(1)}.`;
  }
  if (expect.shape !== undefined) {
    const schema = shapes[expect.shape];
    if (!schema) return `The shape ${expect.shape} isn't in the contract.`;
    const found = validate(response.body, schema, { shapes });
    if (found) return `Doesn't fit ${expect.shape}: ${found.path.length ? `body.${pathText(found.path)}` : 'the body'} ${found.message}.`;
  }
  return null;
}

function briefBody(body) {
  if (body === undefined) return '';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return `: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`;
}

export async function runCheck(check, { base, shapes = {}, signal, timeout = DEFAULT_TIMEOUT } = {}) {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const kept = {};
  const cookies = new Map();
  try {
    for (const [index, step] of (check.setup ?? []).entries()) {
      const name = step.title ? `Setup “${step.title}”` : step.id ? `Setup ${step.id}` : `Setup step ${index + 1}`;
      let response;
      try {
        response = await send(base, step.request, kept, { signal, timeout, cookies });
      } catch (error) {
        if (error instanceof Unchecked) throw new Unchecked(`${name}: ${error.message}`);
        throw error;
      }
      const wrong = step.expect ? mismatch(response, step.expect, kept, shapes) : response.status >= 400 ? `Got status ${response.status}${briefBody(response.body)}.` : null;
      if (wrong) throw new Unchecked(`${name} didn't work, so this couldn't be checked. ${wrong}`);
      for (const [kept_, where] of Object.entries(step.keep ?? {})) {
        const value = keepFrom(response, where);
        if (value === undefined) throw new Unchecked(typeof where === 'string' || !where.match ? `${name} answered with nothing at ${typeof where === 'string' ? where : where.from}, to keep as {${kept_}}.` : `${name}'s ${where.from} has nothing matching ${where.match}, to keep as {${kept_}}.`);
        kept[kept_] = value;
      }
    }
    const response = await send(base, check.request, kept, { signal, timeout, cookies });
    const wrong = mismatch(response, check.expect, kept, shapes);
    return wrong ? { outcome: 'failed', detail: wrong, status: response.status, ms: ms() } : { outcome: 'passed', status: response.status, ms: ms() };
  } catch (error) {
    if (error instanceof Unchecked) return { outcome: 'error', detail: error.message, ms: ms() };
    throw error;
  }
}
