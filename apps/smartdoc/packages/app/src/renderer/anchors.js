// Text anchors: { page, start, end, text }, where start/end are character offsets into the page's
// text. A page's text is its pdf.js text items joined in order, with a newline after each item
// that ends a line (the same rule as src/main/anchors.js, which resolves the AI's quotes).
// pdf.js's text layer makes one span per text item, in order, so offsets map onto spans exactly.

const pages = new Map(); // page number → { text, spans: [{ el, start, end }], contentEl }

export function clearPages() {
  pages.clear();
}

// Call once a page's text layer has rendered. `items` are the text content items given to the
// text layer; `textDivs` is the layer's spans (one per item with a string).
export function registerPage(pageNumber, items, textDivs, contentEl) {
  let text = '';
  const spans = [];
  items.filter((item) => typeof item.str === 'string').forEach((item, i) => {
    const start = text.length;
    text += item.str;
    spans.push({ el: textDivs[i], start, end: text.length });
    if (item.hasEOL) text += '\n';
  });
  pages.set(pageNumber, { text, spans, contentEl });
}

export const pageTexts = () => [...pages.keys()].sort((a, b) => a - b).map((n) => pages.get(n).text);

// The current selection as anchors, one per page it touches (empty if nothing is selected).
export function selectionAnchors() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  const range = selection.getRangeAt(0);
  const anchors = [];
  for (const [page, { text, spans }] of pages) {
    let start = Infinity;
    let end = -Infinity;
    for (const span of spans) {
      if (!span.el.isConnected || !range.intersectsNode(span.el)) continue;
      const length = span.end - span.start;
      const from = span.el.contains(range.startContainer) ? offsetIn(span.el, range.startContainer, range.startOffset) : 0;
      const to = span.el.contains(range.endContainer) ? offsetIn(span.el, range.endContainer, range.endOffset) : length;
      start = Math.min(start, span.start + from);
      end = Math.max(end, span.start + to);
    }
    if (end > start) anchors.push({ page, start, end, text: text.slice(start, end) });
  }
  return anchors.sort((a, b) => a.page - b.page);
}

// Character offset of (node, offset) within a span.
function offsetIn(span, node, offset) {
  if (node === span) return [...span.childNodes].slice(0, offset).reduce((n, c) => n + (c.textContent?.length ?? 0), 0);
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let count = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t === node) return count + offset;
    count += t.length;
  }
  return count;
}

// Rectangles covering an anchor, in the page's unscaled (drawn) coordinates.
export function anchorRects(anchor) {
  const page = pages.get(anchor.page);
  if (!page) return [];
  const box = page.contentEl.getBoundingClientRect();
  const scale = box.width / page.contentEl.offsetWidth || 1;
  const rects = [];
  for (const span of page.spans) {
    if (span.end <= anchor.start || span.start >= anchor.end || !span.el.firstChild) continue;
    const node = span.el.firstChild;
    const range = document.createRange();
    range.setStart(node, Math.max(0, anchor.start - span.start));
    range.setEnd(node, Math.min(node.length, anchor.end - span.start));
    for (const r of range.getClientRects()) {
      if (r.width < 0.5) continue;
      rects.push({ x: (r.left - box.left) / scale, y: (r.top - box.top) / scale, width: r.width / scale, height: r.height / scale });
    }
  }
  return rects;
}

// The text position nearest a point (client coordinates) on a page, for starting or extending a
// selection from the space between the text: { node, offset } in a span's text node, or null if
// the page has no text. Text on the same line as the point wins; otherwise the nearest line. Left
// of a line's text is its start, right of it its end.
export function nearestTextPosition(contentEl, x, y) {
  const page = [...pages.values()].find((p) => p.contentEl === contentEl);
  let best = null;
  for (const span of page?.spans ?? []) {
    const node = span.el.firstChild;
    if (!span.el.isConnected || node?.nodeType !== Node.TEXT_NODE || !node.length) continue;
    const r = span.el.getBoundingClientRect();
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const score = dy * 1000 + dx; // the line matters more than how far along it
    if (!best || score < best.score) best = { score, node, r };
  }
  if (!best) return null;
  const { node, r } = best;
  if (x <= r.left) return { node, offset: 0 };
  if (x >= r.right) return { node, offset: node.length };
  const caret = document.caretRangeFromPoint(x, Math.min(Math.max(y, r.top + 1), r.bottom - 1));
  if (caret?.startContainer === node) return { node, offset: caret.startOffset };
  // Between characters the caret can land outside the span: estimate from the width instead.
  return { node, offset: Math.round(((x - r.left) / r.width) * node.length) };
}

export const pageContent = (pageNumber) => pages.get(pageNumber)?.contentEl;
export const pageNumbers = () => [...pages.keys()];
