import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { format, snapshot } from '../scripts/server-snapshot.mjs';
import { runBridge } from '../packages/cli/lib/bridge.js';
import { NotInstalled, ensureRunning, probe, readToken } from '../packages/cli/lib/launch.js';
import { appEnv, mcpUrl, ownApp, userDataDir } from '../packages/cli/lib/platform.js';

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
  test('the app and the launcher are released together, so share one version', () => {
    const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8')).version;
    assert.equal(read('packages/cli/package.json'), read('packages/app/package.json'));
  });
});

describe('offline answers', () => {
  test('the launcher’s copy of what the app’s server lists is up to date (npm run server-snapshot)', async () => {
    assert.equal(readFileSync(path.join(root, 'packages/cli/lib/server.json'), 'utf8'), format(await snapshot()));
  });

  test('every tool has its safety labels', async () => {
    for (const tool of (await snapshot()).tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', tool.name);
    }
  });
});

describe('platform', () => {
  test('knows when it runs from inside the app', () => {
    assert.equal(ownApp('/Applications/SmartDoc.app/Contents/MacOS/SmartDoc'), '/Applications/SmartDoc.app');
    assert.equal(ownApp('/Users/a/My Apps/SmartDoc.app/Contents/MacOS/SmartDoc'), '/Users/a/My Apps/SmartDoc.app');
    assert.equal(ownApp('/usr/local/bin/node'), null);
  });

  test('opens the app without running it as Node', () => {
    assert.deepEqual(appEnv({ ELECTRON_RUN_AS_NODE: '1', HOME: '/Users/a' }), { HOME: '/Users/a' });
  });

  test('finds the data folder Electron gives the app', () => {
    assert.equal(userDataDir({ env: {}, platform: 'darwin', home: '/Users/a' }), '/Users/a/Library/Application Support/SmartDoc');
    assert.equal(userDataDir({ env: { XDG_CONFIG_HOME: '/c' }, platform: 'linux', home: '/home/a' }), '/c/SmartDoc');
    assert.equal(userDataDir({ env: { SMARTDOC_USER_DATA: '/tmp/x' } }), '/tmp/x');
  });

  test('uses the standard port unless told otherwise', () => {
    assert.equal(mcpUrl({}), 'http://127.0.0.1:47815/mcp');
    assert.equal(mcpUrl({ SMARTDOC_PORT: '50000' }), 'http://127.0.0.1:50000/mcp');
  });
});

describe('opening the app', () => {
  test('says the app isn’t installed, and where to get it, on a computer without it', async () => {
    // Nothing listens on this port, and there's no app this launcher is part of. Off macOS it says
    // the app runs on macOS; on a Mac without SmartDoc, that it isn't installed.
    const env = { SMARTDOC_PORT: '1', SMARTDOC_USER_DATA: tempDir('no-app') };
    await assert.rejects(ensureRunning({ env, execPath: '/usr/local/bin/node', platform: 'linux' }), /runs on macOS/);
    assert.match(new NotInstalled().message, /isn't installed on this computer\. Tell the user to download it from https:\/\/tw050x\.github\.io\/smartdoc\//);
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
  async function exchange({ env, ensure, messages, ...options }) {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (chunk) => (out += chunk));
    const done = runBridge({ input, output, env, ensure, token: () => readToken({ env }), ...options });
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

  describe('answering for the app until it’s running', () => {
    const offline = JSON.parse(readFileSync(path.join(root, 'packages/cli/lib/server.json'), 'utf8'));

    test('answers the handshake and the lists itself, opening nothing', async () => {
      let ensured = 0;
      const replies = await exchange({
        env: { SMARTDOC_PORT: '1', SMARTDOC_USER_DATA: withTokenFile('secret') },
        ensure: async () => { ensured++; },
        offline,
        version: '9.9.9',
        messages: [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
        ],
      });
      const [init, tools, prompts] = replies.sort((a, b) => a.id - b.id);
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.deepEqual(init.result.serverInfo, { name: 'smartdoc', version: '9.9.9' });
      assert.equal(init.result.instructions, offline.instructions);
      assert.deepEqual(tools.result.tools.map((t) => t.name), offline.tools.map((t) => t.name));
      assert.equal(prompts.result.prompts.length, offline.prompts.length);
      assert.equal(ensured, 0);
    });

    test('opens the app for a tool call, and passes it on', async () => {
      const app = await fakeApp('secret');
      const replies = await exchange({
        env: { SMARTDOC_PORT: String(app.port), SMARTDOC_USER_DATA: withTokenFile('secret') },
        ensure: async () => {},
        offline,
        messages: [{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_review' } }],
      });
      assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 4, result: { echo: 'tools/call' } }]);
      await app.close();
    });

    test('answers a tool call the app can’t take with the reason, for the AI to pass on', async () => {
      const replies = await exchange({
        env: { SMARTDOC_PORT: '1', SMARTDOC_USER_DATA: withTokenFile('secret') },
        ensure: async () => { throw new NotInstalled(); },
        offline,
        messages: [{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_review' } }],
      });
      assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 5, result: { isError: true, content: [{ type: 'text', text: new NotInstalled().message }] } }]);
    });
  });
});
