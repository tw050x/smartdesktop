// Working with a document's page texts for the AI: counting, choosing pages and searching. Page
// texts are pdf.js text items joined in order, with a newline after each item that ends a line
// (see anchors.js), so a line of text is a line here, but paragraphs aren't marked and are
// estimated.

// The most text the AI is given in one read: about 15,000 tokens, safely under what AI apps accept
// from a tool (Claude Code's default cap is 25,000 tokens).
export const MAX_READ_CHARS = 60000;
export const estimateTokens = (characters) => Math.ceil(characters / 4);

const SENTENCE_END = /[.!?:;"”’)\]]$/;
const LIST_START = /^(?:[•▪◦‣–—*-]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,5}[.)])\s/i;

export function textStats(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    words: text.match(/\S+/g)?.length ?? 0,
    characters: text.length,
    lines: lines.length,
    paragraphs: countParagraphs(lines),
  };
}

// A paragraph ends at a line that ends a sentence and falls short of a full line (the last line of
// a block of text), at a short line such as a heading, or before a list item. A full line is about
// as long as the page's longest lines (the 90th percentile, so one stray long line doesn't count).
function countParagraphs(lines) {
  if (!lines.length) return 0;
  const lengths = lines.map((l) => l.length).sort((a, b) => a - b);
  const full = lengths[Math.floor((lengths.length - 1) * 0.9)];
  let count = 0;
  lines.forEach((line, i) => {
    const next = lines[i + 1];
    const short = line.length < full * 0.9;
    if (!next || LIST_START.test(next) || (short && (SENTENCE_END.test(line) || line.length < full * 0.5))) count++;
  });
  return count;
}

// Page choices like "3", "5-9" or "1-3, 12", as a sorted list of page numbers.
export function parsePages(spec, pageCount) {
  const pages = new Set();
  for (const part of String(spec).split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!match) throw new Error(`"${part}" isn't a page or a range of pages. Use for example "3", "5-9" or "1-3, 12".`);
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to > pageCount || from > to) throw new Error(`Pages ${part} aren't in the document, which has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
    for (let n = from; n <= to; n++) pages.add(n);
  }
  if (!pages.size) throw new Error('Name the pages to read, for example "3", "5-9" or "1-3, 12".');
  return [...pages].sort((a, b) => a - b);
}

// Every match of a word or phrase (case and spacing ignored) as { page, match, snippet }: the exact
// text matched, which can be quoted as it is, and the text around it.
const SNIPPET = 80;
export function findText(texts, query, limit) {
  const words = String(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('Give a word or phrase to find.');
  const pattern = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi');
  const matches = [];
  let total = 0;
  texts.forEach((text, i) => {
    for (const m of text.matchAll(pattern)) {
      total++;
      if (matches.length >= limit) continue;
      const before = text.slice(Math.max(0, m.index - SNIPPET), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + SNIPPET);
      const snippet = `${m.index > SNIPPET ? '…' : ''}${before}${m[0]}${after}${m.index + m[0].length + SNIPPET < text.length ? '…' : ''}`;
      matches.push({ page: i + 1, match: m[0], snippet: snippet.replace(/\s+/g, ' ') });
    }
  });
  return { query: String(query).trim(), total, matches, ...(total > matches.length && { more: `${total - matches.length} more not shown; search for something more specific.` }) };
}
