// @smartdoc/pdf: its readers, and every kind of file converted and read back with pdf.js (the text
// on each page, in order, and the page sizes).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { convert, detect } from '../index.js';
import { parseFont } from '../lib/font.js';
import { METRIC_COMPATIBLE } from '../lib/fonts.js';
import { formatText } from '../lib/numfmt.js';
import { parseXml, textOf, child } from '../lib/xml.js';
import { readZip, writeZip } from '../lib/zip.js';

// The reference PDFs were made on a Mac set to British English: Excel's built-in currency formats
// show £, and its short dates day first.
process.env.LC_ALL = 'en_GB.UTF-8';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjs = await import(path.join(here, '../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs'));

// Each page's size and its text, line by line from the top.
async function readPdf(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      lines.set(y, (lines.get(y) ?? '') + item.str);
    }
    pages.push({ width: page.view[2], height: page.view[3], lines: [...lines].sort((a, b) => b[0] - a[0]).map(([, t]) => t.trim()) });
  }
  return pages;
}

test('zip: what is written reads back', () => {
  const zip = readZip(writeZip({ 'a.txt': 'hello', 'dir/b.xml': '<x>é</x>' }));
  assert.deepEqual(zip.names(), ['a.txt', 'dir/b.xml']);
  assert.equal(zip.text('a.txt'), 'hello');
  assert.equal(zip.text('dir/b.xml'), '<x>é</x>');
});

test('xml: elements, attributes, entities and preserved spaces', () => {
  const root = parseXml('<?xml version="1.0"?><w:p a="1 &amp; 2"><w:t xml:space="preserve"> two  spaces &lt;ok&gt; </w:t><w:br/></w:p>');
  assert.equal(root.name, 'w:p');
  assert.equal(root.attrs.a, '1 & 2');
  assert.equal(textOf(child(root, 'w:t')), ' two  spaces <ok> ');
  assert.ok(child(root, 'w:br'));
});

test('fonts: a bundled stand-in reads, with its kerning, and subsets', () => {
  const font = parseFont(readFileSync(path.join(here, '../fonts/Carlito-Regular.ttf')));
  assert.equal(font.names.family, 'Carlito');
  assert.equal(font.unitsPerEm, 2048);
  const A = font.glyph(65);
  assert.ok(font.advance(A) > 0);
  assert.ok(font.kern(A, font.glyph(86)) < 0, 'A and V kern together');
  const subset = font.subset([A]);
  assert.ok(subset.length < 200000, 'the subset is much smaller than the font');
  assert.equal(parseFont(subset).glyph(65), 0, 'a subset keeps glyph numbers, not the character map');
});

test('detect: by contents, and old Office files are refused plainly', async () => {
  assert.equal(detect(Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(detect(Buffer.from('# Title\n'), 'notes.md'), 'markdown');
  assert.equal(detect(Buffer.from('plain words'), 'notes.txt'), 'text');
  const ole = Buffer.alloc(16);
  ole.writeUInt32BE(0xd0cf11e0, 0);
  await assert.rejects(convert(ole, { name: 'old.doc' }), /save it as a \.docx/);
});

test('a PDF passes straight through', async () => {
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const { pdf, kind } = await convert(bytes, { name: 'a.pdf' });
  assert.equal(kind, 'pdf');
  assert.equal(pdf, bytes);
});

test('Markdown: headings, lists and tables keep their text and order', async () => {
  const { pdf } = await convert(Buffer.from('# Title\n\nSome **bold** text.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'), { name: 'a.md' });
  const [page] = await readPdf(pdf);
  assert.deepEqual(page.lines.map((l) => l.replace(/\s+/g, ' ')), ['Title', 'Some bold text.', '• one', '• two', 'A B', '1 2']);
});

test('text: every line as it is, in a fixed-width font', async () => {
  const { pdf } = await convert(Buffer.from('first line\n\tindented\nlast'), { name: 'a.txt' });
  const [page] = await readPdf(pdf);
  assert.deepEqual(page.lines, ['first line', 'indented', 'last']);
});

const fixtures = path.join(here, 'fixtures/docx');
for (const file of readdirSync(fixtures).filter((f) => f.endsWith('.docx'))) {
  test(`Word: ${file} converts, its text in order`, async () => {
    const { pdf, report } = await convert(readFileSync(path.join(fixtures, file)), { name: file });
    const pages = await readPdf(pdf);
    assert.ok(pages.length >= 1);
    assert.deepEqual(report.missing, [], 'every character has a glyph');
    const text = pages.flatMap((p) => p.lines).join('\n');
    if (file === 'letter.docx') {
      assert.equal(pages[0].width, 595.3);
      assert.match(text, /I am writing to apply for the role of Engineering Lead advertised on your website\./);
    }
    if (file === 'headers.docx') {
      assert.equal(pages[0].lines[0], 'First page header');
      assert.ok(pages.slice(1).every((p, i) => p.lines.at(-1) === `Page ${i + 2} of ${pages.length}`), 'each page after the first is numbered in its footer');
    }
    if (file === 'lists.docx') assert.match(text, /1\.\s*Arrive at nine[\s\S]*a\.\s*Show your badge[\s\S]*i\.\s*Keep it visible[\s\S]*4\.\s*Wait/);
    if (file === 'sections.docx') assert.ok(pages[1].width > pages[1].height, 'the second section is landscape');
    if (file === 'styles.docx') assert.match(text, /Results and discussion\s*\.+\s*12/);
  });
}

// Office's own PDFs of the fixtures (test/fixtures/reference: Word's, Excel's and PowerPoint's,
// made by Office 16.115 for Mac): every line of Office's is in ours, on the same page, broken in the same
// place, within a point of where Office has it. (tools/compare.mjs measures the pages' ink too,
// and LibreOffice's PDFs beside them.)
async function linesAt(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const rows = [];
    for (const item of (await page.getTextContent()).items) {
      if (!item.str.trim()) continue;
      const y = page.view[3] - item.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x: item.transform[4], str: item.str });
    }
    pages.push(rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      return { y: r.y, x: r.items[0].x, text: r.items.map((i) => i.str).join('').replace(/\s+/g, '') };
    }));
  }
  return pages;
}
for (const [app, kind] of [['Word', 'docx'], ['Excel', 'xlsx'], ['PowerPoint', 'pptx']]) {
  const references = path.join(here, 'fixtures/reference', app.toLowerCase());
  for (const file of readdirSync(references).filter((f) => f.endsWith('.pdf'))) {
  const name = file.replace(/\.pdf$/, `.${kind}`);
  test(`${app}: ${name} breaks and places its lines as ${app} does`, async () => {
    const { pdf, report } = await convert(readFileSync(path.join(here, 'fixtures', kind, name)), { name });
    const ours = await linesAt(pdf);
    // Where a font was replaced by one of different widths (Calibri Light by Carlito, without
    // Office's fonts), its lines still break as Office's do, but needn't sit exactly where they do.
    const exact = report.substituted.every((s) => METRIC_COMPATIBLE[s.font.toLowerCase()] === s.by);
    const theirs = await linesAt(readFileSync(path.join(references, file)));
    assert.equal(ours.length, theirs.length, 'as many pages');
    theirs.forEach((lines, p) => {
      const pool = [...ours[p]];
      for (const line of lines) {
        // The nearest of ours with the same text (a line can repeat), each matched once.
        const same = pool.filter((l) => l.text === line.text).sort((a, b) => Math.abs(a.y - line.y) - Math.abs(b.y - line.y));
        const match = same[0];
        if (match) pool.splice(pool.indexOf(match), 1);
        assert.ok(match, `page ${p + 1}: “${line.text.slice(0, 40)}” is a line of ours`);
        // Excel rounds every position to a whole point, so a rounding that goes the other way is a
        // point out, and PowerPoint's lines wander as much either side of their place; Word's are
        // within one.
        const within = kind === 'docx' ? 0.99 : 1.01;
        if (exact) assert.ok(Math.abs(match.y - line.y) <= within && Math.abs(match.x - line.x) <= within, `page ${p + 1}: “${line.text.slice(0, 40)}” at ${match.x.toFixed(2)}, ${match.y.toFixed(2)}, ${app}'s at ${line.x.toFixed(2)}, ${line.y.toFixed(2)}`);
      }
    });
  });
}
}

test('Excel number formats show values as Excel does', () => {
  const cases = [
    [1234.567, 'General', '1234.567'], [1 / 3, 'General', '0.333333333'], [123456789012, 'General', '1.23457E+11'], [-2 / 3, 'General', '-0.666666667'],
    [1234.5, '#,##0.00', '1,234.50'], [-1234.5, '#,##0.00', '-1,234.50'], [0.256, '0.0%', '25.6%'], [12345678, '#,##0,,"M"', '12M'],
    [-42, '#,##0 ;[Red](#,##0)', '(42)'], [0, '0.00;-0.00;"zero"', 'zero'], ['abc', '0;0;0;"["@"]"', '[abc]'],
    [1234.5, '0.00E+00', '1.23E+03'], [12345, '##0.0E+0', '12.3E+3'], [1.25, '# ?/?', '1 1/4'], [2.5, '# ?/8', '2 4/8'],
    [5551234567, '000-000-0000', '555-123-4567'], [7, '000', '007'], [0.5, '#.##', '.5'], [3, '0.0#', '3.0'],
    [45242, 'd mmm yyyy', '12 Nov 2023'], [45242.75, 'dd/mm/yyyy hh:mm', '12/11/2023 18:00'], [45242.75, 'h:mm AM/PM', '6:00 PM'],
    [1.5, '[h]:mm:ss', '36:00:00'], [45242, 'dddd', 'Sunday'], [60, 'yyyy-mm-dd', '1900-02-29'], [61, 'yyyy-mm-dd', '1900-03-01'],
    [1234.5, '#,##0.00 [$€-1]', '1,234.50 €'], [true, 'General', 'TRUE'],
  ];
  for (const [value, code, shown] of cases) assert.equal(formatText(value, code), shown, `${value} as ${code}`);
});

test('PowerPoint: the deck converts a page a slide, hidden slides left out, its text in order', async () => {
  const { pdf, report } = await convert(readFileSync(path.join(here, 'fixtures/pptx/deck.pptx')), { name: 'deck.pptx' });
  const pages = await readPdf(pdf);
  assert.equal(pages.length, 6, 'six slides shown, the hidden one left out');
  assert.equal(Math.round(pages[0].width), 960);
  assert.equal(Math.round(pages[0].height), 540);
  assert.deepEqual(report.missing, [], 'every character has a glyph');
  const text = pages.map((p) => p.lines.join('\n'));
  assert.match(text[0], /Quarterly review[\s\S]*Prepared for the board/);
  assert.match(text[1], /What we found[\s\S]*Revenue grew[\s\S]*North led[\s\S]*Most came through partners[\s\S]*Next: expand/);
  assert.match(text[2], /Rectangle[\s\S]*Ellipse/);
  assert.match(text[4], /Region\s*Q1\s*Q2[\s\S]*North\s*£1,200\s*£1,450/);
  assert.match(text[5], /1\.\s*First numbered step[\s\S]*2\.\s*Second[\s\S]*3\.\s*Third/);
  assert.ok(!text.join('\n').includes('Hidden slide'));
});
