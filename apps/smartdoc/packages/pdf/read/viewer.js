// The reader behind the small part of pdf.js's API a viewer uses, so either can be used the same
// way: getDocument({ data }) gives a task whose promise is a document (numPages, getPage(n),
// getMetadata(), getOutline(), getDestination(), getPageIndex()), and a page has getViewport({
// scale }), render({ canvas, viewport, transform }) and getTextContent(). `fonts(file)` gives the
// bundled fonts' bytes (fonts/*.ttf, or a promise of them) for fonts that aren't embedded.
//
// In a browser the documents are read and drawn in a worker (worker.js), one for them all, so a
// long document never holds up the page: each page is drawn there and its picture drawn on the
// canvas given. Where there are no workers (Node), or the worker can't start, they're read here.

import { PdfDocument } from './document.js';
import { renderPage, viewport as pageViewport } from './render.js';
import { getTextContent } from './text.js';

export { renderTextLayer } from './text-layer.js';

export function getDocument({ data, password = '', fonts = null, worker = true }) {
  let destroyed = false;
  let opened = null;
  const promise = (async () => {
    // A copy: the caller may hand the same bytes on elsewhere (and the worker is given this one).
    const bytes = new Uint8Array(data);
    const client = worker ? workerClient() : null;
    if (client) {
      try {
        opened = await WorkerDocument.open(client, bytes.slice(), password, fonts);
        if (destroyed) opened.destroy();
        return opened;
      } catch (error) {
        if (!client.broken) throw error; // the PDF itself (a wrong password, say)
      }
    }
    return new DocumentProxy(new PdfDocument(bytes, { password }), fonts);
  })();
  return {
    promise,
    destroy: async () => {
      destroyed = true;
      opened?.destroy();
    },
  };
}

// --- In a worker ----------------------------------------------------------------------------

let shared = null;
function workerClient() {
  if (shared && !shared.broken) return shared;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  let w;
  try {
    w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  const pending = new Map();
  const fontSources = new Map(); // document id → its fonts(file)
  let next = 0;
  const client = {
    broken: false,
    fontSources,
    call(type, message = {}, transfer = []) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ ...message, id, type }, transfer);
      });
    },
  };
  w.onmessage = async ({ data: m }) => {
    if (m.font) {
      // The worker asks for a bundled font's bytes, which only this side can get.
      let bytes = null;
      try {
        bytes = (await fontSources.get(m.doc)?.(m.file)) ?? null;
      } catch {
        bytes = null;
      }
      const copy = bytes ? new Uint8Array(bytes).slice() : null;
      w.postMessage({ fontReply: m.font, bytes: copy }, copy ? [copy.buffer] : []);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error));
  };
  // It couldn't load, or failed: what's waiting fails, and the next document is read here.
  w.onerror = (event) => {
    event.preventDefault?.();
    client.broken = true;
    for (const p of pending.values()) p.reject(new Error('the reader’s worker stopped'));
    pending.clear();
    w.terminate();
  };
  shared = client;
  return client;
}

let docIds = 0;
class WorkerDocument {
  static async open(client, bytes, password, fonts) {
    const id = `d${++docIds}`;
    if (fonts) client.fontSources.set(id, fonts);
    try {
      const { numPages } = await client.call('open', { doc: id, data: bytes.buffer, password, fonts: Boolean(fonts) }, [bytes.buffer]);
      return new WorkerDocument(client, id, numPages);
    } catch (error) {
      client.fontSources.delete(id);
      throw error;
    }
  }
  constructor(client, id, numPages) {
    this.client = client;
    this.id = id;
    this.numPages = numPages;
    this.pages = new Map();
    this.closed = false;
  }
  call(type, message = {}) {
    return this.client.call(type, { ...message, doc: this.id });
  }
  getPage(n) {
    if (!this.pages.has(n)) this.pages.set(n, this.call('page', { n }).then((info) => new WorkerPage(this, n, info)));
    return this.pages.get(n);
  }
  async getMetadata() {
    return { info: await this.call('info') };
  }
  async getOutline() {
    return mapOutline(await this.call('outline'));
  }
  async getDestination(dest) {
    const page = await this.call('destination', { dest });
    return page === null ? null : [{ pageIndex: page }];
  }
  async getPageIndex(ref) {
    return pageIndexOf(ref);
  }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.client.fontSources.delete(this.id);
    if (!this.client.broken) this.call('close').catch(() => {});
  }
}

class WorkerPage {
  reader = 'smartdoc';
  constructor(owner, n, { view, rotate, index }) {
    this.owner = owner;
    this.n = n;
    this.view = view;
    this.rotate = rotate;
    this.index = index;
    this.text = null;
  }
  get pageNumber() {
    return this.index + 1;
  }
  getViewport({ scale = 1 } = {}) {
    return viewportOf(this, scale);
  }
  // Drawn in the worker at the canvas's size, then its picture drawn on the canvas.
  render({ canvas, canvasContext, viewport, transform = null }) {
    const ctx = canvasContext ?? canvas.getContext('2d');
    const k = transform ? transform[0] : 1;
    let cancelled = false;
    const promise = this.owner.call('render', { n: this.n, width: ctx.canvas.width, height: ctx.canvas.height, scale: viewport.scale * k }).then((bitmap) => {
      if (!cancelled) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(bitmap, 0, 0);
        ctx.restore();
      }
      bitmap.close();
    });
    return { promise, cancel: () => (cancelled = true) };
  }
  getTextContent() {
    this.text ??= this.owner.call('text', { n: this.n });
    return this.text;
  }
  cleanup() {}
}

// --- Here -----------------------------------------------------------------------------------

class DocumentProxy {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
  }
  get numPages() {
    return this.doc.pages.length;
  }
  async getPage(n) {
    const page = this.doc.pages[n - 1];
    if (!page) throw new Error(`no page ${n}`);
    return new PageProxy(page, this);
  }
  async getMetadata() {
    return { info: this.doc.info() };
  }
  async getOutline() {
    return mapOutline(this.doc.outline());
  }
  async getDestination(dest) {
    const page = this.doc.destinationPage(dest);
    return page === null ? null : [{ pageIndex: page }];
  }
  async getPageIndex(ref) {
    return pageIndexOf(ref);
  }
  destroy() {}
}

class PageProxy {
  // Which reader made the page: a viewer lays its text with this reader's text layer.
  reader = 'smartdoc';
  constructor(page, owner) {
    this.page = page;
    this.owner = owner;
    this.view = page.view;
    this.rotate = page.rotate;
    this.text = null;
  }
  get pageNumber() {
    return this.page.index + 1;
  }
  getViewport({ scale = 1 } = {}) {
    return viewportOf(this, scale);
  }
  // pdf.js's render: `transform` (a scale for the device's pixels) applies before the viewport.
  render({ canvas, canvasContext, viewport, transform = null }) {
    const ctx = canvasContext ?? canvas.getContext('2d');
    const k = transform ? transform[0] : 1;
    const promise = renderPage(this.page, ctx, { scale: viewport.scale * k, fonts: this.owner.fonts });
    return { promise, cancel() {} };
  }
  async getTextContent() {
    this.text ??= getTextContent(this.page);
    return this.text;
  }
  cleanup() {}
}

// --- Both -----------------------------------------------------------------------------------

// The outline as pdf.js gives it: [{ title, dest, items }], each destination an array whose first
// element getPageIndex turns into the page's index.
const mapOutline = (items) => items.map((item) => ({ title: item.title, dest: item.page === null ? null : [{ pageIndex: item.page }], items: mapOutline(item.items ?? []) }));

function pageIndexOf(ref) {
  if (typeof ref?.pageIndex === 'number') return ref.pageIndex;
  throw new Error('not a page');
}

// `page` has the page's box (`view`) and rotation (`rotate`).
function viewportOf(page, scale) {
  const vp = pageViewport(page, scale);
  const [x0, y0, x1, y1] = page.view;
  return {
    ...vp,
    scale,
    rotation: page.rotate,
    viewBox: page.view,
    rawDims: { pageWidth: x1 - x0, pageHeight: y1 - y0, pageX: x0, pageY: y0 },
  };
}
