import { anchorRects, pageContent } from './anchors.js';
import { toolOf } from './tool-switcher.js';

// The review, laid out in the margins either side of the pages. Each item (a finding, a note or a
// highlight) is a tab beside the line its text starts on: findings about a whole section
// (structure, design) on the left, everything else on the right, and items about no text at all
// in a "Whole document" deck at the top of page 1 on the left. Every tab is the same height, with
// three rows: its kind, its title and its status.
// Tabs never move off their line: one that would overlap the tab above joins it as another card
// in that deck, and the deck pages through its cards ("1 of 3"). Undecided cards come first, then
// notes, then decided ones. Opening a card expands it in place over the margin; nothing moves.
// Hovering a deck brings its top card's text forward on the page; the page tints every item's
// text otherwise (see overlays.js). Selecting text on the page fades the decks that aren't about
// it. A bar under the pages names the tool, says where the review stands and steps through the
// cards; once every finding is decided, it offers the prompt that asks the AI to apply them
// instead (the prompts to start a review are in the focus menu, see focus-picker.js). While a highlights review shows as a list (`view`, see highlights-list.js), there's
// nothing on the page to step through. With `hideDone` (Review and draft), decided findings leave
// the margins and the page (the bar still counts them).

const TAB_HEIGHT = 76; // .margin-tab's height
const PAGER_HEIGHT = 28; // a deck's tab adds a row for its pager (.multi .margin-tab)
const PEEK = 10; // how far the cards behind a deck's top card show below it
const GAP = 8; // the least space between decks
const LIFT = 7; // a tab's top sits this far above its line, so its title lines up with the text
const CARD_WIDTH = 264;
const CARD_INSET = 20; // the space kept between a card and the window edge
const PAGE_SPACE = 10; // the space between a card and the page's edge
const LINKED = 10; // a deck further than this from its card's line draws a line back to it

const FINDING_KINDS = {
  change: { label: 'Wording', color: '#2f6fde', side: 'r' },
  options: { label: 'Content', color: '#7c4ddb', side: 'r' },
  question: { label: 'Question', color: '#08778d', side: 'r' },
  move: { label: 'Structure', color: '#a65a00', side: 'l' },
  design: { label: 'Design', color: '#c2417a', side: 'l' },
  flag: { label: 'Flag', color: '#b23c3c', side: 'r' },
};
const NOTE = { label: 'Note', color: '#b38a00', kindColor: '#7d5e00', background: '#fffbea', tint: 'rgba(255, 214, 10, 0.32)', strong: 'rgba(255, 214, 10, 0.6)' };
// A highlights review colours each category, in the order the categories first appear.
const CATEGORY_COLOURS = ['#2f6fde', '#7c4ddb', '#1f7a45', '#a65a00', '#08778d', '#c2417a'];
const IMPORTANCE_LABELS = { high: 'Important', medium: 'Worth knowing', low: 'Minor' };
const STATUS_LABELS = { accepted: 'Accepted', rejected: 'Rejected', answered: 'Answered', acknowledged: 'Acknowledged' };

const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

export const isHighlights = (review) => review?.type === 'highlights';

// `layer` covers the pages and their margins and scrolls with them; `pagesEl` holds the .page
// elements; `bar` is the bar under the pages. `onMarks` is given what to draw on the page:
// { items: [{ id, anchors, tint, strong }], focus: [ids], veil } (see overlays.js).
// `onReveal(anchors)` scrolls text into view; `onClearFilter` is called to show every deck again.
export function createMarginReview({ layer, pagesEl, bar, api, onMarks, onReveal, onClearFilter }) {
  let state = { document: null, review: null, tool: 'improve', view: 'document', hideDone: false, filter: null };
  let open = null; // the open deck's key (its first item's id)
  let hover = null; // the hovered deck's key
  let stepped = null; // the deck Previous/Next last opened: it shows as if hovered while it stays open
  const pages = new Map(); // deck key → the card it shows (an index into its order)
  const editing = new Set(); // ids of decided findings whose decision is being changed
  let decks = [];
  let items = []; // everything in the review
  let shown = []; // what's on the page: all of it, or (with `hideDone`) only what's still to do

  // --- What the review holds ----------------------------------------------------------------

  function reviewItems(review) {
    if (!review) return [];
    const committed = review.status === 'committed';
    if (isHighlights(review)) {
      const colours = new Map();
      for (const h of review.highlights ?? []) {
        if (!colours.has(h.category)) colours.set(h.category, CATEGORY_COLOURS[colours.size % CATEGORY_COLOURS.length]);
      }
      // Highlights are to read: nothing to decide.
      return (review.highlights ?? []).map((h) => ({
        id: h.id, type: 'highlight', highlight: h, side: 'r', anchors: h.missing ? [] : h.anchors,
        label: h.category, color: colours.get(h.category), title: h.title,
        decidable: false, decided: false,
        status: h.missing ? 'Not in the document' : IMPORTANCE_LABELS[h.importance] ?? 'Highlight',
      }));
    }
    const findings = review.items.map((item) => {
      const kind = FINDING_KINDS[item.kind] ?? FINDING_KINDS.flag;
      return {
        id: item.id, type: 'finding', item, side: kind.side, anchors: item.anchors,
        label: kind.label, color: kind.color, title: item.title,
        decidable: true, decided: item.decision.status !== 'pending',
        status: committed ? findingStatus(item) : 'Waiting for the AI',
      };
    });
    const notes = (review.annotations ?? []).map((note) => ({
      id: note.id, type: 'note', note, side: 'r', anchors: note.anchors,
      label: NOTE.label, color: NOTE.color, kindColor: NOTE.kindColor, background: NOTE.background, tint: NOTE.tint, strong: NOTE.strong,
      title: note.note || quoteOf(note.anchors), decidable: false, decided: false, status: 'No decision needed',
    }));
    return [...findings, ...notes];
  }

  function findingStatus(item) {
    const d = item.decision;
    if (d.status === 'pending') return 'Undecided';
    if (item.kind === 'question' && d.status === 'rejected') return '✓ Skipped';
    if (item.kind === 'options' && d.status === 'accepted') return `✓ ${item.options?.[d.choice]?.label ?? 'Chosen'}`;
    if (item.kind === 'options' && d.status === 'rejected') return '✓ None of these';
    if (item.kind === 'change' && d.status === 'accepted' && d.edited != null && d.edited !== item.proposal?.after) return '✓ Accepted with your edit';
    return `✓ ${STATUS_LABELS[d.status] ?? d.status}`;
  }

  // --- Where everything goes ------------------------------------------------------------------

  // The page geometry the margins hang off: the first page's edges and top, in layer coordinates.
  function geometry() {
    const first = pagesEl.querySelector('.page');
    if (!first) return null;
    return { left: first.offsetLeft, right: first.offsetLeft + first.offsetWidth, top: first.offsetTop, width: layer.clientWidth };
  }

  // The top of an item's text (its first line), in layer coordinates; null until its page is drawn.
  function lineTop(anchors) {
    const first = [...anchors].sort((a, b) => a.page - b.page || a.start - b.start)[0];
    const content = first && pageContent(first.page);
    const rects = content ? anchorRects(first) : [];
    if (!rects.length) return null;
    const pageEl = content.parentElement;
    const scale = pageEl.offsetWidth / Number(pageEl.dataset.width) || 1;
    return pageEl.offsetTop + Math.min(...rects.map((r) => r.y)) * scale;
  }

  function buildDecks(geo) {
    for (const item of shown) {
      if (item.anchors.length) {
        item.y = lineTop(item.anchors);
        item.deckSide = item.side;
      } else {
        item.y = geo.top + LIFT;
        item.deckSide = 'l';
        item.whole = true;
      }
    }
    const result = [];
    for (const side of ['l', 'r']) {
      let last = null;
      for (const item of shown.filter((i) => i.deckSide === side && i.y != null).sort((a, b) => a.y - b.y)) {
        if (last && item.y - LIFT < last.top + last.height + GAP) {
          last.ids.push(item.id);
          last.height = TAB_HEIGHT + PAGER_HEIGHT + PEEK;
        } else {
          last = { key: item.id, side, ids: [item.id], top: item.y - LIFT, height: TAB_HEIGHT };
          result.push(last);
        }
      }
    }
    const byId = new Map(shown.map((i) => [i.id, i]));
    const rank = (i) => (i.decided ? 2 : i.decidable ? 0 : 1);
    for (const deck of result) {
      deck.items = deck.ids.map((id) => byId.get(id));
      deck.order = [...deck.items].sort((a, b) => rank(a) - rank(b) || deck.items.indexOf(a) - deck.items.indexOf(b));
      // While text is selected on the page, a deck about it shows its first card about it.
      const matching = state.filter ? deck.order.findIndex((i) => overlapsFilter(i.anchors)) : -1;
      deck.matches = !state.filter || matching !== -1;
      deck.page = matching !== -1 ? matching : Math.min(pages.get(deck.key) ?? 0, deck.order.length - 1);
      deck.cur = deck.order[deck.page];
      deck.whole = deck.items.some((i) => i.whole);
    }
    return result;
  }

  const overlapsFilter = (anchors) => anchors.some((a) => state.filter.some((f) => f.page === a.page && a.start < f.end && f.start < a.end));

  // --- Drawing --------------------------------------------------------------------------------

  function render() {
    layer.replaceChildren();
    items = reviewItems(state.review);
    // Hiding what's done leaves the notes, which have nothing to do.
    shown = state.hideDone ? items.filter((i) => !i.decided) : items;
    const geo = shown.length ? geometry() : null;
    decks = geo ? buildDecks(geo) : [];
    if (open && !decks.some((d) => d.key === open)) open = null;
    if (hover && !decks.some((d) => d.key === hover)) hover = null;
    const width = geo ? Math.max(140, Math.min(CARD_WIDTH, Math.min(geo.left, geo.width - geo.right) - CARD_INSET - PAGE_SPACE)) : CARD_WIDTH;
    for (const deck of decks) layer.append(...deckElements(deck, geo, width));
    renderBar();
    sendMarks();
  }

  function deckElements(deck, geo, width) {
    const cur = deck.cur;
    const right = deck.side === 'r';
    const isOpen = open === deck.key;
    const n = deck.order.length;
    const elements = [];

    // A line along the page edge from the deck back to its card's text, once they're apart.
    if (!cur.whole && cur.y != null) {
      const lineAt = cur.y + 2;
      const tabAt = deck.top + 12;
      if (Math.abs(tabAt - lineAt) > LINKED) {
        const link = el('div', 'margin-link');
        Object.assign(link.style, {
          left: `${right ? geo.right : geo.left - 2}px`,
          top: `${Math.min(lineAt, tabAt)}px`,
          height: `${Math.abs(tabAt - lineAt)}px`,
          background: cur.color,
        });
        elements.push(link);
      }
    }

    const slot = el('div', `margin-slot margin-${right ? 'r' : 'l'}${n > 1 ? ' multi' : ''}${cur.decided ? ' decided' : ''}${deck.matches ? '' : ' filtered-out'}${isOpen ? ' open' : ''}${hover === deck.key ? ' hovered' : ''}`);
    slot.dataset.key = deck.key;
    Object.assign(slot.style, { top: `${deck.top}px`, width: `${width}px`, left: `${right ? geo.right + PAGE_SPACE : geo.left - width - PAGE_SPACE}px` });
    slot.style.setProperty('--item-color', cur.color);
    slot.style.setProperty('--item-kind-color', cur.kindColor ?? cur.color);
    slot.style.setProperty('--item-background', cur.background ?? '#fff');
    for (let i = Math.min(n - 1, 2); i >= 1; i--) {
      const peek = el('div', 'margin-peek');
      peek.style.transform = `translateY(${i * 5}px)`;
      slot.append(peek);
    }
    slot.append(isOpen ? openCard(deck) : tab(deck));
    if (n > 1) slot.append(pager(deck, n));
    slot.addEventListener('mouseenter', () => setHover(deck.key));
    slot.addEventListener('mouseleave', () => setHover(null));
    elements.push(slot);
    return elements;
  }

  // A closed deck: its top card's kind, title and status. Clicking it opens the card.
  function tab(deck) {
    const cur = deck.cur;
    const button = el('button', 'margin-tab');
    button.type = 'button';
    const decidable = deck.items.filter((i) => i.decidable);
    const allDecided = deck.order.length > 1 && decidable.length > 0 && decidable.every((i) => i.decided);
    button.append(
      el('span', 'margin-kind', deck.whole && deck.order.length > 1 ? 'Whole document' : cur.label),
      el('span', 'margin-title', cur.title),
      el('span', 'margin-status', allDecided ? `✓ All ${decidable.length} decided` : cur.whole && !cur.highlight?.missing ? `Whole document · ${cur.status}` : cur.status),
    );
    button.title = cur.title;
    button.addEventListener('click', () => openDeck(deck.key, deck.page));
    return button;
  }

  // "1 of 3" with arrows either side, on a row of its own across the bottom of the deck, open or
  // closed.
  function pager(deck, n) {
    const box = el('div', 'margin-pager');
    const step = (delta) => {
      pages.set(deck.key, (deck.page + delta + n) % n);
      render();
    };
    const back = el('button', null, '‹');
    back.type = 'button';
    back.setAttribute('aria-label', 'Previous card here');
    back.addEventListener('click', () => step(-1));
    const next = el('button', null, '›');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next card here');
    next.addEventListener('click', () => step(1));
    box.append(back, el('span', null, `${deck.page + 1} of ${n}`), next);
    return box;
  }

  function openCard(deck) {
    const cur = deck.cur;
    const card = el('div', 'margin-card');
    const head = el('div', 'margin-card-head');
    head.append(el('span', 'margin-kind', cur.whole ? `${cur.label} · whole document` : cur.label));
    const close = el('button', 'margin-close');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => closeDeck());
    head.append(close);
    card.append(head, el('h3', 'margin-card-title', cur.title));
    if (cur.type === 'finding') findingBody(card, cur.item);
    else if (cur.type === 'note') noteBody(card, cur.note);
    else highlightBody(card, cur.highlight);
    // Clicking the card (not its controls) brings its text into view.
    card.addEventListener('click', (e) => {
      if (!e.target.closest('button, textarea, input, label, .decision-card')) onReveal(cur.anchors);
    });
    return card;
  }

  function findingBody(card, item) {
    const review = state.review;
    if (item.inResponseTo) {
      const request = review.requests.find((r) => r.id === item.inResponseTo);
      if (request) card.append(el('p', 'finding-reply', `In response to your ${request.kind} request`));
    }
    if (item.body) card.append(el('p', 'finding-body', item.body));
    if (item.anchors.length && item.kind !== 'change') card.append(el('blockquote', 'finding-quote', quoteOf(item.anchors)));
    if (item.kind === 'change' && item.proposal) {
      const diff = el('div', 'diff');
      if (item.proposal.before) diff.append(el('del', null, item.proposal.before));
      diff.append(el('ins', null, item.decision.edited ?? item.proposal.after ?? ''));
      card.append(diff);
    }
    if ((item.kind === 'move' || item.kind === 'design') && item.proposal?.description) card.append(el('p', 'finding-proposal', item.proposal.description));
    if (item.kind === 'question' && item.question) card.append(el('p', 'finding-question', item.question));
    if (review.status === 'committed') card.append(decisionControls(item));
    else if (item.kind === 'options') card.append(optionList(item, false));
  }

  function noteBody(card, note) {
    if (note.note && note.anchors.length) card.append(el('blockquote', 'finding-quote', quoteOf(note.anchors)));
  }

  // A highlight: how important it is, why it matters and the text it quotes.
  function highlightBody(card, h) {
    card.append(el('p', 'finding-reply', h.missing ? 'Not in the document' : IMPORTANCE_LABELS[h.importance] ?? 'Highlight'));
    if (h.note) card.append(el('p', 'finding-body', h.note));
    if (h.anchors.length) card.append(el('blockquote', 'finding-quote', quoteOf(h.anchors)));
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
    const card = el('button', `decision-card decision-card-${d.status}`);
    card.type = 'button';
    card.title = 'Change this decision';
    card.append(el('span', 'decision-card-title', findingStatus(item).replace(/^✓ /, '')), el('span', 'decision-card-hint', 'Change'));
    card.addEventListener('click', () => {
      editing.add(item.id);
      render();
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

  // --- The bar under the pages ----------------------------------------------------------------

  function renderBar() {
    const review = state.review;
    bar.replaceChildren();
    const tool = toolOf(state.tool);
    // The tool's icon, in its colour; its name is for hover and screen readers.
    const label = el('span', 'review-bar-tool');
    label.innerHTML = tool.icon;
    label.title = tool.label;
    label.setAttribute('role', 'img');
    label.setAttribute('aria-label', tool.label);
    const text = el('span', 'review-bar-text');
    const left = el('div', 'review-bar-start');
    left.append(label, text);
    bar.append(left);
    if (!review) {
      // The prompts are in the focus menu at the top.
      text.textContent = 'No review yet. Choose a focus at the top to copy the prompt for your AI.';
      return;
    }
    const decidable = items.filter((i) => i.decidable);
    const decided = decidable.filter((i) => i.decided).length;
    const committed = review.status === 'committed';
    if (state.filter) {
      const count = items.filter((i) => overlapsFilter(i.anchors)).length;
      text.textContent = count ? `${count} ${count === 1 ? 'card is' : 'cards are'} about the selected text` : 'Nothing in the review is about the selected text';
      const all = el('button', 'secondary-button', 'Show all');
      all.type = 'button';
      all.addEventListener('click', onClearFilter);
      left.append(all);
    } else if (!committed) {
      const noun = isHighlights(review) ? 'highlight' : 'finding';
      text.textContent = `${isHighlights(review) ? 'Your AI is picking out the key information' : 'Your AI is reviewing'}…${items.length ? ` ${items.length} ${noun}${items.length === 1 ? '' : 's'} so far` : ''}`;
    } else if (isHighlights(review)) {
      text.textContent = items.length ? `${items.length} highlight${items.length === 1 ? '' : 's'}` : 'The AI found nothing to highlight.';
    } else if (!decidable.length) {
      text.textContent = 'The AI found nothing to change.';
    } else if (decided === decidable.length && !review.applications?.length) {
      // Everything decided: nothing left to step through, just the prompt to send.
      text.textContent = `All ${decided} decided. Send your AI the prompt to write the next draft.`;
      bar.append(copyPromptButton());
      return;
    } else {
      text.textContent = decided === decidable.length ? `All ${decided} decided` : `${decided} of ${decidable.length} decided`;
      const progress = el('span', 'review-progress');
      const fill = el('span', 'review-progress-fill');
      fill.style.width = `${Math.round((decided / decidable.length) * 100)}%`;
      progress.append(fill);
      left.append(progress);
    }
    const end = el('div', 'review-bar-end');
    bar.append(end);
    if (decks.length && state.view !== 'list') {
      const nav = el('div', 'review-bar-nav');
      for (const [label, delta] of [['‹ Previous', -1], ['Next ›', 1]]) {
        const b = el('button', 'secondary-button', label);
        b.type = 'button';
        b.addEventListener('click', () => step(delta));
        nav.append(b);
      }
      end.append(nav);
    }
  }

  // Copies the prompt to write the next draft (its text shows on hover); the icon turns to a tick
  // for a moment once copied. Prompts to start a review are in the focus menu (focus-picker.js).
  function copyPromptButton() {
    const label = 'Copy the prompt';
    const prompt = `I’ve made my decisions in SmartDoc. Apply the review and write the next draft of ${state.document ? `“${state.document.name}” (document ${state.document.id})` : 'my document'}.`;
    const button = el('button', 'primary-button copy-prompt');
    button.type = 'button';
    button.title = prompt;
    const show = (icon, text) => {
      button.innerHTML = icon;
      button.append(document.createTextNode(text));
    };
    show(COPY_ICON, label);
    let reset;
    button.addEventListener('click', async () => {
      await api.copyText(prompt);
      show(COPIED_ICON, 'Copied');
      clearTimeout(reset);
      reset = setTimeout(() => show(COPY_ICON, label), 1500);
    });
    return button;
  }

  // Steps card by card down the pages (left margin and right together), flipping decks to reach
  // each one and scrolling its text into view.
  function step(delta) {
    const placed = shown.filter((i) => i.y != null).sort((a, b) => a.y - b.y || (a.deckSide === 'l' ? -1 : 1));
    if (!placed.length) return;
    const current = decks.find((d) => d.key === open)?.cur;
    const at = current ? placed.indexOf(current) : -1;
    const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
    const target = placed[(from + delta + placed.length) % placed.length];
    const deck = decks.find((d) => d.ids.includes(target.id));
    stepped = deck.key;
    openDeck(deck.key, deck.order.indexOf(target));
    if (target.anchors.length) onReveal(target.anchors);
  }

  // --- Interaction ----------------------------------------------------------------------------

  function openDeck(key, page) {
    open = key;
    pages.set(key, page);
    render();
  }

  function closeDeck() {
    open = null;
    render();
  }

  // Hovering only restyles the decks and the page, so the deck under the pointer stays put.
  function setHover(key) {
    if (hover === key) return;
    hover = key;
    for (const slot of layer.querySelectorAll('.margin-slot')) slot.classList.toggle('hovered', slot.dataset.key === key);
    sendMarks();
  }

  function sendMarks() {
    // A deck reached with Previous/Next counts as hovered until it closes or the pointer is on
    // another deck.
    const hovered = decks.find((d) => d.key === hover) ?? (stepped === open ? decks.find((d) => d.key === stepped) : null);
    const opened = decks.find((d) => d.key === open);
    const focus = hovered ? [hovered.cur.id] : opened ? [opened.cur.id] : [];
    onMarks({
      items: shown.filter((i) => i.anchors.length).map((i) => ({ id: i.id, anchors: i.anchors, tint: i.tint ?? tint(i.color, 0.14), strong: i.strong ?? tint(i.color, 0.3) })),
      focus,
      veil: Boolean(hovered),
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && !e.target.closest?.('textarea, input')) closeDeck();
  });
  // Clicking the page lifts the dimming Previous/Next left.
  pagesEl.addEventListener('pointerdown', () => {
    if (!stepped) return;
    stepped = null;
    sendMarks();
  });

  render();
  return {
    update(next) {
      state = { ...state, ...next };
      render();
    },
    // Redraws in place, e.g. once a page is drawn or the window is resized.
    layout: render,
    // Opens the deck holding an item, on that item's card, and brings its text into view.
    openItem(id) {
      const deck = decks.find((d) => d.ids.includes(id));
      if (!deck) return;
      const item = deck.order.find((i) => i.id === id);
      openDeck(deck.key, deck.order.indexOf(item));
      if (item.anchors.length) onReveal(item.anchors);
    },
    // On opening a document or draft: every deck closed and back on its first card.
    reset() {
      open = null;
      hover = null;
      stepped = null;
      pages.clear();
      editing.clear();
      render();
    },
  };
}

const quoteOf = (anchors) => anchors.map((a) => a.text.replace(/\s+/g, ' ')).join(' … ');

// A see-through version of a #rrggbb colour.
function tint(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
