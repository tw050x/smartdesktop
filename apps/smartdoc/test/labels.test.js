import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NO_LABELS, addLabel, labelsOn, labelsToChoose, readLabels, removeItem, removeLabel, setLabelColor } from '../packages/app/src/main/labels.js';

let n = 0;
const add = (state, path, name) => addLabel(state, path, name, `l${++n}`);
const names = (list) => list.map((l) => l.name);
const DOC = ['d1'];
const VARIATION = ['d1', 'v1'];
const DRAFT = ['d1', 'v1', 'r1'];

describe('labels', () => {
  test('are inherited downwards, and marked so', () => {
    let s = add(NO_LABELS, DOC, 'Client');
    s = add(s, VARIATION, 'Applied');
    s = add(s, DRAFT, 'Final');
    assert.deepEqual(names(labelsOn(s, DOC)), ['Client']);
    assert.deepEqual(names(labelsOn(s, VARIATION)), ['Client', 'Applied']);
    assert.deepEqual(labelsOn(s, DRAFT).map((l) => [l.name, l.inherited]), [['Client', true], ['Applied', true], ['Final', false]]);
  });

  test('of a lower item can’t be chosen higher up', () => {
    const s = add(add(NO_LABELS, DRAFT, 'Final'), VARIATION, 'Applied');
    assert.deepEqual(labelsToChoose(s, VARIATION), []);
    assert.deepEqual(labelsToChoose(s, DOC), []);
  });

  test('can’t be chosen in another scope, only beside the item they’re on', () => {
    const s = add(add(add(NO_LABELS, DRAFT, 'Final'), VARIATION, 'Applied'), DOC, 'Client');
    assert.deepEqual(names(labelsToChoose(s, ['d1', 'v1', 'r2'])), ['Final']);
    assert.deepEqual(labelsToChoose(s, ['d1', 'v2', 'r9']), []);
    assert.deepEqual(names(labelsToChoose(s, ['d1', 'v2'])), ['Applied']);
    assert.deepEqual(labelsToChoose(s, ['d2', 'v1']), []);
    assert.deepEqual(names(labelsToChoose(s, ['d2'])), ['Client']);
  });

  test('typed with a name in the scope is that label, whatever the case', () => {
    const one = add(NO_LABELS, ['d1'], 'Client');
    const two = add(one, ['d2'], ' client ');
    assert.equal(two.labels.length, 1);
    assert.equal(labelsOn(two, ['d2'])[0].id, labelsOn(two, ['d1'])[0].id);
  });

  test('typed with the same name in another scope is a different label', () => {
    const s = add(add(NO_LABELS, ['d1'], 'Urgent'), ['d2', 'v1'], 'Urgent');
    assert.equal(s.labels.length, 2);
    const coloured = setLabelColor(s, labelsOn(s, ['d1'])[0].id, 'red');
    assert.equal(labelsOn(coloured, ['d2', 'v1'])[0].color, 'gray');
  });

  test('add nothing when the item shows that name already', () => {
    const s = add(NO_LABELS, DOC, 'Client');
    assert.equal(add(s, DRAFT, 'CLIENT'), s);
    assert.equal(add(s, DOC, 'client'), s);
  });

  test('need a name, and a real item', () => {
    assert.throws(() => add(NO_LABELS, DOC, '   '));
    assert.throws(() => add(NO_LABELS, [], 'x'));
    assert.throws(() => add(NO_LABELS, ['a', 'b', 'c', 'd'], 'x'));
  });

  test('change color everywhere they’re used', () => {
    let s = add(add(NO_LABELS, ['d1'], 'Client'), ['d2'], 'Client');
    s = setLabelColor(s, s.labels[0].id, 'blue');
    assert.equal(labelsOn(s, ['d1'])[0].color, 'blue');
    assert.equal(labelsOn(s, ['d2', 'v1'])[0].color, 'blue');
    assert.throws(() => setLabelColor(s, s.labels[0].id, 'mauve'));
  });

  test('come off the item they’re on, and go when nothing has them', () => {
    let s = add(add(NO_LABELS, ['d1'], 'Client'), ['d2'], 'Client');
    const { id } = s.labels[0];
    s = removeLabel(s, ['d1'], id);
    assert.deepEqual(labelsOn(s, ['d1']), []);
    assert.equal(s.labels.length, 1);
    s = removeLabel(s, ['d2'], id);
    assert.deepEqual(s, NO_LABELS);
  });

  test('can’t be taken off where they’re inherited', () => {
    const s = add(NO_LABELS, DOC, 'Client');
    assert.deepEqual(names(labelsOn(removeLabel(s, VARIATION, s.labels[0].id), VARIATION)), ['Client']);
  });

  test('go with their item and everything below it, leaving others', () => {
    let s = add(add(add(NO_LABELS, DOC, 'Client'), ['d2'], 'Client'), VARIATION, 'Applied');
    s = add(s, DRAFT, 'Final');
    s = removeItem(s, DOC);
    assert.deepEqual(names(s.labels), ['Client']);
    assert.deepEqual(Object.keys(s.assigned), ['d2']);
    assert.deepEqual(removeItem(s, ['d2']), NO_LABELS);
  });
});

describe('a saved labels file', () => {
  test('that’s missing or damaged leaves no labels', () => {
    assert.deepEqual(readLabels(null), NO_LABELS);
    assert.deepEqual(readLabels({ labels: 'x', assigned: 3 }), NO_LABELS);
  });
  test('drops a label on an item outside its scope, or with no one using it', () => {
    const saved = {
      labels: [{ id: 'a', name: 'A', color: 'blue', scope: '' }, { id: 'b', name: 'B', color: 'mauve', scope: 'd1' }, { id: 'c', name: 'C', color: 'red', scope: '' }],
      assigned: { 'd1/v1/r1': ['a'], 'd1/v1': ['b'], d1: ['a', 'missing'] },
    };
    const s = readLabels(saved);
    assert.deepEqual(s.assigned, { 'd1/v1': ['b'], d1: ['a'] });
    assert.deepEqual(s.labels.map((l) => [l.id, l.color]), [['a', 'blue'], ['b', 'gray']]);
  });
});
