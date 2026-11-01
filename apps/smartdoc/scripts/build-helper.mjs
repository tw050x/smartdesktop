// Builds the launcher's download window (packages/mcp/helper/download-window.swift) into
// packages/mcp/lib/download-window, one program for both kinds of Mac. It needs a Mac with
// Xcode's command line tools. The release workflow signs and notarises it; built locally it's
// signed ad hoc, which is enough to run it on this Mac. Without it the launcher still works, with
// no window.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mcp = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/mcp');
const source = path.join(mcp, 'helper', 'download-window.swift');
const out = path.join(mcp, 'lib', 'download-window');
const work = mkdtempSync(path.join(os.tmpdir(), 'smartdoc-helper-'));

try {
  const builds = ['arm64', 'x86_64'].map((arch) => {
    const file = path.join(work, arch);
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos12`, source, '-o', file], { stdio: 'inherit' });
    return file;
  });
  execFileSync('lipo', ['-create', ...builds, '-output', out]);
  execFileSync('codesign', ['--force', '--sign', '-', out]);
  console.log(`Built ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
