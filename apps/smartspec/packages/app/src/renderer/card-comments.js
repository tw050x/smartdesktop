// Comments on an item's card: what shows for it around the schema (its title, description and card
// lines), as against its content. Right-clicking a side card or an overview card opens a box beside
// it to write one; the AI answers by changing the card. A card with comments has a speech bubble in
// its top corner, and clicking that opens them in the same box, with the AI's replies. One box for the window.

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
export function cardCommentTag(count) {
  const words = count === 1 ? '1 comment on this card' : `${count} comments on this card`;
  const tag = h('span', { className: 'pill kind-pill comment-pill card-comment-tag', role: 'button', tabindex: '0', title: words, 'aria-label': words });
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

// `comments` are this card's; `writing` opens the box ready to write one.
function open(card, { comments, writing, save, remove }) {
  closeCardComments();
  const field = h('textarea', { className: 'comment-input', rows: '3', 'aria-label': 'Your comment on this card', placeholder: 'What should this card say? For example: show the currency' });
  const send = h('button', { className: 'primary-button', type: 'button', disabled: '' }, 'Comment');
  field.addEventListener('input', () => {
    send.disabled = !field.value.trim();
  });
  const sendIt = async () => {
    const text = field.value.trim();
    if (!text) return;
    send.disabled = true;
    reopen = card.dataset.item;
    await save(text);
  };
  send.addEventListener('click', sendIt);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendIt();
    }
  });
  const writer = h('div', { className: 'card-comments-writer' }, field, h('span', { className: 'comment-actions' }, h('button', { className: 'secondary-button', type: 'button', onclick: closeCardComments }, 'Cancel'), send));
  const adder = h('button', { className: 'link-button card-comments-add', type: 'button' }, 'Add a comment');
  adder.addEventListener('click', () => {
    adder.replaceWith(writer);
    field.focus();
    place(card);
  });
  const title = card.querySelector('.title-row strong')?.textContent ?? 'this card';
  box = h('div', { className: 'card-comments', role: 'dialog', 'aria-label': `Comments on the card for ${title}` },
    h('span', { className: 'card-comments-head' }, `On the card for ${title}`),
    ...comments.map((comment) => {
      const bin = h('button', { className: 'icon-button comment-delete', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment' });
      bin.innerHTML = TRASH_ICON;
      bin.addEventListener('click', async () => {
        reopen = card.dataset.item;
        await remove(comment);
      });
      return h('div', { className: 'card-comment', 'data-comment': comment.id },
        h('span', { className: 'comment-top' }, h('p', { className: 'comment-text' }, comment.text), bin),
        comment.replies?.length > 0 && h('div', { className: 'comment-replies' }, ...comment.replies.map((reply) => h('div', { className: 'comment-reply' }, h('strong', {}, reply.author), h('span', {}, reply.text)))));
    }),
    writing || !comments.length ? writer : adder);
  document.body.append(box);
  place(card);
  if (writing || !comments.length) field.focus();
}

// Watches the cards in `root` (the stage's side cards, or the overview's) for right-clicks and their
// tags. `commentsOn(item)` gives a card's comments; `save(item, text)` and `remove(comment)` change
// them. Opens again whatever box was open before a change redrew the page.
export function watchCardComments(root, { cards, commentsOn, save, remove } = {}) {
  if (!root || !cards) return closeCardComments();
  const cardOf = (event) => event.target.closest?.(cards);
  const show = (card, writing) => open(card, { comments: commentsOn(card.dataset.item), writing, save: (text) => save(card.dataset.item, text), remove });
  root.addEventListener('contextmenu', (event) => {
    const card = cardOf(event);
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
