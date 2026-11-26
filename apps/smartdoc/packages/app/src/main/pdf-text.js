// A PDF's text and details, read here in the main process by SmartDoc's own reader (@smartdoc/pdf's
// read/), with no window: each page's text as the window's text layer has it (its items joined in
// order, a newline after each that ends a line; read/text.js gives pdf.js's items exactly), and the
// PDF's own details and outline, as the window reports them (see pdfDetails in app-shell.js). So the
// AI can read a document the moment it opens, before (or without) the window drawing it.
//
// Read on a thread of its own, so a long or damaged PDF never holds up the app; the reader is
// loaded from `readDir`, the package's read/ folder (main.js gives it: in the app's resources once
// packaged, outside its archive).
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const OUTLINE_LIMIT = 300;
const TIME_LIMIT_MS = 60 * 1000;

// The thread: reads the file, then answers with { texts, details } or { error }.
const THREAD = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
(async () => {
  try {
    const { PdfDocument } = await import(workerData.dir + '/document.js');
    const { getTextContent } = await import(workerData.dir + '/text.js');
    const doc = new PdfDocument(new Uint8Array(await readFile(workerData.file)));
    const texts = [];
    for (const page of doc.pages) {
      const { items } = await getTextContent(page);
      let text = '';
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        if (item.hasEOL) text += '\\n';
      }
      texts.push(text);
    }
    let info = {};
    let outline = [];
    try { info = doc.info(); } catch {}
    try { outline = doc.outline(); } catch {}
    parentPort.postMessage({ texts, info, outline });
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message ?? error) });
  }
})();
`;

export function readPdfText(file, readDir) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(THREAD, { eval: true, workerData: { file, dir: pathToFileURL(readDir).href } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Reading the PDF took too long.'));
    }, TIME_LIMIT_MS);
    worker.once('message', (m) => {
      clearTimeout(timer);
      worker.terminate();
      if (m.error) return reject(new Error(m.error));
      resolve({ texts: m.texts, details: { info: detailsOf(m.info), outline: flatOutline(m.outline) } });
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// As the window gives them (pdfDetails in app-shell.js): title, author, subject, the app that made
// it and the one that wrote the PDF, and the dates it was made and changed, as YYYY-MM-DD.
function detailsOf(raw = {}) {
  const info = {};
  for (const [key, name] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Creator', 'createdWith'], ['Producer', 'producer']]) {
    if (typeof raw[key] === 'string' && raw[key].trim()) info[name] = raw[key].trim();
  }
  for (const [key, name] of [['CreationDate', 'created'], ['ModDate', 'modified']]) {
    const match = typeof raw[key] === 'string' && raw[key].match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?/);
    if (match) info[name] = [match[1], match[2] ?? '01', match[3] ?? '01'].join('-');
  }
  return info;
}

// The outline as [{ title, page (1-based, or null), level }], in order, as the window gives it.
function flatOutline(items) {
  const out = [];
  const walk = (list, level) => {
    for (const item of list ?? []) {
      if (out.length >= OUTLINE_LIMIT) return;
      out.push({ title: item.title, page: item.page === null ? null : item.page + 1, level });
      walk(item.items, level + 1);
    }
  };
  walk(items, 1);
  return out;
}
