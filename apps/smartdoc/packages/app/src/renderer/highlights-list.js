// The highlights review as a list, without the document: for when the user knows the document and
// just wants the review. At the top, what they were looking for and the AI's answer; then each
// category as a section, most important first, each highlight with why it matters, the text it
// quotes, and the user's feedback (useful or not, and a comment). What the document doesn't say
// comes last. "Show in document" switches to the document view with that highlight open.

const IMPORTANCE_LABELS = { high: 'Important', medium: 'Worth knowing', low: 'Minor' };
const IMPORTANCE_RANK = { high: 0, medium: 1, low: 2 };
const CATEGORY_COLOURS = ['#2f6fde', '#7c4ddb', '#1f7a45', '#a65a00', '#08778d', '#c2417a']; // as margin-review.js

export function createHighlightsList({ container, api, onShow }) {
  let review = null;

  function render() {
    const scroll = container.scrollTop;
    container.replaceChildren();
    if (!review) return;
    const page = el('div', 'list-page');
    container.append(page);

    const head = el('header', 'list-head');
    if (review.goal) head.append(el('p', 'list-goal-label', 'You were looking for'), el('h1', 'list-goal', review.goal));
    if (review.summary) head.append(el('p', 'list-summary', review.summary));
    else if (review.status !== 'committed') head.append(el('p', 'list-summary list-muted', 'Your AI is still going through the document.'));
    page.append(head);

    const highlights = review.highlights ?? [];
    if (!highlights.length) {
      page.append(el('p', 'list-muted', review.status === 'committed' ? 'The AI found nothing to highlight.' : 'Highlights will appear here as the AI adds them.'));
      container.scrollTop = scroll;
      return;
    }
    const colours = new Map();
    for (const h of highlights) if (!colours.has(h.category)) colours.set(h.category, CATEGORY_COLOURS[colours.size % CATEGORY_COLOURS.length]);
    const byImportance = (a, b) => (IMPORTANCE_RANK[a.importance] ?? 3) - (IMPORTANCE_RANK[b.importance] ?? 3) || position(a) - position(b);
    const found = highlights.filter((h) => !h.missing);
    for (const [category, colour] of colours) {
      const group = found.filter((h) => h.category === category).sort(byImportance);
      if (group.length) page.append(section(category, colour, group));
    }
    const missing = highlights.filter((h) => h.missing).sort(byImportance);
    if (missing.length) page.append(section('Not in the document', '#6e6e73', missing, colours));
    container.scrollTop = scroll;
  }

  // `colours` is given for the missing section, whose items keep their own category's colour.
  function section(title, colour, items, colours) {
    const box = el('section', 'list-section');
    const heading = el('h2', 'list-section-title');
    heading.style.setProperty('--section-color', colour);
    heading.append(el('span', null, title), el('span', 'list-count', String(items.length)));
    box.append(heading);
    for (const h of items) box.append(item(h, colours?.get(h.category) ?? colour, Boolean(colours)));
    return box;
  }

  function item(h, colour, showCategory) {
    const feedback = h.feedback ?? { useful: null, comment: '' };
    const card = el('article', `list-item${feedback.useful === false ? ' not-useful' : ''}`);
    card.style.setProperty('--item-color', colour);
    const meta = el('p', 'list-meta', [showCategory ? h.category : null, IMPORTANCE_LABELS[h.importance] ?? null].filter(Boolean).join(' · '));
    card.append(meta, el('h3', 'list-title', h.title));
    if (h.note) card.append(el('p', 'list-note', h.note));
    if (h.anchors?.length) {
      const quote = el('blockquote', 'list-quote', h.anchors.map((a) => a.text.replace(/\s+/g, ' ')).join(' … '));
      card.append(quote);
    }

    const actions = el('div', 'list-actions');
    const comment = el('textarea', 'list-comment');
    comment.rows = 1;
    comment.placeholder = 'Comment for the AI (optional)';
    comment.value = feedback.comment ?? '';
    comment.addEventListener('change', () => api.rateHighlight(h.id, { comment: comment.value }));
    const row = el('div', 'list-buttons');
    if (h.anchors?.length) {
      const show = el('button', 'list-show', 'Show in document');
      show.type = 'button';
      show.addEventListener('click', () => onShow(h.id));
      row.append(show);
    }
    for (const [label, useful] of [['Not useful', false], ['Useful', true]]) {
      const b = el('button', `secondary-button feedback-button${feedback.useful === useful ? ' selected' : ''}`, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(feedback.useful === useful));
      // Pressing the selected one again clears it.
      b.addEventListener('click', () => api.rateHighlight(h.id, { useful: feedback.useful === useful ? null : useful }));
      row.append(b);
    }
    actions.append(comment, row);
    card.append(actions);
    return card;
  }

  return {
    update(next) {
      review = next;
      render();
    },
  };
}

// Where a highlight's text starts, for ordering within its importance.
function position(h) {
  const a = h.anchors?.[0];
  return a ? a.page * 1e6 + a.start : Infinity;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
