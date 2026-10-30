// Requests the user marked on the page in earlier versions of the app (rewrite, comment, keep, ...).
const requestLabel = (kind) => kind.charAt(0).toUpperCase() + kind.slice(1);

// The review column: the current draft's review. While the AI is still working (open) its findings
// show read-only; once committed, each finding carries the user's decision. The AI's notes on the
// text (its annotations: highlights, underlines and strikes) are listed among the findings, with
// nothing to decide. After them come changes the user writes themselves for the AI to carry out,
// and a dashed card to add another. Clicking a card scrolls its text into view, and hovering one highlights its
// text on the page. The step cards are always open; the cards in them start minimised to their
// heading, and open with the arrow button. Opening a document minimises them all again.

// Each finding is labelled by the part of the CV it's about (questions and notes aren't changes).
const KIND_LABELS = { change: 'Wording', options: 'Content', question: 'Question', move: 'Structure', design: 'Design', flag: 'Note' };
// Findings can be listed in the order their text appears in the CV, or by priority: high, medium,
// then low severity, keeping the AI's order within each. Findings with no text come last.
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

// Prompts for the user to send their AI: to start or carry on the review (step 1), and once
// they've decided, to apply it (the end of step 2). Each can be edited before copying; edits last
// until another review is shown.
const PROMPTS = {
  review: 'Review my CV in Shortlist Dock.',
  continue: 'Carry on reviewing my CV in Shortlist Dock, and commit the review when you’re done.',
  apply: 'I’ve made my decisions in Shortlist Dock. Apply the review and write the next draft of my CV.',
};
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const RESET_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const STATUS_LABELS = { pending: 'Undecided', accepted: 'Accepted', rejected: 'Rejected', answered: 'Answered', acknowledged: 'Acknowledged' };

// `container` is the card; `scroller` is what scrolls it (the whole card scrolls in its column).
export function createReviewPanel({ container, scroller, api, onReveal, onHover }) {
  let state = { hasDocument: false, review: null };
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
      card.append(el('h2', 'review-heading', 'Review'), el('p', 'panel-hint', 'Open a CV to see its review.'));
      panel.append(card);
      return;
    }

    // The review in two steps: the AI reviews, then the user decides and asks the AI to apply
    // their decisions. Each step can be reset, taking the review back to its start.
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
    if (!review) {
      review1.body.append(el('p', 'next-step-text', 'Ask your AI to review this CV: it reads the CV through the app, marks up the text and writes its findings here for you to decide on.'));
      review1.body.append(promptBlock('review', null, PROMPTS.review));
    } else {
      // Dated by when the AI committed it, or when it was started while still in progress.
      const dated = review.committedAt ?? review.createdAt;
      if (dated) {
        const time = el('time', 'review-date', formatDate(dated));
        time.dateTime = dated;
        time.title = [`Started ${formatDateTime(review.createdAt)}`, review.committedAt && `Committed ${formatDateTime(review.committedAt)}`].filter(Boolean).join('\n');
        review1.meta.append(time);
      }
      if (!committed) {
        review1.body.append(el('p', 'review-status', `In progress: the AI is still reviewing${items.length ? ` (${items.length} finding${items.length === 1 ? '' : 's'} so far)` : ''}. If it has stopped, ask it to carry on.`));
        review1.body.append(promptBlock('continue', review.id, PROMPTS.continue));
      }
      if (review.summary) review1.body.append(el('p', 'review-summary', review.summary));
    }

    const decide = step(2, 'Decide', !committed ? 'upcoming' : applied ? 'done' : 'current', {
      title: 'Clear your decisions and your own changes',
      enabled: committed && Boolean(decided || review.changes?.length || items.some((i) => i.decision.comment)),
      action: reset(2),
    });
    panel.append(decide.section);
    if (committed && items.length) decide.meta.textContent = `${decided} of ${items.length} decided`;
    const notes = review?.annotations ?? [];
    if (!review) {
      decide.body.append(el('p', 'panel-hint', 'The AI’s findings appear here for you to accept, reject or answer.'));
    } else if (!items.length) {
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
      const cards = [...items.map((item) => ({ item })), ...notes.map((note) => ({ note, anchors: note.anchors }))];
      for (const card of cards.sort((a, b) => ORDERS[order](a.item ?? a, b.item ?? b))) {
        list.append(card.item ? findingCard(card.item, review, committed) : noteCard(card.note));
      }
      // The user's own changes follow the AI's findings, then the card for adding another.
      if (committed) {
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
        promptBlock('apply', review.id, PROMPTS.apply),
      );
      decide.body.append(apply);
    }
    scroller.scrollTop = scroll;
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
    text.placeholder = 'What should the AI change? For example: “Add my AWS certification to Skills.”';
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
