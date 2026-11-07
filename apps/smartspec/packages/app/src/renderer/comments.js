// Comments on what's in an item. On the board, the user picks something in an item's content (a
// diagram's part or a table's row by clicking it, or words by selecting them; right-clicking works on
// anything, links too), and a Comment button by it opens the item's comments box to write one (see
// card-comments.js). What has comments needing something is marked in the content.
// Each says what it's on (the words quoted, or the part), what the user said, and the AI's replies.
// The store keeps them (see store.js); schemas.js decides which comments show where.


const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const MOST_QUOTED = 500;
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

// A comment still needs something done about it until it's marked "No further action required",
// by the AI when it replies or by the user (see store.js).
export const isOpen = (comment) => !comment.noFurtherAction;

// How the AI dealt with a comment, in its own words, as a tag.
export const outcomeTag = (comment) => comment.outcome && h('span', { className: 'comment-outcome', title: `How it was dealt with: ${comment.outcome}` }, comment.outcome);

// What a comment is waiting for: the AI's answer, or nothing.
export const waitingLine = (comment) => isOpen(comment) && !comment.replies?.length && h('span', { className: 'comment-waiting' }, 'Waiting for the AI');

// The button that marks a comment as needing no further action, or opens it again.
export function noFurtherActionButton(comment, onNoFurtherAction) {
  if (!onNoFurtherAction) return null;
  const done = !isOpen(comment);
  const words = done ? 'Needs more: open it again' : 'No further action required';
  const button = h('button', { className: 'icon-button comment-done', type: 'button', title: words, 'aria-label': words, 'aria-pressed': String(done) });
  button.innerHTML = CHECK_ICON;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onNoFurtherAction(comment, !done);
  });
  return button;
}

// The AI's replies under a comment: who, what it said, and any outcome it gave with it.
export const repliesOf = (comment) => comment.replies?.length > 0 && h('div', { className: 'comment-replies' }, ...comment.replies.map((reply) => h('div', { className: 'comment-reply' },
  h('strong', {}, reply.author), reply.text && h('span', {}, reply.text), !reply.text && reply.outcome && h('span', { className: 'comment-reply-outcome' }, reply.outcome))));

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (key === 'className') element.className = value;
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// --- Finding what a comment is on ----------------------------------------------------------------

const squash = (text) => text.replace(/\s+/g, ' ').trim();

// The words `quote` in `root`, as a range: the first time they appear at or after `after` (an
// element), else the first time anywhere. Spacing doesn't matter, as a selection's text and the
// page's can space them differently.
export function findQuote(root, quote, after = null) {
  const wanted = squash(quote ?? '');
  if (!wanted) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // The page's text with its spacing squashed, and where each character of it came from.
  let text = '';
  const from = [];
  let space = true;
  let block = null;
  let last = null;
  const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dd, dt';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Blocks are apart, even when nothing in the text spaces them.
    const here = node.parentElement?.closest(BLOCKS) ?? null;
    if (last && here !== block && !space) {
      space = true;
      text += ' ';
      from.push([last, last.nodeValue.length - 1]);
    }
    block = here;
    last = node;
    const value = node.nodeValue;
    for (let i = 0; i < value.length; i++) {
      if (/\s/.test(value[i])) {
        if (space) continue;
        space = true;
        text += ' ';
      } else {
        space = false;
        text += value[i];
      }
      from.push([node, i]);
    }
  }
  let start = -1;
  if (after) {
    for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
      const [node] = from[at];
      if (after.contains(node) || after.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        start = at;
        break;
      }
    }
  }
  if (start === -1) start = text.indexOf(wanted);
  if (start === -1) return null;
  const [startNode, startOffset] = from[start];
  const [endNode, endOffset] = from[start + wanted.length - 1];
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, Math.min(endNode.nodeValue.length, endOffset + 1));
  return range;
}

// The heading a place in a document comes under, or the part (a table's row) it's inside.
function partFor(node, body) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const inside = element?.closest('[data-part]');
  if (inside && body.contains(inside) && !/^H[1-6]$/.test(inside.tagName)) return inside.dataset.part;
  let heading = null;
  for (const one of body.querySelectorAll('h1[data-part], h2[data-part], h3[data-part], h4[data-part], h5[data-part], h6[data-part]')) {
    if (one === element || one.contains(node) || one.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) heading = one;
    else break;
  }
  return heading?.dataset.part ?? null;
}

// --- Picking something to comment on --------------------------------------------------------------

let button = null;
let picked = null; // { target, element }

function commentButton() {
  if (button?.isConnected) return button;
  button = h('button', { className: 'comment-start', type: 'button', hidden: '' }, 'Comment');
  button.addEventListener('mousedown', (event) => event.preventDefault()); // keeps the selection
  document.body.append(button);
  return button;
}

function forget() {
  picked?.element?.classList.remove('picked');
  picked = null;
  if (button) button.hidden = true;
}

// The button just above where `rect` ends, in the window.
function offerAt(rect, target, element, start) {
  forget();
  picked = { target, element };
  element?.classList.add('picked');
  const offer = commentButton();
  offer.onclick = () => {
    const { target: chosen } = picked ?? {};
    forget();
    window.getSelection()?.removeAllRanges();
    if (chosen) start(chosen);
  };
  offer.hidden = false;
  const width = offer.offsetWidth;
  const height = offer.offsetHeight;
  const left = Math.min(innerWidth - width - 8, Math.max(8, rect.right - width / 2));
  const top = rect.top - height - 6 >= 8 ? rect.top - height - 6 : rect.bottom + 6;
  Object.assign(offer.style, { left: `${left}px`, top: `${top}px` });
}

// Lets the user pick something in an item's content on the board to comment on. `start(target)`
// begins a comment on `{ item, part, quote }`.
const BODIES = '.board-item > .board-full .focus-body';
function watchPicking(root, start) {
  const bodyAt = (node) => {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const body = element?.closest?.(BODIES);
    return body && root.contains(body) ? body : null;
  };
  const itemOf = (body) => body.closest('.board-item').dataset.item;
  const selected = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const body = bodyAt(range.commonAncestorContainer);
    if (!body) return null;
    const quote = squash(selection.toString()).slice(0, MOST_QUOTED);
    return quote ? { range, quote, body } : null;
  };
  const offerSelection = () => {
    const chosen = selected();
    if (!chosen) return false;
    const rects = chosen.range.getClientRects();
    const rect = rects[rects.length - 1] ?? chosen.range.getBoundingClientRect();
    offerAt(rect, { item: itemOf(chosen.body), part: partFor(chosen.range.startContainer, chosen.body), quote: chosen.quote }, null, start);
    return true;
  };
  // Words, once the mouse lets go of them, or the keyboard has selected them.
  root.addEventListener('mouseup', (event) => {
    if (!bodyAt(event.target)) return;
    setTimeout(() => {
      if (!offerSelection() && !picked?.element) forget();
    });
  });
  root.addEventListener('keyup', (event) => {
    if (event.shiftKey && bodyAt(event.target)) offerSelection();
  });
  // A part, by clicking it: not one that links somewhere, which a click follows (right-click those).
  root.addEventListener('click', (event) => {
    const body = bodyAt(event.target);
    if (!body || event.target.closest('a[href]')) return;
    const part = event.target.closest('[data-part]');
    if (!part || !body.contains(part) || part.classList.contains('part-link') || /^H[1-6]$/.test(part.tagName)) {
      if (!selected()) forget();
      return;
    }
    if (selected()) return;
    offerAt(part.getBoundingClientRect(), { item: itemOf(body), part: part.dataset.part }, part, start);
  });
  root.addEventListener('contextmenu', (event) => {
    const body = bodyAt(event.target);
    if (!body) return;
    if (offerSelection()) return event.preventDefault();
    const part = event.target.closest('[data-part]');
    const item = itemOf(body);
    const target = part && body.contains(part) ? { item, part: part.dataset.part } : { item };
    event.preventDefault();
    offerAt({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }, target, part && body.contains(part) ? part : null, start);
  });
}

// Anything else the user does puts the offer away.
let watchingWindow = false;
function watchWindow() {
  if (watchingWindow) return;
  watchingWindow = true;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picked) forget();
  });
  document.addEventListener('scroll', () => picked && forget(), true);
  document.addEventListener('mousedown', (event) => {
    if (picked && !event.target.closest?.('.comment-start, .focus-body')) forget();
  });
}

// --- Cards ----------------------------------------------------------------------------------------

// What a comment is on, in a line at its top: the words quoted, else the part's name.
export function about(target) {
  if (target.quote) return h('span', { className: 'comment-about quote' }, `“${target.quote}”`);
  if (target.part) return h('span', { className: 'comment-about' }, `→ ${target.partName ?? target.part}`);
  return null;
}

const anchorAttributes = (target) => ({ 'data-part': target.part ?? null, 'data-quote': target.quote ?? null });

// A comment marked "No further action required" folds to one line, its outcome and what it's on,
// and opens again on a click to show what was said.
export function commentCard(comment, { onDelete, onNoFurtherAction }) {
  const gone = comment.target.partMissing || comment.target.missing;
  const done = !isOpen(comment);
  const remove = h('button', { className: 'icon-button comment-delete', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment', onclick: (event) => {
    event.stopPropagation();
    onDelete(comment);
  } });
  remove.innerHTML = TRASH_ICON;
  const card = h('div', { className: `focus-neighbour comment-card${done ? ' done' : ''}`, 'data-comment': comment.id, ...anchorAttributes(gone ? {} : comment.target), role: 'note', 'aria-label': done ? 'Comment, no further action required' : 'Comment' },
    h('span', { className: 'comment-top' }, done && (outcomeTag(comment) || h('span', { className: 'comment-outcome' }, 'No further action')), about(comment.target) ?? h('span', { className: 'comment-about' }, 'On all of it'), noFurtherActionButton(comment, onNoFurtherAction), remove),
    gone && h('span', { className: 'comment-gone' }, comment.target.missing ? `It was on ${comment.target.item}, which has been removed.` : 'That part is no longer here.'),
    h('p', { className: 'comment-text' }, comment.text),
    !done && (outcomeTag(comment) || waitingLine(comment)),
    repliesOf(comment));
  if (done) {
    card.title = 'No further action required. Click to see it.';
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      card.classList.toggle('unfolded');
    });
  }
  return card;
}

// Where an earlier comment is from, as a line on its card.
export const earlierLine = (comment) => h('span', { className: 'comment-earlier-from' }, `Earlier comment · from Draft ${comment.earlier.draft}`);

// The button that says an earlier comment again, on what's showing; none where nothing can be commented.
export function againButton(comment, onAgain) {
  if (!onAgain) return null;
  return h('button', { className: 'link-button comment-again', type: 'button', onclick: (event) => {
    event.stopPropagation();
    onAgain(comment);
  } }, 'Comment again');
}

// --- Marking what has comments --------------------------------------------------------------------

const HIGHLIGHTS = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

// Lets the user pick things to comment on in the items on the board `root`, and marks what each of
// `marks` ({ item, part, quote }: open comments on this draft or proposal) is on. Without a root,
// takes the marks away. Returns a function that marks them again, for an item whose content has
// only just been drawn.
export function watchComments(root, { start = null, marks = [] } = {}) {
  forget();
  const clear = () => {
    if (HIGHLIGHTS) CSS.highlights.delete('comments');
    for (const one of root?.querySelectorAll('.commented') ?? []) one.classList.remove('commented');
  };
  if (HIGHLIGHTS) CSS.highlights.delete('comments');
  if (!root) return () => {};
  watchWindow();
  if (start) watchPicking(root, start);
  const mark = () => {
    clear();
    const ranges = [];
    for (const { item, part, quote } of marks) {
      const body = root.querySelector(`.board-item[data-item="${CSS.escape(item)}"] > .board-full .focus-body`);
      if (!body) continue;
      const element = part ? body.querySelector(`[data-part="${CSS.escape(part)}"]`) : null;
      const end = (quote && findQuote(body, quote, element)) || element;
      if (!end) continue;
      if (end.nodeType) end.classList.add('commented');
      else ranges.push(end);
    }
    if (HIGHLIGHTS && ranges.length) CSS.highlights.set('comments', new Highlight(...ranges));
  };
  mark();
  return mark;
}
