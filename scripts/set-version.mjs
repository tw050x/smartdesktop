// node scripts/set-version.mjs <version>: sets the family's version, which every app releases at
// (the user's choice, 2026-11-26: one version, every app released together, so whatever's installed
// was released together). In each app: its package.json, its packages/app, and each of its packages
// on the app's version (its CLI, SmartDoc's PDF converter; a package with a version of its own, as
// SmartSpec's runner, is left as it is), and the same in its package-lock.json.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('usage: set-version.mjs <version> (as 0.27.0)');
  process.exit(2);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = path.join(root, 'apps');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, json) => writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);

for (const app of readdirSync(apps).sort()) {
  const top = path.join(apps, app, 'package.json');
  if (!existsSync(top)) continue;
  const was = read(path.join(apps, app, 'packages/app/package.json')).version;
  const moved = [''];
  for (const name of readdirSync(path.join(apps, app, 'packages'))) {
    const file = path.join(apps, app, 'packages', name, 'package.json');
    if (!existsSync(file)) continue;
    const json = read(file);
    if (name !== 'app' && json.version !== was) continue;
    json.version = version;
    write(file, json);
    moved.push(`packages/${name}`);
  }
  const json = read(top);
  json.version = version;
  write(top, json);
  const lockFile = path.join(apps, app, 'package-lock.json');
  if (existsSync(lockFile)) {
    const lock = read(lockFile);
    lock.version = version;
    for (const key of moved) if (lock.packages?.[key]) lock.packages[key].version = version;
    write(lockFile, lock);
  }
  console.log(`${app}: ${was} → ${version} (${moved.map((one) => one || 'its package.json').join(', ')})`);
}
