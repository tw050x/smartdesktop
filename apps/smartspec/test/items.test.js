import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connectedPairs, connectionDetails, checkItem, checkLinks, itemChanges, linkGraph, linksOf, neighboursOf, pairKey, parseLink, partName, partsOf, tableSummary, previewsFor, slug } from '../packages/app/src/main/items.js';
import { layoutFlow, layoutSequence } from '../packages/app/src/renderer/layout.js';
import { chooseSides } from '../packages/app/src/renderer/list-lines.js';

const flow = { id: 'overview', kind: 'flow', title: 'Overview', nodes: [{ id: 'a', label: 'A', link: 'rules#backoff' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'calls' }] };
const doc = { id: 'rules', kind: 'document', title: 'Rules', markdown: '# Top\n\n## Back_off **now**\n\nSee [the flow](overview#a), [web](https://x.dev), ![pic](overview) and [here](#top).\n\n```\n[not](a-link)\n```\n' };
const sequence = { id: 'calls', kind: 'sequence', title: 'Calls', participants: [{ id: 'w', label: 'W' }, { id: 'x', label: 'X', link: 'rules' }], messages: [{ id: 'm1', from: 'w', to: 'x', label: 'hi' }, { id: 'm2', from: 'x', to: 'w', label: 'yo', reply: true, link: 'overview' }] };
const table = { id: 'fields', kind: 'table', title: 'Fields', columns: [{ id: 'name', label: 'Name' }], rows: [{ id: 'exp', cells: { name: 'see [rules](rules#top)' }, link: 'calls#m1' }] };

describe('parts', () => {
  test('each kind says what can be linked to', () => {
    assert.deepEqual(partsOf(flow), ['a', 'b', 'a-b']);
    assert.deepEqual(partsOf(doc), ['top', 'backoff-now']);
    assert.deepEqual(partsOf(sequence), ['w', 'x', 'm1', 'm2']);
    assert.deepEqual(partsOf(table), ['exp']);
    assert.deepEqual(partsOf({ kind: 'image' }), []);
  });

  test('a heading\'s id is the same from its source and its rendered text', () => {
    assert.equal(slug('Back_off now'), 'backoff-now');
    assert.equal(slug('  Retry: rules!  '), 'retry-rules');
  });
});

describe('links', () => {
  test('each kind says what it links to, leaving out web links, images and code', () => {
    assert.deepEqual(linksOf(doc).map((l) => l.to), ['overview#a', '#top']);
    assert.deepEqual(linksOf(flow), [{ part: 'a', to: 'rules#backoff', label: 'A' }]);
    assert.deepEqual(linksOf(sequence).map((l) => [l.part, l.to]), [['x', 'rules'], ['m2', 'overview']]);
    assert.deepEqual(linksOf(table).map((l) => [l.part, l.to]), [['exp', 'calls#m1'], ['exp', 'rules#top']]);
    assert.deepEqual(linksOf({ kind: 'image', links: [{ to: 'rules', label: 'x' }] }), [{ part: null, to: 'rules', label: 'x' }]);
  });

  test('a link to a part of its own item is resolved to that item', () => {
    assert.deepEqual(parseLink('#top', 'rules'), { target: 'rules', part: 'top' });
    assert.deepEqual(parseLink('rules#top'), { target: 'rules', part: 'top' });
    assert.deepEqual(parseLink('rules'), { target: 'rules', part: null });
  });

  test('the graph joins items of every kind', () => {
    const graph = linkGraph({ contract: 'See [flow](overview).', items: [doc, flow] });
    assert.deepEqual(graph.map(({ from, to }) => [from, to]), [['contract', 'overview'], ['rules', 'overview#a'], ['rules', 'rules#top'], ['overview#a', 'rules#backoff']]);
  });

  const record = (over) => ({ contract: '', items: [doc, flow], uses: [{ id: 'auth' }], ...over });

  test('accepts links that land, including the contract and an embedded schema', () => {
    const ok = { id: 'n', kind: 'document', title: 'N', markdown: '[a](contract) [b](auth) [c](auth#contract) [d](rules#top) [e](overview#a-b)' };
    assert.doesNotThrow(() => checkLinks(record({ items: [...record().items.filter((i) => i.id !== 'overview'), { ...flow, nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, ok] })));
  });

  test('refuses links that go nowhere, saying why', () => {
    const withDoc = (markdown) => record({ items: [{ id: 'n', kind: 'document', title: 'N', markdown }, { ...doc, markdown: '# Top' }, { ...flow, nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] });
    assert.throws(() => checkLinks(withDoc('[x](missing)')), /goes to missing/);
    assert.throws(() => checkLinks(withDoc('[x](rules#missing)')), /no part missing/);
    assert.throws(() => checkLinks(withDoc('[x](contract#part)')), /no parts/);
  });

  test('refuses links that reach inside an embedded schema', () => {
    assert.throws(() => checkLinks(record({ items: [{ id: 'n', kind: 'document', title: 'N', markdown: '[x](auth#inside)' }] })), /reaches inside an embedded schema/);
  });
});

describe('checking items', () => {
  test('accepts each kind', () => {
    for (const item of [flow, doc, sequence, table, { id: 'i', kind: 'image', title: 'I', mediaType: 'image/png', data: 'aGk=' }]) assert.doesNotThrow(() => checkItem(structuredClone(item)));
  });

  test('names what\'s wrong', () => {
    const fails = (item, pattern) => assert.throws(() => checkItem(item), pattern);
    fails({ id: 'x', kind: 'canvas', title: 'X' }, /unknown kind/);
    fails({ id: 'x', kind: 'document', title: ' ', markdown: '' }, /needs a title/);
    fails({ ...flow, edges: [{ from: 'a', to: 'nope' }] }, /no node nope/);
    fails({ ...flow, nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /Two of the nodes/);
    fails({ ...flow, edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }] }, /Two of the connections/);
    fails({ ...sequence, messages: [{ id: 'm', from: 'w', to: 'ghost', label: 'x' }] }, /ghost, who isn't a participant/);
    fails({ ...table, rows: [{ id: 'r', cells: { nope: '1' } }] }, /nope, which isn't a column/);
    fails({ id: 'i', kind: 'image', title: 'I', mediaType: 'text/html', data: 'aGk=' }, /unsupported image type/);
    fails({ id: 'i', kind: 'image', title: 'I', mediaType: 'image/png', data: 'not base64!' }, /base64/);
  });
});

describe('wrapping in sequence diagrams', () => {
  const messages = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, from: 'w', to: 'x', label: id }));
  const wrapped = (extra) => ({ id: 's', kind: 'sequence', title: 'S', participants: [{ id: 'w', label: 'W' }, { id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], messages, ...extra });

  test('its groups, activations and boxes can be linked to, and link', () => {
    const item = wrapped({ groups: [{ id: 'retry', kind: 'loop', from: 'a', to: 'b', link: 'rules' }], activations: [{ id: 'busy', participant: 'x', from: 'a', to: 'c' }], boxes: [{ id: 'core', participants: ['w', 'x'] }] });
    assert.doesNotThrow(() => checkItem(item));
    assert.deepEqual(partsOf(item).slice(-3), ['retry', 'busy', 'core']);
    assert.deepEqual(linksOf(item), [{ part: 'retry', to: 'rules', label: null }]);
  });

  test('refuses what can\'t be drawn, saying why', () => {
    const fails = (extra, pattern) => assert.throws(() => checkItem(wrapped(extra)), pattern);
    fails({ groups: [{ id: 'g', kind: 'nope', from: 'a', to: 'b' }] }, /unknown kind/);
    fails({ groups: [{ id: 'g', kind: 'loop', from: 'a', to: 'nope' }] }, /isn't a message/);
    fails({ groups: [{ id: 'g', kind: 'loop', from: 'c', to: 'a' }] }, /ending before it starts/);
    fails({ groups: [{ id: 'g', kind: 'alt', from: 'b', to: 'c', sections: [{ at: 'e' }] }] }, /isn't a later message inside it/);
    fails({ groups: [{ id: 'g', kind: 'alt', from: 'b', to: 'c', sections: [{ at: 'b' }] }] }, /isn't a later message inside it/);
    fails({ activations: [{ id: 'g', participant: 'ghost', from: 'a', to: 'b' }] }, /ghost, who isn't a participant/);
    fails({ boxes: [{ id: 'g', participants: ['w', 'y'] }] }, /aren't next to each other/);
    fails({ boxes: [{ id: 'g', participants: ['ghost'] }] }, /isn't a participant/);
    fails({ boxes: [{ id: 'g', participants: ['w'] }, { id: 'h', participants: ['w'] }] }, /in two boxes/);
    fails({ groups: [{ id: 'a', kind: 'loop', from: 'a', to: 'b' }] }, /Two of the parts/);
  });

  const measure = (label) => ({ width: String(label).length * 8, height: 18 });
  test('leaves room for groups, nesting them with the outer one around the inner', () => {
    const plain = layoutSequence(wrapped(), measure);
    const layout = layoutSequence(wrapped({ groups: [{ id: 'inner', kind: 'opt', from: 'b', to: 'c' }, { id: 'outer', kind: 'loop', from: 'a', to: 'd' }] }), measure);
    assert.ok(layout.height > plain.height);
    const [inner, outer] = layout.groups;
    assert.ok(outer.top < inner.top && outer.bottom > inner.bottom, 'taller');
    assert.ok(outer.left < inner.left && outer.right > inner.right, 'wider');
    assert.ok(layout.messages[0].y > outer.top && layout.messages[3].y < outer.bottom);
  });

  test('two groups starting at one message stack, and sections sit between their messages', () => {
    const layout = layoutSequence(wrapped({ groups: [{ id: 'one', kind: 'loop', from: 'a', to: 'c' }, { id: 'two', kind: 'alt', from: 'a', to: 'b', sections: [{ at: 'b', label: 'else' }] }] }), measure);
    const [one, two] = layout.groups;
    assert.ok(one.top < two.top);
    const line = two.sections[0].y;
    assert.ok(line > layout.messages[0].y && line < layout.messages[1].y);
  });

  test('activations that overlap on a lifeline sit side by side', () => {
    const { activations: [first, second, apart] } = layoutSequence(wrapped({ activations: [{ id: 'one', participant: 'x', from: 'a', to: 'c' }, { id: 'two', participant: 'x', from: 'b', to: 'b' }, { id: 'three', participant: 'x', from: 'd', to: 'e' }] }), measure);
    assert.ok(second.x > first.x);
    assert.equal(apart.x, first.x);
    assert.ok(first.top < first.bottom);
  });

  test('boxes around participants leave room for their label above them', () => {
    const layout = layoutSequence(wrapped({ boxes: [{ id: 'core', label: 'Core', participants: ['w', 'x'] }] }), measure);
    assert.ok(layout.head > layoutSequence(wrapped(), measure).head);
    assert.ok(layout.boxes[0].left < layout.participants[0].x && layout.boxes[0].right > layout.participants[1].x);
  });
});

describe('what surrounds the focused item', () => {
  const links = [
    { from: 'overview#a', to: 'rules#backoff' },
    { from: 'overview#b', to: 'fields' },
    { from: 'overview#a', to: 'fields#exp' },
    { from: 'calls', to: 'overview' },
    { from: 'calls#m1', to: 'overview#b' },
    { from: 'rules', to: 'overview#a' },
    { from: 'overview', to: 'overview#b' },
    { from: 'fields', to: 'rules' },
  ];

  test('what links here goes left, what it links to goes right, and both ways goes right', () => {
    const { left, right } = neighboursOf('overview', links, ['a', 'b']);
    assert.deepEqual(left.map((n) => n.id), ['calls']);
    assert.deepEqual(right.map((n) => n.id).sort(), ['fields', 'rules']);
  });

  test('one neighbour gets one card, with each part its links touch', () => {
    const { left, right } = neighboursOf('overview', links, ['a', 'b']);
    assert.equal(left[0].count, 2);
    assert.deepEqual(right.find((n) => n.id === 'fields').parts, ['a', 'b']);
  });

  test('a specific part replaces a line for the whole item', () => {
    const { left, right } = neighboursOf('overview', links, ['a', 'b']);
    assert.deepEqual(left[0].parts, ['b']);
    assert.deepEqual(neighboursOf('x', [{ from: 'x', to: 'one' }]).right[0].parts, [null]);
  });

  test('cards follow the order of the parts, so the same links always look the same', () => {
    const order = (parts) => neighboursOf('x', [{ from: 'x#p2', to: 'one' }, { from: 'x#p1', to: 'two' }, { from: 'x', to: 'three' }], parts).right.map((n) => n.id);
    assert.deepEqual(order(['p1', 'p2']), ['three', 'two', 'one']);
    assert.deepEqual(order(['p2', 'p1']), ['three', 'one', 'two']);
  });

  test('a link within the item is not a neighbour', () => {
    const { left, right } = neighboursOf('rules', [{ from: 'rules', to: 'rules#top' }]);
    assert.deepEqual([...left, ...right], []);
  });

  test('previews go only to neighbours that stand out, and only two', () => {
    const entry = (id, count) => ({ id, count });
    assert.deepEqual(previewsFor({ left: [entry('a', 1)], right: [entry('b', 1), entry('c', 1)] }), []);
    assert.deepEqual(previewsFor({ left: [entry('a', 2)], right: [entry('b', 1)] }), ['a']);
    assert.deepEqual(previewsFor({ left: [entry('a', 2), entry('b', 5)], right: [entry('c', 3), entry('d', 4)] }), ['b', 'd']);
  });
});

describe('what a proposal changes', () => {
  test('says what\'s added, changed and removed', () => {
    const changes = itemChanges({ contract: 'a', items: [doc, flow, table] }, { contract: 'b', items: [{ ...doc, title: 'New title' }, table, sequence] });
    assert.deepEqual(changes.items, { rules: 'changed', calls: 'added' });
    assert.deepEqual(changes.removed, [{ id: 'overview', title: 'Overview', kind: 'flow' }]);
    assert.equal(changes.contract, true);
    assert.equal(itemChanges(null, { contract: 'b', items: [doc] }).items.rules, 'added');
  });
});

describe('layout', () => {
  const measure = (label) => ({ width: label.length * 8, height: 18 });

  test('places every node and connection without overlapping, and stores no position', () => {
    const layout = layoutFlow(flow, measure);
    const [a, b] = layout.nodes;
    assert.ok(a.y + a.height / 2 <= b.y - b.height / 2, 'top to bottom by default');
    assert.ok(layout.edges[0].points.length >= 2);
    assert.ok(layout.height >= a.height + b.height);
    assert.equal(flow.nodes[0].x, undefined);
  });

  test('can run left to right when asked', () => {
    const [a, b] = layoutFlow({ ...flow, direction: 'LR' }, measure).nodes;
    assert.ok(a.x + a.width / 2 <= b.x - b.width / 2);
  });

  test('copes with loops, two connections between one pair, and a lone node', () => {
    const layout = layoutFlow({ nodes: flow.nodes, edges: [{ id: 'one', from: 'a', to: 'b' }, { id: 'two', from: 'a', to: 'b' }, { id: 'back', from: 'b', to: 'a' }, { id: 'self', from: 'a', to: 'a' }] }, measure);
    assert.equal(layout.edges.length, 4);
    for (const edge of layout.edges) assert.ok(edge.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), edge.id);
    assert.equal(layoutFlow({ nodes: [{ id: 'a', label: 'A' }] }, measure).nodes.length, 1);
  });

  test('a sequence runs in order, with room for its longest label', () => {
    const layout = layoutSequence({ ...sequence, messages: [...sequence.messages, { id: 'm3', from: 'w', to: 'x', label: 'x'.repeat(60) }] }, measure);
    assert.ok(layout.column >= 60 * 8);
    assert.ok(layout.messages[0].y < layout.messages[1].y);
    assert.equal(layout.messages[1].x1, layout.participants[1].x);
  });
});

describe('connectedPairs', () => {
  test('gives each pair once, whichever way and however many links', () => {
    const links = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a#one', to: 'b#two' }, { from: 'b', to: 'c' }];
    assert.deepEqual(connectedPairs(links).map(([x, y]) => [x, y].sort()), [['a', 'b'], ['b', 'c']]);
  });
  test('a link within an item connects nothing', () => {
    assert.deepEqual(connectedPairs([{ from: 'a#one', to: 'a#two' }]), []);
  });
});

describe('partName', () => {
  test('says what each kind of part is called', () => {
    assert.equal(partName(flow, 'a'), 'A');
    assert.equal(partName(flow, 'a-b'), 'calls');
    assert.equal(partName({ ...flow, edges: [{ from: 'a', to: 'b' }] }, 'a-b'), 'A → B');
    assert.equal(partName(doc, 'backoff-now'), 'Back_off now');
    assert.equal(partName(sequence, 'm2'), 'yo');
    assert.equal(partName(table, 'exp'), 'see rules');
  });
  test('falls back on the id', () => {
    assert.equal(partName(flow, 'nope'), 'nope');
    assert.equal(partName(sequence, 'nope'), 'nope');
  });
});

describe('tableSummary', () => {
  const big = { id: 't', kind: 'table', title: 'T', columns: [{ id: 'name', label: 'Name' }, { id: 'type', label: 'Type' }], rows: ['a', 'b', 'c', 'd'].map((id) => ({ id, cells: { name: `\`${id}\``, type: 'text' } })) };
  test('gives the rows the links are about, in the table\'s order, whichever way they go', () => {
    const made = tableSummary(big, 'f', [{ from: 'f#x', to: 't#b' }, { from: 't#a', to: 'f' }, { from: 'g', to: 't#c' }]);
    assert.deepEqual(made.rows, [{ id: 'a', name: 'a', detail: 'text' }, { id: 'b', name: 'b', detail: 'text' }]);
    assert.equal(made.linked, 2);
    assert.equal(made.rowCount, 4);
    assert.equal(made.columnCount, 2);
  });
  test('shows two, however many are linked, and says how many', () => {
    const made = tableSummary(big, 'f', ['a', 'b', 'c'].map((id) => ({ from: 'f', to: `t#${id}` })));
    assert.equal(made.rows.length, 2);
    assert.equal(made.linked, 3);
  });
  test('no rows when the links are about the table as a whole', () => {
    assert.deepEqual(tableSummary(big, 'f', [{ from: 'f', to: 't' }]).rows, []);
  });
});

describe('connectionDetails', () => {
  const titled = { items: [flow, doc], uses: [{ id: 'ledger', name: 'Ledger' }] };
  const details = (links) => connectionDetails({ ...titled, links });
  test('names both ends of each link, and sorts them by way', () => {
    const { count, ways } = details([{ from: 'overview#a', to: 'rules#top', label: 'A' }, { from: 'rules', to: 'overview', label: 'the flow' }])[pairKey('overview', 'rules')];
    assert.equal(count, 2);
    assert.deepEqual(ways.map(({ from, to }) => [from, to]), [['Overview', 'Rules'], ['Rules', 'Overview']]);
    assert.deepEqual(ways[0].links, [{ from: 'A', to: 'Top', label: null }]);
    assert.deepEqual(ways[1].links, [{ from: null, to: null, label: 'the flow' }]);
  });
  test('reaches the contract and embedded schemas', () => {
    const made = details([{ from: 'contract', to: 'ledger#contract', label: null }]);
    assert.deepEqual(made[pairKey('contract', 'ledger')].ways, [{ id: 'contract', from: 'Contract', to: 'Ledger', links: [{ from: null, to: 'Contract', label: null }] }]);
  });
  test('says the same link once, and nothing of links within an item', () => {
    const same = { from: 'rules', to: 'overview', label: 'x' };
    assert.equal(details([same, same])[pairKey('overview', 'rules')].count, 1);
    assert.deepEqual(details([{ from: 'rules#top', to: 'rules', label: null }]), {});
  });
});

describe('chooseSides', () => {
  test('lines that would cross go on opposite sides', () => {
    const [one, other] = chooseSides([[0, 2], [1, 3]]);
    assert.notEqual(one, other);
  });
  test('lines that would not cross still share themselves out', () => {
    const sides = chooseSides([[0, 1], [1, 2], [2, 3], [3, 4]]);
    assert.equal(sides.filter((side) => side === 'left').length, 2);
  });
  test('a line inside another does not count as crossing it', () => {
    assert.equal(chooseSides([[0, 3], [1, 2]]).length, 2);
  });
  test('answers in the order given, whatever the lengths', () => {
    assert.deepEqual(chooseSides([[0, 5], [0, 1]]), ['left', 'right']);
  });
  test('three lines that all cross put no more than necessary together', () => {
    const spans = [[0, 3], [1, 4], [2, 5]];
    const sides = chooseSides(spans);
    assert.ok(new Set(sides).size === 2);
  });
});
