import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brokenLinks, cardIdFrom, headingSlugs, linkQuote, linksOf, markdownLinks, parseLink, slug } from '../packages/app/src/main/cards.js';

test('a heading\'s slug, and a card\'s id made from its title', () => {
  assert.equal(slug('The Event Loop'), 'the-event-loop');
  assert.equal(slug('What’s a _closure_?'), 'what-s-a-closure');
  assert.equal(cardIdFrom('What is Kubernetes, really?'), 'what-is-kubernetes-really');
  assert.equal(cardIdFrom('Résumé tips'), 'resume-tips');
  assert.equal(cardIdFrom('???'), 'card');
  assert.ok(cardIdFrom('a '.repeat(80)).length <= 48);
});

test('headings and links are read from the answer, leaving out code and images', () => {
  const markdown = '# Pods\n\nSee [the scheduler](scheduler#queues) and [docs](https://k8s.io).\n\n```\n[not a link](nowhere)\n# not a heading\n```\n\n![a picture](picture)\n\n## How they *start*\n';
  assert.deepEqual(headingSlugs(markdown), ['pods', 'how-they-start']);
  assert.deepEqual(markdownLinks(markdown), [{ to: 'scheduler#queues', label: 'the scheduler' }]);
  assert.deepEqual(parseLink('#pods', 'pods-card'), { target: 'pods-card', part: 'pods' });
  assert.deepEqual(linksOf({ id: 'a', content: 'Up to [here](#top) and [b](b)' }), [{ to: 'a#top', label: 'here' }, { to: 'b', label: 'b' }]);
});

test('a link that goes nowhere is found, with where it is and why', () => {
  const cards = [
    { id: 'pods', content: '# Pods\n\nRun on [nodes](nodes), scheduled by [the scheduler](scheduler).' },
    { id: 'nodes', content: '## Kubelet\n\nBack to [pods](pods#pods), or [missing](pods#nowhere).' },
  ];
  assert.deepEqual(brokenLinks(cards), [
    { card: 'pods', link: '[the scheduler](scheduler)', why: 'there\'s no card scheduler' },
    { card: 'nodes', link: '[missing](pods#nowhere)', why: 'pods has no heading nowhere (its headings: pods)' },
  ]);
});

test('the words asked about become a link where they first appear unlinked', () => {
  const markdown = 'A pod runs on a node. The [node](nodes) has a kubelet, and every node reports back.';
  assert.equal(linkQuote(markdown, 'node', 'what-node'), 'A pod runs on a [node](what-node). The [node](nodes) has a kubelet, and every node reports back.');
  // Already linked, inside code, or part of a longer word: skipped.
  assert.equal(linkQuote('The [kubelet](k) and `kubelet` and kubelets, then the kubelet.', 'kubelet', 'x'), 'The [kubelet](k) and `kubelet` and kubelets, then the [kubelet](x).');
  // Spacing doesn't matter: a selection squashes line breaks.
  assert.equal(linkQuote('It keeps the\ndesired state.', 'the desired state', 'x'), 'It keeps [the\ndesired state](x).');
});

test('words picked across bold or italic are linked with it whole, never splitting it', () => {
  assert.equal(linkQuote('A **control** loop', 'control loop', 'x'), 'A [**control** loop](x)');
  const md = 'You state what you want (the **desired state**): three replicas. A controller *watches* it.';
  assert.equal(linkQuote(md, '(the desired state): three replicas.', 'x'), 'You state what you want [(the **desired state**): three replicas.](x) A controller *watches* it.');
  assert.equal(linkQuote(md, 'desired state', 'x'), 'You state what you want (the [**desired state**](x)): three replicas. A controller *watches* it.');
  assert.equal(linkQuote(md, 'A controller watches it.', 'x'), 'You state what you want (the **desired state**): three replicas. [A controller *watches* it.](x)');
  assert.equal(linkQuote('a **b** c **d** e', 'b c d', 'x'), 'a [**b** c **d**](x) e');
  assert.equal(linkQuote('x a**b**c y', 'abc', 'x'), 'x [a**b**c](x) y');
  assert.equal(linkQuote('snake_case is fine', 'snake_case', 'x'), '[snake_case](x) is fine');
  // Half of some emphasis would break it.
  assert.equal(linkQuote(md, 'the desired', 'x'), null);
  assert.equal(linkQuote(md, 'state): three', 'x'), null);
});

test('words that cross a link, or aren\'t there, aren\'t linked', () => {
  assert.equal(linkQuote('A [control](c) loop', 'control loop', 'x'), null);
  assert.equal(linkQuote('Nothing here', 'elsewhere', 'x'), null);
  assert.equal(linkQuote('One paragraph\n\nanother', 'paragraph another', 'x'), null);
  assert.equal(linkQuote('Text', '   ', 'x'), null);
});
