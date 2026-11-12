import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDERS, contextFor, withSuggestions } from '../packages/app/src/main/agent.js';
import { describeStep } from '../packages/app/src/main/steps.js';

const servers = [
  { name: 'smartdoc', url: 'http://127.0.0.1:47815/mcp', headers: { Authorization: 'Bearer a', 'x-smartdoc-window': 'w-1' } },
  { name: 'smartspec', url: 'http://127.0.0.1:47825/mcp', headers: { Authorization: 'Bearer b' } },
];

test('Claude gets every connected app, and only their tools', () => {
  const args = PROVIDERS.claude.args({ prompt: 'Hi', systemPrompt: 'Rules', where: 'Where', servers, resume: null, model: null });
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['smartdoc', 'smartspec']);
  assert.equal(config.mcpServers.smartdoc.headers['x-smartdoc-window'], 'w-1');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__smartdoc,mcp__smartspec');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'Rules\n\nWhere');
});

test('Codex gets every connected app; a resumed session is told only where things are now', () => {
  const fresh = PROVIDERS.codex.args({ prompt: 'Hi', systemPrompt: 'Rules', where: 'Where', servers, resume: null, model: null });
  assert.ok(fresh.includes('mcp_servers.smartdoc.url="http://127.0.0.1:47815/mcp"'));
  assert.ok(fresh.includes('mcp_servers.smartspec.url="http://127.0.0.1:47825/mcp"'));
  assert.equal(fresh.at(-1), 'Rules\n\nWhere\n\nHi');
  const resumed = PROVIDERS.codex.args({ prompt: 'Hi', systemPrompt: 'Rules', where: 'Where', servers, resume: 'thread-1', model: null });
  assert.deepEqual(resumed.slice(-3), ['resume', 'thread-1', '[Where]\n\nHi']);
});

test('steps are named by the app whose tool it is, however the AI names it', () => {
  assert.equal(describeStep('mcp__smartdoc__get_review'), 'Reading the review');
  assert.equal(describeStep('get_schematic', {}, 'smartspec'), 'Reading the schematic');
  assert.equal(describeStep('some_new_tool', {}, 'elsewhere'), 'Some new tool');
});

test('what the user did since their last message goes with the next one', () => {
  const messages = [
    { role: 'event', kind: 'context', text: 'Opened “CV”', detail: 'In SmartDoc: the window shows “CV”.' },
    { role: 'user', text: 'Hi' },
    { role: 'event', kind: 'context', text: 'Went home', detail: 'In SmartSpec: home.' },
  ];
  assert.equal(contextFor(messages), '[What I\'ve done in the apps since my last message, for context:\n- In SmartSpec: home.]\n\n');
  assert.equal(contextFor(messages.slice(0, 2)), '');
});

test('suggested questions come out of the reply', () => {
  const m = withSuggestions({ role: 'assistant', text: 'Done.\n<suggest>What next?</suggest>' });
  assert.equal(m.text, 'Done.');
  assert.deepEqual(m.suggestions, ['What next?']);
});

test('the AI names a chat with a <title> line, taken out of what shows', async () => {
  const { withTitle } = await import('../packages/app/src/main/agent.js');
  assert.deepEqual(withTitle({ role: 'assistant', text: 'Done.\n\n<title> Tighten   the CV </title>' }), { message: { role: 'assistant', text: 'Done.' }, title: 'Tighten the CV' });
  const plain = { role: 'assistant', text: 'No name here.' };
  assert.deepEqual(withTitle(plain), { message: plain, title: null });
  const mine = { role: 'user', text: '<title>not the AI</title>' };
  assert.equal(withTitle(mine).title, null);
});

test('chats are kept apart, each in a file of its own; the one conversation from before becomes the first', async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createAgent } = await import('../packages/app/src/main/agent.js');
  const userData = await mkdtemp(path.join(os.tmpdir(), 'agent-'));
  try {
    await writeFile(path.join(userData, 'chat.json'), JSON.stringify({ messages: [{ role: 'user', text: 'old', at: '2026-11-01T00:00:00Z' }], sessions: { claude: 's1' } }));
    const events = [];
    const agent = createAgent({ userData, onEvent: (e) => events.push(e) });
    const before = await agent.list();
    assert.equal(before.length, 1);
    assert.equal((await agent.load(before[0].id)).messages[0].text, 'old');
    const a = await agent.create();
    const b = await agent.create();
    await agent.note(a.id, { text: 'Opened “CV”' });
    assert.equal((await agent.load(a.id)).messages.length, 1);
    assert.equal((await agent.load(b.id)).messages.length, 0);
    assert.equal(JSON.parse(await readFile(path.join(userData, 'chats', `${a.id}.json`), 'utf8')).messages[0].text, 'Opened “CV”');
    await agent.rename(b.id, 'Mine');
    assert.equal((await agent.load(b.id)).titleBy, 'user');
    assert.ok(events.some((e) => e.type === 'title' && e.chatId === b.id && e.title === 'Mine'));
    assert.equal(agent.isRunning(a.id), false);
    assert.equal((await agent.list()).length, 3);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
