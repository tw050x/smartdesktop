// What's in a topic: its cards, each one question and its answer in Markdown, and the links between
// them. Plain data and no Node or Electron, as the store and the interface both use it.
//
// A card's id is a short slug ("event-loop"), the AI's own or made from its title, and a link is
// `card` or `card#heading`: a card, or a heading inside its answer (as a slug). `#heading` alone is
// a heading in the same card. The question a card answers is shown above its answer, as the card's
// own, so it isn't a heading anything links to.

export const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const QUESTION_MAX = 500;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 300;

// A heading's id, and a card's when it's made from its title. `_` goes too, so it's the same for
// the source and the rendered text (as SmartSpec's).
export const slug = (text) => String(text ?? '').toLowerCase().replace(/_/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

// A card's id from its title: a slug, short, and only the letters a link can carry.
export function cardIdFrom(title) {
  const made = slug(title).normalize('NFKD').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return made || 'card';
}

// Fenced code and inline code, which hold no links or headings.
const CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$|`[^`\n]*`/gm;
const withoutCode = (markdown) => String(markdown ?? '').replace(CODE, (code) => code.replace(/[^\n]/g, ' '));

// A link's or emphasis's marks taken out of a bit of Markdown, leaving what it reads as.
const plainHeading = (markdown) => markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*~`]/g, '');

// The headings in some Markdown, as written, and as the slugs links use.
export function headingsOf(markdown) {
  return [...withoutCode(markdown).matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((match) => plainHeading(match[1]));
}
export const headingSlugs = (markdown) => headingsOf(markdown).map(slug);

// Whether a link in Markdown is to a card: no scheme, and not a path.
export const isInternalLink = (href) => Boolean(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('//');

// The links to cards in some Markdown, leaving out images and code: [{ to, label }].
export function markdownLinks(markdown) {
  return [...withoutCode(markdown).matchAll(/(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g)]
    .filter((match) => isInternalLink(match[2]))
    .map((match) => ({ to: match[2], label: match[1] }));
}

// Splits a link, resolving `#heading` to the card it's in.
export function parseLink(link, fromCard = null) {
  const at = link.indexOf('#');
  const target = at === -1 ? link : link.slice(0, at);
  return { target: target || fromCard, part: at === -1 ? null : link.slice(at + 1) || null };
}

// The links out of a card, each as `card` or `card#heading`, with what it says.
export const linksOf = (card) => markdownLinks(card.content).map(({ to, label }) => {
  const { target, part } = parseLink(to, card.id);
  return { to: part ? `${target}#${part}` : target, label };
});

// Every link that goes nowhere among `cards`: each with where it is (its card and the link as
// written), and why. Empty if they all work.
export function brokenLinks(cards) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const broken = [];
  for (const card of cards) {
    for (const { to, label } of markdownLinks(card.content)) {
      const { target, part } = parseLink(to, card.id);
      const linked = byId.get(target);
      if (!linked) broken.push({ card: card.id, link: `[${label}](${to})`, why: `there's no card ${target}` });
      else if (part && !headingSlugs(linked.content).includes(part)) {
        const headings = headingSlugs(linked.content);
        broken.push({ card: card.id, link: `[${label}](${to})`, why: `${target} has no heading ${part} (its headings: ${headings.join(', ') || 'none'})` });
      }
    }
  }
  return broken;
}

// The parts of some Markdown that the words a user quoted mustn't be linked inside: code, links and
// images (what they say and where they go), autolinks and HTML tags. As [start, end) ranges.
function untouchable(markdown) {
  const ranges = [];
  for (const pattern of [CODE, /!?\[[^\]]*\]\([^)]*\)/g, /<[^>\n]+>/g, /^ {0,3}\[[^\]]+\]:.*$/gm]) {
    for (const match of markdown.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The words `quote` (as the user picked them, spacing aside) turned into a link to `to`, where they
// first appear in `markdown` outside a link or code. Returns the new Markdown, or null if the words
// aren't there as written (picked across formatting, say, or from the card's question).
export function linkQuote(markdown, quote, to) {
  const words = String(quote ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const source = String(markdown ?? '');
  const blocked = untouchable(source);
  // Whole words only: "event" isn't linked inside "prevent".
  const before = /^[\p{L}\p{N}]/u.test(words[0]) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = /[\p{L}\p{N}]$/u.test(words.at(-1)) ? '(?![\\p{L}\\p{N}])' : '';
  // Bold and italic markers (* and _) may come between any of the words' characters, as picked text
  // has none: a whole sentence picked often runs over some.
  const EMPHASIS = '[*_]{0,3}';
  const word = (one) => [...one].map(escapeRegExp).join(EMPHASIS);
  // Markers just round the words are taken in too, so emphasis on the first or last word is kept whole.
  const pattern = new RegExp(`${before}${EMPHASIS}${words.map(word).join(`${EMPHASIS}\\s+${EMPHASIS}`)}${EMPHASIS}${after}`, 'gu');
  // The emphasis markers a match takes in beyond the words' own characters, as runs ("**", "_"):
  // each closing one must close one opened inside the match, and none be left open. As Markdown
  // tells them apart, a run with a space after it closes, one with a space before it opens, and one
  // inside a word closes what's open, else opens.
  const letters = words.join('');
  const balanced = (text) => {
    const open = [];
    let ok = true;
    let run = '';
    let runAt = 0;
    let at = 0;
    const close = (i) => {
      if (!run) return;
      const before = text[runAt - 1] ?? ' ';
      const after = text[i] ?? ' ';
      const closes = /\s/.test(after) || (!/\s/.test(before) && open.at(-1) === run);
      if (!closes) open.push(run);
      else if (open.at(-1) === run) open.pop();
      else ok = false;
      run = '';
    };
    [...text].forEach((char, i) => {
      if (at < letters.length && char === letters[at]) {
        close(i);
        at++;
      } else if (char === '*' || char === '_') {
        if (!run) runAt = i;
        run += char;
      } else close(i);
    });
    close(text.length);
    return ok && !open.length;
  };
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (blocked.some(([from, until]) => start < until && end > from)) continue;
    // Not where a link's brackets would break it, nor across a paragraph break.
    if (/[[\]]/.test(match[0]) || /\n\s*\n/.test(match[0])) continue;
    // Nor where it would take in one end of some emphasis but not the other.
    if (!balanced(match[0])) continue;
    return `${source.slice(0, start)}[${match[0]}](${to})${source.slice(end)}`;
  }
  return null;
}
