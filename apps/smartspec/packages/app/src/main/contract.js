// A schematic's contract: its public side, the only part of it other schematics can see or link to.
// Plain data and no Node or Electron, as the store and the interface both use it.
//
// A contract is either Markdown (as every contract was at first, and still can be) or a tree (the
// user's choice: a list didn't show that /orders/:id sits under /orders, and a tree lets a branch be
// run again on its own). The contract itself is the tree's root; each node is a part of the
// interface (`/orders`, then `/orders/:id` under it; a module, then its functions, later):
//   node: { id, name, path?, markdown?, shapes?, setup?, clauses?, children? }
// (the root has no id, name or path). `markdown` explains that part. `shapes` are the data it talks
// about, as JSON Schema, seen by checks there and below (as a variable is in its scope: the user's
// choice, a shape beside what uses it rather than in a list of its own). `setup` is steps run before
// every check there and below, whose `keep` gives names to what they got back (an order made, so
// `/orders/{id}` can be read), as nested describe/beforeEach blocks are. `clauses` are its promises:
//   clause: { id, title, markdown?, defined_by?, checks? }
// each with the checks that test it. A clause can be defined by one of the schematic's own items, or
// a part of one (`defined_by`), when the feature is worked out there: outsiders still link to the
// clause, never to the item, so the item can change without anyone outside knowing.
// Nodes', clauses' and shapes' ids are the contract's parts and its public names, unique across the
// whole tree, so moving one to another branch breaks no link: set once, never derived from a title.

export const DEFINING_KINDS = ['document', 'flow', 'sequence', 'table'];
export const CHECK_KINDS = ['http'];
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const ID = /^[a-z0-9][\w-]*$/i;
const NAME = /^[a-z_][\w]*$/i;
const PLACEHOLDER = /\{([^{}\s]+)\}/g;

const withoutCode = (markdown) => markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
const isInternal = (href) => Boolean(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('//');
const markdownLinks = (markdown) => [...withoutCode(markdown ?? '').matchAll(/(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g)]
  .filter((match) => isInternal(match[2]))
  .map((match) => ({ to: match[2], label: match[1] }));

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Whether a contract is a tree rather than Markdown.
export const isStructured = (contract) => isObject(contract);

// The contract as a tree, whichever it was written as: Markdown is a root with only writing.
export function contractTree(contract) {
  if (isStructured(contract)) return contract;
  return contract ? { markdown: contract } : {};
}

// Every node, root first, depth first, each as { node, depth, above }: `above`, the nodes over it,
// the root first.
export function walk(contract) {
  const out = [];
  const visit = (node, above) => {
    out.push({ node, depth: above.length, above });
    for (const child of node.children ?? []) visit(child, [...above, node]);
  };
  visit(contractTree(contract), []);
  return out;
}

// Every clause, with the node it's on.
export const clausesOf = (contract) => walk(contract).flatMap(({ node }) => (node.clauses ?? []).map((clause) => ({ clause, node })));

// The contract's parts, its public names: every node's, clause's and shape's id, in the tree's order.
export function contractParts(contract) {
  return walk(contract).flatMap(({ node }) => [
    ...(node.id ? [node.id] : []),
    ...(node.shapes ?? []).map((shape) => shape.id),
    ...(node.clauses ?? []).map((clause) => clause.id),
  ]);
}

// A part of the contract by its id: { kind: 'node' | 'clause' | 'shape', part, node, above }.
export function findPart(contract, id) {
  for (const { node, above } of walk(contract)) {
    if (node.id === id) return { kind: 'node', part: node, node, above };
    const shape = (node.shapes ?? []).find((one) => one.id === id);
    if (shape) return { kind: 'shape', part: shape, node, above };
    const clause = (node.clauses ?? []).find((one) => one.id === id);
    if (clause) return { kind: 'clause', part: clause, node, above };
  }
  return null;
}

// What a part of the contract is called, to show someone.
export function contractPartName(contract, id) {
  const found = findPart(contract, id);
  if (!found) return id;
  if (found.kind === 'node') return found.part.name;
  return found.part.title ?? id;
}

// The contract as Markdown: for what reads it as writing (a collapsed card, words a comment quotes,
// comparing it word by word). Each node is its name in bold, each clause its title.
export function contractText(contract) {
  if (!isStructured(contract)) return contract ?? '';
  return walk(contract).flatMap(({ node }) => [
    node.name && `**${node.name}**`,
    node.markdown,
    ...(node.clauses ?? []).flatMap((clause) => [`**${clause.title}**`, clause.markdown]),
  ]).filter(Boolean).join('\n\n');
}

// The links out of the contract: [{ part, to, label }], `part` the node or clause they're in (null
// for the root's writing), a clause's definition being a link from it to the item that defines it.
export function contractLinks(contract) {
  const links = [];
  for (const { node } of walk(contract)) {
    for (const link of markdownLinks(node.markdown)) links.push({ part: node.id ?? null, ...link });
    for (const clause of node.clauses ?? []) {
      for (const link of markdownLinks(clause.markdown)) links.push({ part: clause.id, ...link });
      if (clause.defined_by) links.push({ part: clause.id, to: clause.defined_by, label: 'Defined here' });
    }
  }
  return links;
}

// The names a request uses, `{id}`, in its path, query, headers and body.
export function placeholders(request) {
  const found = new Set();
  const scan = (value) => {
    if (typeof value === 'string') for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (isObject(value)) Object.values(value).forEach(scan);
  };
  scan([request.path, request.query, request.headers, request.body, request.form]);
  return [...found];
}

// Whether a request's path sits under a node's: each of the node's segments matched in turn, a
// `:name` or `{name}` segment matching any one.
export function pathUnder(path, nodePath) {
  const segments = (text) => text.split('?')[0].split('/').filter(Boolean);
  const want = segments(nodePath);
  const have = segments(path);
  if (have.length < want.length) return false;
  return want.every((segment, index) => /^[:{]/.test(segment) || /^\{.*\}$/.test(have[index]) || segment === have[index]);
}

// Every check under a part of the contract (the whole of it with none given; a node and all below
// it; one clause), each with the setup to run before it, from the root down: what running that
// branch again runs. [{ clause, check, node, setup: [steps] }].
export function checksUnder(contract, id = null) {
  const target = id ? findPart(contract, id) : null;
  if (id && (!target || target.kind === 'shape')) return [];
  const out = [];
  for (const { node, above } of walk(contract)) {
    const inBranch = !target || (target.kind === 'node' && (node === target.node || above.includes(target.node))) || (target.kind === 'clause' && node === target.node);
    if (!inBranch) continue;
    const setup = [...above, node].flatMap((one) => one.setup ?? []);
    for (const clause of node.clauses ?? []) {
      if (target?.kind === 'clause' && clause !== target.part) continue;
      for (const check of clause.checks ?? []) out.push({ clause, check, node, setup });
    }
  }
  return out;
}

// What a runner is given to run all of a contract, or a branch or clause of it again (`id`): each
// check with the setup above it, keyed `clause/check` as results are, and the contract's shapes by
// id (unique across the tree, and already checked to be in scope). See @smartspec/runner.
export function contractJob(contract, id = null) {
  if (!isStructured(contract)) return { checks: [], shapes: {} };
  const shapes = Object.fromEntries(walk(contract).flatMap(({ node }) => (node.shapes ?? []).map((shape) => [shape.id, shape.schema])));
  const checks = checksUnder(contract, id).map(({ clause, check, setup }) => ({
    key: `${clause.id}/${check.id}`,
    clause: clause.id,
    ...(check.title ? { title: check.title } : {}),
    setup: setup.map(({ id: step, title, request, expect, keep }) => ({ id: step, ...(title ? { title } : {}), request, ...(expect ? { expect } : {}), ...(keep ? { keep } : {}) })),
    request: check.request,
    expect: check.expect,
  }));
  return { checks, shapes };
}

// What a schematic relies on from one it embeds (a use's `expects`, the user's model, 2026-11-25:
// each schematic tests itself, and one that depends on another writes down what it relies on, so a
// change to that one's contract shows what it breaks for those depending on it). A tree in the
// contract's own format, its checks run against the embedded schematic's code, kept apart from that
// schematic's own checks by their keys: `use:<owner>/<use>/clause/check`. A use's parameters (`with`)
// fill `{name}` in its requests.
export const useKey = (ownerId, useId) => `use:${ownerId}/${useId}/`;
export const isUseKey = (key) => key.startsWith('use:');

function fill(value, values) {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (whole, name) => (Object.hasOwn(values, name) ? values[name] : whole));
  if (Array.isArray(value)) return value.map((one) => fill(one, values));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one, values)]));
  return value;
}

// The job's checks for what a use relies on, keyed apart (see useKey), its parameters filled in.
// `shapes`, its own shapes; the embedded schematic's are given beside them.
export function expectationsJob(expects, { ownerId, useId, values = {} }) {
  const { checks, shapes } = contractJob(expects);
  const prefix = useKey(ownerId, useId);
  return {
    shapes,
    checks: checks.map((check) => ({
      ...check,
      key: `${prefix}${check.key}`,
      clause: `${prefix}${check.clause}`,
      setup: check.setup.map((step) => ({ ...step, request: fill(step.request, values) })),
      request: fill(check.request, values),
    })),
  };
}

// The shapes a tree's checks and setup name (expect.shape), for what a use relies on from another's
// contract: one it removes or changes breaks it.
export function shapesNamed(tree) {
  const named = new Set();
  for (const { node } of walk(tree)) {
    for (const step of node.setup ?? []) if (step.expect?.shape) named.add(step.expect.shape);
    for (const clause of node.clauses ?? []) for (const check of clause.checks ?? []) if (check.expect?.shape) named.add(check.expect.shape);
  }
  return [...named];
}

// The shapes a contract declares, by id.
export const shapeIds = (contract) => (isStructured(contract) ? walk(contract).flatMap(({ node }) => (node.shapes ?? []).map((shape) => shape.id)) : []);

function fail(message) {
  throw new Error(message);
}

function checkRequest(request, where, { nodePath, known }) {
  if (!isObject(request)) fail(`${where} needs a request: its method and path.`);
  if (!HTTP_METHODS.includes(String(request.method).toUpperCase())) fail(`${where} has an unknown method, "${request.method}". The methods are: ${HTTP_METHODS.join(', ')}.`);
  request.method = request.method.toUpperCase();
  if (typeof request.path !== 'string' || !request.path.startsWith('/')) fail(`${where} needs a path starting with /, such as /orders.`);
  if (nodePath && !pathUnder(request.path, nodePath)) fail(`${where} requests ${request.path}, which isn't under its node's path, ${nodePath}. Move it to the node its path is under.`);
  if (request.port !== undefined && !(Number.isInteger(request.port) && request.port > 0 && request.port < 65536)) fail(`${where}'s port should be a port number: another port on the implementation's host, such as another service of the run.`);
  if (request.form !== undefined && request.body !== undefined) fail(`${where} has a body and a form: send one, JSON as body or fields as form.`);
  for (const key of ['headers', 'query', 'form']) {
    if (request[key] !== undefined && (!isObject(request[key]) || Object.values(request[key]).some((value) => typeof value !== 'string'))) fail(`${where}'s ${key} should be names and their values, as text.`);
  }
  for (const name of placeholders(request)) {
    if (!known.has(name)) fail(`${where} uses {${name}}, which no setup above it keeps. ${known.size ? `Those kept there are: ${[...known].join(', ')}.` : 'Keep it with a setup step\'s keep, on this node or one above it.'}`);
  }
}

function checkExpect(expect, where, shapes) {
  if (!isObject(expect)) fail(`${where} needs expect: what the response should be.`);
  if (expect.status !== undefined && !(Number.isInteger(expect.status) && expect.status >= 100 && expect.status <= 599)) fail(`${where} expects status ${expect.status}, which isn't an HTTP status.`);
  if (expect.headers !== undefined && (!isObject(expect.headers) || Object.values(expect.headers).some((value) => typeof value !== 'string'))) fail(`${where}'s expected headers should be names and their values, as text.`);
  if (expect.status === undefined && expect.headers === undefined && expect.body === undefined && expect.shape === undefined) fail(`${where} expects nothing: give a status, headers, a body or a shape.`);
  if (expect.shape !== undefined && !shapes.has(expect.shape)) fail(`${where} expects shape ${expect.shape}, which isn't declared on its node or one above it. ${shapes.size ? `Those it can use are: ${[...shapes].join(', ')}.` : 'Declare it on this node, or one above it if other branches use it too.'}`);
}

// Throws saying what's wrong with a contract, naming the part. `items`, the schematic's items, for
// what defines a clause; `partsOf`, an item's parts. Tidies it as it goes (methods in capitals).
// For what a use relies on (`expects`): `shapes`, the embedded schematic's, which its checks can
// name too (its own can't share their ids); `known`, the use's parameters, filled into requests.
export function checkContract(contract, { items = [], partsOf = () => [], shapes: given = [], known: values = [] } = {}) {
  if (contract === undefined || contract === null || typeof contract === 'string') return;
  if (!isObject(contract)) fail('The contract is Markdown, or a tree of nodes.');
  const seen = new Set();
  const theirs = new Set(given);
  const name = (id, what) => {
    if (typeof id !== 'string' || !ID.test(id)) fail(`"${id}" can't be the id of ${what}: use letters, numbers, - and _.`);
    if (id === 'contract') fail(`"contract" can't be the id of ${what}.`);
    if (seen.has(id)) fail(`Two of the contract's nodes, clauses and shapes have the id ${id}. Give each its own: they're its public names.`);
    seen.add(id);
  };
  const byId = new Map(items.map((item) => [item.id, item]));
  const list = (node, key, where) => {
    if (node[key] !== undefined && !Array.isArray(node[key])) fail(`${where}'s ${key} should be a list.`);
    return node[key] ?? [];
  };

  const visit = (node, { root, parentPath, shapes: shapesAbove, known: knownAbove }) => {
    if (!isObject(node)) fail('The contract has a node that isn\'t one.');
    const where = root ? 'The contract' : `Node ${node.id}`;
    if (!root) {
      name(node.id, 'a node');
      if (typeof node.name !== 'string' || !node.name.trim()) fail(`${where} needs a name: the part of the interface it is, such as /orders.`);
    } else if (node.id !== undefined || node.name !== undefined || node.path !== undefined) fail('The contract is the tree\'s root, so it has no id, name or path: put them on a node in its children.');
    if (node.markdown !== undefined && typeof node.markdown !== 'string') fail(`${where}'s markdown should be text.`);
    let path = parentPath;
    if (node.path !== undefined) {
      if (typeof node.path !== 'string' || !node.path.startsWith('/')) fail(`${where}'s path should start with /, such as /orders/:id.`);
      if (parentPath && !pathUnder(node.path, parentPath)) fail(`${where}'s path, ${node.path}, isn't under its parent's, ${parentPath}.`);
      path = node.path;
    }

    const shapes = new Set(shapesAbove);
    for (const shape of list(node, 'shapes', where)) {
      if (!isObject(shape)) fail(`${where} has a shape that isn't one.`);
      name(shape.id, 'a shape');
      if (theirs.has(shape.id)) fail(`Shape ${shape.id} has the id of one of the embedded schematic's shapes: name that one in expect.shape instead, or give this its own id.`);
      if (!isObject(shape.schema)) fail(`Shape ${shape.id} needs a schema: JSON Schema, as an object.`);
      shapes.add(shape.id);
    }

    const known = new Set(knownAbove);
    const steps = new Set();
    for (const step of list(node, 'setup', where)) {
      if (!isObject(step)) fail(`${where} has a setup step that isn't one.`);
      if (typeof step.id !== 'string' || !ID.test(step.id)) fail(`"${step.id}" can't be the id of a setup step on ${root ? 'the contract' : node.id}: use letters, numbers, - and _.`);
      if (steps.has(step.id)) fail(`${where} has two setup steps with the id ${step.id}.`);
      steps.add(step.id);
      const at = `Setup ${root ? '' : `${node.id}/`}${step.id}`;
      if (!CHECK_KINDS.includes(step.kind)) fail(`${at} is of an unknown kind, "${step.kind}". The kinds are: ${CHECK_KINDS.join(', ')}.`);
      checkRequest(step.request, at, { nodePath: null, known });
      if (step.expect !== undefined) checkExpect(step.expect, at, shapes);
      if (step.keep !== undefined) {
        const keepable = (value) => typeof value === 'string' || (isObject(value) && typeof value.from === 'string' && Object.keys(value).every((key) => ['from', 'match', 'decode'].includes(key)));
        if (!isObject(step.keep) || !Object.values(step.keep).every(keepable)) fail(`${at}'s keep should be names and where each is in the response, such as { "id": "body.id" }, or { "from": "headers.location", "match": "state=([^&]+)", "decode": "url" } to keep part of it.`);
        for (const [kept, where] of Object.entries(step.keep)) {
          const from = typeof where === 'string' ? where : where.from;
          if (!NAME.test(kept)) fail(`${at} keeps "${kept}", which can't be a name: use letters, numbers and _.`);
          if (!/^(body|headers|status)(\.|$)/.test(from)) fail(`${at} keeps ${kept} from "${from}": say where in the response, starting body., headers. or status.`);
          if (typeof where !== 'string' && where.match !== undefined) {
            try { new RegExp(where.match); } catch { fail(`${at} keeps ${kept} matching "${where.match}", which isn't a regular expression.`); }
          }
          if (typeof where !== 'string' && where.decode !== undefined && !['url', 'html'].includes(where.decode)) fail(`${at} keeps ${kept} decoded as "${where.decode}": decode is url or html.`);
          known.add(kept);
        }
      }
    }

    for (const clause of list(node, 'clauses', where)) {
      if (!isObject(clause)) fail(`${where} has a clause that isn't one.`);
      name(clause.id, 'a clause');
      const at = `Clause ${clause.id}`;
      if (typeof clause.title !== 'string' || !clause.title.trim()) fail(`${at} needs a title: the promise, in a line.`);
      if (clause.markdown !== undefined && typeof clause.markdown !== 'string') fail(`${at}'s markdown should be text.`);
      if (clause.defined_by !== undefined) {
        const [target, part] = String(clause.defined_by).split('#');
        const item = byId.get(target);
        if (!item) fail(`${at} is defined by ${clause.defined_by}, but there's no item ${target} here. A clause is defined by one of this schematic's own items, or a part of one.`);
        if (!DEFINING_KINDS.includes(item.kind)) fail(`${at} is defined by ${target}, an ${item.kind}, which can't define a clause: the app can't read or compare it. Use a ${DEFINING_KINDS.join(', ')}.`);
        if (part !== undefined && !partsOf(item).includes(part)) fail(`${at} is defined by ${clause.defined_by}, but ${target} has no part ${part}. Its parts are: ${partsOf(item).join(', ') || 'none'}.`);
      }
      const checks = new Set();
      for (const check of list(clause, 'checks', at)) {
        if (!isObject(check)) fail(`${at} has a check that isn't one.`);
        if (typeof check.id !== 'string' || !ID.test(check.id)) fail(`"${check.id}" can't be the id of a check in ${clause.id}: use letters, numbers, - and _.`);
        if (checks.has(check.id)) fail(`${at} has two checks with the id ${check.id}.`);
        checks.add(check.id);
        const check_ = `Check ${clause.id}/${check.id}`;
        if (!CHECK_KINDS.includes(check.kind)) fail(`${check_} is of an unknown kind, "${check.kind}". The kinds are: ${CHECK_KINDS.join(', ')}.`);
        checkRequest(check.request, check_, { nodePath: path, known });
        checkExpect(check.expect, check_, shapes);
      }
    }

    for (const child of list(node, 'children', where)) visit(child, { root: false, parentPath: path, shapes, known });
  };
  visit(contract, { root: true, parentPath: null, shapes: theirs, known: new Set(values) });
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Each public part, by id, as compared between drafts: a node without what hangs on it (that's
// compared as parts of their own), a clause, a shape.
function partsById(contract) {
  const parts = new Map();
  for (const { node, above } of walk(contract)) {
    if (node.id) {
      const { children, clauses, shapes, ...own } = node;
      parts.set(node.id, { kind: 'node', value: own });
    }
    const parent = above.length ? node.id : null;
    for (const shape of node.shapes ?? []) parts.set(shape.id, { kind: 'shape', value: shape, parent });
    for (const clause of node.clauses ?? []) parts.set(clause.id, { kind: 'clause', value: clause, parent });
  }
  return parts;
}

// What a proposal changes in the contract: whether it changed at all; each node, clause and shape
// added, changed or removed (by id); and whether the root's writing did.
export function contractChanges(before, after) {
  const was = partsById(before);
  const is = partsById(after);
  const parts = {};
  for (const [id, one] of is) {
    if (!was.has(id)) parts[id] = 'added';
    else if (!same(was.get(id).value, one.value)) parts[id] = 'changed';
  }
  for (const id of was.keys()) if (!is.has(id)) parts[id] = 'removed';
  return { changed: !same(before ?? '', after ?? ''), parts, text: contractTree(before).markdown !== contractTree(after).markdown };
}

// What a new draft breaks for those that link to its public names: each part they link to that it
// removes, or whose promise changes: a clause's title or checks, a shape's schema, a node's path.
// Rewording what explains something, what defines a clause, or moving it in the tree, breaks
// nothing. `linked`, the parts linked to from outside.
export function brokenParts(before, after, linked) {
  const promise = (contract, id) => {
    const found = findPart(contract, id);
    if (!found) return null;
    if (found.kind === 'clause') return { title: found.part.title, checks: found.part.checks ?? [] };
    if (found.kind === 'shape') return { schema: found.part.schema };
    return { path: found.part.path ?? null };
  };
  const out = [];
  for (const part of new Set(linked)) {
    const was = promise(before, part);
    if (!was) continue;
    const is = promise(after, part);
    if (!is) out.push({ part, change: 'removed' });
    else if (!same(was, is)) out.push({ part, change: 'changed' });
  }
  return out;
}
