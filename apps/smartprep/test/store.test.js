import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore } from '../packages/app/src/main/store.js';

async function withStore(run) {
  const folder = await mkdtemp(path.join(tmpdir(), 'smartprep-store-'));
  try {
    await run(createStore(folder), folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const cover = { id: 'cover', title: 'What it covers', question: 'What will this interview cover?', description: 'The rounds and what each asks', content: '# Rounds\n\nA [system design](design) round, then coding.' };
const design = { id: 'design', title: 'System design', question: 'What is a system design round?', content: 'You design a service out loud. Start from the **requirements**, then the data model.' };

test('a topic starts with its goal and first cards, each new until read', async () => withStore(async (store, folder) => {
  const made = await store.create({ name: 'Platform engineer at Acme', goal: 'The platform role in the job advert', cards: [cover, design] });
  assert.deepEqual(made.cards, [{ id: 'cover', made: 'new' }, { id: 'design', made: 'new' }]);
  const topic = await store.get(made.topic);
  assert.equal(topic.goal, 'The platform role in the job advert');
  assert.deepEqual(topic.cards.map(({ id, question, links, headings, unread }) => ({ id, question, links, headings, unread })), [
    { id: 'cover', question: 'What will this interview cover?', links: ['design'], headings: ['rounds'], unread: 'new' },
    { id: 'design', question: 'What is a system design round?', links: [], headings: [], unread: 'new' },
  ]);
  const [listed] = await store.list();
  assert.equal(listed.cards, 2);
  assert.equal(listed.unread, 2);
  const kept = JSON.parse(await readFile(path.join(folder, 'topics', made.topic, 'cards.json'), 'utf8'));
  assert.equal(kept.cards[0].content, cover.content);
}));

test('every card answers a question, and a link that goes nowhere is refused with where it is', async () => withStore(async (store) => {
  const { topic } = await store.create({ name: 'Kubernetes' });
  await assert.rejects(store.writeCards(topic, [{ title: 'Pods', content: 'A pod.' }]), /cards\[0\]\.question is missing/);
  await assert.rejects(store.writeCards(topic, [{ id: 'Not An Id', title: 'Pods', question: 'What is a pod?', content: 'A pod.' }]), /cards\[0\]\.id "Not An Id" isn't a card id/);
  await assert.rejects(store.writeCards(topic, [
    { id: 'pods', title: 'Pods', question: 'What is a pod?', content: 'Runs on [nodes](nodes#kubelet).' },
    { id: 'nodes', title: 'Nodes', question: 'What is a node?', content: 'A machine.' },
  ]), /cards\[0\]\.content: \[nodes\]\(nodes#kubelet\): nodes has no heading kubelet/);
  assert.equal((await store.get(topic)).cards.length, 0);
}));

test('a card written again is updated, one with no id gets one from its title, and reading clears the mark', async () => withStore(async (store) => {
  const { topic } = await store.create({ name: 'Interview', cards: [cover, design] });
  await store.markRead(topic, 'design');
  const again = await store.writeCards(topic, [
    { ...design, content: `${design.content} Then scale it.` },
    { title: 'System design', question: 'How do I practise system design?', content: 'Out loud, on a whiteboard.' },
    cover,
  ]);
  assert.deepEqual(again.cards, [{ id: 'design', made: 'updated' }, { id: 'system-design', made: 'new' }, { id: 'cover', made: 'unchanged' }]);
  const cards = (await store.get(topic)).cards;
  assert.deepEqual(cards.map(({ id, unread }) => [id, unread]), [['cover', 'new'], ['design', 'updated'], ['system-design', 'new']]);
  // A card still new stays new when it changes.
  await store.writeCards(topic, [{ ...cover, content: `${cover.content}\n\nAnd a chat.` }]);
  assert.equal((await store.get(topic)).cards[0].unread, 'new');
  await store.markRead(topic, 'cover');
  assert.equal((await store.get(topic)).cards[0].unread, null);
}));

test('a question on words is answered with a new card, the words becoming a link to it', async () => withStore(async (store) => {
  const { topic } = await store.create({ name: 'Interview', cards: [cover, design] });
  const asked = await store.addQuestion(topic, { target: { item: 'design', part: null, quote: 'data model' }, text: 'What goes in a data model?' });
  assert.deepEqual(asked.target, { card: 'design', quote: 'data model', item: 'design', title: 'System design' });
  assert.equal((await store.get(topic)).questions.waiting, 1);
  const answered = await store.answerQuestion(topic, asked.id, {
    reply: 'Here is a card on it.',
    card: { title: 'Data models', question: 'What goes in a data model?', content: 'The entities, their fields, and how they relate. Back to [system design](design).' },
    author: 'Claude',
  });
  assert.deepEqual(answered, { topic, question: asked.id, card: 'data-models', linked: true, linkedIn: 'design', outcome: 'Answered', noFurtherAction: true });
  const [, source, made] = await store.getCards(topic);
  assert.equal(source.content, 'You design a service out loud. Start from the **requirements**, then the [data model](data-models).');
  assert.equal(made.answers, asked.id);
  assert.equal(made.unread, 'new');
  const [question] = await store.listQuestions(topic);
  assert.equal(question.answeredBy, 'data-models');
  assert.equal(question.replies[0].author, 'Claude');
  assert.equal(question.replies[0].card, 'data-models');
  assert.deepEqual((await store.get(topic)).questions, { waiting: 0, open: 0, total: 1 });
}));

test('words that can\'t be linked as written are left for the AI, saying so', async () => withStore(async (store) => {
  const { topic } = await store.create({ name: 'Interview', cards: [design] });
  const asked = await store.addQuestion(topic, { target: { item: 'design', quote: 'requirements are' }, text: 'Which ones?' });
  const answered = await store.answerQuestion(topic, asked.id, { card: { title: 'Requirements', question: 'Which requirements matter?', content: 'Load, latency, and what must never be lost.' } });
  assert.equal(answered.linked, false);
  assert.match(answered.note, /weren't found as written in design's answer/);
  // An answer is a new card, never one there already.
  const again = await store.addQuestion(topic, { target: { item: 'design' }, text: 'More?' });
  await assert.rejects(store.answerQuestion(topic, again.id, { card: { id: 'requirements', title: 'Again', question: 'Q?', content: 'A.' } }), /is a card already/);
}));

test('a question on passages picked apart keeps each, and links each to its answer', async () => withStore(async (store) => {
  const { topic } = await store.create({ name: 'Interview', cards: [design] });
  const asked = await store.addQuestion(topic, { target: { item: 'design', quote: 'ignored', quotes: ['You design a service out loud.', ' the  data model. '] }, text: 'How do these fit together?' });
  assert.deepEqual(asked.target.quotes, ['You design a service out loud.', 'the data model.']);
  assert.equal(asked.target.quote, 'You design a service out loud. … the data model.');
  const answered = await store.answerQuestion(topic, asked.id, { card: { title: 'Fitting together', question: 'How do these fit together?', content: 'The model follows from what the service must do.' } });
  assert.equal(answered.linked, true);
  const [source] = await store.getCards(topic);
  assert.equal(source.content, '[You design a service out loud.](fitting-together) Start from the **requirements**, then [the data model.](fitting-together)');
  // One passage alone is a quote, as before.
  const one = await store.addQuestion(topic, { target: { item: 'design', quotes: ['requirements'] }, text: 'Which?' });
  assert.deepEqual(one.target, { card: 'design', quote: 'requirements', item: 'design', title: 'System design' });
}));

test('questions on the topic, replies in words, and the user\'s own flag', async () => withStore(async (store) => {
  const { topic } = await store.create({ name: 'Interview', cards: [design] });
  const whole = await store.addQuestion(topic, { target: { topic: true, at: { x: 0.4, y: 2 } }, text: 'How long should I prepare?' });
  assert.deepEqual(whole.target, { topic: true, at: { x: 0.4, y: 1 } });
  await assert.rejects(store.addQuestion(topic, { target: { item: 'nowhere' }, text: 'Hm?' }), /no card nowhere/);
  await assert.rejects(store.replyToQuestion(topic, whole.id, {}), /something said, or an outcome/);
  assert.deepEqual(await store.replyToQuestion(topic, whole.id, { text: 'A week, an hour a day.', outcome: 'Answered' }), { question: whole.id, reply: (await store.listQuestions(topic))[0].replies[0].id, outcome: 'Answered', noFurtherAction: false });
  assert.equal((await store.get(topic)).questions.waiting, 0);
  assert.equal((await store.get(topic)).questions.open, 1);
  await store.setNoFurtherAction(topic, whole.id, true);
  assert.equal((await store.listQuestions(topic, { all: false })).length, 0);
  assert.equal((await store.listQuestions(topic)).length, 1);
}));

test('a card another links to isn\'t removed, and a deleted topic goes with everything in it', async () => withStore(async (store) => {
  const { topic } = await store.create({ name: 'Interview', cards: [cover, design] });
  await assert.rejects(store.removeCards(topic, ['design']), /other cards link to these[\s\S]*card cover\.content: \[system design\]\(design\)/);
  assert.deepEqual(await store.removeCards(topic, ['design', 'cover']), { topic, removed: ['design', 'cover'] });
  await store.rename(topic, { name: 'Acme, round two', goal: 'The second round' });
  assert.deepEqual((await store.list()).map(({ name, goal }) => [name, goal]), [['Acme, round two', 'The second round']]);
  await store.delete(topic);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.get(topic), /No topic/);
}));
