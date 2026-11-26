import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../packages/app/src/main/mcp-tools.js';
import { createStore } from '../packages/app/src/main/store.js';

// The comment tools as an AI calls them, through the MCP server, against a real store.
const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-tools-'));
after(() => rmSync(temp, { recursive: true, force: true }));

async function connect(store) {
  const schemas = {
    listComments: (id, options) => store.listComments(id, options),
    replyToComment: (id, commentId, reply) => store.replyToComment(id, commentId, { ...reply, author: 'Test AI' }),
  };
  const server = buildServer((_name, _args, run) => run(schemas), { version: '0.0.0' });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const callTool = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  return { client, callTool };
}

test('get_comments leaves out comments needing no further action unless asked for all, and reply_to_comment sets an outcome and the flag', async () => {
  const store = createStore(path.join(temp, 'one'));
  const { schema } = await store.propose({ name: 'Auth', summary: 'Tokens.', note: 'First', items: [{ id: 'rules', kind: 'document', title: 'Rules', markdown: '# Rules' }] });
  await store.accept(schema);
  const read = await store.addComment(schema, { target: { item: 'rules' }, text: 'FYI.' });
  await store.addComment(schema, { target: { item: 'rules' }, text: 'Change this.' });
  const { callTool } = await connect(store);

  const open = await callTool('get_comments', { schematic_id: schema });
  assert.equal(open.length, 2);
  assert.deepEqual([open[0].outcome, open[0].noFurtherAction], [null, null]);

  const replied = await callTool('reply_to_comment', { schematic_id: schema, comment_id: read.id, outcome: 'Noted', no_further_action: true });
  assert.equal(replied.noFurtherAction, true);
  const left = await callTool('get_comments', { schematic_id: schema });
  assert.deepEqual(left.map((one) => one.text), ['Change this.']);
  const all = await callTool('get_comments', { schematic_id: schema, all: true });
  assert.equal(all.length, 2);
  assert.equal(all[0].outcome, 'Noted');
  assert.equal(all[0].noFurtherAction.by, 'ai');

  const neither = await callTool('reply_to_comment', { schematic_id: schema, comment_id: read.id });
  assert.match(neither.error, /text, an outcome, or both/);
});
