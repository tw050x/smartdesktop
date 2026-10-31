import { anchorRects, pageContent, pageNumbers } from './anchors.js';

// The review's marks on the pages: each item's text tinted in its colour. Where several items'
// text overlaps, the shared part is striped in all their colours. While a deck is hovered (the
// veil), only its top card's text stays marked, and a white veil fades the rest of the page so
// that text stands out; an open card's text shows at full strength without the veil.

let marks = { items: [], focus: [], veil: false }; // see margin-review.js

export function setMarks(next) {
  marks = next;
  redraw();
}

export function redraw() {
  for (const page of pageNumbers()) {
    const content = pageContent(page);
    if (!content) continue;
    let layer = content.querySelector('.marks');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'marks';
      content.append(layer);
    }
    layer.replaceChildren();

    const focused = [];
    for (const segment of segments(page)) {
      const ids = marks.veil ? segment.ids.filter((id) => marks.focus.includes(id)) : segment.ids;
      if (!ids.length) continue;
      const colours = ids.map((id) => {
        const item = marks.items.find((i) => i.id === id);
        return marks.focus.includes(id) ? item.strong : item.tint;
      });
      const background = colours.length === 1 ? colours[0]
        : `repeating-linear-gradient(135deg, ${colours.map((c, i) => `${c} ${i * 6}px ${(i + 1) * 6}px`).join(', ')})`;
      for (const r of anchorRects({ page, start: segment.start, end: segment.end })) {
        const el = document.createElement('div');
        el.className = 'mark';
        Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px`, background });
        layer.append(el);
        if (marks.veil) focused.push(r);
      }
    }
    if (marks.veil) layer.prepend(veil(content.offsetWidth, content.offsetHeight, focused));
  }
}

// The page's marked text split wherever an item's text starts or ends, so each piece knows every
// item it belongs to: [{ start, end, ids }], adjoining pieces with the same items joined.
function segments(page) {
  const spans = [];
  for (const item of marks.items) {
    for (const a of item.anchors) if (a.page === page && a.end > a.start) spans.push({ start: a.start, end: a.end, id: item.id });
  }
  const cuts = [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [start, end] = [cuts[i], cuts[i + 1]];
    const ids = [...new Set(spans.filter((s) => s.start <= start && s.end >= end).map((s) => s.id))];
    if (!ids.length) continue;
    const last = result.at(-1);
    if (last && last.end === start && last.ids.join() === ids.join()) last.end = end;
    else result.push({ start, end, ids });
  }
  return result;
}

// A white wash over the whole page with holes cut where the focused text is.
const VEIL_PADDING = 2;
function veil(width, height, holes) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'veil');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const p = VEIL_PADDING;
  path.setAttribute('d', [`M0 0H${width}V${height}H0Z`, ...holes.map((r) => `M${r.x - p} ${r.y - p}h${r.width + 2 * p}v${r.height + 2 * p}h${-(r.width + 2 * p)}Z`)].join(''));
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

// Scrolls the first anchor (all its lines) towards the middle of the view, as far as the
// scroll range allows: it never scrolls past the top or bottom of the document to get there.
// Text that's already about central stays put. Text taller than the view lines up its top
// near the top of the view instead.
const CENTRED_ENOUGH = 24; // px off centre that's left alone
const TOP_MARGIN = 40;
export function revealAnchors(anchors, scroller) {
  const first = anchors?.[0];
  const rects = first ? anchorRects(first) : [];
  const content = first && pageContent(first.page);
  if (!rects.length || !content) return;
  const box = content.getBoundingClientRect();
  const scale = box.width / content.offsetWidth || 1;
  const top = box.top + Math.min(...rects.map((r) => r.y)) * scale;
  const bottom = box.top + Math.max(...rects.map((r) => r.y + r.height)) * scale;
  const view = scroller.getBoundingClientRect();
  const delta = bottom - top > view.height - 2 * TOP_MARGIN
    ? top - (view.top + TOP_MARGIN)
    : (top + bottom) / 2 - (view.top + view.height / 2);
  const range = scroller.scrollHeight - scroller.clientHeight;
  const target = Math.max(0, Math.min(range, scroller.scrollTop + delta));
  if (Math.abs(target - scroller.scrollTop) < CENTRED_ENOUGH) return;
  scroller.scrollTo({ top: target, behavior: 'smooth' });
}
