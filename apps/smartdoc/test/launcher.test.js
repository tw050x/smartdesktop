import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { runBridge } from '../packages/mcp/lib/bridge.js';
import { ensureInstalled, parseChecksums } from '../packages/mcp/lib/install.js';
import { probe, readToken } from '../packages/mcp/lib/launch.js';
import { VERSION, assetName, cacheDir, mcpUrl, userDataDir } from '../packages/mcp/lib/platform.js';

// Everything here runs against temporary folders and its own ports: never the real app or its data.
const root = path.join(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'smartdoc-test-'));
after(() => rmSync(temp, { recursive: true, force: true }));
const tempDir = (name) => {
  const dir = path.join(temp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// A local HTTP server; resolves to { url, port, close, requests }.
async function serve(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('versions', () => {
  test('the app, the launcher and the bundle are released together, so share one version', () => {
    const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8')).version;
    assert.equal(read('packages/mcp/package.json'), read('packages/app/package.json'));
    assert.equal(read('mcpb/manifest.json'), read('packages/app/package.json'));
  });

  test('the bundle lists the tools the app serves', () => {
    const served = [...readFileSync(path.join(root, 'packages/app/src/main/mcp-server.js'), 'utf8').matchAll(/tool\('([a-z_]+)'/g)].map((m) => m[1]);
    const listed = JSON.parse(readFileSync(path.join(root, 'mcpb/manifest.json'), 'utf8')).tools.map((t) => t.name);
    assert.deepEqual(listed.sort(), served.sort());
  });
});

describe('platform', () => {
  test('names the build for each Mac, and none elsewhere yet', () => {
    assert.equal(assetName({ version: '1.2.3', platform: 'darwin', arch: 'arm64' }), 'smartdoc-1.2.3-mac-arm64.zip');
    assert.equal(assetName({ version: '1.2.3', platform: 'darwin', arch: 'x64' }), 'smartdoc-1.2.3-mac-x64.zip');
    assert.equal(assetName({ platform: 'win32', arch: 'x64' }), null);
    assert.equal(assetName({ platform: 'linux', arch: 'x64' }), null);
  });

  test('finds the data folder Electron gives the app', () => {
    assert.equal(userDataDir({ env: {}, platform: 'darwin', home: '/Users/a' }), '/Users/a/Library/Application Support/SmartDoc');
    assert.equal(userDataDir({ env: { XDG_CONFIG_HOME: '/c' }, platform: 'linux', home: '/home/a' }), '/c/SmartDoc');
    assert.equal(userDataDir({ env: { SMARTDOC_USER_DATA: '/tmp/x' } }), '/tmp/x');
    assert.equal(cacheDir({ env: {}, platform: 'darwin', home: '/Users/a' }), '/Users/a/Library/Caches/smartdoc');
  });

  test('uses the standard port unless told otherwise', () => {
    assert.equal(mcpUrl({}), 'http://127.0.0.1:47815/mcp');
    assert.equal(mcpUrl({ SMARTDOC_PORT: '50000' }), 'http://127.0.0.1:50000/mcp');
  });
});

describe('install', () => {
  test('reads a checksums file', () => {
    const hash = 'a'.repeat(64);
    const sums = parseChecksums(`${hash}  one.zip\n${'b'.repeat(64)} *two.zip\nnot a line\n`);
    assert.equal(sums.get('one.zip'), hash);
    assert.equal(sums.get('two.zip'), 'b'.repeat(64));
    assert.equal(sums.size, 2);
  });

  // Unpacking uses macOS's ditto, and only Macs have builds.
  const onMac = { skip: process.platform !== 'darwin' && 'macOS only' };

  // A release with a fake app zipped the way the release build zips it.
  async function fakeRelease({ corrupt = false } = {}) {
    const work = tempDir(`release-${Math.random().toString(36).slice(2)}`);
    const bundle = path.join(work, 'SmartDoc.app', 'Contents');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'Info.plist'), '<plist/>');
    const zip = path.join(work, assetName());
    execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(work, 'SmartDoc.app'), zip]);
    const body = readFileSync(zip);
    const sum = createHash('sha256').update(corrupt ? 'something else' : body).digest('hex');
    return serve((req, res) => {
      if (req.url === '/SHA256SUMS.txt') return res.end(`${sum}  ${assetName()}\n`);
      if (req.url === `/${assetName()}`) return res.end(body);
      res.writeHead(404).end();
    });
  }

  test('downloads, checks and unpacks the build once, even when asked twice at once', onMac, async () => {
    const release = await fakeRelease();
    const env = { SMARTDOC_CACHE: tempDir('cache-ok'), SMARTDOC_DOWNLOADS: release.url };
    const [a, b] = await Promise.all([ensureInstalled({ env }), ensureInstalled({ env })]);
    assert.equal(a, b);
    assert.equal(a, path.join(env.SMARTDOC_CACHE, VERSION, 'SmartDoc.app'));
    assert.ok(existsSync(path.join(a, 'Contents', 'Info.plist')));
    assert.equal(release.requests.filter((u) => u.endsWith('.zip')).length, 1);
    assert.equal(await ensureInstalled({ env }), a); // cached: no further download
    assert.equal(release.requests.filter((u) => u.endsWith('.zip')).length, 1);
    await release.close();
  });

  test('refuses a download that doesn’t match its checksum', onMac, async () => {
    const release = await fakeRelease({ corrupt: true });
    const env = { SMARTDOC_CACHE: tempDir('cache-bad'), SMARTDOC_DOWNLOADS: release.url };
    await assert.rejects(ensureInstalled({ env }), /didn’t match/);
    assert.ok(!existsSync(path.join(env.SMARTDOC_CACHE, VERSION)));
    await release.close();
  });
});

describe('bridge', () => {
  // A stand-in for the app's MCP server: checks the token like the real one, answers 405 to GET,
  // echoes requests and accepts notifications.
  async function fakeApp(token) {
    return serve(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end(JSON.stringify({ error: 'Missing or wrong token.' }));
      if (req.method !== 'POST') return res.writeHead(405).end();
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) return res.writeHead(202).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.method } }));
    });
  }

  function withTokenFile(token) {
    const dir = tempDir(`data-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path.join(dir, 'mcp-token'), token);
    return dir;
  }

  // Runs the bridge on in-memory streams; resolves to the replies once input ends.
  async function exchange({ env, ensure, messages }) {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (chunk) => (out += chunk));
    const done = runBridge({ input, output, env, ensure, token: () => readToken({ env }) });
    for (const m of messages) input.write(`${JSON.stringify(m)}\n`);
    input.end();
    await done;
    return out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  test('probes the app with its token', async () => {
    const app = await fakeApp('secret');
    assert.equal(await probe({ env: { SMARTDOC_PORT: String(app.port), SMARTDOC_USER_DATA: withTokenFile('secret') } }), 'up');
    assert.equal(await probe({ env: { SMARTDOC_PORT: String(app.port), SMARTDOC_USER_DATA: withTokenFile('wrong') } }), 'locked');
    await app.close();
    assert.equal(await probe({ env: { SMARTDOC_PORT: String(app.port), SMARTDOC_USER_DATA: withTokenFile('secret') } }), 'down');
  });

  test('passes requests to the app and its replies back, once the app is ready', async () => {
    const app = await fakeApp('secret');
    const env = { SMARTDOC_PORT: String(app.port), SMARTDOC_USER_DATA: withTokenFile('secret') };
    let ensured = 0;
    const replies = await exchange({
      env,
      ensure: async () => { ensured++; },
      messages: [{ jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
    });
    assert.deepEqual(replies.sort((a, b) => a.id - b.id), [
      { jsonrpc: '2.0', id: 1, result: { echo: 'initialize' } },
      { jsonrpc: '2.0', id: 2, result: { echo: 'tools/list' } },
    ]);
    assert.equal(ensured, 1); // the app is started once, not per message
    await app.close();
  });

  test('answers with an error when the app can’t be started', async () => {
    const replies = await exchange({
      env: { SMARTDOC_PORT: '1', SMARTDOC_USER_DATA: withTokenFile('secret') },
      ensure: async () => { throw new Error('SmartDoc didn’t start in time.'); },
      messages: [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }],
    });
    assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'SmartDoc didn’t start in time.' } }]);
  });

  test('opens the app again if it was closed since', async () => {
    const env = { SMARTDOC_PORT: '0', SMARTDOC_USER_DATA: withTokenFile('secret') };
    let app = null;
    // The first "start" brings up a server that's closed straight away; the second keeps one up.
    let starts = 0;
    const ensure = async () => {
      starts++;
      if (app) return;
      const server = await fakeApp('secret');
      env.SMARTDOC_PORT = String(server.port);
      if (starts === 1) await server.close();
      else app = server;
    };
    const replies = await exchange({ env, ensure, messages: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }] });
    assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 1, result: { echo: 'tools/list' } }]);
    assert.equal(starts, 2);
    await app.close();
  });

  test('reports the app refusing the token', async () => {
    const app = await fakeApp('secret');
    const replies = await exchange({
      env: { SMARTDOC_PORT: String(app.port), SMARTDOC_USER_DATA: withTokenFile('stale') },
      ensure: async () => {},
      messages: [{ jsonrpc: '2.0', id: 3, method: 'tools/list' }],
    });
    assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Missing or wrong token.' } }]);
    await app.close();
  });
});
