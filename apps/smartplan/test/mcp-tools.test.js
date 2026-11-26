import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../packages/app/src/main/mcp-tools.js';
import { describeStep } from '../packages/app/src/main/describe-step.js';

// A client on the app's MCP server, its tools run against `boards` (as main.js's boardsFor).
async function connect(boards) {
  const calls = [];
  const server = buildServer((name, args, run) => {
    calls.push(name);
    return run(boards);
  }, { version: '0.0.0' });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, calls };
}
const result = (reply) => JSON.parse(reply.content[0].text);

test('the server lists SmartPlan\'s tools, and says the user moves the cards', async () => {
  const { client } = await connect({});
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['add_cards', 'add_lists', 'create_board', 'get_board', 'list_boards', 'move_cards', 'remove_cards', 'remove_list', 'rename_board', 'set_icon', 'show_card', 'update_card', 'update_list', 'use_window']);
  assert.match(client.getInstructions(), /drags them between lists/);
  await client.close();
});

test('a card with a bad due date is refused before it reaches the app', async () => {
  const { client, calls } = await connect({ addCards: (...args) => ({ args }) });
  const refused = await client.callTool({ name: 'add_cards', arguments: { list_id: 'l-1', cards: [{ title: 'Pack', due: 'Friday' }] } });
  assert.equal(refused.isError, true);
  assert.deepEqual(calls, []);
  const added = await client.callTool({ name: 'add_cards', arguments: { list_id: 'l-1', cards: [{ title: 'Pack', due: '2026-12-01' }], position: 0 } });
  assert.deepEqual(result(added), { args: [null, 'l-1', [{ title: 'Pack', due: '2026-12-01' }], { position: 0 }] });
  await client.close();
});

test('updating a card passes only what changes', async () => {
  let seen = null;
  const { client } = await connect({ updateCard: (...args) => { seen = args; return { card: 'c-1' }; } });
  await client.callTool({ name: 'update_card', arguments: { card_id: 'c-1', title: 'New title' } });
  assert.deepEqual(seen, [undefined, 'c-1', { title: 'New title' }]);
  await client.close();
});

test('each step the chat shows is said in SmartPlan\'s words', () => {
  assert.equal(describeStep('mcp__smartplan__add_cards', { cards: [{ title: 'Pack' }] }), 'Adding the card “Pack”');
  assert.equal(describeStep('mcp__smartplan__add_cards', { cards: [{}, {}] }), 'Adding 2 cards');
  assert.equal(describeStep('create_board', { name: 'Launch' }), 'Starting the board “Launch”');
});
