import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../packages/app/src/main/mcp-tools.js';
import { describeStep } from '../packages/app/src/main/describe-step.js';

// A client on the app's MCP server, its tools run against `topics` (as main.js's topicsFor).
async function connect(topics) {
  const calls = [];
  const server = buildServer((name, args, run) => {
    calls.push(name);
    return run(topics);
  }, { version: '0.0.0' });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, calls };
}
const result = (reply) => JSON.parse(reply.content[0].text);

test('the server lists SmartPrep\'s tools, and says every card answers a question', async () => {
  const { client } = await connect({});
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['answer_question', 'create_topic', 'get_cards', 'get_questions', 'get_topic', 'list_topics', 'remove_cards', 'rename_topic', 'reply_to_question', 'set_icon', 'show_card', 'use_window', 'write_cards']);
  assert.match(client.getInstructions(), /Every card answers one question/);
  assert.match(client.getInstructions(), /ask what it's for/);
  await client.close();
});

test('a card without its question is refused before it reaches the app', async () => {
  const { client, calls } = await connect({ writeCards: () => ({ written: true }) });
  const refused = await client.callTool({ name: 'write_cards', arguments: { cards: [{ title: 'Pods', content: 'A pod.' }] } });
  assert.equal(refused.isError, true);
  assert.deepEqual(calls, []);
  const written = await client.callTool({ name: 'write_cards', arguments: { cards: [{ title: 'Pods', question: 'What is a pod?', content: 'A pod.' }] } });
  assert.deepEqual(result(written), { written: true });
  await client.close();
});

test('answering a question passes the new card and the AI\'s word on it', async () => {
  let seen = null;
  const { client } = await connect({ answerQuestion: (...args) => { seen = args; return { card: 'x' }; } });
  await client.callTool({ name: 'answer_question', arguments: { question_id: 'q1', reply: 'See the card.', card: { title: 'T', question: 'Q?', content: 'A.' }, no_further_action: false } });
  assert.deepEqual(seen, [undefined, 'q1', { reply: 'See the card.', card: { title: 'T', question: 'Q?', content: 'A.' }, outcome: undefined, noFurtherAction: false }]);
  const empty = await client.callTool({ name: 'reply_to_question', arguments: { question_id: 'q1' } });
  assert.equal(empty.isError, true);
  await client.close();
});

test('each step the chat shows is said in SmartPrep\'s words', () => {
  assert.equal(describeStep('mcp__smartprep__write_cards', { cards: [{ title: 'Pods' }] }), 'Writing the card “Pods”');
  assert.equal(describeStep('mcp__smartprep__write_cards', { cards: [{}, {}] }), 'Writing 2 cards');
  assert.equal(describeStep('answer_question', { card: { title: 'Data models' } }), 'Answering your question with “Data models”');
  assert.equal(describeStep('create_topic', { name: 'Acme' }), 'Starting the topic “Acme”');
});
