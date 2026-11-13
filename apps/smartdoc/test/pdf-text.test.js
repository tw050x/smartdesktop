// The main process reads a draft's page texts and details itself (pdf-text.js), with no window, so
// they must be what the window gives: each page's text as its text layer has it, and the PDF's
// details and outline as pdfDetails in app-shell.js makes them from pdf.js. Checked against pdf.js
// on the reference PDFs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPdfText } from '../packages/app/src/main/pdf-text.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readDir = path.join(here, '../packages/pdf/read');
const pdfjs = await import(path.join(here, '../node_modules/pdfjs-dist/legacy/build/pdf.mjs'));

// What the window reports for a PDF, made the way it makes it (pageModel in anchors.js, pdfDetails
// in app-shell.js), from pdf.js.
async function fromPdfjs(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  const texts = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    let text = '';
    for (const item of (await (await pdf.getPage(n)).getTextContent()).items) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    texts.push(text);
  }
  const info = {};
  const { info: raw } = await pdf.getMetadata();
  for (const [key, name] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Creator', 'createdWith'], ['Producer', 'producer']]) {
    if (typeof raw?.[key] === 'string' && raw[key].trim()) info[name] = raw[key].trim();
  }
  for (const [key, name] of [['CreationDate', 'created'], ['ModDate', 'modified']]) {
    const match = typeof raw?.[key] === 'string' && raw[key].match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?/);
    if (match) info[name] = [match[1], match[2] ?? '01', match[3] ?? '01'].join('-');
  }
  const outline = [];
  const walk = async (items, level) => {
    for (const item of items ?? []) {
      let page = null;
      try {
        const explicit = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        page = Array.isArray(explicit) ? (await pdf.getPageIndex(explicit[0])) + 1 : null;
      } catch {}
      outline.push({ title: item.title, page, level });
      await walk(item.items, level + 1);
    }
  };
  await walk(await pdf.getOutline(), 1);
  await task.destroy();
  return { texts, details: { info, outline } };
}

test('the main process reads page texts and details as the window gives them, with no window', async () => {
  const dir = path.join(here, '../packages/pdf/test/fixtures/reference');
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.pdf')).map((f) => path.join(dir, f));
  assert.ok(files.length > 10);
  let outlines = 0;
  for (const file of files) {
    const ours = await readPdfText(file, readDir);
    const theirs = await fromPdfjs(readFileSync(file));
    assert.deepEqual(ours, theirs, path.relative(dir, file));
    if (ours.details.outline.length) outlines++;
  }
  assert.ok(outlines > 0, 'some reference PDF has an outline');
});

test('a file that isn’t a PDF is refused, not hung on', async () => {
  await assert.rejects(readPdfText(fileURLToPath(import.meta.url), readDir));
});
