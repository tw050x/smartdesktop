import { anchorRects, pageContent, pageNumbers } from './anchors.js';

// Marks drawn over the pages: the user's requests and the AI's annotations, plus the text of
// whichever finding is hovered in the review.

let marks = []; // [{ anchors, className, title }]
let hovered = []; // anchors of the hovered finding

export function setMarks(next) {
  marks = next;
  redraw();
}

export function setHovered(anchors) {
  const next = anchors ?? [];
  if (next === hovered || (!next.length && !hovered.length)) return;
  hovered = next;
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

    for (const mark of [...marks, { anchors: hovered, className: 'mark-hover' }]) {
      for (const anchor of mark.anchors.filter((a) => a.page === page)) {
        for (const r of anchorRects(anchor)) {
          const el = document.createElement('div');
          el.className = `mark ${mark.className}`;
          el.title = mark.title ?? '';
          Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
          layer.append(el);
        }
      }
    }
  }
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
