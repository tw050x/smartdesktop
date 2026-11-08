// The comments on one thing, in a box over the page by where the user pressed: what was said, the
// AI's replies with how it dealt with each, "No further action required", and a field to write
// another. Opened by a long press (to write one) or by clicking a comment marker or commented words
// (see comments.js). One box for the window. After a change the page is drawn again, and the box is
// drawn again from it (refreshThread), so it stays open on the same thing.

import { about, againButton, earlierLine, isOpen, noFurtherActionButton, outcomeTag, repliesOf, waitingLine } from './comments.js';

const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const GAP = 12;

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

let box = null;
let showing = null; // { key, x, y }: what the box is on, and where it was opened

export function closeThread() {
  box?.remove();
  box = null;
  showing = null;
}

// Beside the point (x, y), right and below if there's room, kept in the window.
function place(x, y) {
  const { width, height } = box.getBoundingClientRect();
  const left = x + GAP + width <= innerWidth - 8 ? x + GAP : Math.max(8, x - GAP - width);
  const top = Math.max(8, Math.min(y - 16, innerHeight - height - 8));
  Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
}

// Opens the box at (x, y) on the thing `key` names. `heading` says what it's on, `target` is what a
// new comment would be on (shown as a line saying so), `comments` are those already on it (earlier
// ones, from the draft this came from, dashed with Comment again). `send(text)` writes a new one;
// `remove`, `flag` and `again` act on one. `writing` opens it ready to write.
export function openThread({ key, x, y, heading, target = null, comments = [], send, remove, flag, again, writing = false }) {
  closeThread();
  showing = { key, x, y };
  const field = h('textarea', { className: 'comment-input', rows: '3', 'aria-label': 'Your comment', placeholder: target?.card ? 'What should its title or description say?' : 'What should change, or what do you want to ask?' });
  const sendButton = h('button', { className: 'primary-button', type: 'button', disabled: '' }, 'Comment');
  field.addEventListener('input', () => {
    sendButton.disabled = !field.value.trim();
  });
  const sendIt = async () => {
    const text = field.value.trim();
    if (!text) return;
    sendButton.disabled = true;
    await send(text);
  };
  sendButton.addEventListener('click', sendIt);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendIt();
    }
  });
  const writer = h('div', { className: 'card-comments-writer' }, field, h('span', { className: 'comment-actions' }, h('button', { className: 'secondary-button', type: 'button', onclick: closeThread }, 'Cancel'), sendButton));
  const adder = h('button', { className: 'link-button card-comments-add', type: 'button' }, 'Add a comment');
  adder.addEventListener('click', () => {
    adder.replaceWith(writer);
    field.focus();
    place(x, y);
  });
  const current = comments.filter((comment) => !comment.earlier);
  const open = writing || !current.length;
  box = h('div', { className: 'card-comments comment-thread', role: 'dialog', 'aria-label': heading },
    h('span', { className: 'card-comments-head' }, heading),
    target && (about(target) ?? null),
    ...comments.map((comment) => entry(comment, { remove, flag, again })),
    open ? writer : adder);
  document.body.append(box);
  place(x, y);
  if (open) field.focus();
}

function entry(comment, { remove, flag, again }) {
  // An earlier comment, from the draft this came from: dashed, to say again here or leave.
  if (comment.earlier) {
    return h('div', { className: 'card-comment earlier', 'data-comment': comment.id },
      h('p', { className: 'comment-text' }, comment.text),
      h('span', { className: 'comment-earlier-foot' }, earlierLine(comment), againButton(comment, again)));
  }
  const bin = h('button', { className: 'icon-button comment-delete', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment' });
  bin.innerHTML = TRASH_ICON;
  bin.addEventListener('click', () => remove(comment));
  // Marked "No further action required", it's kept, faded, with how it was dealt with first.
  const done = !isOpen(comment);
  return h('div', { className: `card-comment${done ? ' done' : ''}`, 'data-comment': comment.id },
    h('span', { className: 'comment-top' }, h('p', { className: 'comment-text' }, comment.text), noFurtherActionButton(comment, flag), bin),
    outcomeTag(comment) || waitingLine(comment),
    repliesOf(comment));
}

// After the page is drawn again: the box opens again on the same thing, from `find(key)`, which gives
// what openThread takes (without the key and place), or nothing if it's gone.
export function refreshThread(find) {
  if (!showing) return;
  const { key, x, y } = showing;
  const again = find(key);
  if (again) openThread({ ...again, key, x, y });
  else closeThread();
}

// Anything else the user does puts the box away: Escape, a key pressed elsewhere, pressing, clicking
// or scrolling anywhere but in it (a comment marker opens its own box instead).
const outside = (event) => box && !box.contains(event.target) && !event.target.closest?.('.comment-marker');
document.addEventListener('keydown', (event) => {
  if (box && (event.key === 'Escape' || outside(event))) closeThread();
}, true);
document.addEventListener('pointerdown', (event) => {
  if (outside(event)) closeThread();
}, true);
document.addEventListener('wheel', (event) => {
  if (outside(event)) closeThread();
}, { capture: true, passive: true });
