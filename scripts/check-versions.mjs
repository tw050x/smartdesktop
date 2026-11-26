// node scripts/check-versions.mjs: every app on the family's one version (scripts/set-version.mjs),
// each app's packages on it too where they move with it. Prerequisites runs it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apps = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps');
const versions = new Map();
for (const app of readdirSync(apps).sort()) {
  const file = path.join(apps, app, 'packages/app/package.json');
  if (existsSync(file)) versions.set(app, JSON.parse(readFileSync(file, 'utf8')).version);
}
const all = new Set(versions.values());
if (all.size !== 1) {
  console.error(`The apps aren't on one version: ${[...versions].map(([app, v]) => `${app} ${v}`).join(', ')}. Set it with node scripts/set-version.mjs <version>.`);
  process.exit(1);
}
console.log(`Every app is at ${[...all][0]}: ${[...versions.keys()].join(', ')}`);
