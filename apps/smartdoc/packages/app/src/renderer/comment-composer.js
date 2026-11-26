import { anchorRects, pageContent } from './anchors.js';

// Commenting on selected text. Selecting text offers a small Comment button at the end of the
// selection; pressing it opens a box in the right margin, where the review's cards go, and tints
// the text (typing moves the browser's selection into the box, so the page's would disappear).
// `canComment()` says whether comments can be added to what's showing; `cardPlace()` gives the
// margin's { left, width }; `onDone()` runs once a comment is added.
export function createCommentComposer({ wrapEl, api, canComment, cardPlace, onDone }) {
  let anchors = null;
  let pill = null;
  let card = null;
  let marks = [];

  const pagePoint = (anchor, rect) => {
    const pageEl = pageContent(anchor.page)?.parentElement;
    if (!pageEl) return null;
    const scale = pageEl.offsetWidth / Number(pageEl.dataset.width) || 1;
    return { pageEl, x: pageEl.offsetLeft + rect.x * scale, y: pageEl.offsetTop + rect.y * scale, right: pageEl.offsetLeft + (rect.x + rect.width) * scale, bottom: pageEl.offsetTop + (rect.y + rect.height) * scale };
  };

  function place() {
    if (pill) {
      const last = anchors.at(-1);
      const rect = anchorRects(last).at(-1);
      const point = rect && pagePoint(last, rect);
      if (!point) return;
      const edge = point.pageEl.offsetLeft + point.pageEl.offsetWidth - pill.offsetWidth - 4;
      pill.style.left = `${Math.min(point.right - pill.offsetWidth / 2, edge)}px`;
      pill.style.top = `${point.bottom + 4}px`;
    }
    if (card) {
      const first = anchors[0];
      const rect = anchorRects(first)[0];
      const point = rect && pagePoint(first, rect);
      const { left, width } = cardPlace() ?? {};
      if (!point || left == null) return;
      Object.assign(card.style, { left: `${left}px`, top: `${point.y - 7}px`, width: `${width}px` });
    }
  }

  function removePill() {
    pill?.remove();
    pill = null;
  }

  function close() {
    removePill();
    card?.remove();
    card = null;
    for (const mark of marks) mark.remove();
    marks = [];
    anchors = null;
  }

  function tintText() {
    for (const anchor of anchors) {
      const content = pageContent(anchor.page);
      for (const r of content ? anchorRects(anchor) : []) {
        const mark = document.createElement('div');
        mark.className = 'comment-draft-mark';
        Object.assign(mark.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
        content.append(mark);
        marks.push(mark);
      }
    }
  }

  function openBox() {
    removePill();
    tintText();
    card = document.createElement('div');
    card.className = 'comment-composer';
    const title = document.createElement('p');
    title.className = 'margin-kind';
    title.textContent = 'Your comment';
    const input = document.createElement('textarea');
    input.rows = 3;
    input.placeholder = 'What should your AI do with this text?';
    input.setAttribute('aria-label', 'Your comment');
    const error = document.createElement('p');
    error.className = 'comment-error';
    error.hidden = true;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-button';
    cancel.textContent = 'Cancel';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'primary-button';
    add.textContent = 'Add comment';
    add.disabled = true;
    const buttons = document.createElement('div');
    buttons.className = 'comment-buttons';
    buttons.append(cancel, add);
    card.append(title, input, error, buttons);
    wrapEl.append(card);
    place();
    input.focus({ preventScroll: true });

    const submit = async () => {
      const note = input.value.trim();
      if (!note || add.disabled) return;
      add.disabled = true;
      try {
        await api.addRequest({ kind: 'comment', anchors, note });
        close();
        onDone();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        add.disabled = false;
      }
    };
    input.addEventListener('input', () => { add.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
    cancel.addEventListener('click', close);
    add.addEventListener('click', submit);
  }

  return {
    // What's selected on the page changed. A box already open stays, so its text isn't lost.
    offer(next) {
      if (card) return;
      removePill();
      anchors = null;
      if (!next.length || !canComment()) return;
      anchors = next;
      pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'comment-offer';
      pill.textContent = 'Comment';
      // Keeps the selection until the box opens.
      pill.addEventListener('mousedown', (e) => e.preventDefault());
      pill.addEventListener('click', openBox);
      wrapEl.append(pill);
      place();
    },
    place,
    close,
  };
}
