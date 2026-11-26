import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestRelease, pickAssets, sumFor } from '../main/install-desktop.js';

const release = (tag, published, more = {}) => ({ tag_name: tag, published_at: published, draft: false, prerelease: false, assets: [{ name: `smartdesktop-${tag}-mac-arm64.zip`, browser_download_url: `https://x/${tag}`, size: 10 }], ...more });

test('the latest SmartDesktop release among the family’s, by its tag', async () => {
  const fetcher = async (url) => ({ ok: true, json: async () => (assert.match(url, /repos\/tw050x\/smartdesktop\/releases/), [
    release('smartdoc-v0.21.0', '2026-12-03'),
    release('smartdesktop-v0.3.0', '2026-12-01'),
    release('smartdesktop-v0.4.0', '2026-12-02', { draft: true }),
    release('smartdesktop-v0.3.1', '2026-12-02', { prerelease: true }),
    release('smartdesktop-v0.2.0', '2026-11-30'),
  ]) });
  const newest = await latestRelease({ repo: 'tw050x/smartdesktop', prefix: 'smartdesktop-v' }, fetcher);
  assert.equal(newest.version, '0.3.0');
  await assert.rejects(latestRelease({ repo: 'tw050x/smartdesktop', prefix: 'smartnothing-v' }, fetcher), /No SmartDesktop release/);
});

test('the zip for this Mac, and its checksum', () => {
  const assets = [{ name: 'smartdesktop-0.3.0-mac-arm64.zip' }, { name: 'smartdesktop-0.3.0-mac-x64.zip' }, { name: 'SmartDesktop-mac-arm64.dmg' }, { name: 'SHA256SUMS.txt' }];
  assert.equal(pickAssets(assets, 'arm64').zip.name, 'smartdesktop-0.3.0-mac-arm64.zip');
  assert.equal(pickAssets(assets, 'x64').zip.name, 'smartdesktop-0.3.0-mac-x64.zip');
  assert.throws(() => pickAssets(assets.slice(0, 3), 'arm64'), /SHA256SUMS/);
  const sums = `${'a'.repeat(64)}  smartdesktop-0.3.0-mac-arm64.zip\n${'B'.repeat(64)} *smartdesktop-0.3.0-mac-x64.zip\n`;
  assert.equal(sumFor(sums, 'smartdesktop-0.3.0-mac-arm64.zip'), 'a'.repeat(64));
  assert.equal(sumFor(sums, 'smartdesktop-0.3.0-mac-x64.zip'), 'b'.repeat(64));
  assert.equal(sumFor(sums, 'other.zip'), null);
});
