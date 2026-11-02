// Makes the app's icons from packages/app/resources/icon.svg: icon.png (1024 pixels, for Windows
// and Linux) and icon.icns (every size macOS uses), beside it. Draws the SVG with headless Chrome
// (for its filters and gradients), then sizes it with macOS's sips and iconutil, so it runs on a
// Mac with Chrome installed. Run with `node scripts/make-icons.mjs` after changing icon.svg.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/app/resources');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const work = mkdtempSync(path.join(os.tmpdir(), 'smartdoc-icons-'));

try {
  // The SVG alone on a transparent page, at its full size.
  const page = path.join(work, 'icon.html');
  writeFileSync(page, `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img src="file://${path.join(dir, 'icon.svg')}" width="1024" height="1024">`);
  const png = path.join(dir, 'icon.png');
  execFileSync(chrome, ['--headless=new', '--hide-scrollbars', '--default-background-color=00000000', '--window-size=1024,1024', `--screenshot=${png}`, `file://${page}`], { stdio: 'ignore' });

  // Every size an .icns holds, at 1x and 2x.
  const set = path.join(work, 'icon.iconset');
  execFileSync('mkdir', [set]);
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(dir, 'icon.icns')]);
  console.log(`Made ${path.join(dir, 'icon.png')} and icon.icns`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
