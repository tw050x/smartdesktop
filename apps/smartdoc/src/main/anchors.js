// Text anchors point at exact text on a page: { page, start, end, text }, where start/end are
// character offsets into the page's text. A page's text is its text items joined in order, with
// a newline after each item that ends a line. The window builds the same string from pdf.js's text
// layer (see src/renderer/anchors.js), so offsets match the highlighted spans exactly.

// Finds `quote` on `page` (whitespace-insensitive, so a quote may span line breaks) and returns its
// anchor. `occurrence` picks the nth match (1-based) when the quote appears more than once.
export function resolveQuote(pages, { page, quote, occurrence = 1 }) {
  const text = pages?.[page - 1];
  if (text === undefined) throw new Error(`Page ${page} doesn't exist (the document has ${pages?.length ?? 0} pages).`);
  const pattern = quote.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  if (!pattern) throw new Error('The quote is empty.');
  const matches = [...text.matchAll(new RegExp(pattern, 'g'))];
  if (!matches.length) throw new Error(`"${quote}" wasn't found on page ${page}. Quote the page text exactly (see get_document).`);
  const match = matches[occurrence - 1];
  if (!match) throw new Error(`"${quote}" appears ${matches.length} time(s) on page ${page}; occurrence ${occurrence} doesn't exist.`);
  return { page, start: match.index, end: match.index + match[0].length, text: match[0] };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
