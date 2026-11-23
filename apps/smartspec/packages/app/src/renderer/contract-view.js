import { contractText, contractTree, isStructured } from '../main/contract.js';
import { isInternalLink } from '../main/items.js';
import { plainText, renderMarkdown } from './markdown.js';

// A schematic's contract, drawn as the tree it is (see contract.js): its writing, then each part of
// its interface as a branch (its name, how the whole branch stands, what explains it, its shapes and
// setup folded, its clauses, and the parts under it, indented along a line), each clause a promise
// with what explains it, where it's worked out (`defined_by`) and its checks. Nodes, clauses and
// shapes are parts (`data-part`), so comments and links land on them. With no results yet (testing
// isn't run yet), a clause with checks is Not run, and one without is No checks yet.
//
// A branch can be folded (the user's choice): its card then keeps its head and lists what's directly
// under it as short entries, each clause its title and each part under it its name, with how each
// stands; clicking one unfolds the branch and goes to it. `folded`, the ids of the folded nodes;
// `onFold(id, folded)`, told as the user folds or unfolds one (the view changes itself).
//
// `titleOf(link)`, what a link in it goes to, for a clause's "Defined in"; `outside`, drawn in
// another schematic, where only the contract can be seen: links to this schematic's items show as
// plain text (the user's choice), and what defines a clause isn't named. `marks`, each node's,
// clause's or shape's change under review (added, changed, removed). `results`, each check's result
// by `clause/check`: { outcome: 'passed' | 'failed', detail }.

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// A branch's icon (Lucide's list-tree, ISC), so a branch reads as part of the tree, not a promise.
function treeIcon() {
  const icon = h('span', { className: 'node-icon', 'aria-hidden': 'true' });
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>';
  return icon;
}

// What's directly under a branch, in words: "2 promises · 1 branch".
function countOf(node) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const clauses = (node.clauses ?? []).length;
  const children = (node.children ?? []).length;
  return [clauses && plural(clauses, 'promise', 'promises'), children && plural(children, 'branch', 'branches')].filter(Boolean).join(' · ');
}

const MARK_WORDS = { added: 'New', changed: 'Changed', removed: 'Removed' };
const markTag = (mark) => mark && h('span', { className: `clause-mark ${mark}` }, MARK_WORDS[mark]);

// A request, in a line: its method and path, then its body.
function requestLine(request) {
  return [
    h('code', { className: 'check-request' }, `${request.method} ${request.path}${request.query ? `?${new URLSearchParams(request.query)}` : ''}`),
    request.body !== undefined && h('code', { className: 'check-body' }, JSON.stringify(request.body)),
  ];
}

function expectLine(expect) {
  return [
    expect.status !== undefined && String(expect.status),
    expect.shape && `fits ${expect.shape}`,
    expect.body !== undefined && JSON.stringify(expect.body),
    expect.headers && Object.entries(expect.headers).map(([name, value]) => `${name}: ${value}`).join(', '),
  ].filter(Boolean).join(' · ');
}

// How some checks stand, from their results: passing, failing, not run, or none to run.
function standing(keys, results) {
  if (!keys.length) return { status: 'untested', label: 'No checks yet' };
  const outcomes = keys.map((key) => results[key]?.outcome);
  const failed = outcomes.filter((one) => one === 'failed').length;
  if (failed) return { status: 'failing', label: `${failed} of ${keys.length} failing` };
  if (outcomes.every((one) => one === 'passed')) return { status: 'passing', label: 'Passing' };
  const passed = outcomes.filter((one) => one === 'passed').length;
  return { status: 'not-run', label: passed ? `${passed} of ${keys.length} passing` : 'Not run' };
}

const checkKeys = (clause) => (clause.checks ?? []).map((check) => `${clause.id}/${check.id}`);
const branchKeys = (node) => [...(node.clauses ?? []).flatMap(checkKeys), ...(node.children ?? []).flatMap(branchKeys)];

// Links to the schematic's own items, taken out (their words kept) for a contract seen from outside.
function unlinkItems(element) {
  for (const anchor of element.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!isInternalLink(href) || href === 'contract' || href.startsWith('contract#')) continue;
    anchor.replaceWith(...anchor.childNodes);
  }
}

function markdown(text, outside) {
  const element = h('div', {});
  renderMarkdown(element, text);
  if (outside) unlinkItems(element);
  return element;
}

export function renderContract(element, contract, { titleOf = (link) => link, outside = false, marks = {}, results = {}, folded = new Set(), onFold = () => {} } = {}) {
  element.classList.add('contract-view');
  if (!contract) return element.append(h('p', { className: 'muted' }, 'No contract yet.'));
  if (!isStructured(contract)) return element.append(markdown(contract, outside));

  const shapes = (node) => (node.shapes ?? []).length > 0 && h('details', { className: 'contract-shapes' },
    h('summary', {}, node.shapes.length === 1 ? 'Shape' : `Shapes (${node.shapes.length})`, ' ', ...node.shapes.map((shape) => h('code', {}, shape.id))),
    ...node.shapes.map((shape) => h('section', { className: `shape${marks[shape.id] ? ` ${marks[shape.id]}` : ''}`, 'data-part': shape.id },
      h('header', {}, h('code', {}, shape.id), shape.title && h('strong', {}, shape.title), markTag(marks[shape.id])),
      shape.description && h('p', {}, shape.description),
      h('pre', {}, JSON.stringify(shape.schema, null, 2)))));

  const setup = (node) => (node.setup ?? []).length > 0 && h('details', { className: 'contract-setup' },
    h('summary', {}, 'Setup ', h('span', { className: 'muted' }, node.setup.flatMap((step) => Object.keys(step.keep ?? {})).map((name) => `keeps {${name}}`).join(', ') || `${node.setup.length} ${node.setup.length === 1 ? 'step' : 'steps'}`)),
    h('ul', { className: 'clause-checks' }, ...node.setup.map((step) => h('li', { className: 'check setup-step' },
      step.title && h('span', { className: 'check-title' }, step.title),
      ...requestLine(step.request),
      step.expect && h('span', { className: 'check-arrow', 'aria-hidden': 'true' }, '→'),
      step.expect && h('code', { className: 'check-expect' }, expectLine(step.expect)),
      step.keep && h('span', { className: 'setup-keep' }, `keeps ${Object.entries(step.keep).map(([name, from]) => `{${name}} from ${from}`).join(', ')}`)))));

  const clause = (one) => {
    const { status, label } = standing(checkKeys(one), results);
    return h('section', { className: `clause ${status}${marks[one.id] ? ` ${marks[one.id]}` : ''}`, 'data-part': one.id },
      h('header', { className: 'clause-head' },
        h('span', { className: 'clause-dot', 'aria-hidden': 'true' }),
        h('strong', { className: 'clause-title' }, one.title),
        markTag(marks[one.id]),
        h('span', { className: 'clause-status' }, label)),
      one.markdown && markdown(one.markdown, outside),
      one.defined_by && !outside && h('p', { className: 'clause-defined' }, 'Defined in ', h('a', { href: one.defined_by }, titleOf(one.defined_by))),
      (one.checks ?? []).length > 0 && h('ul', { className: 'clause-checks' }, ...one.checks.map((check) => {
        const result = results[`${one.id}/${check.id}`];
        return h('li', { className: `check ${result?.outcome ?? 'not-run'}` },
          check.title && h('span', { className: 'check-title' }, check.title),
          ...requestLine(check.request),
          h('span', { className: 'check-arrow', 'aria-hidden': 'true' }, '→'),
          h('code', { className: 'check-expect' }, expectLine(check.expect)),
          result?.detail && h('p', { className: 'check-detail' }, result.detail));
      })));
  };

  // What hangs on a node, the root included: its writing, shapes, setup, clauses and the parts under it.
  const contents = (node) => [
    node.markdown && markdown(node.markdown, outside),
    shapes(node),
    setup(node),
    ...(node.clauses ?? []).map(clause),
    ...(node.children ?? []).map(branch),
  ];

  // What's directly under a folded branch, an entry each: its clauses, then the parts under it.
  const entries = (node, section) => {
    const under = [
      ...(node.clauses ?? []).map((one) => ({ id: one.id, kind: 'clause', name: one.title, ...standing(checkKeys(one), results) })),
      ...(node.children ?? []).map((one) => ({ id: one.id, kind: 'node', name: one.name, ...standing(branchKeys(one), results) })),
    ];
    if (!under.length) return h('p', { className: 'node-entries muted' }, 'Nothing under it yet.');
    return h('ul', { className: 'node-entries' }, ...under.map((entry) => h('li', { className: `node-entry entry-${entry.kind} ${entry.status}` },
      h('button', { type: 'button', title: 'Unfold this branch and go to it', onclick: () => {
        fold(section, node, false);
        section.querySelector(`[data-part="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } },
        entry.kind === 'node' ? treeIcon() : h('span', { className: 'clause-dot', 'aria-hidden': 'true' }),
        entry.kind === 'node' ? h('code', { className: 'entry-name' }, entry.name) : h('span', { className: 'entry-name' }, entry.name),
        markTag(marks[entry.id]),
        h('span', { className: 'clause-status' }, entry.label)))));
  };

  const fold = (section, node, shut) => {
    section.classList.toggle('folded', shut);
    const button = section.querySelector(':scope > .node-head > .node-fold');
    button.setAttribute('aria-expanded', String(!shut));
    button.title = shut ? `Unfold ${node.name}` : `Fold ${node.name}`;
    onFold(node.id, shut);
  };

  const branch = (node) => {
    const { status, label } = standing(branchKeys(node), results);
    const shut = folded.has(node.id);
    const section = h('section', { className: `contract-node ${status}${marks[node.id] ? ` ${marks[node.id]}` : ''}${shut ? ' folded' : ''}`, 'data-part': node.id });
    const toggle = h('button', { type: 'button', className: 'node-fold', 'aria-expanded': String(!shut), title: shut ? `Unfold ${node.name}` : `Fold ${node.name}`, onclick: () => fold(section, node, !section.classList.contains('folded')) });
    toggle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    section.append(
      h('header', { className: 'node-head' },
        toggle,
        treeIcon(),
        h('code', { className: 'node-name' }, node.name),
        node.path && node.path !== node.name && h('span', { className: 'node-path' }, node.path),
        h('span', { className: 'node-count' }, countOf(node)),
        markTag(marks[node.id]),
        h('span', { className: 'clause-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'clause-status' }, label)),
      h('div', { className: 'node-body' }, ...contents(node)));
    section.append(entries(node, section));
    return section;
  };

  element.append(...contents(contractTree(contract)).filter(Boolean));
  return element;
}

// The contract as plain text, for a collapsed card.
export const contractPlain = (contract) => plainText(contractText(contract));
