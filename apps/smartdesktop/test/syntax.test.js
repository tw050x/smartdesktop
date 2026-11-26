import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The main process's files load only in Electron, so no other test reads them all: each is at least
// checked to parse (a stray apostrophe in main.js's chat instructions once stopped SmartDesktop
// starting, with every test passing).
const main = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/app/src/main');

test('every main-process file parses', () => {
  for (const file of readdirSync(main).filter((name) => /\.(js|mjs)$/.test(name))) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(main, file)], { stdio: 'pipe' }), file);
  }
});
