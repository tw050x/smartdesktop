// @smartdoc/pdf's PDF reader (read/): its decompression and ciphers against Node's own, a Type 1
// font program read back, and each page's text against pdf.js's for every reference PDF and every
// document the converter makes (stored review positions are offsets into that text, so it must
// come out the same).
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { convert } from '../index.js';
import { PdfDocument } from '../read/document.js';
import { aesDecrypt, md5, sha256, sha384, sha512 } from '../read/hash.js';
import { inflate, inflateRaw } from '../read/inflate.js';
import { decodeCCITT } from '../read/ccitt.js';
import { readOperators } from '../read/content.js';
import { drawingFont } from '../read/drawfont.js';
import { loadTextFont } from '../read/font.js';
import { TrueTypeOutlines } from '../read/glyphs.js';
import { readCmap, readSfnt } from '../read/sfnt.js';
import { getTextContent, pageText } from '../read/text.js';
import { decrypt, parseType1, type1Width } from '../read/type1.js';
import { getDocument } from '../read/viewer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjs = await import(path.join(here, '../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs'));

test('inflate: what zlib deflates comes back, and a stream cut short is marked damaged', () => {
  for (const size of [0, 1, 100, 5000, 70000]) {
    const data = Buffer.concat([randomBytes(size), Buffer.alloc(size, 'a'), Buffer.from('end of the stream '.repeat(size % 97))]);
    for (const level of [0, 1, 9]) {
      const z = deflateSync(data, { level });
      assert.deepEqual(Buffer.from(inflate(new Uint8Array(z))), data);
      assert.equal(inflate(new Uint8Array(z)).damaged, undefined);
      assert.deepEqual(Buffer.from(inflateRaw(new Uint8Array(deflateRawSync(data, { level })))), data);
    }
  }
  const z = deflateSync(Buffer.from('x'.repeat(3000) + 'abc'.repeat(3000)), { level: 9 });
  const cut = inflate(new Uint8Array(z.subarray(0, z.length - 20)));
  assert.equal(cut.damaged, true);
  assert.ok(cut.complete <= cut.length);
});

test('hashes and AES match Node crypto', () => {
  for (const size of [0, 3, 55, 56, 64, 119, 1000]) {
    const data = randomBytes(size);
    for (const [ours, name] of [[md5, 'md5'], [sha256, 'sha256'], [sha384, 'sha384'], [sha512, 'sha512']]) {
      assert.equal(Buffer.from(ours(new Uint8Array(data))).toString('hex'), createHash(name).update(data).digest('hex'), `${name} of ${size} bytes`);
    }
  }
  for (const bits of [128, 256]) {
    const key = randomBytes(bits / 8);
    const iv = randomBytes(16);
    const plain = randomBytes(77);
    const c = createCipheriv(`aes-${bits}-cbc`, key, iv);
    const encrypted = Buffer.concat([iv, c.update(plain), c.final()]);
    assert.deepEqual(Buffer.from(aesDecrypt(new Uint8Array(key), new Uint8Array(encrypted))), plain);
  }
});

// Type 1 encryption (the inverse of read/type1.js's decrypt), for making a font to read back.
function encrypt(data, key, prefix) {
  let r = key;
  const out = new Uint8Array(prefix.length + data.length);
  [...prefix, ...data].forEach((p, i) => {
    const c = p ^ (r >> 8);
    out[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xffff;
  });
  return out;
}

test('a Type 1 font program: its encoding, matrix, and glyph widths from hsbw', () => {
  const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  // Charstrings: "0 450 hsbw endchar" and "20 600 hsbw endchar" (numbers as v + 139).
  const width450 = Uint8Array.of(139, 247 + 1, 450 - 108 - 256, 13, 14);
  const width600 = Uint8Array.of(139 + 20, 247 + 1, 600 - 108 - 256, 13, 14);
  const cs = (glyph) => encrypt(glyph, 4330, [0, 0, 0, 0]);
  const parts = [ascii('dup /Private 8 dict dup begin /lenIV 4 def /Subrs 0 array\n2 index /CharStrings 3 dict dup begin\n')];
  for (const [name, glyph] of [['.notdef', width450], ['A', width600], ['B', width450]]) {
    const enc = cs(glyph);
    parts.push(ascii(`/${name} ${enc.length} RD `), enc, ascii(' ND\n'));
  }
  parts.push(ascii('end\nend\nmark currentfile closefile\n'));
  const program = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (program.set(p, at), at + p.length), 0);
  const header = ascii('%!PS-AdobeFont-1.0: Test 001\n/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\ndup 65 /A put\ndup 66 /B put\nreadonly def\ncurrentfile eexec\n');
  const eexec = encrypt(program, 55665, [1, 2, 3, 4]);
  const file = new Uint8Array(header.length + eexec.length);
  file.set(header);
  file.set(eexec, header.length);

  assert.deepEqual([...decrypt(eexec, 55665, 4)], [...program]);
  const font = parseType1(file, { length1: header.length });
  assert.deepEqual(font.fontMatrix, [0.001, 0, 0, 0.001, 0, 0]);
  assert.equal(font.encoding[65], 'A');
  assert.equal(font.encoding[66], 'B');
  assert.deepEqual(font.charstrings.map((c) => c.name), ['.notdef', 'A', 'B']);
  assert.deepEqual(font.charstrings.map((c) => type1Width(c.encoded, font.subrs)), [450, 600, 450]);
  // A wrong Length1 is put right by finding eexec.
  assert.equal(parseType1(file, { length1: 10 }).encoding[65], 'A');
});

async function pdfjsTexts(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  const texts = [];
  for (let p = 1; p <= doc.numPages; p++) texts.push(pageText((await (await doc.getPage(p)).getTextContent()).items));
  await task.destroy();
  return texts;
}

const ourTexts = (bytes) => new PdfDocument(new Uint8Array(bytes)).pages.map((page) => pageText(getTextContent(page).items));

test("each page's text is pdf.js's: the reference PDFs (Office's and LibreOffice's)", async () => {
  const dir = path.join(here, 'fixtures/reference');
  const files = readdirSync(dir).flatMap((d) => (d.endsWith('.md') ? [] : readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.pdf')).map((f) => path.join(dir, d, f))));
  assert.ok(files.length > 10);
  for (const f of files) {
    const bytes = readFileSync(f);
    assert.deepEqual(ourTexts(bytes), await pdfjsTexts(bytes), path.relative(dir, f));
  }
});

test("each page's text is pdf.js's: every test document, converted", async () => {
  const dir = path.join(here, 'fixtures');
  for (const kind of ['docx', 'xlsx', 'pptx']) {
    for (const f of readdirSync(path.join(dir, kind)).filter((n) => n.endsWith(`.${kind}`))) {
      const { pdf } = await convert(readFileSync(path.join(dir, kind, f)), { name: f });
      assert.deepEqual(ourTexts(pdf), await pdfjsTexts(pdf), `${kind}/${f}`);
    }
  }
});

test("the viewer's API, where there are no workers (Node): read here, the same pages and text", async () => {
  const dir = path.join(here, 'fixtures/reference');
  const file = readdirSync(dir, { recursive: true }).find((f) => f.endsWith('.pdf'));
  const bytes = new Uint8Array(readFileSync(path.join(dir, file)));
  const doc = new PdfDocument(bytes);
  const task = getDocument({ data: bytes });
  const pdf = await task.promise;
  assert.equal(pdf.numPages, doc.pages.length);
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    assert.equal(page.reader, 'smartdoc');
    assert.equal(pageText((await page.getTextContent()).items), pageText(getTextContent(doc.pages[n - 1]).items));
    const vp = page.getViewport({ scale: 2 });
    const [x0, y0, x1, y1] = doc.pages[n - 1].view;
    assert.deepEqual(vp.rawDims, { pageWidth: x1 - x0, pageHeight: y1 - y0, pageX: x0, pageY: y0 });
  }
  await task.destroy();
});

test('glyph outlines: every character shown on the reference pages has one, from its embedded font', () => {
  const dir = path.join(here, 'fixtures/reference');
  let checked = 0;
  for (const d of readdirSync(dir).filter((x) => !x.endsWith('.md'))) {
    for (const f of readdirSync(path.join(dir, d)).filter((x) => x.endsWith('.pdf'))) {
      const doc = new PdfDocument(new Uint8Array(readFileSync(path.join(dir, d, f))));
      for (const page of doc.pages) {
        let font = null;
        const show = (str) => {
          if (!font || typeof str !== 'string') return;
          for (const glyph of font.glyphs(str)) {
            if (!glyph.unicode.trim()) continue;
            const g = drawingFont(font).glyph(glyph.originalCharCode);
            assert.ok(g.cmds?.length, `${d}/${f}: no outline for ${JSON.stringify(glyph.unicode)} in ${font.name}`);
            checked++;
          }
        };
        readOperators(page.contents(), (op, a) => {
          if (op === 'Tf') {
            const ref = page.resources.dict('Font')?.raw(a[0]?.name);
            font = ref ? loadTextFont(doc, ref) : null;
            if (font?.missingFile) font = null;
          } else if (op === 'Tj' || op === "'") show(a[0]);
          else if (op === 'TJ' && Array.isArray(a[0])) a[0].forEach(show);
        });
      }
    }
  }
  assert.ok(checked > 1000, `only ${checked} glyphs checked`);
});

test('glyph outlines: a bundled TrueType font', () => {
  const sfnt = readSfnt(new Uint8Array(readFileSync(path.join(here, '../fonts/LiberationSans-Regular.ttf'))));
  const outlines = new TrueTypeOutlines(sfnt.tables);
  const cmap = readCmap(sfnt.tables.cmap, false, true).mappings;
  const a = outlines.outline(cmap.get(0x41));
  assert.equal(a[0][0], 'M');
  // Every point of "A" within its em square, and its outline closed.
  for (const [, ...v] of a) for (const n of v) assert.ok(n > -0.1 && n < 1.1);
  assert.ok(a.some((c) => c[0] === 'Z'));
  // A composite glyph (Aacute: A and an accent) has both contours.
  const aacute = outlines.outline(cmap.get(0xc1));
  assert.ok(aacute.filter((c) => c[0] === 'M').length > a.filter((c) => c[0] === 'M').length);
});

test('CCITT Group 4: random images through an encoder written from T.6 come back as they were', () => {
  const src = readFileSync(path.join(here, '../read/ccitt.js'), 'utf8');
  const grab = (name) => JSON.parse(src.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))[1].replace(/'/g, '"'));
  const [WT, WM, BT, BM, EM] = ['WHITE_TERMINATING', 'WHITE_MAKEUP', 'BLACK_TERMINATING', 'BLACK_MAKEUP', 'EXTENDED_MAKEUP'].map(grab);
  const runCode = (n, white) => {
    let s = '';
    while (n >= 2624) {
      s += EM[12];
      n -= 2560;
    }
    if (n >= 64) {
      const m = Math.floor(n / 64);
      s += m <= 27 ? (white ? WM : BM)[m - 1] : EM[m - 28];
      n -= m * 64;
    }
    return s + (white ? WT : BT)[n];
  };
  const V = { 0: '1', 1: '011', 2: '000011', 3: '0000011', '-1': '010', '-2': '000010', '-3': '0000010' };
  const encode = (img, w) => {
    let bits = '';
    let ref = [w, w];
    for (const row of img) {
      const next = (from, col) => {
        for (let x = Math.max(from, 0); x < w; x++) if (row[x] !== col) return x;
        return w;
      };
      let a0 = -1;
      let color = 0;
      while (a0 < w) {
        const a1 = next(a0 < 0 ? 0 : a0, color);
        let i = 0;
        while (i < ref.length && (ref[i] <= a0 || (i & 1) !== color)) i++;
        const b1 = ref[i] ?? w;
        const b2 = ref[i + 1] ?? w;
        if (b2 < a1) {
          bits += '0001';
          a0 = b2;
        } else if (Math.abs(a1 - b1) <= 3) {
          bits += V[a1 - b1];
          a0 = a1;
          color ^= 1;
        } else {
          const a2 = next(a1, color ^ 1);
          bits += '001' + runCode(a1 - Math.max(a0, 0), color === 0) + runCode(a2 - a1, color !== 0);
          a0 = a2;
        }
      }
      const changes = [];
      for (let x = 0, c = 0; x < w; x++) if (row[x] !== c) {
        changes.push(x);
        c = row[x];
      }
      ref = [...changes, w, w];
    }
    bits += '000000000001000000000001';
    while (bits.length % 8) bits += '0';
    return Uint8Array.from(bits.match(/.{8}/g), (b) => parseInt(b, 2));
  };
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0; t < 100; t++) {
    const w = 1 + Math.floor(random() * 3000);
    const h = 1 + Math.floor(random() * 20);
    const img = [];
    for (let y = 0; y < h; y++) {
      const r = new Uint8Array(w);
      let c = random() < 0.5 ? 1 : 0;
      for (let x = 0; x < w; x++) {
        if (random() < 0.05) c ^= 1;
        r[x] = y > 0 && random() < 0.6 ? img[y - 1][x] : c;
      }
      img.push(r);
    }
    const out = decodeCCITT(encode(img, w), { get: (k) => ({ K: -1, Columns: w, Rows: h })[k] }, w, h);
    const rb = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.equal((out.data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1, img[y][x] ? 0 : 1, `image ${t} (${w}×${h}) at ${x}, ${y}`);
  }
});
