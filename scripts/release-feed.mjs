// node scripts/release-feed.mjs <latest-mac.yml> <app> <version> [repo]: prints the app's update feed,
// the latest-mac.yml electron-builder wrote with each file named by its whole address in the
// version's own release (<repo>/releases/download/<app>-v<version>/<file>). The release workflow
// puts it in the app's feed release, <app>-updates, which the app's updater and its CLI's install
// read (the family's apps share one repo, whose single "latest" release can't be every app's).
import { readFileSync } from 'node:fs';

const [file, app, version, repo = 'tw050x/smartdesktop'] = process.argv.slice(2);
if (!file || !app || !version) {
  console.error('usage: release-feed.mjs <latest-mac.yml> <app> <version> [repo]');
  process.exit(2);
}
const base = `https://github.com/${repo}/releases/download/${app}-v${version}`;
const text = readFileSync(file, 'utf8');
const written = text.replace(/^(\s*-\s+url:\s*|path:\s*)'?([^'\s]+)'?\s*$/gm, (_line, key, name) => (/^https?:/.test(name) ? `${key}${name}` : `${key}${base}/${name}`));
if (!/^version:\s*/m.test(written) || !written.includes(base)) {
  console.error(`${file} doesn't look like electron-builder's latest-mac.yml`);
  process.exit(1);
}
process.stdout.write(written);
