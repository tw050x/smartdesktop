import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byUse, period, search, summarize, when } from '../packages/app/src/main/chat-history.js';

const chat = (over = {}) => ({
  id: 'c-1',
  title: 'Tailor my CV',
  createdAt: '2026-11-10T09:00:00Z',
  messages: [
    { role: 'event', kind: 'context', text: 'Opened “CV”', at: '2026-11-10T09:00:00Z' },
    { role: 'user', text: 'Tailor it to the\n  Larder job', at: '2026-11-10T09:01:00Z', by: 'claude' },
    { role: 'assistant', text: 'Done: the summary now leads with logistics.', at: '2026-11-10T09:02:00Z', by: 'claude' },
    { role: 'step', text: 'Read the document', at: '2026-11-10T09:03:00Z' },
  ],
  ...over,
});

test('a chat is summarised by its name, when it was last used and the last thing said', () => {
  const s = summarize(chat());
  assert.equal(s.title, 'Tailor my CV');
  assert.equal(s.usedAt, '2026-11-10T09:03:00Z');
  assert.equal(s.by, 'claude');
  assert.equal(s.preview, 'Done: the summary now leads with logistics.');
  assert.equal(s.said, true);
  const mine = summarize(chat({ messages: chat().messages.slice(0, 2) }));
  assert.equal(mine.preview, 'You: Tailor it to the Larder job');
  const opened = summarize({ id: 'c-2', title: 'New chat', createdAt: '2026-11-11T00:00:00Z', messages: [{ role: 'event', text: 'Opened “CV”', at: '2026-11-11T00:01:00Z' }] });
  assert.equal(opened.said, false);
  assert.equal(opened.preview, '');
  assert.equal(summarize({ id: 'c-3', createdAt: '2026-11-12T00:00:00Z' }).usedAt, '2026-11-12T00:00:00Z');
  assert.ok(summarize(chat({ messages: [{ role: 'user', text: 'x'.repeat(500) }] })).preview.length <= 140);
});

test('a search finds a chat by its name or what was said, every word, in any case', () => {
  assert.equal(search(chat(), 'cv').preview, 'Done: the summary now leads with logistics.');
  const found = search(chat(), 'LARDER job');
  assert.equal(found.preview, 'You: Tailor it to the Larder job');
  assert.equal(found.match, true);
  assert.equal(search(chat(), 'larder missing'), null);
  // Not the lines of context nor the steps.
  assert.equal(search(chat(), 'opened'), null);
  assert.equal(search(chat(), 'read the document'), null);
  assert.equal(search(chat(), '  ').title, 'Tailor my CV');
  // Far into a long message: the snippet starts shortly before the match.
  const long = search(chat({ messages: [{ role: 'assistant', text: `${'filler '.repeat(40)}needle here` }] }), 'needle');
  assert.match(long.preview, /^…filler.*needle here$/);
});

test('chats are grouped by when they were last used', () => {
  const now = new Date(2026, 10, 16, 15, 0);
  assert.equal(period(new Date(2026, 10, 16, 1, 0), now), 'Today');
  assert.equal(period(new Date(2026, 10, 15, 23, 0), now), 'Yesterday');
  assert.equal(period(new Date(2026, 10, 10), now), 'Previous 7 Days');
  assert.equal(period(new Date(2026, 9, 20), now), 'Previous 30 Days');
  assert.match(period(new Date(2026, 8, 1), now), /^\S+$/); // its month, this year
  assert.match(period(new Date(2025, 8, 1), now), / 2025$/);
  assert.equal(period('nonsense', now), 'Earlier');
  assert.equal(when(new Date(2026, 10, 15, 9), now), 'Yesterday');
  assert.match(when(new Date(2026, 10, 16, 9, 5), now), /09.05/);
  assert.deepEqual([{ usedAt: '2026-11-01' }, { usedAt: '2026-11-09' }].sort(byUse).map((c) => c.usedAt), ['2026-11-09', '2026-11-01']);
});

test('the agent lists every chat kept for the history, from its file or from memory', async () => {
  const { mkdtemp, rm, writeFile, mkdir } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createAgent } = await import('../packages/app/src/main/agent.js');
  const userData = await mkdtemp(path.join(os.tmpdir(), 'history-'));
  try {
    await mkdir(path.join(userData, 'chats'));
    await writeFile(path.join(userData, 'chats', 'c-old.json'), JSON.stringify(chat({ id: 'c-old' })));
    await writeFile(path.join(userData, 'chats', 'c-bad.json'), '{ not json');
    const agent = createAgent({ userData, onEvent: () => {} });
    const fresh = await agent.create();
    await agent.note(fresh.id, { text: 'Opened “Spec”' });
    const all = await agent.history();
    assert.deepEqual(all.map((c) => c.id), [fresh.id, 'c-old']); // newest first; the broken file left out
    assert.equal(all[0].said, false);
    assert.deepEqual((await agent.history('larder')).map((c) => c.id), ['c-old']);
    await agent.rename(fresh.id, 'Larder spec');
    assert.deepEqual((await agent.history('larder')).map((c) => c.id), [fresh.id, 'c-old']);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
