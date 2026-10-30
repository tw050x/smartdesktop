// Packs the MCP package into dist/smartdoc.mcpb, the bundle Claude Desktop installs. The bundle
// holds mcpb/manifest.json and packages/mcp (as server/), which opens the app and talks to it.
// The file name carries no version, so the website can always link to the latest release's copy.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'dist', 'mcpb');
const out = path.join(root, 'dist', 'smartdoc.mcpb');
const mcpb = path.join(root, 'node_modules', '.bin', 'mcpb');

rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'server'), { recursive: true });
cpSync(path.join(root, 'mcpb', 'manifest.json'), path.join(stage, 'manifest.json'));
for (const entry of ['index.js', 'lib', 'package.json']) {
  cpSync(path.join(root, 'packages', 'mcp', entry), path.join(stage, 'server', entry), { recursive: true });
}

execFileSync(mcpb, ['validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
rmSync(out, { force: true });
execFileSync(mcpb, ['pack', stage, out], { stdio: 'inherit' });
