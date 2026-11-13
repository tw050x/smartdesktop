// The reader in a worker (see viewer.js), so reading and drawing a PDF never holds up the page:
// it keeps each document opened in it, draws a page on a canvas of its own and sends the picture
// back (an ImageBitmap, moved rather than copied), and gives a page's text, the document's info,
// outline and destinations. Bundled fonts' bytes are asked of the page that opened the document
// (`font`), which has them.
import { PdfDocument } from './document.js';
import { renderPage } from './render.js';
import { getTextContent } from './text.js';

const docs = new Map(); // id → { doc, fonts }
const waiting = new Map(); // font request id → resolve
let next = 0;

function fontsFor(docId) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      cache.set(file, new Promise((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        self.postMessage({ font: id, doc: docId, file });
      }));
    }
    return cache.get(file);
  };
}

const page = (docId, n) => {
  const entry = docs.get(docId);
  if (!entry) throw new Error('document closed');
  const p = entry.doc.pages[n - 1];
  if (!p) throw new Error(`no page ${n}`);
  return { entry, p };
};

const handlers = {
  open({ doc: id, data, password, fonts }) {
    const doc = new PdfDocument(new Uint8Array(data), { password });
    docs.set(id, { doc, fonts: fonts ? fontsFor(id) : null });
    return { numPages: doc.pages.length };
  },
  close({ doc }) {
    docs.delete(doc);
  },
  page({ doc, n }) {
    const { p } = page(doc, n);
    return { view: p.view, rotate: p.rotate, index: p.index };
  },
  async render({ doc, n, width, height, scale }) {
    const { entry, p } = page(doc, n);
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    await renderPage(p, canvas.getContext('2d'), { scale, fonts: entry.fonts });
    const bitmap = canvas.transferToImageBitmap();
    return { value: bitmap, transfer: [bitmap] };
  },
  text({ doc, n }) {
    return getTextContent(page(doc, n).p);
  },
  info({ doc }) {
    return docs.get(doc)?.doc.info() ?? {};
  },
  outline({ doc }) {
    return docs.get(doc)?.doc.outline() ?? [];
  },
  destination({ doc, dest }) {
    return docs.get(doc)?.doc.destinationPage(dest) ?? null;
  },
};

self.onmessage = async ({ data: message }) => {
  if (message.fontReply) {
    waiting.get(message.fontReply)?.(message.bytes ? new Uint8Array(message.bytes) : null);
    waiting.delete(message.fontReply);
    return;
  }
  const { id, type } = message;
  try {
    const result = await handlers[type](message);
    if (type === 'render') self.postMessage({ id, ok: true, value: result.value }, result.transfer);
    else self.postMessage({ id, ok: true, value: result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message ?? String(error) });
  }
};
