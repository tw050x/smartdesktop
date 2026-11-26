import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEGACY_SESSION, SESSION_TIMEOUT_MS, clientLabel, createSessions } from '../packages/app/src/main/sessions.js';

describe('AI sessions', () => {
  const setup = () => {
    let time = 1000;
    return { clock: { tick: (ms) => { time += ms; } }, sessions: createSessions({ now: () => time }) };
  };

  test('a session is the same one for each call, and calls with no id share one', () => {
    const { sessions } = setup();
    assert.equal(sessions.touch('a', 'claude-code'), sessions.touch('a'));
    assert.equal(sessions.touch('a').client, 'claude-code');
    assert.notEqual(sessions.touch('a'), sessions.touch('b'));
    assert.equal(sessions.touch(undefined).id, LEGACY_SESSION);
  });

  test('one session can hold a claim, and can take it again', () => {
    const { sessions } = setup();
    const [a, b] = [sessions.touch('a'), sessions.touch('b')];
    assert.equal(sessions.claim(a, 'doc:improve:original'), null);
    assert.equal(sessions.claim(a, 'doc:improve:original'), null);
    assert.equal(sessions.claim(b, 'doc:improve:original'), a);
  });

  test('different work on one document can go on at once', () => {
    const { sessions } = setup();
    const [a, b] = [sessions.touch('a'), sessions.touch('b')];
    assert.equal(sessions.claim(a, 'doc:improve:original'), null);
    assert.equal(sessions.claim(b, 'doc:highlights:Risks'), null);
    assert.equal(sessions.claim(b, 'doc:improve:variation-1'), null);
  });

  test('a claim survives a long wait while the launcher is still there', () => {
    const { sessions, clock } = setup();
    const [a, b] = [sessions.touch('a'), sessions.touch('b')];
    sessions.claim(a, 'k');
    for (let i = 0; i < 100; i++) {
      clock.tick(SESSION_TIMEOUT_MS / 2);
      sessions.touch('a');
      sessions.touch('b');
    }
    assert.equal(sessions.claim(b, 'k'), a);
  });

  test('a session that ends, or goes quiet, gives its claims up', () => {
    const { sessions, clock } = setup();
    const [a, b] = [sessions.touch('a'), sessions.touch('b')];
    sessions.claim(a, 'k');
    sessions.end('a');
    assert.equal(sessions.claim(b, 'k'), null);
    const c = sessions.touch('c');
    sessions.claim(c, 'other');
    clock.tick(SESSION_TIMEOUT_MS + 1);
    sessions.touch('b');
    assert.equal(sessions.claim(b, 'other'), null);
    assert.deepEqual(sessions.sweep().map((s) => s.id), ['c']);
  });

  test('connections with no id never expire: only the user can release them', () => {
    const { sessions, clock } = setup();
    const legacy = sessions.touch(undefined);
    sessions.claim(legacy, 'k');
    clock.tick(SESSION_TIMEOUT_MS * 10);
    assert.equal(sessions.claim(sessions.touch('b'), 'k'), legacy);
  });

  test('an AI app is named as a person would say it', () => {
    assert.equal(clientLabel('claude-code'), 'Claude Code');
    assert.equal(clientLabel('some-agent'), 'some-agent');
    assert.equal(clientLabel(null), 'An AI');
  });
});
