import { anchorRects, lineExtent, pageContent, pageNumbers, pageText, spanAt } from './anchors.js';
import { diffText } from './word-diff.js';

// The review's marks on the pages: each item's text tinted in its colour. Where several items'
// text overlaps, the shared part is striped in all their colours. While a deck is hovered (the
// veil), only its top card's text stays marked, and a white veil fades the rest of the page so
// that text stands out; an open card's text shows at full strength without the veil.

// A suggested change open beside the pages shows on the page, at the text it changes (`change`,
// see drawChange).
let marks = { items: [], focus: [], veil: false, change: null }; // see margin-review.js

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
    if (marks.change) drawChange(page, layer);
  }
}

// --- A suggested change, in place ---------------------------------------------------------------
// The open change finding's passage shows what it changes, only there (the user's choice: the card
// has the switch, the page the changes, never a whole-document comparison). `change` is { anchors,
// after, view }: Before marks on the page's own text what goes, red, and what's reworded, amber;
// Changes and After lay the new wording over the passage, in its column and at its size, Changes
// with what goes struck through in red where it was and what's added in green, After with what's
// added in green and what's reworded in amber. What's laid over is drawn on the page's white, so the
// text it covers doesn't show through, and runs on below the passage if it's longer.

// The passage as one text, and where each anchor's part of it is: { text, pieces: [{ page, start,
// end, at }] }, `at` being where the piece starts in `text`.
function passage(anchors) {
  let text = '';
  const pieces = [];
  for (const a of anchors) {
    if (a.end <= a.start) continue;
    if (text) text += '\n';
    pieces.push({ page: a.page, start: a.start, end: a.end, at: text.length });
    text += pageText(a.page).slice(a.start, a.end);
  }
  return { text, pieces };
}

// A range of the passage's text as ranges of one page's text.
function onPage(pieces, page, range) {
  return pieces.filter((p) => p.page === page).flatMap((p) => {
    const start = Math.max(range.start, p.at);
    const end = Math.min(range.end, p.at + p.end - p.start);
    return end > start ? [{ start: p.start + start - p.at, end: p.start + end - p.at }] : [];
  });
}

// Each part of each change, with what kind of change it belongs to: reworded where the change both
// removes and adds, else removed or added.
function changeParts(before, after) {
  return diffText(before, after).flatMap(({ parts }) => {
    const kind = parts.some((p) => p.removed) && parts.some((p) => p.added) ? 'changed' : parts.some((p) => p.removed) ? 'removed' : 'added';
    return parts.map((part) => ({ ...part, kind }));
  });
}

function drawChange(page, layer) {
  const { anchors, after, view } = marks.change;
  const { text: before, pieces } = passage(anchors);
  if (!pieces.some((p) => p.page === page)) return;
  const parts = changeParts(before, after);
  const box = (className, r) => {
    const node = document.createElement('div');
    node.className = className;
    Object.assign(node.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    layer.append(node);
  };

  if (view === 'before') {
    for (const part of parts) {
      if (!part.removed) continue;
      for (const range of onPage(pieces, page, part.removed)) {
        for (const r of anchorRects({ page, ...range })) box(`mark change-mark ${part.kind}`, r);
      }
    }
    return;
  }

  // The passage covered, and the new wording laid over it from where it starts.
  const rects = pieces.filter((p) => p.page === page).flatMap((p) => anchorRects({ page, start: p.start, end: p.end }));
  for (const r of rects) box('change-cover', { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 });
  const first = pieces[0];
  if (first.page !== page || !rects.length) return;
  const lines = [];
  for (const r of rects) if (!lines.some((l) => Math.abs(l.y - r.y) < r.height / 2)) lines.push(r);
  const extents = lines.map((l) => lineExtent(page, l));
  const left = Math.min(...extents.map((e) => e.left));
  const right = Math.max(...extents.map((e) => e.right));
  const head = rects[0];
  const pitch = lines.length > 1 ? lines[1].y - lines[0].y : head.height * 1.2;
  const lineHeight = Math.max(head.height, Math.min(pitch, head.height * 1.6));
  const span = spanAt(page, first.start);
  const words = document.createElement('div');
  words.className = 'change-words';
  Object.assign(words.style, {
    left: `${left}px`,
    top: `${head.y - (lineHeight - head.height) / 2}px`,
    width: `${Math.max(right - left, head.width)}px`,
    fontSize: `${head.height * 0.86}px`,
    lineHeight: `${lineHeight}px`,
    textIndent: `${head.x - left}px`,
    fontFamily: span ? getComputedStyle(span).fontFamily : '',
  });
  const run = document.createElement('span');
  run.className = 'change-run';
  const plain = (s) => s && run.append(document.createTextNode(s));
  const marked = (tag, className, s) => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = s;
    run.append(node);
  };
  let cursor = 0;
  for (const part of parts) {
    const at = part.added?.start ?? part.at;
    plain(after.slice(cursor, at));
    cursor = at;
    if (view === 'changes' && part.removed) {
      const gone = before.slice(part.removed.start, part.removed.end).replace(/\s+/g, ' ');
      // A space after it, unless the wording after it starts with one (or there's none).
      marked('del', 'change-removed', part.added || !/^\s|^$/.test(after.slice(at, at + 1)) ? `${gone} ` : gone);
    }
    if (part.added) {
      marked('ins', view === 'changes' ? 'change-added' : `change-${part.kind}`, after.slice(part.added.start, part.added.end));
      cursor = part.added.end;
    }
  }
  plain(after.slice(cursor));
  words.append(run);
  layer.append(words);
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
