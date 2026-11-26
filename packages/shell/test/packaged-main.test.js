import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An app's main process loads main/ from this package as it's packaged with the app; renderer/ is
// only bundled into its pages by Vite. So nothing in main/ may load a file outside main/ (as an
// app's own main process may load nothing outside its src/main: SmartDoc 0.20.2 and 0.20.3 crashed
// on launch from such an import).
const MAIN = fileURLToPath(new URL('../main/', import.meta.url));

test('main/ imports only files in main/', () => {
  const outside = [];
  for (const name of readdirSync(MAIN).filter((file) => /\.(m|c)?js$/.test(file))) {
    const source = readFileSync(path.join(MAIN, name), 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)].map((match) => match[1]);
    for (const specifier of specifiers) {
      const target = path.resolve(MAIN, specifier);
      if (!target.startsWith(MAIN) || !existsSync(target)) outside.push(`${name} → ${specifier}`);
    }
  }
  assert.deepEqual(outside, []);
});
