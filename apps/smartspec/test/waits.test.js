import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { wait, EXIT } from '../packages/cli/lib/wait.js';
import { createStore } from '../packages/app/src/main/store.js';
import { createWaits } from '../packages/app/src/main/waits.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'smartspec-waits-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const setup = () => {
  const store = createStore(path.join(temp, `store-${n++}`));
  return { store, waits: createWaits({ store }) };
};
const proposal = { name: 'A', summary: 'B', note: 'C' };

describe('waiting for a proposal', () => {
  test('ends when the user accepts it', async () => {
    const { store, waits } = setup();
    const made = await store.propose(proposal);
    const { promise } = waits.forProposal(made.proposal);
    const { draft } = await store.accept(made.schema);
    const result = await promise;
    assert.equal(result.event, 'proposal-accepted');
    assert.equal(result.draft, draft);
    assert.equal(store.events.listenerCount('proposal'), 0);
  });

  test('finds an answer given before the wait began', async () => {
    const { store, waits } = setup();
    const made = await store.propose(proposal);
    await store.discard(made.schema);
    assert.equal((await waits.forProposal(made.proposal).promise).event, 'proposal-discarded');
  });

  test('ends when the proposal is replaced', async () => {
    const { store, waits } = setup();
    const made = await store.propose(proposal);
    await store.accept(made.schema);
    const change = await store.propose({ ...proposal, schemaId: made.schema });
    const { promise } = waits.forProposal(change.proposal);
    await store.propose({ ...proposal, schemaId: made.schema });
    assert.equal((await promise).event, 'proposal-replaced');
  });

  test('refuses a proposal that doesn\'t exist', async () => {
    const { waits } = setup();
    await assert.rejects(waits.forProposal('nope').promise, (error) => error.status === 404);
  });

  test('can be cancelled, leaving nothing listening', async () => {
    const { store, waits } = setup();
    const made = await store.propose(proposal);
    const { promise, cancel } = waits.forProposal(made.proposal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancel();
    assert.equal(await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200))]), null);
    assert.equal(store.events.listenerCount('proposal'), 0);
  });
});

describe('the wait command', () => {
  // A stand-in for the app, answering as `answer` says.
  async function run(args, answer) {
    const dir = mkdtempSync(path.join(temp, 'data-'));
    writeFileSync(path.join(dir, 'mcp-token'), 'secret');
    const bodies = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      answer(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const lines = [];
    const code = await wait(args, { env: { SMARTSPEC_PORT: String(server.address().port), SMARTSPEC_USER_DATA: dir }, out: (t) => lines.push(t), err: (t) => lines.push(t) });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    return { code, lines, bodies };
  }

  test('asks about the proposal and prints what happened', async () => {
    const { code, lines, bodies } = await run(['proposal', '--id', 'p1'], (res) => res.writeHead(200).end('{"event":"proposal-accepted"}'));
    assert.equal(code, EXIT.happened);
    assert.deepEqual(lines, ['{"event":"proposal-accepted"}']);
    assert.deepEqual(bodies, [{ url: '/mcp/wait', auth: 'Bearer secret', body: { what: 'proposal', proposal: 'p1' } }]);
  });

  test('gives up after the timeout', async () => {
    const { code } = await run(['proposal', '--id', 'p1', '--timeout', '0.05'], () => {});
    assert.equal(code, EXIT.timedOut);
  });

  test('says when the app refuses', async () => {
    const { code, lines } = await run(['proposal', '--id', 'p1'], (res) => res.writeHead(404).end('{"error":"There\'s no proposal p1."}'));
    assert.equal(code, EXIT.refused);
    assert.deepEqual(lines, ["There's no proposal p1."]);
  });

  test('refuses a wrong command', async () => {
    const lines = [];
    assert.equal(await wait(['decisions', '--id', 'x'], { env: {}, err: (t) => lines.push(t) }), EXIT.usage);
    assert.equal(await wait(['proposal'], { env: {}, err: (t) => lines.push(t) }), EXIT.usage);
    assert.match(lines[0], /Usage/);
  });
});
