// Searching a document's page texts for the find bar (see find-bar.js). A page's text is as
// anchors.js builds it, so a match's offsets are the offsets its marks are placed from.

// Case and spacing are ignored, so a phrase can run across a line break, and straight and curly
// quotes are the same: a PDF's "don’t" is found by typing "don't".
const LOOKALIKES = { "'": "['’‘]", '’': "['’‘]", '‘': "['’‘]", '"': '["“”]', '“': '["“”]', '”': '["“”]' };

function patternFor(query) {
  const words = String(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const word = (w) => [...w].map((c) => LOOKALIKES[c] ?? c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(words.map(word).join('\\s+'), 'gi');
}

// Every match on a page, as { page, start, end }.
export function matchesOnPage(text, page, query) {
  const pattern = patternFor(query);
  if (!pattern) return [];
  return [...text.matchAll(pattern)].map((m) => ({ page, start: m.index, end: m.index + m[0].length }));
}

// Every match in a document's pages, in order.
export const matchesInPages = (texts, query) => texts.flatMap((text, i) => matchesOnPage(text, i + 1, query));

// A match with the text either side of it, on one line, to show in a list.
const AROUND = 40;
export function snippetOf(text, { start, end }) {
  const tidy = (s) => s.replace(/\s+/g, ' ');
  return {
    before: `${start > AROUND ? '…' : ''}${tidy(text.slice(Math.max(0, start - AROUND), start)).trimStart()}`,
    match: tidy(text.slice(start, end)),
    after: `${tidy(text.slice(end, end + AROUND)).trimEnd()}${end + AROUND < text.length ? '…' : ''}`,
  };
}

// What the document's history says about a search, given the drafts on its line, oldest first, as
// { id, label, count }. The answer to "did we already take this out?" is the draft it was last in,
// when the newest draft no longer has it.
export function historyVerdict(line, currentId) {
  const last = line.findLast((d) => d.count > 0);
  if (!last) return 'Not in any draft';
  if (last !== line.at(-1)) return `Removed after ${last.label}`;
  const inOthers = line.filter((d) => d.id !== currentId && d.count > 0);
  if (!inOthers.length) return 'Not in any other draft';
  return `In ${inOthers.length} other draft${inOthers.length === 1 ? '' : 's'}`;
}
