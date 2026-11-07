// An item's comments, in a box beside it. On the overview these are comments on its card: what shows
// for it around the schematic (its title, description and card lines), as against its content.
// Right-clicking an overview card, or an item's card on the board, opens the box to write one; the AI
// answers by changing the card. On the board the box holds every comment on the item, on its content
// too, each saying what it's on, and a comment started on something picked in the item's content is
// written there (see comments.js). A card with comments has a speech bubble, and clicking that opens
// them, with the AI's replies. One box for the window.

import { about, againButton, earlierLine, isOpen, noFurtherActionButton, outcomeTag, repliesOf, waitingLine } from './comments.js';

const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const GAP = 10;

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

// The tag on a card with comments: a speech bubble, and how many if more than one, right of the kind
// tag on its line. It's inside the card, so a click on it mustn't reach the card.
const BUBBLE = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';
// With no count and only earlier comments, from the draft this came from, the bubble is dashed; with
// no count and none needing anything, it's faded.
export function cardCommentTag(count, { earlierOnly = !count, on = 'this card' } = {}) {
  const words = count ? (count === 1 ? `1 comment on ${on}` : `${count} comments on ${on}`) : earlierOnly ? `An earlier comment on ${on}` : `Comments on ${on}, none needing anything`;
  const tag = h('span', { className: `pill kind-pill comment-pill card-comment-tag${count ? '' : earlierOnly ? ' earlier' : ' settled'}`, role: 'button', tabindex: '0', title: words, 'aria-label': words });
  tag.innerHTML = BUBBLE;
  if (count > 1) tag.append(String(count));
  return tag;
}

let box = null;
let reopen = null; // the item whose box opens again once the page is drawn again, after a change

export function closeCardComments() {
  box?.remove();
  box = null;
}

// Beside `card`, to the right if there's room, else to the left, level with its top.
function place(card) {
  const rect = card.getBoundingClientRect();
  const { width, height } = box.getBoundingClientRect();
  const x = rect.right + GAP + width <= innerWidth - 8 ? rect.right + GAP : Math.max(8, rect.left - GAP - width);
  const y = Math.max(8, Math.min(rect.top, innerHeight - height - 8));
  Object.assign(box.style, { left: `${x}px`, top: `${y}px` });
}

// `comments` are this card's; `writing` opens the box ready to write one, on `target` if given.
function open(card, { comments, writing, target = null, save, remove, flag, again, heading }) {
  closeCardComments();
  const onCard = !target || target.card;
  const field = h('textarea', { className: 'comment-input', rows: '3', 'aria-label': onCard ? 'Your comment on this card' : 'Your comment', placeholder: onCard ? 'What should this card say? For example: show the currency' : 'What should change, or what do you want to ask?' });
  const send = h('button', { className: 'primary-button', type: 'button', disabled: '' }, 'Comment');
  field.addEventListener('input', () => {
    send.disabled = !field.value.trim();
  });
  const sendIt = async () => {
    const text = field.value.trim();
    if (!text) return;
    send.disabled = true;
    reopen = card.dataset.item;
    await save(text, target);
  };
  send.addEventListener('click', sendIt);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendIt();
    }
  });
  const writer = h('div', { className: 'card-comments-writer' }, target && !target.card && about(target), field, h('span', { className: 'comment-actions' }, h('button', { className: 'secondary-button', type: 'button', onclick: closeCardComments }, 'Cancel'), send));
  const adder = h('button', { className: 'link-button card-comments-add', type: 'button' }, 'Add a comment');
  adder.addEventListener('click', () => {
    adder.replaceWith(writer);
    field.focus();
    place(card);
  });
  const title = card.querySelector('.title-row strong, .pane-title h2')?.textContent ?? 'this card';
  const head = heading ? heading(title) : `On the card for ${title}`;
  box = h('div', { className: 'card-comments', role: 'dialog', 'aria-label': head },
    h('span', { className: 'card-comments-head' }, head),
    ...comments.map((comment) => {
      // An earlier comment, from the draft this came from: dashed, to say again here or leave.
      if (comment.earlier) {
        return h('div', { className: 'card-comment earlier', 'data-comment': comment.id },
          heading && aboutLine(comment.target),
          h('p', { className: 'comment-text' }, comment.text),
          h('span', { className: 'comment-earlier-foot' }, earlierLine(comment), againButton(comment, again && (async (one) => {
            reopen = card.dataset.item;
            await again(one);
          }))));
      }
      const bin = h('button', { className: 'icon-button comment-delete', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment' });
      bin.innerHTML = TRASH_ICON;
      bin.addEventListener('click', async () => {
        reopen = card.dataset.item;
        await remove(comment);
      });
      // Marked "No further action required", it's kept, faded, with how it was dealt with first.
      const done = !isOpen(comment);
      const marking = flag && noFurtherActionButton(comment, async (one, next) => {
        reopen = card.dataset.item;
        await flag(one, next);
      });
      return h('div', { className: `card-comment${done ? ' done' : ''}`, 'data-comment': comment.id },
        heading && aboutLine(comment.target),
        h('span', { className: 'comment-top' }, h('p', { className: 'comment-text' }, comment.text), marking, bin),
        outcomeTag(comment) || waitingLine(comment),
        repliesOf(comment));
    }),
    writing || !comments.some((comment) => !comment.earlier) ? writer : adder);
  document.body.append(box);
  place(card);
  if (writing || !comments.some((comment) => !comment.earlier)) field.focus();
}

// What a comment in the box is on, where the box holds more than the card's.
const aboutLine = (target) => (target.card ? h('span', { className: 'comment-about' }, 'On its card') : about(target) ?? h('span', { className: 'comment-about' }, 'On all of it'));

let watching = null; // what the last watchCardComments was given, for startComment

// Watches the cards in `root` (the board's items, or the overview's cards) for right-clicks and
// their tags. `cards` finds a card, `menuOn` what a right-click on opens its box (the card itself if
// not given). `commentsOn(item)` gives a card's comments; `save(item, text, target)` and
// `remove(comment)` change them; `heading(title)` names the box, if not for the card. Opens again
// whatever box was open before a change redrew the page.
export function watchCardComments(root, { cards, menuOn = cards, commentsOn, save, remove, flag, again, heading } = {}) {
  watching = null;
  if (!root || !cards) return closeCardComments();
  const cardOf = (event) => event.target.closest?.(cards);
  const show = (card, writing, target = null) => open(card, { comments: commentsOn(card.dataset.item), writing, target, save: (text, on) => save(card.dataset.item, text, on), remove, flag, again, heading });
  watching = { root, cards, show };
  root.addEventListener('contextmenu', (event) => {
    const where = event.target.closest?.(menuOn);
    const card = where && cardOf(event);
    if (!card || !card.dataset.item) return;
    event.preventDefault();
    show(card, true);
  });
  // The tag opens the comments, and the card isn't followed.
  const fromTag = (event) => {
    const tag = event.target.closest?.('.card-comment-tag');
    if (!tag) return false;
    event.preventDefault();
    event.stopPropagation();
    const card = tag.closest(cards);
    if (card) show(card, false);
    return true;
  };
  root.addEventListener('click', fromTag, true);
  root.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList?.contains('card-comment-tag')) fromTag(event);
  }, true);
  // A drag on the overview starts on a card as often as not: the tag mustn't start one.
  root.addEventListener('pointerdown', (event) => {
    if (event.target.closest?.('.card-comment-tag')) event.stopPropagation();
  }, true);
  if (reopen) {
    const card = [...root.querySelectorAll(cards)].find((one) => one.dataset.item === reopen);
    reopen = null;
    if (card) show(card, false);
  } else closeCardComments();
}

// Opens an item's box to write a comment on `target` ({ item, part, quote }), picked in its content.
export function startComment(target) {
  if (!watching?.root.isConnected) return;
  const card = [...watching.root.querySelectorAll(watching.cards)].find((one) => one.dataset.item === target.item);
  if (card) watching.show(card, true, target);
}

// Anything else the user does puts the box away.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && box) closeCardComments();
});
document.addEventListener('mousedown', (event) => {
  if (box && !box.contains(event.target) && !event.target.closest?.('.card-comment-tag')) closeCardComments();
}, true);
document.addEventListener('scroll', (event) => {
  if (box && !box.contains(event.target)) closeCardComments();
}, true);
document.addEventListener('wheel', (event) => {
  if (box && !box.contains(event.target)) closeCardComments();
}, { capture: true, passive: true });
