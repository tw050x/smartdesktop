// Picking words in a card to ask about (the user's rules; this replaces SmartSpec's selection.js).
// A drag picks words as anywhere. A double-click picks the word under it, and a double-click on
// what's picked picks more (pick-rules.js): a word grows to its sentence, one sentence to the
// sentences either side, two or more to the whole paragraph. Three clicks are nothing of their own
// (the browser's paragraph pick is off): only each second click counts, so double-clicking twice
// quickly is two double-clicks. Shift with a double-click outside what's picked adds that
// sentence: a range of its own, unless it runs on from one already picked (overlapping it, or with
// only spacing between), when the two join.
//
// Several ranges can be picked at once, which the browser's selection can't hold (Chromium keeps
// one range), so what's picked is kept here (`picks`) and drawn as a highlight (`::highlight(picked)`
// in styles.css), the browser's own selection hidden in cards and let go once a drag ends. A long
// press on what's picked asks about it (pickedAt, for comments.js); ⌘C copies it.
//
// A click anywhere lets everything picked go when the pointer comes up (so a long press still
// asks), as in any text editor, even where nothing can be picked; a click on what's picked waits a
// moment first, in case it's the first of a double-click. Shift-clicks, and clicks in fields and the
// question box, keep it.
import { longPressed } from './long-press.js';
import { grow, sentenceAt, wordAt } from './pick-rules.js';

const AREA = '.focus-body'; // a card's page: where words are picked
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dd, dt';
const KEEPS = 'input, textarea, [contenteditable="true"], .comment-thread, dialog';
const DOUBLE_MS = 500; // how long a click on what's picked waits for a second click

let picks = []; // Ranges, in the document's order, all in one card
let down = null; // the press under way: { target, shift, detail }
let letGo = null; // the timer letting go after a click on what's picked

const areaOf = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(AREA) ?? null;
const live = (range) => range.startContainer.isConnected && range.endContainer.isConnected;
const inside = (range, x, y) => [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);

// --- A paragraph's text, and where in the page each character of it is ---------------------------

function blockOf(node, area) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const block = element?.closest(BLOCKS);
  return block && area.contains(block) ? block : area;
}

// The paragraph's own text (not that of a paragraph inside it, as a list inside a list item).
function textOf(block, area) {
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (blockOf(node, area) !== block) continue;
    nodes.push({ node, start: text.length });
    text += node.nodeValue;
  }
  return { text, nodes };
}

function offsetOf(model, container, offset) {
  for (const one of model.nodes) if (one.node === container) return one.start + offset;
  // A point between elements: where the first text after it starts.
  const point = document.createRange();
  point.setStart(container, offset);
  for (const one of model.nodes) if (point.comparePoint(one.node, 0) >= 0) return one.start;
  return model.text.length;
}

function pointAt(model, at, end) {
  for (let i = 0; i < model.nodes.length; i++) {
    const { node, start } = model.nodes[i];
    const length = node.nodeValue.length;
    if (at < start + length || (at === start + length && (end || i === model.nodes.length - 1))) return [node, Math.max(0, at - start)];
  }
  const last = model.nodes.at(-1);
  return [last.node, last.node.nodeValue.length];
}

function rangeOf(model, [start, end]) {
  const range = document.createRange();
  range.setStart(...pointAt(model, start, false));
  range.setEnd(...pointAt(model, end, true));
  return range;
}

function caretAt(x, y) {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return [position.offsetNode, position.offset];
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? [range.startContainer, range.startOffset] : null;
}

// The word or sentence under the pointer, as a range, or null where there's none (spacing, the
// margin beside a line).
function spanAt(x, y, area, find) {
  const caret = caretAt(x, y);
  if (!caret || !area.contains(caret[0])) return null;
  const model = textOf(blockOf(caret[0], area), area);
  if (!model.nodes.length) return null;
  const span = find(model.text, offsetOf(model, ...caret));
  if (!span) return null;
  const range = rangeOf(model, span);
  return inside(range, x, y) ? range : null;
}

// What a double-click on a pick makes it. Across paragraphs, it's all of each.
function grown(range, area) {
  const first = blockOf(range.startContainer, area);
  const last = blockOf(range.endContainer, area);
  if (first !== last) {
    const a = textOf(first, area);
    const b = textOf(last, area);
    if (!a.nodes.length || !b.nodes.length) return null;
    const whole = document.createRange();
    whole.setStart(...pointAt(a, a.text.length - a.text.trimStart().length, false));
    whole.setEnd(...pointAt(b, b.text.trimEnd().length, true));
    return whole;
  }
  const model = textOf(first, area);
  if (!model.nodes.length) return null;
  const span = grow(model.text, [offsetOf(model, range.startContainer, range.startOffset), offsetOf(model, range.endContainer, range.endOffset)]);
  return span && rangeOf(model, span);
}

// Ranges in order, those overlapping or with only spacing between joined.
function joined(ranges) {
  const sorted = ranges.map((range) => range.cloneRange()).sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b));
  const out = [];
  for (const range of sorted) {
    const last = out.at(-1);
    let touches = false;
    if (last) {
      if (last.comparePoint(range.startContainer, range.startOffset) <= 0) touches = true;
      else {
        const gap = document.createRange();
        gap.setStart(last.endContainer, last.endOffset);
        gap.setEnd(range.startContainer, range.startOffset);
        touches = !gap.toString().trim();
      }
    }
    if (!touches) out.push(range);
    else if (last.compareBoundaryPoints(Range.END_TO_END, range) < 0) last.setEnd(range.endContainer, range.endOffset);
  }
  return out;
}

// --- What's picked ---------------------------------------------------------------------------------

function show() {
  picks = picks.filter(live);
  if (!globalThis.CSS?.highlights) return;
  if (picks.length) CSS.highlights.set('picked', new Highlight(...picks));
  else CSS.highlights.delete('picked');
}

function set(ranges) {
  clearTimeout(letGo);
  letGo = null;
  picks = ranges;
  show();
}

// The picks in `area` if the point is on one of them (what a long press there asks about), else null.
export function pickedAt(x, y, area) {
  const here = picks.filter((range) => live(range) && area.contains(range.commonAncestorContainer));
  return here.some((range) => inside(range, x, y)) ? here : null;
}

function doubleClick(event, area) {
  const { clientX: x, clientY: y } = event;
  const current = picks.filter((range) => live(range) && area.contains(range.commonAncestorContainer));
  const on = current.find((range) => inside(range, x, y));
  if (on) {
    const more = grown(on, area);
    if (more) set(joined(current.map((range) => (range === on ? more : range))));
    return;
  }
  if (event.shiftKey) {
    const sentence = spanAt(x, y, area, sentenceAt);
    if (sentence) set(joined([...current, sentence]));
    return;
  }
  const word = spanAt(x, y, area, wordAt);
  set(word ? [word] : []);
}

addEventListener('pointerdown', (event) => {
  down = event.button === 0 ? { target: event.target, shift: event.shiftKey, detail: 1 } : null;
}, true);

addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  if (down) down.detail = event.detail;
  const area = event.target.closest?.(AREA);
  if (!area || event.target.closest('a[href], button, input, textarea')) return;
  if (event.detail >= 2) {
    // The browser picks a word or a paragraph itself; these clicks are ours, and keep what's picked.
    event.preventDefault();
    clearTimeout(letGo);
    letGo = null;
    if (event.detail % 2 === 0) doubleClick(event, area);
  } else if (event.shiftKey) {
    // Not the browser's Shift-click, which would stretch its one range: a Shift-double-click adds.
    event.preventDefault();
  }
}, true);

addEventListener('pointerup', (event) => {
  const was = down;
  down = null;
  if (!was || longPressed()) return;
  const selection = getSelection();
  // A drag that picked words: they're what's picked now (see selectionchange), shown as picks.
  if (selection?.rangeCount && !selection.isCollapsed) {
    if (areaOf(selection.getRangeAt(0).commonAncestorContainer)) selection.removeAllRanges();
    return;
  }
  if (was.detail >= 2 || was.shift || was.target.closest?.(KEEPS) || !picks.length) return;
  if (picks.some((range) => live(range) && inside(range, event.clientX, event.clientY))) {
    clearTimeout(letGo);
    letGo = setTimeout(() => set([]), DOUBLE_MS);
  } else set([]);
}, true);

// A drag picking words, as it goes: in a card, it's the one range picked; elsewhere, nothing in a
// card is.
document.addEventListener('selectionchange', () => {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (areaOf(range.commonAncestorContainer)) set([range.cloneRange()]);
  else if (picks.length) set([]);
});

addEventListener('copy', (event) => {
  const selection = getSelection();
  picks = picks.filter(live);
  if (!picks.length || (selection && !selection.isCollapsed)) return;
  event.clipboardData.setData('text/plain', picks.map((range) => range.toString().trim()).join('\n\n'));
  event.preventDefault();
});
