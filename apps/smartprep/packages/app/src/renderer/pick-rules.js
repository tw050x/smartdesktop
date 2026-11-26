// The rules for picking more words by double-clicking (the user's), on a paragraph's text alone, so
// they can be tested without a page (picking.js applies them to the page). Offsets are into the
// paragraph's text; a span is [start, end).

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

// The paragraph's sentences, each without the spacing round it.
export function sentencesOf(text) {
  const out = [];
  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    const lead = segment.length - segment.trimStart().length;
    const body = segment.trim();
    if (body) out.push([index + lead, index + lead + body.length]);
  }
  return out;
}

// The word at an offset (a caret just after a word's last letter is still on it), or null on
// spacing or punctuation.
export function wordAt(text, at) {
  let edge = null;
  for (const { segment, index, isWordLike } of wordSegmenter.segment(text)) {
    if (!isWordLike) continue;
    const end = index + segment.length;
    if (at >= index && at < end) return [index, end];
    if (at === end) edge = [index, end];
  }
  return edge;
}

// The sentence at an offset, or null on spacing between sentences.
export function sentenceAt(text, at) {
  const sentences = sentencesOf(text);
  return sentences.find(([start, end]) => at >= start && at < end) ?? sentences.find(([, end]) => at === end) ?? null;
}

// What a double-click on the span picked makes it: a word (or any part of a sentence) grows to the
// whole sentences it's in; one whole sentence to it and the sentences either side (only one side
// at the start or end of the paragraph); two or more whole sentences to the whole paragraph. The
// whole paragraph grows no further (null), nor does anything in a paragraph with no sentences.
export function grow(text, [from, to]) {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  const sentences = sentencesOf(text);
  const touched = sentences.flatMap(([start, end], i) => (start < to && end > from ? [i] : []));
  if (!touched.length) return null;
  const first = touched[0];
  const last = touched.at(-1);
  if (from !== sentences[first][0] || to !== sentences[last][1]) return [sentences[first][0], sentences[last][1]];
  if (first === 0 && last === sentences.length - 1) return null;
  if (first === last) return [sentences[Math.max(0, first - 1)][0], sentences[Math.min(sentences.length - 1, last + 1)][1]];
  return [sentences[0][0], sentences.at(-1)[1]];
}
