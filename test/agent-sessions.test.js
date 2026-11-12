import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionGone } from '../packages/app/src/main/agent.js';

test('an AI saying its session has gone is recognised, from Codex and Claude Code', () => {
  assert.ok(sessionGone('Error: thread/resume: thread/resume failed: no rollout found for thread id 01a1c364 (code -32600)'));
  assert.ok(sessionGone('No conversation found with session ID: 296a8ed3'));
  assert.ok(!sessionGone('Rate limit reached, try again later'));
  assert.ok(!sessionGone(''));
});
