import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../packages/app/src/main/mcp-tools.js';
import { describeStep } from '../packages/app/src/main/describe-step.js';

// A client on the app's MCP server, its tools run against `projects` (as main.js's projectsFor).
async function connect(projects) {
  const calls = [];
  const server = buildServer((name, args, run) => {
    calls.push(name);
    return run(projects);
  }, { version: '0.0.0' });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, calls };
}
const result = (reply) => JSON.parse(reply.content[0].text);

test('the server lists SmartStudio\'s tools, and says what a take is', async () => {
  const { client } = await connect({});
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['add_note', 'create_project', 'generate', 'generate_status', 'get_project', 'get_selection', 'inspect_take', 'list_projects', 'remake_part', 'rename_project', 'set_icon', 'stop_take', 'use_window']);
  assert.match(client.getInstructions(), /each take is music .* or video/);
  // generate reaches the user's generation server.
  assert.equal(tools.find((tool) => tool.name === 'generate').annotations.openWorldHint, true);
  await client.close();
});

test('a take of an unknown kind is refused before it reaches the app', async () => {
  const { client, calls } = await connect({ generate: (...args) => ({ args }) });
  const refused = await client.callTool({ name: 'generate', arguments: { kind: 'speech', prompt: 'hello' } });
  assert.equal(refused.isError, true);
  assert.deepEqual(calls, []);
  const asked = await client.callTool({ name: 'generate', arguments: { kind: 'music', prompt: 'synth-pop', lyrics: '[Chorus]', seconds: 30 } });
  assert.deepEqual(result(asked), { args: [null, { kind: 'music', prompt: 'synth-pop', lyrics: '[Chorus]', seconds: 30 }] });
  await client.close();
});

test('each step the chat shows is said in SmartStudio\'s words', () => {
  assert.equal(describeStep('mcp__smartstudio__generate', { kind: 'music', prompt: 'warm neo-soul' }), 'Making a song: “warm neo-soul”');
  assert.equal(describeStep('generate', { kind: 'video' }), 'Making a clip');
  assert.equal(describeStep('create_project', { name: 'Launch' }), 'Starting the project “Launch”');
  assert.equal(describeStep('remake_part', { start: 42, end: 51.5 }), 'Making 0:42–0:51 again');
  assert.equal(describeStep('inspect_take', { start: 65 }), 'Listening to from 1:05');
});

test('a selection with a clip\'s frames comes back as pictures after it, each said where it\'s from', async () => {
  const frame = { at: 1.5, inside: true, mimeType: 'image/jpeg', data: 'AAAA' };
  const { client } = await connect({ selection: () => ({ selection: { take: { id: 't-1', kind: 'video' }, start: 1, end: 2 }, images: [{ ...frame, at: 0.8, inside: false }, frame] }) });
  const reply = await client.callTool({ name: 'get_selection', arguments: {} });
  assert.deepEqual(reply.content.map((item) => item.type), ['text', 'text', 'image', 'text', 'image']);
  assert.deepEqual(JSON.parse(reply.content[0].text).frames, [0.8, 1.5]);
  assert.match(reply.content[1].text, /0.8s \(just outside the selection\)/);
  assert.equal(reply.content[4].data, 'AAAA');
  await client.close();
});

test('a part to make again is passed on as asked, and only the user\'s project tools are read-only', async () => {
  const { client, calls } = await connect({ remakePart: (...args) => ({ args }) });
  const asked = await client.callTool({ name: 'remake_part', arguments: { take_id: 't-1', start: 12, end: 20 } });
  assert.deepEqual(result(asked), { args: [null, 't-1', { start: 12, end: 20 }] });
  assert.deepEqual(calls, ['remake_part']);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((tool) => tool.name === 'get_selection').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'remake_part').annotations.openWorldHint, true);
  await client.close();
});
