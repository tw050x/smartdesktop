// Comments on what's in an item, and on the schematic as a whole. The user starts one with a long
// press (see long-press.js) on an open item on the board: on words they've selected (on those words),
// on its title (on its card: its title and description), elsewhere on its title bar (on all of it),
// on a part of it, such as a diagram's node or a table's row (on that part), or anywhere else in it
// (on that point, the item as its context); or on empty space, on the board or the overview, for the
// schematic as a whole. Words with comments are marked in the comment colour; anything else with
// comments has a marker there, with how many, and clicking either opens them (comment-overlay.js).
// The store keeps them (see store.js); schemas.js decides which comments show where.

const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
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

// --- Cards ----------------------------------------------------------------------------------------

// What a comment is on, in a line at its top: the words quoted, else the part's name.
export function about(target) {
  if (target.quote) return h('span', { className: 'comment-about quote' }, `“${target.quote}”`);
  if (target.part) return h('span', { className: 'comment-about' }, `→ ${target.partName ?? target.part}`);
  if (target.schematic) return h('span', { className: 'comment-about' }, 'On the whole schematic');
  if (target.card) return h('span', { className: 'comment-about' }, 'On its title and description');
  if (target.point) return h('span', { className: 'comment-about' }, 'On this place in it');
  return null;
}

const anchorAttributes = (target) => ({ 'data-part': target.part ?? null, 'data-quote': target.quote ?? null });

// A comment marked "No further action required" folds to one line, its outcome and what it's on,
// and opens again on a click to show what was said. On the board's middle it's always open (see
// look in board-view.js), so a click there does nothing; elsewhere on the board, it says so, for the
// board to give it its new size.
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
      if (event.target.closest('button') || card.closest('.board-item.in-middle')) return;
      card.classList.toggle('unfolded');
      card.dispatchEvent(new CustomEvent('comment-folded', { bubbles: true }));
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

// --- Where comments are ---------------------------------------------------------------------------

const HIGHLIGHTS = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
const BUBBLE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M2,22V4Q2,3.17 2.59,2.59T4,2H20q0.83,0 1.41,0.59T22,4V16q0,0.82-0.59,1.41T20,18H6L2,22Zm3.15-6H20V4H4V17.13L5.15,16ZM4,16V4V16Z"/></svg>';
// Comments none of which needs anything more: a speech bubble with a tick at its corner (the
// user's choice), rather than a faded marker.
const SETTLED = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M17.35,20l-3.53-3.55l1.4-1.4l2.13,2.13l4.25-4.25L23,14.35L17.35,20ZM2,22V4Q2,3.17 2.59,2.59T4,2H20q0.83,0 1.41,0.59T22,4v7H20V4H4V17.13L5.15,16H12v2H6L2,22Zm2-6V4V16Z"/></svg>';

// Comments on the same thing gather together, under one key: the same words, part, point, card or
// item.
export function keyOf(target) {
  if (target.schematic) return 'schematic';
  if (target.card) return `${target.item}|card`;
  if (target.quote) return `${target.item}|quote|${target.quote}`;
  if (target.part && !target.partMissing) return `${target.item}|part|${target.part}`;
  if (target.point) return `${target.item}|point|${target.point.x.toFixed(3)}|${target.point.y.toFixed(3)}`;
  return `${target.item}|item`;
}

// What a point's fractions are of: a diagram's drawing (which moves as it's panned and zoomed), else
// the item's content as laid out.
const pointBox = (body) => body.querySelector('svg.diagram-svg') ?? body.firstElementChild ?? body;

// Where a point's fractions are measured, in the window. Something that scrolls itself (a table's
// holder) counts as all it scrolls through, so the point moves with what's in it.
function pointRect(body) {
  const box = pointBox(body);
  const rect = box.getBoundingClientRect();
  const scrolls = box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight;
  if (!scrolls) return rect;
  return { left: rect.left - box.scrollLeft, top: rect.top - box.scrollTop, width: box.scrollWidth, height: box.scrollHeight };
}

// The text inside `element` is under (x, y): over the words themselves, not just their box.
function overText(element, x, y) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return [...range.getClientRects()].some((rect) => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2);
}

const MOST_QUOTED = 500;

// What a long press at `event` in the open item `element` (a .board-item) is on: words selected there
// and pressed on, its title (its card), the rest of its title bar (all of it), a part, or a point in
// its content. Null if it's on none of those (a button, say).
export function targetAt(element, event) {
  const item = element.dataset.item;
  const full = element.querySelector(':scope > .board-full');
  if (!full) return null;
  const { clientX: x, clientY: y } = event;
  const head = event.target.closest?.('.pane-head');
  if (head && full.contains(head)) {
    if (event.target.closest('.pane-actions, button')) return null;
    const title = head.querySelector('.pane-title h2');
    return title && overText(title, x, y) ? { item, card: true } : { item };
  }
  const body = full.querySelector('.focus-body');
  if (!body || !body.contains(event.target)) return null;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    const inside = [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    const quote = squash(selection.toString()).slice(0, MOST_QUOTED);
    if (inside && quote && body.contains(range.commonAncestorContainer)) return { item, part: partFor(range.startContainer, body), quote };
  }
  const part = event.target.closest('[data-part]');
  if (part && body.contains(part)) return { item, part: part.dataset.part };
  const box = pointRect(body);
  if (!box.width || !box.height) return { item };
  return { item, point: { x: Math.min(1, Math.max(0, (x - box.left) / box.width)), y: Math.min(1, Math.max(0, (y - box.top) / box.height)) } };
}

// Where a group's marker goes, in the window, or null if it can't be placed: by the title for its
// card, at the right of the title bar for all of it, at a part's top right, at a point, or at the end
// of the words for earlier comments on words (current ones are marked in the text instead).
function spotOf(element, group) {
  const full = element.querySelector(':scope > .board-full');
  if (!full) return null;
  const { target } = group;
  const head = full.querySelector('.pane-head');
  if (target.card) {
    const title = head?.querySelector('.pane-title h2');
    if (!title) return null;
    const range = document.createRange();
    range.selectNodeContents(title);
    const rect = range.getBoundingClientRect();
    // After its title and the tags beside it (New, Changed…), so it covers neither.
    const pills = head.querySelector('.pane-title .status-pills')?.getBoundingClientRect();
    const right = pills?.width && Math.abs(pills.top + pills.height / 2 - (rect.top + rect.height / 2)) < rect.height ? Math.max(rect.right, pills.right) : rect.right;
    return { x: right + 6, y: rect.top + rect.height / 2, align: 'left', probe: [rect.right - 3, rect.top + rect.height / 2] };
  }
  const body = full.querySelector('.focus-body');
  const headSpot = () => {
    const rect = head?.getBoundingClientRect();
    if (!rect) return null;
    const actions = head.querySelector('.pane-actions')?.getBoundingClientRect();
    const x = (actions?.width ? actions.left : rect.right) - 6;
    return { x, y: rect.top + rect.height / 2, align: 'right', probe: [x - 3, rect.top + rect.height / 2] };
  };
  if (!body) return headSpot();
  if (target.quote) {
    const at = target.part ? body.querySelector(`[data-part="${CSS.escape(target.part)}"]`) : null;
    const range = findQuote(body, target.quote, at);
    if (!range) return headSpot();
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return last && { x: last.right + 2, y: last.top, align: 'left', probe: [last.right - 2, last.top + 2] };
  }
  if (target.part && !target.partMissing) {
    const part = body.querySelector(`[data-part="${CSS.escape(target.part)}"]`);
    if (!part) return headSpot();
    const rect = part.getBoundingClientRect();
    return { x: rect.right, y: rect.top, align: 'right', probe: [rect.right - 2, rect.top + 2] };
  }
  if (target.point) {
    const box = pointRect(body);
    return { x: box.left + target.point.x * box.width, y: box.top + target.point.y * box.height, align: 'centre' };
  }
  return headSpot();
}

// Watches the board `root`'s comments: `groups` ({ key, target, comments }, each the comments on one
// thing, current and earlier) get a marker each, kept by what they're on as things move, scroll and
// zoom, and words with open comments are marked in the text. Clicking a marker or marked words calls
// `open(group, x, y)`. Without a root, takes everything away. Returns a function that marks things
// again, for an item whose content has only just been drawn.
export function watchComments(root, { groups = [], open = () => {} } = {}) {
  if (HIGHLIGHTS) CSS.highlights.delete('comments');
  if (!root) return () => {};
  // One watch per board: a new one (the board drawn again) stops the one before, or the two would
  // each set the markers every frame and they'd flicker.
  root.stopComments?.();
  let stopped = false;
  let words = []; // { range, group }: the marked words
  const markers = new Map(); // key -> marker
  const mark = () => {
    for (const marker of markers.values()) marker.remove();
    markers.clear();
    words = [];
    for (const group of groups) {
      // An item on the board, or on the overview.
      const element = root.querySelector(`:is(.board > .board-item, .overview-world > .overview-item)[data-item="${CSS.escape(group.target.item)}"]`);
      const body = element?.querySelector(':scope > .board-full .focus-body');
      if (!element) continue;
      const current = group.comments.filter((comment) => !comment.earlier);
      const waiting = current.filter(isOpen).length;
      // Words with comments on this draft are marked in the text; earlier ones get a marker.
      if (group.target.quote && current.length && body) {
        const at = group.target.part ? body.querySelector(`[data-part="${CSS.escape(group.target.part)}"]`) : null;
        const range = findQuote(body, group.target.quote, at);
        if (range) {
          if (waiting) words.push({ range, group });
          else words.push({ range, group, settled: true });
          continue;
        }
      }
      const label = waiting ? (waiting === 1 ? '1 comment' : `${waiting} comments`) : current.length ? 'Comments, none needing anything' : 'An earlier comment';
      const marker = h('button', { className: `comment-marker${waiting ? '' : current.length ? ' settled' : ' earlier'}`, type: 'button', title: label, 'aria-label': label });
      marker.innerHTML = !waiting && current.length ? SETTLED : BUBBLE;
      if (waiting > 1) marker.append(String(waiting));
      marker.addEventListener('pointerdown', (event) => event.stopPropagation());
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = marker.getBoundingClientRect();
        open(group, rect.right, rect.top);
      });
      // On the board, not in the item, so it can hang over the item's edge rather than be cut off.
      marker.group = group;
      marker.item = element;
      marker.classList.add('away');
      root.append(marker);
      markers.set(group.key, marker);
    }
    if (HIGHLIGHTS) {
      const live = words.filter((one) => !one.settled).map((one) => one.range);
      if (live.length) CSS.highlights.set('comments', new Highlight(...live));
    }
  };
  // Markers follow what they're on, every frame, as items glide, scroll, pan and zoom.
  const follow = () => {
    if (stopped) return;
    if (!root.isConnected) {
      if (HIGHLIGHTS) CSS.highlights.delete('comments');
      return;
    }
    const board = root.getBoundingClientRect();
    for (const marker of markers.values()) {
      const element = marker.item;
      const spot = element?.isConnected && !element.classList.contains('is-card') ? spotOf(element, marker.group) : null;
      // Shown only while what it's on can be seen: not scrolled or panned out of its item, nor
      // under another item. It fades in and out, and may hang over the item's edge.
      const [px, py] = spot?.probe ?? [spot?.x, spot?.y];
      const under = spot ? document.elementsFromPoint(px, py).find((hit) => !hit.closest('.comment-marker')) : null;
      // A card's drawer, or the card floating over full screen, covers what's under it too.
      const seen = Boolean(under && element.contains(under) && !under.closest('.card-drawer, .change-float'));
      marker.classList.toggle('away', !seen);
      marker.style.zIndex = element?.style.zIndex || '1';
      if (!spot) continue;
      // On something zoomed out (the overview), markers shrink with it, though not out of sight.
      const k = root.markerScale?.() ?? 1;
      marker.style.transformOrigin = '0 0';
      const width = (marker.offsetWidth || 36) * k;
      const height = (marker.offsetHeight || 36) * k;
      const left = spot.align === 'right' ? spot.x - width : spot.align === 'centre' ? spot.x - width / 2 : spot.x;
      const top = spot.y - height / 2;
      marker.style.transform = `translate(${Math.round(left - board.left)}px, ${Math.round(top - board.top)}px)${k === 1 ? '' : ` scale(${k})`}`;
    }
    requestAnimationFrame(follow);
  };
  // Clicking marked words opens their comments, unless the click was picking words.
  const onClick = (event) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const hit = words.find(({ range }) => [...range.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
    if (!hit || event.target.closest('a[href]')) return;
    event.stopPropagation();
    open(hit.group, event.clientX, event.clientY);
  };
  root.addEventListener('click', onClick);
  root.stopComments = () => {
    stopped = true;
    for (const marker of markers.values()) marker.remove();
    markers.clear();
    root.removeEventListener('click', onClick);
  };
  mark();
  requestAnimationFrame(follow);
  // Marking again after stopping would put back markers nothing moves.
  return () => {
    if (!stopped) mark();
  };
}
