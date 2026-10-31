// Requests the user marked on the page in earlier versions of the app (rewrite, comment, keep, ...).
const requestLabel = (kind) => kind.charAt(0).toUpperCase() + kind.slice(1);

// The review column: the current draft's review, which is one of two kinds. With no review yet, it
// offers the user a prompt for each.
// An improvement review: while the AI is still working (open) its findings show read-only; once
// committed, each finding carries the user's decision. The AI's notes on the text (its
// annotations: highlights, underlines and strikes) are listed among the findings, with nothing to
// decide. After them come changes the user writes themselves for the AI to carry out, and a
// dashed card to add another.
// A highlights review: the user's goal, then the key information the AI found, by category, each
// with the user's feedback.
// Clicking a card scrolls its text into view, and hovering one highlights its text on the page.
// Selecting text on the page shows only the cards about that text (see `filter`).
// The step cards are always open; the cards in them start minimised to their heading, and open
// with the arrow button. Opening a document minimises them all again.

// Each finding is labelled by the part of the document it's about (questions and notes aren't
// changes).
const KIND_LABELS = { change: 'Wording', options: 'Content', question: 'Question', move: 'Structure', design: 'Design', flag: 'Note' };
// Findings can be listed in the order their text appears in the document, or by priority: high,
// medium, then low severity, keeping the AI's order within each. Findings with no text come last.
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const position = (item) => {
  const first = [...item.anchors].sort((a, b) => a.page - b.page || a.start - b.start)[0];
  return first ? [first.page, first.start] : [Infinity, Infinity];
};
const ORDERS = {
  content: (a, b) => {
    const [pa, sa] = position(a);
    const [pb, sb] = position(b);
    return pa - pb || sa - sb;
  },
  priority: (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
};

// Notes are labelled by how they mark the text.
const MARK_LABELS = { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough' };

// Prompts for the user to send their AI: to start a review of either kind, to carry one on, and
// once they've decided, to apply an improvement review. Each names the open document and gives its
// id, so the AI knows which one is meant even when several share a name. Each can be edited before
// copying; edits last until another document or review is shown.
const PROMPTS = {
  improve: (doc) => `Review ${doc} in SmartDoc and suggest improvements.`,
  highlights: (doc) => `Go through ${doc} in SmartDoc and highlight the key information for me.`,
  continue: (doc) => `Carry on reviewing ${doc} in SmartDoc, and commit the review when you’re done.`,
  continueHighlights: (doc) => `Carry on with the highlights for ${doc} in SmartDoc, and commit the review when you’re done.`,
  apply: (doc) => `I’ve made my decisions in SmartDoc. Apply the review and write the next draft of ${doc}.`,
};

// A highlights review groups its highlights by the categories the AI chose, each with its own
// colour (on the page too), in the order they first appear. Within a category the most important
// come first, then in content order; anything the document doesn't say comes last.
const IMPORTANCE_LABELS = { high: 'Important', medium: 'Worth knowing', low: 'Minor' };
const IMPORTANCE_RANK = { high: 0, medium: 1, low: 2 };
const CATEGORY_COLOURS = 6;
export const isHighlights = (review) => review?.type === 'highlights';
export function categoryColours(review) {
  const colours = new Map();
  for (const h of review?.highlights ?? []) {
    if (!colours.has(h.category)) colours.set(h.category, colours.size % CATEGORY_COLOURS);
  }
  return colours;
}
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const RESET_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const STATUS_LABELS = { pending: 'Undecided', accepted: 'Accepted', rejected: 'Rejected', answered: 'Answered', acknowledged: 'Acknowledged' };

// `container` is the card; `scroller` is what scrolls it (the whole card scrolls in its column).
// `filter` (set with update) is the text selected on the page, as anchors: while it's set, only the
// cards whose text overlaps it show. `onClearFilter` is called when the user asks to see them all.
export function createReviewPanel({ container, scroller, api, onReveal, onHover, onClearFilter }) {
  let state = { hasDocument: false, document: null, review: null, filter: null };
  const prompt = (key) => PROMPTS[key](state.document ? `“${state.document.name}” (document ${state.document.id})` : 'my document');
  const overlaps = (anchors) => anchors.some((a) => state.filter.some((f) => f.page === a.page && a.start < f.end && f.start < a.end));
  const shown = (anchors) => !state.filter || overlaps(anchors);
  const expanded = new Set(); // ids of opened findings, kept across re-renders
  const editing = new Set(); // ids of decided findings whose decision is being changed
  let order = 'content'; // a key of ORDERS
  const promptEdits = new Map(); // prompt key → { scope, text }: the user's edits to a prompt
  // The user's own change being written or edited: { id } (null for a new one) and its text so far.
  let changeDraft = null;

  function render() {
    const { hasDocument, review } = state;
    const scroll = scroller.scrollTop;
    container.replaceChildren();
    // Each step is its own card in the column.
    const panel = el('div', 'panel review-steps');
    container.append(panel);

    if (!hasDocument || !review) onHover(null);
    if (!hasDocument) {
      const card = el('section', 'review-step');
      card.append(el('h2', 'review-heading', 'Review'), el('p', 'panel-hint', 'Open a document to see its review.'));
      panel.append(card);
      return;
    }

    // No review yet: the user asks their AI for one, of either kind.
    if (!review) {
      const card = el('section', 'review-step');
      card.append(el('h2', 'review-heading', 'Review'));
      card.append(el('p', 'next-step-text', 'Ask your AI to go through this document. It reads the document through the app, agrees with you what you’re after, and shows its review here.'));
      card.append(el('h3', 'start-title', 'Improve it'));
      card.append(el('p', 'next-step-text', 'The AI suggests changes for you to accept, reject or answer, then writes the next draft from your decisions.'));
      card.append(promptBlock('improve', state.document?.id, prompt('improve')));
      card.append(el('h3', 'start-title', 'Find the key information'));
      card.append(el('p', 'next-step-text', 'The AI asks what you’re looking for, then picks out what matters for it, including anything the document doesn’t say.'));
      card.append(promptBlock('highlights', state.document?.id, prompt('highlights')));
      panel.append(card);
      return;
    }
    if (state.filter) panel.append(filterBar(review));
    if (isHighlights(review)) {
      panel.append(highlightsView(review));
      scroller.scrollTop = scroll;
      return;
    }

    // An improvement review, in two steps: the AI reviews, then the user decides and asks the AI
    // to apply their decisions. Each step can be reset, taking the review back to its start.
    const committed = review?.status === 'committed';
    const items = review?.items ?? [];
    const decided = items.filter((i) => i.decision.status !== 'pending').length;
    const applied = Boolean(review?.applications?.length);

    const reset = (number) => async () => {
      if (await api.resetToStep(number)) {
        editing.clear();
        changeDraft = null;
        render();
      }
    };

    const review1 = step(1, 'Review', committed ? 'done' : 'current', {
      title: 'Start the review again, empty',
      enabled: Boolean(review && (committed || items.length || review.annotations?.length || review.summary)),
      action: reset(1),
    });
    panel.append(review1.section);
    // Dated by when the AI committed it, or when it was started while still in progress.
    const dated = review.committedAt ?? review.createdAt;
    if (dated) {
      const time = el('time', 'review-date', formatDate(dated));
      time.dateTime = dated;
      time.title = [`Started ${formatDateTime(review.createdAt)}`, review.committedAt && `Committed ${formatDateTime(review.committedAt)}`].filter(Boolean).join('\n');
      review1.meta.append(time);
    }
    if (review.goal) review1.body.append(goalLine('Goal', review.goal));
    if (!committed) {
      review1.body.append(el('p', 'review-status', `In progress: the AI is still reviewing${items.length ? ` (${items.length} finding${items.length === 1 ? '' : 's'} so far)` : ''}. If it has stopped, ask it to carry on.`));
      review1.body.append(promptBlock('continue', review.id, prompt('continue')));
    }
    if (review.summary) review1.body.append(el('p', 'review-summary', review.summary));

    const decide = step(2, 'Decide', !committed ? 'upcoming' : applied ? 'done' : 'current', {
      title: 'Clear your decisions and your own changes',
      enabled: committed && Boolean(decided || review.changes?.length || items.some((i) => i.decision.comment)),
      action: reset(2),
    });
    panel.append(decide.section);
    if (committed && items.length) decide.meta.textContent = `${decided} of ${items.length} decided`;
    const notes = review?.annotations ?? [];
    if (!items.length) {
      decide.body.append(el('p', 'panel-hint', committed ? 'The AI found nothing to change.' : 'Findings will appear here as the AI adds them.'));
    }
    if (items.length + notes.length > 1) {
      const bar = el('label', 'finding-order');
      bar.append(el('span', null, 'Order'));
      const select = document.createElement('select');
      for (const [value, label] of [['content', 'Content order'], ['priority', 'Priority']]) {
        const option = el('option', null, label);
        option.value = value;
        option.selected = value === order;
        select.append(option);
      }
      select.addEventListener('change', () => {
        order = select.value;
        render();
      });
      bar.append(select);
      decide.body.append(bar);
    }
    if (items.length + notes.length || committed) {
      const list = el('ul', 'finding-list');
      const cards = [...items.map((item) => ({ item, anchors: item.anchors })), ...notes.map((note) => ({ note, anchors: note.anchors }))];
      for (const card of cards.filter((c) => shown(c.anchors)).sort((a, b) => ORDERS[order](a.item ?? a, b.item ?? b))) {
        list.append(card.item ? findingCard(card.item, review, committed) : noteCard(card.note));
      }
      // The user's own changes follow the AI's findings, then the card for adding another. They
      // aren't about any text, so a filter hides them.
      if (committed && !state.filter) {
        for (const change of review.changes ?? []) list.append(changeCard(change));
        list.append(changeDraft && !changeDraft.id ? changeEditor() : addChangeCard());
      }
      decide.body.append(list);
    }
    if (committed) {
      const apply = el('div', 'apply-prompt');
      apply.append(
        el('h3', 'apply-title', 'When you’ve decided'),
        el('p', 'next-step-text', 'Ask your AI to apply your decisions. It writes the next draft from them, and the draft opens here.'),
        promptBlock('apply', review.id, prompt('apply')),
      );
      decide.body.append(apply);
    }
    scroller.scrollTop = scroll;
  }

  // A highlights review: the goal it was for, the AI's answer (its summary) once it has finished,
  // then the highlights by category. The user can mark each one useful or not, and comment.
  function highlightsView(review) {
    const committed = review.status === 'committed';
    const highlights = review.highlights ?? [];
    const section = el('section', 'review-step highlights-view');
    const head = el('h2', 'step-head');
    head.append(el('span', 'step-title', 'Key information'));
    if (committed || highlights.length) {
      const button = el('button', 'finding-toggle step-reset');
      button.type = 'button';
      button.title = 'Start the highlights again, keeping the goal';
      button.setAttribute('aria-label', button.title);
      button.innerHTML = RESET_ICON;
      button.addEventListener('click', async () => {
        if (await api.resetToStep(1)) render();
      });
      head.append(button);
    }
    const meta = el('span', 'step-meta');
    const dated = review.committedAt ?? review.createdAt;
    const time = el('time', 'review-date', formatDate(dated));
    time.dateTime = dated;
    time.title = [`Started ${formatDateTime(review.createdAt)}`, review.committedAt && `Finished ${formatDateTime(review.committedAt)}`].filter(Boolean).join('\n');
    meta.append(time);
    head.append(meta);
    const body = el('div', 'step-body');
    section.append(head, body);

    if (review.goal) body.append(goalLine('Looking for', review.goal));
    if (review.context) body.append(el('p', 'review-context', review.context));
    if (!committed) {
      body.append(el('p', 'review-status', `In progress: the AI is still going through the document${highlights.length ? ` (${highlights.length} highlight${highlights.length === 1 ? '' : 's'} so far)` : ''}. If it has stopped, ask it to carry on.`));
      body.append(promptBlock('continueHighlights', review.id, prompt('continueHighlights')));
    }
    if (review.summary) body.append(el('p', 'review-summary', review.summary));
    if (!highlights.length) {
      body.append(el('p', 'panel-hint', committed ? 'The AI found nothing to highlight.' : 'Highlights will appear here as the AI adds them.'));
      return section;
    }

    const colours = categoryColours(review);
    const rank = (h) => [h.missing ? 1 : 0, IMPORTANCE_RANK[h.importance] ?? 3, ...position(h)];
    const byRank = (a, b) => {
      const [x, y] = [rank(a), rank(b)];
      const i = x.findIndex((v, n) => v !== y[n]);
      return i === -1 ? 0 : x[i] - y[i];
    };
    for (const [category, colour] of colours) {
      const group = highlights.filter((h) => h.category === category && shown(h.anchors)).sort(byRank);
      if (!group.length) continue;
      const heading = el('h3', `highlight-category cat-${colour}`);
      heading.append(el('span', 'highlight-category-name', category), el('span', 'highlight-category-count', String(group.length)));
      const list = el('ul', 'finding-list');
      for (const h of group) list.append(highlightCard(h, colour));
      body.append(heading, list);
    }
    return section;
  }

  function highlightCard(h, colour) {
    const feedback = h.feedback ?? { useful: null, comment: '' };
    const li = el('li', `finding highlight cat-${colour} importance-${h.importance}${h.missing ? ' highlight-missing' : ''}${feedback.useful === false ? ' highlight-not-useful' : ''}`);
    cardHead(li, h.id, h.missing ? 'Not in the document' : IMPORTANCE_LABELS[h.importance] ?? 'Highlight', feedback.useful === null ? null : feedback.useful ? 'Useful' : 'Not useful');
    li.append(el('h3', 'finding-title', h.title));
    if (h.note) li.append(el('p', 'finding-body', h.note));
    if (h.anchors.length) li.append(el('blockquote', 'finding-quote', h.anchors.map((a) => a.text.replace(/\s+/g, ' ')).join(' … ')));

    const box = el('div', 'decision');
    const comment = el('textarea', 'decision-comment');
    comment.rows = 1;
    comment.placeholder = 'Comment for the AI (optional)';
    comment.value = feedback.comment ?? '';
    comment.addEventListener('change', () => api.rateHighlight(h.id, { comment: comment.value }));
    const row = el('div', 'decision-buttons');
    for (const [label, useful] of [['Not useful', false], ['Useful', true]]) {
      const b = el('button', `secondary-button feedback-button${feedback.useful === useful ? ' selected' : ''}`, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(feedback.useful === useful));
      // Pressing the selected one again clears it.
      b.addEventListener('click', () => api.rateHighlight(h.id, { useful: feedback.useful === useful ? null : useful }));
      row.append(b);
    }
    box.append(comment, row);
    li.append(box);
    linkToText(li, h.anchors);
    return li;
  }

  // Shown while the page selection filters the cards: how many match, and a button to show all.
  function filterBar(review) {
    const cards = isHighlights(review) ? review.highlights ?? [] : [...review.items, ...(review.annotations ?? [])];
    const count = cards.filter((c) => overlaps(c.anchors)).length;
    const bar = el('div', 'filter-bar');
    bar.append(el('span', 'filter-text', count
      ? `Showing ${count} ${count === 1 ? 'card' : 'cards'} about the selected text`
      : 'Nothing in the review is about the selected text'));
    const button = el('button', 'secondary-button', 'Show all');
    button.type = 'button';
    button.addEventListener('click', onClearFilter);
    bar.append(button);
    return bar;
  }

  function goalLine(label, text) {
    const p = el('p', 'review-goal');
    p.append(el('strong', null, `${label}: `), document.createTextNode(text));
    return p;
  }

  // A numbered step, always open: its heading (number, title, an optional reset button straight
  // after it and a space on the right for details) and body. `state` is done, current or
  // upcoming; a done step shows a tick in place of its number. The reset button shows only when
  // there's something to reset.
  function step(number, title, state, reset) {
    const section = el('section', `review-step step-${state}`);
    const head = el('h2', 'step-head');
    const badge = el('span', 'step-number', state === 'done' ? '' : String(number));
    if (state === 'done') badge.innerHTML = COPIED_ICON;
    badge.setAttribute('aria-label', `Step ${number}${state === 'done' ? ', done' : ''}`);
    const meta = el('span', 'step-meta');
    head.append(badge, el('span', 'step-title', title));
    if (reset?.enabled) {
      const button = el('button', 'finding-toggle step-reset');
      button.type = 'button';
      button.title = reset.title;
      button.setAttribute('aria-label', reset.title);
      button.innerHTML = RESET_ICON;
      button.addEventListener('click', reset.action);
      head.append(button);
    }
    head.append(meta);
    const body = el('div', 'step-body');
    section.append(head, body);
    return { section, meta, body };
  }

  // A prompt for the user to send their AI, editable, with a copy button in its corner. Edits
  // are kept for as long as `scope` (the review it's for) stays the same.
  function promptBlock(key, scope, defaultText) {
    if (promptEdits.get(key)?.scope !== scope) promptEdits.set(key, { scope, text: defaultText });
    const edit = promptEdits.get(key);
    const block = el('div', 'prompt-block');
    const text = el('textarea', 'prompt-text');
    text.rows = 2;
    text.spellcheck = false;
    text.setAttribute('aria-label', 'Prompt for your AI');
    text.value = edit.text;
    text.addEventListener('input', () => (edit.text = text.value));
    const copy = el('button', 'prompt-copy');
    copy.type = 'button';
    copy.title = 'Copy the prompt';
    copy.setAttribute('aria-label', copy.title);
    copy.innerHTML = COPY_ICON;
    let reset;
    copy.addEventListener('click', async () => {
      await api.copyText(text.value);
      copy.innerHTML = COPIED_ICON;
      copy.classList.add('copied');
      clearTimeout(reset);
      reset = setTimeout(() => {
        copy.innerHTML = COPY_ICON;
        copy.classList.remove('copied');
      }, 1500);
    });
    block.append(text, copy);
    return block;
  }

  // A dashed card at the end of the list: tapping it opens an editor for a change of the user's own.
  function addChangeCard() {
    const li = el('li', 'finding add-change');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.append(el('span', 'add-change-title', '+ Add your own change'), el('span', 'add-change-hint', 'Tell the AI something else to change when it writes the next draft.'));
    const open = () => {
      changeDraft = { id: null, text: '' };
      render();
      container.querySelector('.change-editor textarea')?.focus();
    };
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    return li;
  }

  // One of the user's changes. Clicking its text edits it.
  function changeCard(change) {
    if (changeDraft?.id === change.id) return changeEditor(change);
    const li = el('li', 'finding user-change');
    const head = el('div', 'finding-head');
    head.append(el('span', 'finding-kind', 'Your change'));
    const text = el('p', 'user-change-text', change.text);
    text.tabIndex = 0;
    text.setAttribute('role', 'button');
    text.title = 'Edit this change';
    const edit = () => {
      changeDraft = { id: change.id, text: change.text };
      render();
      container.querySelector('.change-editor textarea')?.focus();
    };
    text.addEventListener('click', edit);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        edit();
      }
    });
    li.append(head, text);
    return li;
  }

  // Writing a new change, or editing one (`change`). Cmd/Ctrl+Return saves; Escape cancels.
  function changeEditor(change) {
    const li = el('li', 'finding change-editor');
    const head = el('div', 'finding-head');
    head.append(el('span', 'finding-kind', change ? 'Your change' : 'New change'));
    const text = el('textarea', 'change-text');
    text.rows = 2;
    text.placeholder = 'What should the AI change? For example: “Add a short summary at the top.”';
    text.value = changeDraft.text;
    text.addEventListener('input', () => (changeDraft.text = text.value));
    const row = el('div', 'decision-buttons');
    const button = (label, className, action) => {
      const b = el('button', className, label);
      b.type = 'button';
      b.addEventListener('click', action);
      row.append(b);
      return b;
    };
    const close = () => {
      changeDraft = null;
      render();
    };
    const save = async () => {
      if (!text.value.trim()) return;
      if (change) await api.updateChange(change.id, text.value);
      else await api.addChange(text.value);
      close();
    };
    if (change) {
      button('Delete', 'secondary-button change-delete', async () => {
        await api.removeChange(change.id);
        close();
      });
    }
    button('Cancel', 'secondary-button', close);
    const saveButton = button(change ? 'Save' : 'Add', 'primary-button', save);
    const sync = () => (saveButton.disabled = !text.value.trim());
    text.addEventListener('input', sync);
    sync();
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    li.append(head, text, row);
    return li;
  }

  // A card's heading row: its label, an optional state and the arrow that opens and closes it.
  function cardHead(li, id, label, stateText) {
    const head = el('div', 'finding-head');
    const toggle = el('button', 'finding-toggle');
    toggle.type = 'button';
    toggle.innerHTML = CHEVRON_ICON;
    const setMinimised = (on) => {
      if (on) expanded.delete(id);
      else expanded.add(id);
      li.classList.toggle('minimised', on);
      toggle.title = on ? 'Expand' : 'Minimise';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(!on));
    };
    // Only the arrow button opens and closes the finding; clicking the rest of it shows its text.
    toggle.addEventListener('click', () => setMinimised(expanded.has(id)));
    setMinimised(!expanded.has(id));
    const end = el('span', 'finding-head-end');
    if (stateText) end.append(el('span', 'finding-state', stateText));
    end.append(toggle);
    head.append(el('span', 'finding-kind', label), end);
    li.append(head);
  }

  // Clicking a card (not its controls) shows its text; hovering it highlights the text.
  function linkToText(li, anchors) {
    li.addEventListener('mouseenter', () => onHover(anchors));
    li.addEventListener('mouseleave', () => onHover(null));
    li.addEventListener('click', (e) => {
      if (!e.target.closest('.decision-card, button, textarea, input, label')) onReveal(anchors);
    });
  }

  function findingCard(item, review, committed) {
    const li = el('li', `finding finding-${item.kind} severity-${item.severity} decision-${item.decision.status}`);
    cardHead(li, item.id, KIND_LABELS[item.kind], STATUS_LABELS[item.decision.status]);
    li.append(el('h3', 'finding-title', item.title));
    if (item.inResponseTo) {
      const request = review.requests.find((r) => r.id === item.inResponseTo);
      if (request) li.append(el('p', 'finding-reply', `In response to your ${requestLabel(request.kind).toLowerCase()} request`));
    }
    if (item.body) li.append(el('p', 'finding-body', item.body));
    if (item.anchors.length && item.kind !== 'change') li.append(el('blockquote', 'finding-quote', item.anchors.map((a) => a.text).join(' … ')));

    if (item.kind === 'change' && item.proposal) {
      const diff = el('div', 'diff');
      if (item.proposal.before) diff.append(el('del', null, item.proposal.before));
      diff.append(el('ins', null, item.decision.edited ?? item.proposal.after ?? ''));
      li.append(diff);
    }
    if ((item.kind === 'move' || item.kind === 'design') && item.proposal?.description) li.append(el('p', 'finding-proposal', item.proposal.description));
    if (item.kind === 'question' && item.question) li.append(el('p', 'finding-question', item.question));

    if (committed) li.append(decisionControls(item));
    else if (item.kind === 'options') li.append(optionList(item, false));

    linkToText(li, item.anchors);
    return li;
  }

  // The AI's note on some text: what it says, and the text it marks. A note without words shows
  // the text as its title instead.
  function noteCard(note) {
    const style = MARK_LABELS[note.style] ? note.style : 'highlight';
    const li = el('li', `finding finding-note note-${style}`);
    cardHead(li, note.id, MARK_LABELS[style]);
    const quote = note.anchors.map((a) => a.text.replace(/\s+/g, ' ')).join(' … ');
    li.append(el('h3', 'finding-title', note.note || quote));
    if (note.note && quote) li.append(el('blockquote', 'finding-quote', quote));
    linkToText(li, note.anchors);
    return li;
  }

  // The controls stay in place once a finding is decided (the options, the text boxes and the
  // comment); only the buttons give way to a card showing the decision, and clicking that card
  // brings them back to change it. Options have no buttons: the chosen one simply stays selected.
  function decisionControls(item) {
    const box = el('div', 'decision');
    const decided = item.decision.status !== 'pending';
    // Making a decision ends any change to it; a comment alone doesn't.
    const decide = (decision) => {
      editing.delete(item.id);
      return api.decide(item.id, decision);
    };
    const buttons = (...defs) => {
      if (decided && !editing.has(item.id)) return decisionCard(item);
      const row = el('div', 'decision-buttons');
      if (editing.has(item.id)) {
        const cancel = el('button', 'secondary-button decision-cancel', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', () => {
          editing.delete(item.id);
          render();
        });
        row.append(cancel);
      }
      for (const [label, decision, primary] of defs) {
        const b = el('button', primary ? 'primary-button' : 'secondary-button', label);
        b.type = 'button';
        b.addEventListener('click', () => decide(decision));
        row.append(b);
      }
      return row;
    };

    if (item.kind === 'change') {
      const edit = el('textarea', 'decision-edit');
      edit.rows = 3;
      edit.value = item.decision.edited ?? item.proposal?.after ?? '';
      edit.hidden = true;
      edit.addEventListener('change', () => decide({ status: 'accepted', edited: edit.value }));
      const row = buttons(['Reject', { status: 'rejected' }], ['Accept', { status: 'accepted' }, true]);
      if (row.classList.contains('decision-buttons')) {
        const editButton = el('button', 'secondary-button', 'Edit');
        editButton.type = 'button';
        editButton.addEventListener('click', () => {
          edit.hidden = false;
          edit.focus();
        });
        const cancel = row.querySelector('.decision-cancel');
        if (cancel) cancel.after(editButton);
        else row.prepend(editButton);
      }
      box.append(edit, row);
    } else if (item.kind === 'options') {
      box.append(optionList(item, true));
    } else if (item.kind === 'question') {
      const answer = el('textarea', 'decision-answer');
      answer.rows = 2;
      answer.placeholder = 'Your answer';
      answer.value = item.decision.answer ?? '';
      const row = buttons(['Skip', { status: 'rejected' }]);
      if (row.classList.contains('decision-buttons')) {
        const save = el('button', 'primary-button', 'Answer');
        save.type = 'button';
        save.addEventListener('click', () => answer.value.trim() && decide({ status: 'answered', answer: answer.value.trim() }));
        row.append(save);
      } else {
        // Once answered, changing the text updates the answer.
        answer.addEventListener('change', () => answer.value.trim() && api.decide(item.id, { status: 'answered', answer: answer.value.trim() }));
      }
      box.append(answer, row);
    } else if (item.kind === 'flag') {
      box.append(buttons(['Acknowledge', { status: 'acknowledged' }, true]));
    } else {
      box.append(buttons(['Reject', { status: 'rejected' }], ['Accept', { status: 'accepted' }, true]));
    }

    const comment = el('textarea', 'decision-comment');
    comment.rows = 1;
    comment.placeholder = 'Comment for the AI (optional)';
    comment.value = item.decision.comment ?? '';
    comment.addEventListener('change', () => api.decide(item.id, { comment: comment.value }));
    // The comment goes above the buttons (or the decision card standing in for them), so it's
    // written before deciding; options have no buttons, so it follows them.
    const choice = box.querySelector(':scope > .decision-buttons, :scope > .decision-card');
    if (choice) choice.before(comment);
    else box.append(comment);
    return box;
  }

  // Stands in for the buttons once decided: the decision made, and a hint that it can be changed.
  function decisionCard(item) {
    const d = item.decision;
    const title = item.kind === 'question' && d.status === 'rejected' ? 'Skipped'
      : item.kind === 'change' && d.status === 'accepted' && d.edited != null && d.edited !== item.proposal?.after ? 'Accepted with your edit'
      : STATUS_LABELS[d.status];
    const card = el('div', `decision-card decision-card-${d.status}`);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = 'Change this decision';
    card.append(el('span', 'decision-card-title', title), el('span', 'decision-card-hint', 'Change'));
    const edit = () => {
      editing.add(item.id);
      render();
    };
    card.addEventListener('click', edit);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        edit();
      }
    });
    return card;
  }

  // When the user can choose, the AI's options end with "None of these", which rejects them all.
  function optionList(item, selectable) {
    const list = el('div', 'option-list');
    const addOption = (title, description, checked, decision) => {
      const label = el('label', 'option');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `option-${item.id}`;
      radio.checked = checked;
      radio.disabled = !selectable;
      radio.addEventListener('change', () => {
        editing.delete(item.id);
        api.decide(item.id, decision);
      });
      const text = el('span', 'option-text');
      text.append(el('strong', null, title));
      if (description) text.append(el('span', null, description));
      label.append(radio, text);
      list.append(label);
    };
    item.options?.forEach((option, i) => addOption(option.label, option.text, item.decision.choice === i, { status: 'accepted', choice: i }));
    if (selectable) addOption('None of these', null, item.decision.status === 'rejected', { status: 'rejected', choice: null });
    return list;
  }

  render();
  return {
    update(next) {
      state = { ...state, ...next };
      render();
    },
    minimiseAll() {
      expanded.clear();
      render();
    },
  };
}

const formatDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const formatDateTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
