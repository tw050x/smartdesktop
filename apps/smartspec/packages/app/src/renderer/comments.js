// Comments in the item view. The user picks something in the middle (a diagram's part or a table's
// row by clicking it, or words by selecting them; right-clicking works on anything, links too), and a
// Comment button by it starts a comment card in a side column, level with it, among the link cards.
// What has comments is marked in the middle, and pointing at it lights up their cards; pointing at a
// comment's card lights up what it's on.
// Each card says what it's on (the words quoted, or the part), what the user said, and the AI's
// replies. The store keeps them (see store.js); schemas.js decides which comments show where.


const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const MOST_QUOTED = 500;

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

const partIn = (middle, part) => (part ? middle.querySelector(`.focus-body [data-part="${CSS.escape(part)}"]`) : null);

// What a comment card sits level with in the middle: the words it quotes, else its part, else
// nothing (it's on the item as a whole). Worked out once, while the page stays as it is.
export function commentEnds(card, middle) {
  if (!card.anchor || (card.anchor.nodeType && !card.anchor.isConnected)) {
    const part = partIn(middle, card.dataset.part);
    const body = middle.querySelector('.focus-body');
    card.anchor = (card.dataset.quote && body && findQuote(body, card.dataset.quote, part)) || part || 'none';
  }
  return card.anchor === 'none' ? [] : [card.anchor];
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

// Lets the user pick something in the stage's middle to comment on. `start(target)` begins a comment
// on `{ item, part, quote }`.
function watchPicking(stage, item, start) {
  const middle = stage.querySelector(':scope > .focus-card');
  const body = middle?.querySelector('.focus-body');
  if (!body) return;
  const selected = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return null;
    const quote = squash(selection.toString()).slice(0, MOST_QUOTED);
    return quote ? { range, quote } : null;
  };
  const offerSelection = () => {
    const chosen = selected();
    if (!chosen) return false;
    const rects = chosen.range.getClientRects();
    const rect = rects[rects.length - 1] ?? chosen.range.getBoundingClientRect();
    offerAt(rect, { item, part: partFor(chosen.range.startContainer, body), quote: chosen.quote }, null, start);
    return true;
  };
  // Words, once the mouse lets go of them, or the keyboard has selected them.
  body.addEventListener('mouseup', () => setTimeout(() => {
    if (!offerSelection() && !picked?.element) forget();
  }));
  body.addEventListener('keyup', (event) => {
    if (event.shiftKey) offerSelection();
  });
  // A part, by clicking it: not one that links somewhere, which a click follows (right-click those).
  body.addEventListener('click', (event) => {
    if (event.target.closest('a[href]')) return;
    const part = event.target.closest('[data-part]');
    if (!part || !body.contains(part) || part.classList.contains('part-link') || /^H[1-6]$/.test(part.tagName)) {
      if (!selected()) forget();
      return;
    }
    if (selected()) return;
    offerAt(part.getBoundingClientRect(), { item, part: part.dataset.part }, part, start);
  });
  body.addEventListener('contextmenu', (event) => {
    if (offerSelection()) return event.preventDefault();
    const part = event.target.closest('[data-part]');
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
    if (picked && !event.target.closest?.('.comment-start, .focus-card .focus-body')) forget();
  });
}

// --- Cards ----------------------------------------------------------------------------------------

// What a comment is on, in a line at its top: the words quoted, else the part's name.
function about(target) {
  if (target.quote) return h('span', { className: 'comment-about quote' }, `“${target.quote}”`);
  if (target.part) return h('span', { className: 'comment-about' }, `→ ${target.partName ?? target.part}`);
  return null;
}

const anchorAttributes = (target) => ({ 'data-part': target.part ?? null, 'data-quote': target.quote ?? null });

export function commentCard(comment, { onDelete }) {
  const gone = comment.target.partMissing || comment.target.missing;
  const remove = h('button', { className: 'icon-button comment-delete', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment', onclick: () => onDelete(comment) });
  remove.innerHTML = TRASH_ICON;
  return h('div', { className: 'focus-neighbour comment-card', 'data-comment': comment.id, ...anchorAttributes(gone ? {} : comment.target), role: 'note', 'aria-label': 'Comment' },
    h('span', { className: 'comment-top' }, about(comment.target) ?? h('span', { className: 'comment-about' }, 'On all of it'), remove),
    gone && h('span', { className: 'comment-gone' }, comment.target.missing ? `It was on ${comment.target.item}, which has been removed.` : 'That part is no longer here.'),
    h('p', { className: 'comment-text' }, comment.text),
    comment.replies?.length > 0 && h('div', { className: 'comment-replies' }, ...comment.replies.map((reply) => h('div', { className: 'comment-reply' },
      h('strong', {}, reply.author), h('span', {}, reply.text)))));
}

// A comment being written: `draft` is { target, text }, kept by the caller so a redraw keeps it.
export function composerCard(draft, { onSave, onCancel }) {
  const field = h('textarea', { className: 'comment-input', rows: '3', 'aria-label': 'Your comment', placeholder: 'What should change, or what do you want to ask?' });
  field.value = draft.text ?? '';
  const save = h('button', { className: 'primary-button', type: 'button', disabled: !field.value.trim() || null }, 'Comment');
  field.addEventListener('input', () => {
    draft.text = field.value;
    save.disabled = !field.value.trim();
  });
  const send = () => field.value.trim() && onSave(field.value.trim());
  save.addEventListener('click', send);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  });
  const card = h('div', { className: 'focus-neighbour comment-card composing', 'data-comment': 'new', ...anchorAttributes(draft.target) },
    about(draft.target),
    field,
    h('span', { className: 'comment-actions' }, h('button', { className: 'secondary-button', type: 'button', onclick: onCancel }, 'Cancel'), save));
  card.focusField = () => field.focus({ preventScroll: true });
  return card;
}

// --- Marking what has comments --------------------------------------------------------------------

const HIGHLIGHTS = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

// Marks what each comment card in the stage is on, and lights one up while pointing at its card.
// Without a stage, takes the marks away. `start(target)` begins a comment, `item` being what's in
// the middle; with neither, nothing can be picked (full screen).
export function watchComments(stage, { item = null, start = null } = {}) {
  if (HIGHLIGHTS) {
    CSS.highlights.delete('comments');
    CSS.highlights.delete('comment-lit');
  }
  forget();
  if (!stage) return;
  watchWindow();
  const middle = stage.querySelector(':scope > .focus-card');
  if (!middle) return;
  if (item && start) watchPicking(stage, item, start);
  const cards = [...stage.querySelectorAll('.focus-side .comment-card')];
  const ranges = [];
  for (const card of cards) {
    const [end] = commentEnds(card, middle);
    if (!end) continue;
    if (end.nodeType) end.classList.add('commented');
    else ranges.push(end);
  }
  if (HIGHLIGHTS && ranges.length) CSS.highlights.set('comments', new Highlight(...ranges));
  watchMarks(middle, cards);
  for (const card of cards) {
    card.addEventListener('mouseenter', () => {
      const [end] = commentEnds(card, middle);
      if (!end) return;
      if (end.nodeType) end.classList.add('comment-lit');
      else if (HIGHLIGHTS) CSS.highlights.set('comment-lit', new Highlight(end));
    });
    card.addEventListener('mouseleave', () => {
      for (const lit of middle.querySelectorAll('.comment-lit')) lit.classList.remove('comment-lit');
      if (HIGHLIGHTS) CSS.highlights.delete('comment-lit');
    });
  }
}

// Pointing at something with comments lights up their side cards. Words have no element of their
// own, so where the pointer is is checked against where they are.
function watchMarks(middle, cards) {
  const body = middle.querySelector('.focus-body');
  if (!body || !cards.length) return;
  let showing = '';
  const stop = () => {
    if (!showing) return;
    showing = '';
    for (const card of cards) card.classList.remove('comment-pointed');
  };
  const under = (event) => cards.filter((card) => {
    const [end] = commentEnds(card, middle);
    if (!end) return false;
    if (end.nodeType) return end.contains(event.target);
    return [...end.getClientRects()].some((r) => event.clientX >= r.left - 1 && event.clientX <= r.right + 1 && event.clientY >= r.top - 1 && event.clientY <= r.bottom + 1);
  });
  body.addEventListener('mousemove', (event) => {
    const found = under(event);
    const key = found.map((card) => card.dataset.comment).join();
    if (key === showing) return;
    stop();
    showing = key;
    for (const card of found) card.classList.add('comment-pointed');
  });
  body.addEventListener('mouseleave', stop);
}
