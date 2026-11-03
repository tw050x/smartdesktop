import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createConnect } from '../packages/app/src/main/connect.js';
import { createStore } from '../packages/app/src/main/store.js';
import { createWaits, reviewOutcome } from '../packages/app/src/main/waits.js';
import { EXIT, wait } from '../packages/cli/lib/wait.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'smartdoc-waits-'));
after(() => rm(root, { recursive: true, force: true }));
const events = new EventEmitter();
const store = createStore(root, { onReview: (r) => events.emit('review', r), onDocument: (d) => events.emit('document', d) });

async function committedReview(type = 'improve') {
  const source = path.join(root, 'example.pdf');
  await writeFile(source, '%PDF-original');
  const doc = await store.importDocument(source);
  const review = await store.createReview(doc.id, doc.currentDraftId, 'ai', { type, variationId: doc.variationId });
  review.status = 'committed';
  await store.saveReview(doc.id, review);
  return { doc, review };
}

describe('what a review says has happened', () => {
  const committed = { id: 'r', type: 'improve', status: 'committed' };

  test('decisions, once sent', () => {
    assert.equal(reviewOutcome('decisions', committed), null);
    assert.equal(reviewOutcome('decisions', { ...committed, decisionsSentAt: 'then' }).event, 'decisions-sent');
  });

  test('a draft preview, once answered', () => {
    const preview = { ...committed, preview: {} };
    assert.equal(reviewOutcome('preview', preview), null);
    assert.equal(reviewOutcome('preview', { ...preview, previewCommentsSentAt: 'then' }).event, 'preview-comments');
    assert.equal(reviewOutcome('preview', { ...committed, previewResult: { outcome: 'accepted', draft: 'Draft 2' } }).event, 'preview-accepted');
    assert.equal(reviewOutcome('preview', { ...committed, previewResult: { outcome: 'discarded' } }).event, 'preview-discarded');
  });

  test('refuses waits that could never end', () => {
    assert.throws(() => reviewOutcome('decisions', { ...committed, status: 'open' }), /commit_review/);
    assert.throws(() => reviewOutcome('decisions', { ...committed, type: 'highlights' }), /highlights/);
    assert.throws(() => reviewOutcome('preview', committed), /apply_review/);
    assert.throws(() => reviewOutcome('decisions', { ...committed, applications: [{}] }), /already become a draft/);
  });
});

describe('waiting on a review', () => {
  const waits = createWaits({ store, events });

  test('ends when the review changes, and only for that review', async () => {
    const { doc, review } = await committedReview();
    const other = await committedReview();
    const { promise } = waits.forReview('decisions', review.id);
    let ended = false;
    promise.then(() => { ended = true; });
    other.review.decisionsSentAt = 'then';
    await store.saveReview(other.doc.id, other.review);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ended, false);
    assert.deepEqual(waits.active().map((w) => w.reviewId), [review.id]);
    review.decisionsSentAt = 'then';
    await store.saveReview(doc.id, review);
    const result = await promise;
    assert.equal(result.event, 'decisions-sent');
    assert.equal(result.document, doc.id);
    assert.deepEqual(waits.active(), []);
  });

  test('finds what has already happened', async () => {
    const { doc, review } = await committedReview();
    review.decisionsSentAt = 'then';
    await store.saveReview(doc.id, review);
    assert.equal((await waits.forReview('decisions', review.id).promise).event, 'decisions-sent');
  });

  test('refuses a review that does not exist', async () => {
    await assert.rejects(waits.forReview('decisions', 'review-nope').promise, (error) => error.status === 404);
  });

  test('stops being listed when cancelled', async () => {
    const { review } = await committedReview();
    const { promise, cancel } = waits.forReview('decisions', review.id);
    assert.equal(waits.active().length, 1);
    cancel();
    assert.equal(await promise, null);
    assert.deepEqual(waits.active(), []);
  });

  test('ends when the review goes with its draft', async () => {
    const { doc, review } = await committedReview();
    const { promise } = waits.forReview('decisions', review.id);
    const refused = assert.rejects(promise, (error) => error.status === 404);
    await rm(path.join(root, 'documents', doc.id, 'drafts', review.draftId), { recursive: true });
    events.emit('recent');
    await refused;
  });
});

describe('the wait command', () => {
  async function app(answer) {
    const data = await mkdtemp(path.join(root, 'data-'));
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'mcp-token'), 'secret');
    const asked = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        asked.push({ url: req.url, token: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
        answer(res);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { asked, env: { SMARTDOC_USER_DATA: data, SMARTDOC_PORT: String(server.address().port) }, server };
  }
  const run = async (argv, env) => {
    const out = [];
    const err = [];
    const code = await wait(argv, { env, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  test('prints what happened and exits 0', async () => {
    const { asked, env, server } = await app((res) => res.writeHead(200).end('{"event":"decisions-sent"}'));
    const { code, out } = await run(['decisions', '--review', 'r1'], env);
    assert.equal(code, EXIT.happened);
    assert.equal(out, '{"event":"decisions-sent"}');
    assert.deepEqual(asked, [{ url: '/mcp/wait', token: 'Bearer secret', body: { what: 'decisions', review: 'r1' } }]);
    server.close();
  });

  test('passes on a refusal', async () => {
    const { env, server } = await app((res) => res.writeHead(404).end('{"error":"There\'s no review r1"}'));
    const { code, err } = await run(['decisions', '--review', 'r1'], env);
    assert.equal(code, EXIT.refused);
    assert.match(err, /no review r1/);
    server.close();
  });

  test('gives up at its timeout, leaving the app free', async () => {
    const closed = [];
    const { env, server } = await app((res) => res.on('close', () => closed.push(true)));
    assert.equal((await run(['open', '--request', 'o1', '--timeout', '0.05'], env)).code, EXIT.timedOut);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed.length, 1);
    server.close();
  });

  test('says when the app quits while waiting', async () => {
    const { env, server } = await app((res) => res.destroy());
    assert.equal((await run(['preview', '--review', 'r1'], env)).code, EXIT.noApp);
    server.close();
  });

  test('says when the app is not running', async () => {
    const { env, server } = await app(() => {});
    await new Promise((resolve) => server.close(resolve));
    assert.equal((await run(['preview', '--review', 'r1'], env)).code, EXIT.noApp);
  });

  test('refuses a wrong command', async () => {
    const { env, server } = await app(() => {});
    for (const argv of [[], ['nonsense', '--review', 'r'], ['decisions'], ['decisions', '--request', 'r'], ['open', '--review', 'r'], ['decisions', '--review', 'r', '--timeout', 'soon'], ['decisions', '--bad']]) {
      assert.equal((await run(argv, env)).code, EXIT.usage, argv.join(' '));
    }
    server.close();
  });
});

describe('the command the AI is given', () => {
  test('runs the app’s own copy of the command', () => {
    const { waitCommand } = createConnect({ isPackaged: true, execPath: '/Users/a/My Apps/SmartDoc.app/Contents/MacOS/SmartDoc', resourcesPath: '/Users/a/My Apps/SmartDoc.app/Contents/Resources' });
    assert.equal(waitCommand('decisions', '--review', 'review-1'), "ELECTRON_RUN_AS_NODE=1 '/Users/a/My Apps/SmartDoc.app/Contents/MacOS/SmartDoc' '/Users/a/My Apps/SmartDoc.app/Contents/Resources/cli/cli.js' wait decisions --review review-1");
  });

  test('the app carries that copy of the command', async () => {
    const { build } = JSON.parse(await readFile(new URL('../packages/app/package.json', import.meta.url), 'utf8'));
    assert.ok(build.extraResources.find((r) => r.to === 'cli').filter.includes('cli.js'));
  });

  test('a development copy names its own data and port', () => {
    const { waitCommand } = createConnect({ isPackaged: false, execPath: '/repo/electron', appPath: '/repo/packages/app', userData: '/data/SmartDoc Dev', port: 47816 });
    assert.match(waitCommand('open', '--request', 'open-1'), /SMARTDOC_USER_DATA='\/data\/SmartDoc Dev' SMARTDOC_PORT=47816 /);
  });
});
