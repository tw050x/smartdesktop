// Compares two documents' text word by word, across their whole length, so text that only moved
// to another line or page isn't a change. Words and punctuation marks are compared separately and
// white space not at all: wrapping can't show up as a change, even where a line breaks at a hyphen
// ("line-\nmanaging"). Pure, so it can be tested without a window.

const TOKEN = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;
// Beyond this many differing tokens the documents have little in common, and working out the
// shortest edit would take too much memory: what's between their shared start and end all counts
// as changed.
const MAX_EDITS = 3000;
// Edits this few tokens apart are one change to step through ("2 iOS apps" → "an iOS app").
const SAME_CHANGE_GAP = 2;

function tokenize(pages) {
  const tokens = [];
  pages.forEach((text, i) => {
    for (const match of text.matchAll(TOKEN)) {
      tokens.push({ word: match[0], page: i + 1, start: match.index, end: match.index + match[0].length });
    }
  });
  return tokens;
}

// The shortest edit from a to b (Myers), as [{ aStart, aEnd, bStart, bEnd }] with nothing shared
// inside each edit.
function edits(a, b) {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > shared && bEnd > shared && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const n = aEnd - shared;
  const m = bEnd - shared;
  if (!n && !m) return [];
  const whole = [{ aStart: shared, aEnd, bStart: shared, bEnd }];
  if (!n || !m) return whole;

  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const furthest = new Int32Array(2 * limit + 3); // diagonal k (x - y) + offset → the furthest x
  const trace = []; // furthest as it stood before each round, from diagonal -d - 1
  const goesDown = (at, k, d) => k === -d || (k !== d && at(k - 1) < at(k + 1));

  for (let d = 0; d <= limit; d++) {
    trace.push(furthest.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = goesDown((j) => furthest[offset + j], k, d) ? furthest[offset + k + 1] : furthest[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[shared + x] === b[shared + y]) {
        x++;
        y++;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) return shift(walkBack(trace, n, m, goesDown), shared);
    }
  }
  return whole;
}

// From the end of the edit graph back to its start: each round's single insertion or deletion,
// then joined where they touch.
function walkBack(trace, n, m, goesDown) {
  const steps = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const at = (j) => trace[d][j + d + 1];
    const k = x - y;
    const fromK = goesDown(at, k, d) ? k + 1 : k - 1;
    const fromX = at(fromK);
    const fromY = fromX - fromK;
    steps.push(fromK === k + 1 ? { x: fromX, y: fromY, dx: 0, dy: 1 } : { x: fromX, y: fromY, dx: 1, dy: 0 });
    x = fromX;
    y = fromY;
  }
  const joined = [];
  for (const { x: sx, y: sy, dx, dy } of steps.reverse()) {
    const last = joined.at(-1);
    if (last && last.aEnd === sx && last.bEnd === sy) {
      last.aEnd += dx;
      last.bEnd += dy;
    } else {
      joined.push({ aStart: sx, aEnd: sx + dx, bStart: sy, bEnd: sy + dy });
    }
  }
  return joined;
}

const shift = (list, by) => list.map((e) => ({ aStart: e.aStart + by, aEnd: e.aEnd + by, bStart: e.bStart + by, bEnd: e.bEnd + by }));

// A removal or addition next to a repeat of its own text could equally be marked a token earlier
// or later: ") Drive … beta" or "Drive … beta )". Moved as late as it can go, it starts and ends
// where a reader would expect, as whole lines and clauses tend to end with their punctuation.
function slideForward(list, a, b) {
  list.forEach((edit, i) => {
    const next = list[i + 1];
    const removal = edit.aEnd > edit.aStart && edit.bEnd === edit.bStart;
    const addition = edit.bEnd > edit.bStart && edit.aEnd === edit.aStart;
    if (!removal && !addition) return;
    const repeats = () => (removal
      ? edit.aEnd < a.length && a[edit.aStart] === a[edit.aEnd]
      : edit.bEnd < b.length && b[edit.bStart] === b[edit.bEnd]);
    while (repeats() && (!next || (edit.aEnd < next.aStart && edit.bEnd < next.bStart))) {
      edit.aStart++;
      edit.aEnd++;
      edit.bStart++;
      edit.bEnd++;
    }
  });
  return list;
}

// A run of tokens as one range per page it touches, white space between them included.
function ranges(tokens, from, to) {
  const result = [];
  for (let i = from; i < to; i++) {
    const { page, start, end } = tokens[i];
    const last = result.at(-1);
    if (last?.page === page) last.end = end;
    else result.push({ page, start, end });
  }
  return result;
}

// The changes from one document to another, given each one's page texts, in reading order:
// [{ removed: [{ page, start, end }], added: [{ page, start, end }] }], with page numbers from 1
// and offsets into that page's text.
export function diffPages(beforePages, afterPages) {
  const before = tokenize(beforePages);
  const after = tokenize(afterPages);
  const changes = [];
  let previous = null;
  const words = [before.map((t) => t.word), after.map((t) => t.word)];
  for (const edit of slideForward(edits(...words), ...words)) {
    if (!previous || edit.aStart - previous.aEnd > SAME_CHANGE_GAP) changes.push({ removed: [], added: [] });
    const change = changes.at(-1);
    change.removed.push(...ranges(before, edit.aStart, edit.aEnd));
    change.added.push(...ranges(after, edit.bStart, edit.bEnd));
    previous = edit;
  }
  return changes;
}
