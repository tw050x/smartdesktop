import { diffText } from './word-diff.js';

// Marks what changed between two versions of some writing, in the writing as drawn (Markdown
// rendered into elements): added words green, removed ones red. In one view (markInline) the
// removed words are put back where they were, struck through; side by side (markSides) each version
// marks its own. The words are compared as the reader sees them, so a change only to how the
// Markdown is written isn't one.

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dd, dt, figcaption';

// The text in `root` as one string, and where each of its text nodes starts in it. Blocks are kept
// apart by a line break, so the last word of one paragraph and the first of the next aren't one word.
function textOf(root) {
  const nodes = [];
  let text = '';
  let block = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('.diff-removed') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const here = node.parentElement?.closest(BLOCKS) ?? root;
    if (block && here !== block) text += '\n';
    block = here;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

// Wraps the text from `start` to `end` of `root` (offsets in textOf's string) in spans of
// `className`, one for each text node it crosses. Returns the spans.
function wrap(root, start, end, className) {
  const spans = [];
  for (const { node, start: from } of textOf(root).nodes) {
    const to = from + node.data.length;
    if (to <= start || from >= end) continue;
    let piece = node;
    if (start > from) piece = piece.splitText(start - from);
    if (end < to) piece.splitText(end - Math.max(start, from));
    if (!piece.data.trim()) continue;
    const span = document.createElement('span');
    span.className = className;
    piece.replaceWith(span);
    span.append(piece);
    spans.push(span);
  }
  return spans;
}

// Puts `words` into `root` at `offset` (in textOf's string), struck through as removed. Before a
// mark already there, not inside it.
function insertRemoved(root, offset, words) {
  const del = document.createElement('span');
  del.className = 'diff-removed';
  del.textContent = words.trim(); // its spacing is its margin (styles.css), so no space is struck through
  const { nodes } = textOf(root);
  const found = nodes.find(({ node, start }) => offset >= start && offset < start + node.data.length) ?? null;
  if (found) {
    const place = offset > found.start ? found.node.splitText(offset - found.start) : found.node;
    const mark = place.parentElement?.closest('.diff-added');
    (mark && mark.firstChild === place ? mark : place).before(del);
  } else {
    // At the very end: after the last words.
    const last = nodes.at(-1)?.node;
    if (last) last.after(del);
    else root.append(del);
  }
  return del;
}

const order = (part) => Math.max(part.at, part.added?.start ?? 0);

// The new version, `after`, with what changed from `beforeText` marked in it. Returns how many
// changes there are.
export function markInline(after, beforeText) {
  const changes = diffText(beforeText, textOf(after).text);
  const parts = changes.flatMap((change) => change.parts).sort((a, b) => order(b) - order(a));
  for (const part of parts) {
    if (part.added) wrap(after, part.added.start, part.added.end, 'diff-added');
    if (part.removed) insertRemoved(after, part.at, beforeText.slice(part.removed.start, part.removed.end).replace(/\s+/g, ' '));
  }
  return changes.length;
}

// Both versions, each marking its own side of every change. Returns the changes, each with its
// marks, to step through.
export function markSides(before, after) {
  const changes = diffText(textOf(before).text, textOf(after).text);
  const marks = changes.map(() => []);
  [...changes.entries()].reverse().forEach(([index, change]) => {
    for (const part of [...change.parts].reverse()) {
      if (part.added) marks[index].push(...wrap(after, part.added.start, part.added.end, 'diff-added'));
      if (part.removed) marks[index].push(...wrap(before, part.removed.start, part.removed.end, 'diff-removed'));
    }
  });
  return marks;
}

// The text of some Markdown as it reads, for comparing with: drawn by `render` into an element
// that's never shown.
export function readText(render) {
  const element = document.createElement('div');
  render(element);
  return textOf(element).text;
}
