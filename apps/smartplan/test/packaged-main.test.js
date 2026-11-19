import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The packaged app holds only src/main and the built renderer (package.json's build.files), so the
// main process must never load a file from elsewhere in the source: SmartDoc 0.20.2 and 0.20.3
// imported ../renderer/home-review-state.js and crashed on launch, though it ran in development.
const MAIN = fileURLToPath(new URL('../packages/app/src/main/', import.meta.url));

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(m|c)?js$/.test(name) ? [full] : [];
  });
}

test('the main process imports only files that are packaged with it', () => {
  const outside = [];
  for (const file of files(MAIN)) {
    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)].map((match) => match[1]);
    for (const specifier of specifiers) {
      const target = path.resolve(path.dirname(file), specifier);
      if (!target.startsWith(MAIN) || !existsSync(target)) outside.push(`${path.relative(MAIN, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(outside, []);
});
