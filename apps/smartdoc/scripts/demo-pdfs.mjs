// Draws the website demo's fictional CV (packages/app/src/renderer/demo/cv-*.html) to PDF with
// Chrome, next to its sources. Run it after changing them: node scripts/demo-pdfs.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/app/src/renderer/demo');

for (const file of readdirSync(dir).filter((f) => /^cv-.*\.html$/.test(f))) {
  const out = path.join(dir, file.replace(/\.html$/, '.pdf'));
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, pathToFileURL(path.join(dir, file)).href], { stdio: 'ignore' });
  console.log('wrote', path.relative(process.cwd(), out));
}
