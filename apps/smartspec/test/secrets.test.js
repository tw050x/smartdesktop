import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { checkImplementation } from '../packages/app/src/main/implementation.js';
import { createSecrets, randomValue } from '../packages/app/src/main/secrets.js';
import { createTestRuns } from '../packages/app/src/main/test-runs.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-secrets-'));
after(() => rmSync(temp, { recursive: true, force: true }));

// Stands in for the Keychain's key: reversible, and plainly not the value.
const cipher = { available: () => true, encrypt: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`), decrypt: (data) => [...data.toString().slice(4)].reverse().join('') };

const git = (secrets) => ({ source: { kind: 'git', url: 'https://github.com/larder/auth.git' }, start: { port: 4000, env: { PORT: '4000' }, commands: ['node server.js'] }, secrets });

describe('an implementation\'s secrets', () => {
  test('name what the code needs and how it gets it, never a value', () => {
    assert.doesNotThrow(() => checkImplementation(git([
      { name: 'jwt-key', description: 'Signs its tokens', files: ['service/auth/.secret/jwt.key', 'service/admin/.secret/jwt.key'], random: { format: 'hex', length: 64 } },
      { name: 'db-password', env: 'DB_PASSWORD' },
    ])));
    assert.doesNotThrow(() => checkImplementation({ source: { kind: 'image', image: 'auth:1' }, start: { port: 1 }, secrets: [{ name: 'k', env: 'K' }] }));
  });

  test('refuse what couldn\'t be given, saying why', () => {
    const refused = (implementation, pattern) => assert.throws(() => checkImplementation(implementation), pattern);
    refused(git([{ name: 'k' }]), /needs env .* or files/);
    refused(git([{ name: 'k', env: 'K' }, { name: 'k', env: 'J' }]), /two secrets called k/);
    refused(git([{ name: 'k', env: 'PORT' }]), /start.env sets too/);
    refused(git([{ name: 'k', files: ['../outside'] }]), /inside its code/);
    refused(git([{ name: 'k', files: ['/etc/passwd'] }]), /inside its code/);
    refused(git([{ name: 'k', files: ['.git/config'] }]), /inside its code/);
    refused(git([{ name: 'k', env: 'K', random: { format: 'emoji' } }]), /random format/);
    refused({ source: { kind: 'image', image: 'auth:1' }, start: { port: 1 }, secrets: [{ name: 'k', files: ['a'] }] }, /give it as env instead/);
    refused({ source: { kind: 'running', url: 'https://auth.example.com' }, secrets: [{ name: 'k', env: 'K' }] }, /already running/);
  });

  test('can be made at random, in their format and length', () => {
    assert.match(randomValue(), /^[0-9a-f]{64}$/);
    assert.match(randomValue({ format: 'base64url', length: 20 }), /^[\w-]{20}$/);
    assert.match(randomValue({ format: 'alphanumeric' }), /^[A-Za-z0-9]{43}$/);
    assert.notEqual(randomValue(), randomValue());
  });
});

describe('secrets kept on this Mac', () => {
  test('are encrypted, each schematic\'s its own, and say only whether they\'re set', () => {
    const changed = [];
    const dir = path.join(temp, 'kept');
    const secrets = createSecrets(dir, { cipher, onChange: (id) => changed.push(id) });
    const implementation = git([{ name: 'jwt-key', files: ['.secret/jwt.key'], random: {} }, { name: 'db', env: 'DB' }]);
    assert.deepEqual(secrets.statusOf('s1', implementation).map((one) => one.set), [false, false]);
    assert.deepEqual(secrets.valuesFor('s1', implementation), { values: [], missing: ['jwt-key', 'db'] });
    secrets.set('s1', 'db', 'hunter2-password');
    secrets.generate('s1', implementation.secrets[0]);
    assert.throws(() => secrets.generate('s1', implementation.secrets[1]), /has to be entered/);
    const status = secrets.statusOf('s1', implementation);
    assert.deepEqual(status.map(({ name, set, by }) => ({ name, set, by })), [{ name: 'jwt-key', set: true, by: 'random' }, { name: 'db', set: true, by: 'user' }]);
    assert.equal(JSON.stringify(status).includes('hunter2'), false);
    const { values, missing } = secrets.valuesFor('s1', implementation);
    assert.deepEqual(missing, []);
    assert.deepEqual(values[1], { name: 'db', value: 'hunter2-password', env: 'DB' });
    assert.match(values[0].value, /^[0-9a-f]{64}$/);
    // Never written down as it is, and another schematic's are its own.
    const file = readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    assert.equal(file.includes('hunter2'), false);
    assert.equal(secrets.statusOf('s2', implementation)[1].set, false);
    // Read again after a restart; cleared, gone.
    const again = createSecrets(dir, { cipher });
    assert.equal(again.valuesFor('s1', implementation).values[1].value, 'hunter2-password');
    again.clear('s1', 'db');
    assert.deepEqual(again.valuesFor('s1', implementation).missing, ['db']);
    assert.equal(Object.keys(JSON.parse(readFileSync(path.join(dir, 'secrets.json'), 'utf8')).values).length, 1);
    assert.deepEqual(changed, ['s1', 's1']);
  });

  test('aren\'t kept when the Keychain can\'t be used', () => {
    const secrets = createSecrets(path.join(temp, 'locked'), { cipher: { ...cipher, available: () => false } });
    assert.throws(() => secrets.set('s1', 'db', 'x'), /Keychain isn't available/);
  });
});

describe('a run needing secrets', () => {
  // A runner that keeps the job it's given and says it passed.
  const jobFile = path.join(temp, 'job.json');
  const fake = path.join(temp, 'fake-runner.mjs');
  writeFileSync(fake, `import fs from 'node:fs'; let job = ''; process.stdin.on('data', (c) => (job += c)); process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(jobFile)}, job); console.log(JSON.stringify({ type: 'done', outcome: 'passed', counts: { passed: 0, failed: 0, error: 0 } })); });`);
  const implementation = git([{ name: 'jwt-key', files: ['.secret/jwt.key'], random: {} }, { name: 'db', env: 'DB' }]);
  const store = {
    getSchema: async () => ({ draftId: 'd1', number: 1, total: 1, line: ['d1'], name: 'Auth', implementation, contract: { children: [{ id: 'a', name: '/a', path: '/a', clauses: [{ id: 'up', title: 'Up', checks: [{ id: 'ok', kind: 'http', request: { method: 'GET', path: '/a' }, expect: { status: 200 } }] }] }] } }),
    getProposal: async () => null,
  };

  test('isn\'t started while one is missing, saying which, and how the AI can make one', async () => {
    const secrets = createSecrets(path.join(temp, 'runs'), { cipher });
    let ended;
    const runs = createTestRuns({ runner: { command: process.execPath, args: [fake], env: {} }, store, secrets, onChange: (_id, run) => { if (!run.running) ended?.(run); } });
    await assert.rejects(runs.start('s1', 'd1', { target: 'ref:main' }), /needs secrets not set on this Mac yet: jwt-key, db/);
    await assert.rejects(runs.runAndWait('s1', { ref: 'main' }), (error) => /jwt-key can be made at random: generate_secrets/.test(error.message) && /Only the user can enter db/.test(error.message));
    secrets.generate('s1', implementation.secrets[0]);
    secrets.set('s1', 'db', 'hunter2-password');
    const done = new Promise((resolve) => { ended = resolve; });
    await runs.start('s1', 'd1', { target: 'ref:main' });
    const run = await done;
    // The runner was given them, in its job; the run kept and sent holds none.
    const job = JSON.parse(readFileSync(jobFile, 'utf8'));
    assert.deepEqual(job.secrets.map(({ name, env, files }) => ({ name, env, files })), [{ name: 'jwt-key', env: undefined, files: ['.secret/jwt.key'] }, { name: 'db', env: 'DB', files: undefined }]);
    assert.equal(job.secrets[1].value, 'hunter2-password');
    assert.equal(JSON.stringify(run).includes('hunter2'), false);
  });
});
