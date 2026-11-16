// The questions on one thing, in a box over the page by where the user pressed: what was asked, the
// AI's replies with how it dealt with each (and the card it wrote), "No further action required",
// and a field to ask another. Opened by a long press (to ask one) or by clicking a question marker or
// marked words (see comments.js). One box for the window. After a change the page is drawn again,
// and the box is drawn again from it (refreshThread), so it stays open on the same thing. As
// SmartSpec's comment box, asking rather than commenting, and nothing in it deleted.

import { about, isOpen, noFurtherActionButton, outcomeTag, repliesOf, waitingLine } from './comments.js';
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
// new question would be on (shown as a line saying so), `comments` are the questions already on it.
// `send(text)` asks a new one; `flag` marks one as needing nothing more. `writing` opens it ready to
// write.
export function openThread({ key, x, y, heading, target = null, comments = [], send, flag, writing = false }) {
  closeThread();
  showing = { key, x, y };
  const field = h('textarea', { className: 'comment-input', rows: '3', 'aria-label': 'Your question', placeholder: target?.quote ? 'What do you want to know about these words?' : 'What do you want to know?' });
  const sendButton = h('button', { className: 'primary-button', type: 'button', disabled: '' }, 'Ask');
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
  const adder = h('button', { className: 'link-button card-comments-add', type: 'button' }, 'Ask another question');
  adder.addEventListener('click', () => {
    adder.replaceWith(writer);
    field.focus();
    place(x, y);
  });
  // Ready to write only when asked (a long press) or when there's nothing to read yet: questions
  // already asked are shown to read, with "Ask another question" to write one.
  const open = writing || !comments.length;
  box = h('div', { className: 'card-comments comment-thread', role: 'dialog', 'aria-label': heading },
    h('span', { className: 'card-comments-head' }, heading),
    target && (about(target) ?? null),
    ...comments.map((comment) => entry(comment, { flag })),
    open ? writer : adder);
  document.body.append(box);
  place(x, y);
  if (open) field.focus();
}

function entry(comment, { flag }) {
  // Marked "No further action required", it's kept, faded, with how it was dealt with first.
  const done = !isOpen(comment);
  return h('div', { className: `card-comment${done ? ' done' : ''}`, 'data-comment': comment.id },
    h('span', { className: 'comment-top' }, h('p', { className: 'comment-text' }, comment.text), noFurtherActionButton(comment, flag)),
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
