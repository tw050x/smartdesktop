import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SESSION_TIMEOUT_MS, SHARED_SESSION, clientLabel, createSessions } from '../packages/app/src/main/sessions.js';

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
    assert.equal(sessions.touch(undefined).id, SHARED_SESSION);
  });

  test('a session lasts through a long wait while the launcher is still there', () => {
    const { sessions, clock } = setup();
    const a = sessions.touch('a');
    for (let i = 0; i < 100; i++) {
      clock.tick(SESSION_TIMEOUT_MS / 2);
      sessions.touch('a');
    }
    assert.equal(sessions.alive(a), true);
    assert.deepEqual(sessions.sweep(), []);
  });

  test('a session ends when its launcher says so, or goes quiet', () => {
    const { sessions, clock } = setup();
    sessions.touch('a');
    sessions.touch('c');
    assert.equal(sessions.end('a').id, 'a');
    assert.equal(sessions.get('a'), undefined);
    clock.tick(SESSION_TIMEOUT_MS + 1);
    assert.deepEqual(sessions.sweep().map((s) => s.id), ['c']);
    assert.equal(sessions.get('c'), undefined);
  });

  test('connections with no id never expire: only the user can release them', () => {
    const { sessions, clock } = setup();
    const shared = sessions.touch(undefined);
    clock.tick(SESSION_TIMEOUT_MS * 10);
    assert.equal(sessions.alive(shared), true);
    assert.deepEqual(sessions.sweep(), []);
  });

  test('one session can hold a claim, and can take it again', () => {
    const { sessions } = setup();
    const [a, b] = [sessions.touch('a'), sessions.touch('b')];
    assert.equal(sessions.claim(a, 'k'), null);
    assert.equal(sessions.claim(a, 'k'), null);
    assert.equal(sessions.claim(b, 'k'), a);
  });

  test('a claim ends with its work, its session, or its session going quiet', () => {
    const { sessions, clock } = setup();
    const [a, b] = [sessions.touch('a'), sessions.touch('b')];
    sessions.claim(a, 'answered');
    sessions.release('answered');
    assert.equal(sessions.claim(b, 'answered'), null);
    sessions.claim(a, 'ended');
    sessions.end('a');
    assert.equal(sessions.claim(b, 'ended'), null);
    const c = sessions.touch('c');
    sessions.claim(c, 'quiet');
    clock.tick(SESSION_TIMEOUT_MS + 1);
    sessions.touch('b');
    assert.equal(sessions.claim(b, 'quiet'), null);
  });

  test('an AI app is named as a person would say it', () => {
    assert.equal(clientLabel('claude-code'), 'Claude Code');
    assert.equal(clientLabel('some-agent'), 'some-agent');
    assert.equal(clientLabel(null), 'An AI');
  });
});
