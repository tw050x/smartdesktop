import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { installRelease, latestRelease, parseLatest, zipFor } from '../packages/cli/lib/install.js';

// Everything here uses a stand-in release on its own port and temporary folders: never the real
// release, Applications, or the user's app.
const temp = mkdtempSync(path.join(os.tmpdir(), 'smartdoc-install-test-'));
after(() => rmSync(temp, { recursive: true, force: true }));

// latest-mac.yml as electron-builder writes it.
const latest = (zips) => [
  'version: 1.2.3',
  'files:',
  ...zips.flatMap((z) => [`  - url: ${z.url}`, `    sha512: ${z.sha512}`, `    size: ${z.size}`]),
  '  - url: SmartDoc-mac-arm64.dmg',
  '    sha512: abc==',
  '    size: 10',
  `path: ${zips[0]?.url ?? 'x'}`,
  `sha512: ${zips[0]?.sha512 ?? 'x'}`,
  "releaseDate: '2026-11-02T00:07:59.716Z'",
].join('\n');

describe('the latest release', () => {
  test('reads latest-mac.yml and picks the zip for this Mac', () => {
    const { version, files } = parseLatest(latest([
      { url: 'smartdoc-1.2.3-mac-x64.zip', sha512: 'x64sum==', size: 125 },
      { url: 'smartdoc-1.2.3-mac-arm64.zip', sha512: 'armsum==', size: 120 },
    ]));
    assert.equal(version, '1.2.3');
    assert.deepEqual(zipFor(files, 'arm64'), { url: 'smartdoc-1.2.3-mac-arm64.zip', sha512: 'armsum==', size: 120 });
    assert.deepEqual(zipFor(files, 'x64'), { url: 'smartdoc-1.2.3-mac-x64.zip', sha512: 'x64sum==', size: 125 });
    assert.equal(zipFor(files, 'ia32'), null);
  });
});

describe('installing', { skip: process.platform !== 'darwin' && 'macOS only (ditto)' }, () => {
  // A release with a stand-in app, zipped the way the release build zips it.
  async function fakeRelease({ corrupt = false } = {}) {
    const work = mkdtempSync(path.join(temp, 'release-'));
    const contents = path.join(work, 'SmartDoc.app', 'Contents');
    mkdirSync(contents, { recursive: true });
    writeFileSync(path.join(contents, 'Info.plist'), '<plist/>');
    const name = `smartdoc-1.2.3-mac-${process.arch}.zip`;
    execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(work, 'SmartDoc.app'), path.join(work, name)]);
    const body = readFileSync(path.join(work, name));
    const sha512 = createHash('sha512').update(corrupt ? 'something else' : body).digest('base64');
    const yml = latest([{ url: name, sha512, size: body.length }]);
    const server = createServer((req, res) => {
      if (req.url === '/latest-mac.yml') return res.end(yml);
      if (req.url === `/${name}`) return res.end(body);
      res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  }

  test('downloads, checks and puts the app in the folder, replacing one there', async () => {
    const release = await fakeRelease();
    const env = { SMARTDOC_DOWNLOADS: release.url };
    const dir = path.join(temp, 'Applications');
    mkdirSync(path.join(dir, 'SmartDoc.app', 'Contents'), { recursive: true });
    writeFileSync(path.join(dir, 'SmartDoc.app', 'Contents', 'old'), 'old version');
    const { version, zip } = await latestRelease({ env });
    assert.equal(version, '1.2.3');
    const seen = [];
    const app = await installRelease(zip, dir, { env, progress: (received, total) => seen.push([received, total]) });
    assert.equal(app, path.join(dir, 'SmartDoc.app'));
    assert.ok(existsSync(path.join(app, 'Contents', 'Info.plist')));
    assert.ok(!existsSync(path.join(app, 'Contents', 'old')));
    assert.equal(seen.at(-1)[0], seen.at(-1)[1]);
    await release.close();
  });

  test('refuses a download that doesn’t match its checksum, leaving the folder alone', async () => {
    const release = await fakeRelease({ corrupt: true });
    const env = { SMARTDOC_DOWNLOADS: release.url };
    const dir = path.join(temp, 'Applications-bad');
    mkdirSync(dir);
    const { zip } = await latestRelease({ env });
    await assert.rejects(installRelease(zip, dir, { env }), /didn’t match/);
    assert.deepEqual(readdirSync(dir), []);
    await release.close();
  });
});
