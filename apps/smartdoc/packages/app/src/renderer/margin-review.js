import { anchorRects, pageContent, pageNumbers, pageText } from './anchors.js';
import { kindIcon } from './kind-icons.js';
import { earlierComments, isDone, notCommentedAgain, onVersion } from '../main/comments.js';

// The review, laid out in the margins either side of the pages. Each item (a finding, a note or a
// highlight) is a tab beside the line its text starts on: findings about a whole section
// (structure, design) on the left, everything else on the right, and items about no text at all
// in a "Whole document" deck at the top of page 1 on the left. A tab says only what the card is:
// its kind's icon and name and a short title, or, when the gutters are narrow, the icon alone.
// Tabs never move off their line: one that would overlap the tab above joins it as another card
// in that deck, which shows its top card and how many it holds. Undecided cards come first, then
// notes, then decided ones. Clicking a card opens it in full in the chat's tray (chat-panel.js), where
// it's read and decided in full; the chat lists every card in the document's order (those about all
// of it first).
// Hovering a deck brings its top card's text forward on the page; the page tints every item's
// text otherwise (see overlays.js). Selecting text on the page fades the decks that aren't about
// it. A bar under the pages says where the review stands; what to ask the AI next goes to the chat
// (`onSuggestion`), which replaced the bar's Copy the prompt buttons. While a highlights review
// shows as a list (`view`, see highlights-list.js), there's nothing on the page. While the AI's preview of the next draft
// shows (`preview`), its pages aren't what the review is about, so the review steps aside and the
// bar asks the user to accept or discard it.

const TAB_HEIGHT = 48; // .margin-tab's height: its kind's icon and name, then a short title
const ICON_TAB = 36; // in narrow gutters a tab is its kind's icon only, this size square
const ICON_ONLY_BELOW = 120; // the gutter's width, less its spacing, below which tabs are icons only
const FOLDED_HEIGHT = 32; // a comment needing no further action, alone: one line (.margin-tab.folded)
const GAP = 8; // the least space between decks
const LIFT = 7; // a tab's top sits this far above its line, so its title lines up with the text
const CARD_WIDTH = 220;
const WIDENED_CARD_WIDTH = 520; // the most a card takes when the user has made the gutters wider
export const MIN_CARD_WIDTH = ICON_TAB;
export const CARD_INSET = 20; // the space kept between a card and the window edge
export const PAGE_SPACE = 10; // the space between a card and the page's edge
const LINKED = 10; // a deck further than this from its card's line draws a line back to it

const FINDING_KINDS = {
  change: { label: 'Wording', color: '#2f6fde', side: 'r' },
  options: { label: 'Content', color: '#7c4ddb', side: 'r' },
  question: { label: 'Question', color: '#08778d', side: 'r' },
  move: { label: 'Structure', color: '#a65a00', side: 'l' },
  design: { label: 'Design', color: '#c2417a', side: 'l' },
  flag: { label: 'Flag', color: '#b23c3c', side: 'r' },
};
// The user's own comment on the text they selected.
const COMMENT = { label: 'Your comment', color: '#0f7c8a', background: 'light-dark(#e8f6f7, #16302f)', tint: 'rgba(15, 160, 175, 0.28)', strong: 'rgba(15, 160, 175, 0.5)' };
// A comment from before the version showing: dashed and muted, with no colour on the page.
const EARLIER = { color: '#8a8f98', background: 'var(--bg)' };
const NOTE = { label: 'Note', color: '#b38a00', kindColor: '#7d5e00', background: 'light-dark(#fffbea, #332d17)', tint: 'rgba(255, 214, 10, 0.32)', strong: 'rgba(255, 214, 10, 0.6)' };
// A highlights review colours each category, in the order the categories first appear.
const CATEGORY_COLOURS = ['#2f6fde', '#7c4ddb', '#1f7a45', '#a65a00', '#08778d', '#c2417a'];
const IMPORTANCE_LABELS = { high: 'Important', medium: 'Worth knowing', low: 'Minor' };
const STATUS_LABELS = { accepted: 'Accepted', rejected: 'Rejected', answered: 'Answered', acknowledged: 'Acknowledged' };


export const isHighlights = (review) => review?.type === 'highlights';

// `layer` covers the pages and their margins and scrolls with them; `pagesEl` holds the .page
// elements; `bar` is the bar under the pages. `onMarks` is given what to draw on the page:
// { items: [{ id, anchors, tint, strong }], focus: [ids], veil } (see overlays.js).
// `onReveal(anchors)` scrolls text into view; `onClearFilter` is called to show every deck again.
// `onOpenItem(id)` says an item was opened beside the pages (the chat opens with it); `onNote(note)`
// gives the chat a line of context for the AI, about what the user looked at or decided ({ text,
// detail, focus, about }: see note in main/agent.js); `onSuggestion(next)` gives the chat what to
// ask the AI next ({ what, label, prompt, waiting }), or null; `onChange()` says the review redrew.
export function createMarginReview({ layer, pagesEl, bar, api, onMarks, onCompare, pagesResized, onReveal, onOpenItem = () => {}, onNote = () => {}, onSuggestion, onChange, onClearFilter }) {
  let state = { document: null, review: null, earlier: [], tool: 'improve', view: 'document', filter: null, preview: null, comparing: false, commentable: false, aiWaiting: [] };
  let focused = null; // the id of the item open beside the pages: it stands out on the page
  let iconOnly = false; // the gutters are too narrow for more than the kinds' icons
  let suggestion = null; // what to ask the AI next, for the chat (see renderBar)
  let hover = null; // the hovered deck's key
  const editing = new Set(); // ids of decided findings whose decision is being changed
  const picked = new Map(); // finding id → the option picked, not yet confirmed: { decision, title }
  let decks = [];
  let items = []; // everything in the review
  let shown = []; // what's on the page: the review's items and earlier comments
  let order = []; // `shown` in the order to work through it (reviewOrder)

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
    // A comment belongs to the version it was written on, the draft or one draft preview, and only
    // means anything over its pages. One marked "No further action required" stays, folded to its
    // outcome, the AI's own words.
    const comments = (review.requests ?? []).filter((request) => request.kind === 'comment' && onVersion(request, review, { preview: Boolean(state.preview) })).map((request) => {
      const done = isDone(request);
      const responded = request.replies?.length || review.items.some((i) => i.inResponseTo === request.id);
      return {
        id: request.id, type: 'comment', request, side: 'r', anchors: request.anchors,
        ...COMMENT, title: request.note, decidable: false, decided: done, done,
        status: done ? request.outcome ?? 'No further action required'
          : request.outcome ?? (responded ? 'Your AI responded' : state.preview ? 'For your AI to change' : committed ? 'For the next draft' : 'For your AI'),
      };
    });
    return [...findings, ...notes, ...comments];
  }

  // Comments from before the version showing that weren't dealt with, where their text is still in
  // it: dashed cards to see, and to comment again on this version. They count for nothing here.
  function earlierItems() {
    if (state.tool !== 'improve' || isHighlights(state.review)) return [];
    // The chat's own window has no pages to look in: the app's window says where they are.
    if (state.earlierResolved) return state.earlierResolved.map(earlierItem);
    // On a preview, the draft's own comments and those it carried from earlier drafts.
    const earlier = state.preview
      ? [...earlierComments({ review: state.review, preview: true, draftLabel: () => state.preview.comparesWith }), ...notCommentedAgain(state.earlier ?? [], state.review)]
      : state.earlier ?? [];
    return notCommentedAgain(earlier, state.review).flatMap((comment) => {
      const anchors = comment.anchors.map(findAgain);
      return anchors.some((a) => !a) ? [] : [earlierItem({ ...comment, anchors })];
    });
  }

  const earlierItem = (comment) => ({
    id: `earlier-${comment.id}`, type: 'earlier', earlier: comment, side: 'r', anchors: comment.anchors,
    label: 'Earlier comment', color: EARLIER.color, background: EARLIER.background,
    title: comment.note, decidable: false, decided: false, done: false, status: `From ${comment.from}`,
  });

  // Where an earlier version's quoted text is in the pages drawn so far: on the same page first,
  // then any other (whitespace-insensitive, like the AI's quotes in src/main/anchors.js).
  function findAgain(anchor) {
    const pattern = (anchor.text ?? '').trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    if (!pattern) return null;
    for (const page of [anchor.page, ...pageNumbers().filter((n) => n !== anchor.page).sort((a, b) => a - b)]) {
      const match = new RegExp(pattern).exec(pageText(page));
      if (match) return { page, start: match.index, end: match.index + match[0].length, text: match[0] };
    }
    return null;
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

  // --- An item open beside the pages ---------------------------------------------------------
  // Clicking a deck opens its top card in a panel floating over the window, the card in full, to read
  // and decide: its kind and title along the top (which it's moved by), what it says (which
  // scrolls), and its comment for the AI and its decision along the bottom, always in view. The chat stays one conversation (the user found
  // cards in it a distraction): opening it opens the chat too, with a line of context there saying
  // what the user is looking at, for the AI with their next message, and so does each decision.
  // Escape, its close button, or its card's tab again closes it.
  const OPENED_WIDTH = 380;
  const reviewed = (item) => order.find((i) => i.item === item) ?? { id: item.id, title: item.title, label: 'Finding' };
  const DECIDED = { accepted: 'Accepted', rejected: 'Rejected', answered: 'Answered', acknowledged: 'Acknowledged' };
  function noteDecision(cur, decision, choice = null) {
    if (!decision?.status) return;
    const verb = choice ? `Chose “${choice}” for` : cur.item?.kind === 'question' && decision.status === 'rejected' ? 'Skipped' : DECIDED[decision.status] ?? 'Decided';
    onNote({ text: `${verb} “${cur.title}”`, detail: `${verb} the ${cur.label.toLowerCase()} “${cur.title}” (${cur.type ?? 'finding'} ${cur.id})${decision.edited ? `, with my own wording: “${decision.edited}”` : ''}${decision.answer ? `, answering: “${decision.answer}”` : ''}` });
  }

  function openCard(id) {
    const item = id && shown.find((i) => i.id === id);
    focused = item ? id : null;
    render();
    if (!item) return;
    if (item.anchors.length) onReveal(item.anchors);
    onOpenItem(id);
    onNote({
      text: `Looking at “${item.title}”`,
      detail: `Looking at the ${item.label.toLowerCase()} “${item.title}” (${item.type} ${item.id}) in the review on screen`,
      focus: true,
      about: item.title,
    });
  }

  // The panel floats over the window, free of the page (it doesn't scroll or zoom with it), and the
  // user moves it by its top (the user's choice). It opens beside its card's tab, which hides while
  // it's open, until the user has moved one: then where they put it last (kept for next time).
  const PLACE_KEY = 'opened-card-place';
  let panel = null; // the floating panel, made the first time a card is opened
  let placedFor = null; // the item the panel was placed for, so it's placed once per opening
  const keptPlace = () => {
    try {
      const place = JSON.parse(localStorage.getItem(PLACE_KEY));
      return Number.isFinite(place?.left) && Number.isFinite(place?.top) ? place : null;
    } catch {
      return null;
    }
  };
  // Inside the window, below its top bar, wholly in view where it can be.
  function placePanel(left, top) {
    const doc = layer.ownerDocument;
    const view = doc.documentElement;
    const topBar = doc.querySelector('.top-bar')?.getBoundingClientRect().bottom ?? 0;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    panel.style.left = `${Math.round(Math.max(8, Math.min(view.clientWidth - w - 8, left)))}px`;
    panel.style.top = `${Math.round(Math.max(topBar + 8, Math.min(view.clientHeight - Math.min(h, 120) - 8, top)))}px`;
  }

  function showOpened(geo) {
    const item = focused && shown.find((i) => i.id === focused);
    if (!item || !geo) {
      if (panel) panel.hidden = true;
      placedFor = null;
      return;
    }
    const doc = layer.ownerDocument;
    if (!panel) {
      panel = el('div', 'margin-opened');
      panel.setAttribute('role', 'dialog');
      doc.body.append(panel);
      dragPanel();
    }
    // A comment being written in it keeps what's written as it's drawn again.
    const typing = panel.contains(doc.activeElement) ? doc.activeElement : null;
    const kept = typing && { className: typing.className, value: typing.value, start: typing.selectionStart, end: typing.selectionEnd };
    panel.style.setProperty('--item-color', item.color);
    panel.style.setProperty('--item-kind-color', item.kindColor ?? item.color);
    panel.setAttribute('aria-label', item.title);
    const head = el('div', 'margin-opened-head');
    head.title = 'Drag to move';
    const close = el('button', 'margin-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => openCard(null));
    const top = el('div', 'margin-opened-top');
    top.append(el('span', 'margin-kind', item.whole ? `${item.label} · whole document` : item.label), el('span', 'margin-status', item.status), close);
    head.append(top, el('div', 'margin-opened-title', item.title));
    const card = fullCard(item);
    card.querySelector('.margin-card-head')?.remove(); // its kind is in the panel's own head
    const body = el('div', 'margin-opened-body');
    body.append(card);
    const foot = el('div', 'margin-opened-foot');
    const comment = card.querySelector('.decision-comment');
    const decision = card.querySelector('.decision-buttons, .decision-card');
    if (comment) foot.append(comment);
    if (decision) foot.append(decision);
    const scrolled = placedFor === item.id ? panel.querySelector('.margin-opened-body')?.scrollTop ?? 0 : 0;
    panel.replaceChildren(head, body);
    if (foot.childElementCount) panel.append(foot);
    panel.hidden = false;
    body.scrollTop = scrolled;
    if (placedFor !== item.id) {
      placedFor = item.id;
      const place = keptPlace();
      if (place) placePanel(place.left, place.top);
      else {
        // Beside its tab, over the page, its top level with the tab's.
        const tab = layer.querySelector(`.margin-slot[data-key="${CSS.escape(decks.find((d) => d.order.some((i) => i.id === item.id))?.key ?? '')}"]`)?.getBoundingClientRect();
        const right = item.side === 'r';
        const w = panel.offsetWidth;
        if (tab) placePanel(right ? tab.right - w : tab.left, tab.top);
        else placePanel((doc.documentElement.clientWidth - w) / 2, 120);
      }
    }
    if (kept) {
      const again = panel.querySelector(`.${kept.className.split(' ')[0]}`);
      if (again) {
        again.value = kept.value;
        again.focus();
        again.setSelectionRange(kept.start, kept.end);
      }
    }
  }

  // Dragged by its top (not its buttons), anywhere in the window; where it's left is kept.
  function dragPanel() {
    panel.addEventListener('pointerdown', (event) => {
      const head = event.target.closest('.margin-opened-head');
      if (!head || event.target.closest('button') || event.button !== 0) return;
      event.preventDefault();
      const at = panel.getBoundingClientRect();
      const from = { x: event.clientX - at.left, y: event.clientY - at.top };
      head.setPointerCapture(event.pointerId);
      panel.classList.add('moving');
      const move = (m) => placePanel(m.clientX - from.x, m.clientY - from.y);
      const end = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('lostpointercapture', end);
        panel.classList.remove('moving');
        try {
          localStorage.setItem(PLACE_KEY, JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop }));
        } catch {}
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('lostpointercapture', end);
    });
    // The window resized: still wholly in it.
    layer.ownerDocument.defaultView.addEventListener('resize', () => {
      if (!panel.hidden) placePanel(panel.offsetLeft, panel.offsetTop);
    });
  }

  layer.ownerDocument.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && focused && panel && !panel.hidden) openCard(null);
  });

  // --- Where everything goes ------------------------------------------------------------------

  // The page geometry the margins hang off: the first page's edges and top, in layer coordinates.
  function geometry() {
    const first = pagesEl.querySelector('.page');
    if (!first) return null;
    return { left: first.offsetLeft, right: first.offsetLeft + first.offsetWidth, top: first.offsetTop, width: layer.clientWidth };
  }

  const gutter = (geo) => Math.min(geo.left, geo.width - geo.right) - CARD_INSET - PAGE_SPACE;
  const cardWidth = (geo) => (iconOnly ? ICON_TAB : Math.min(pagesResized() ? WIDENED_CARD_WIDTH : CARD_WIDTH, gutter(geo)));

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
          last.tabHeight = Math.max(last.tabHeight, tabHeight(item));
          last.height = last.tabHeight;
        } else {
          last = { key: item.id, side, ids: [item.id], top: item.y - LIFT, tabHeight: tabHeight(item), height: tabHeight(item) };
          result.push(last);
        }
      }
    }
    const byId = new Map(shown.map((i) => [i.id, i]));
    // The user's own comment comes first until it's answered: it's what they've just been working on.
    const awaitingAnswer = (i) => i.type === 'comment' && !i.done && !i.request.replies?.length && !state.review.items.some((f) => f.inResponseTo === i.id);
    const rank = (i) => (i.type === 'earlier' ? 3 : awaitingAnswer(i) ? -1 : i.decided ? 2 : i.decidable ? 0 : 1);
    for (const deck of result) {
      deck.items = deck.ids.map((id) => byId.get(id));
      deck.order = [...deck.items].sort((a, b) => rank(a) - rank(b) || deck.items.indexOf(a) - deck.items.indexOf(b));
      // While text is selected on the page, a deck about it shows its first card about it.
      const matching = state.filter ? deck.order.findIndex((i) => overlapsFilter(i.anchors)) : -1;
      deck.matches = !state.filter || matching !== -1;
      deck.page = matching !== -1 ? matching : 0;
      deck.cur = deck.order[deck.page];
      deck.whole = deck.items.some((i) => i.whole);
    }
    return result;
  }

  const tabHeight = (item) => (iconOnly ? ICON_TAB : item.done ? FOLDED_HEIGHT : TAB_HEIGHT);

  // The order to work through the cards in: down the document, those about all of it first.
  function reviewOrder() {
    const first = (i) => [...i.anchors].sort((a, b) => a.page - b.page || a.start - b.start)[0];
    return [...shown].sort((a, b) => {
      const fa = first(a);
      const fb = first(b);
      if (!fa || !fb) return (fa ? 1 : 0) - (fb ? 1 : 0) || shown.indexOf(a) - shown.indexOf(b);
      return fa.page - fb.page || fa.start - fb.start || shown.indexOf(a) - shown.indexOf(b);
    });
  }

  const overlapsFilter = (anchors) => anchors.some((a) => state.filter.some((f) => f.page === a.page && a.start < f.end && f.start < a.end));

  // --- Drawing --------------------------------------------------------------------------------

  function render() {
    layer.replaceChildren();
    // On a draft preview the review steps aside, leaving only the comments made on it.
    items = reviewItems(state.review).filter((i) => !state.preview || i.type === 'comment');
    // Earlier comments are on the page but not in the review: nothing counts them.
    shown = [...items, ...earlierItems()];
    const geo = shown.length ? geometry() : null;
    iconOnly = Boolean(geo) && gutter(geo) < ICON_ONLY_BELOW;
    // Zoomed in so far there's no gutter left, the cards step aside (the chat still lists them).
    decks = geo && gutter(geo) >= ICON_TAB ? buildDecks(geo) : [];
    if (hover && !decks.some((d) => d.key === hover)) hover = null;
    order = reviewOrder();
    const width = geo ? cardWidth(geo) : CARD_WIDTH;
    for (const deck of decks) layer.append(...deckElements(deck, geo, width));
    showOpened(geo);
    renderBar();
    onSuggestion?.(suggestion);
    sendMarks();
    onChange?.();
  }

  function deckElements(deck, geo, width) {
    const cur = deck.cur;
    const right = deck.side === 'r';
    const n = deck.order.length;
    const elements = [];

    // A line along the page edge from the deck back to its card's text, once they're apart.
    if (!cur.whole && cur.y != null && cur.id !== focused) {
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

    // The card open in the floating panel is hidden here while it's open (the user's choice), its
    // place kept so the deck doesn't move.
    const slot = el('div', `margin-slot margin-${right ? 'r' : 'l'}${iconOnly ? ' icon-only' : ''}${n > 1 ? ' multi' : ''}${cur.id === focused ? ' focused opened' : ''}${cur.decided ? ' decided' : ''}${cur.type === 'earlier' ? ' earlier' : ''}${deck.matches ? '' : ' filtered-out'}${hover === deck.key ? ' hovered' : ''}`);
    slot.dataset.key = deck.key;
    Object.assign(slot.style, { top: `${deck.top}px`, width: `${width}px`, left: `${right ? geo.right + PAGE_SPACE : geo.left - width - PAGE_SPACE}px` });
    slot.style.setProperty('--item-color', cur.color);
    slot.style.setProperty('--item-kind-color', cur.kindColor ?? cur.color);
    slot.style.setProperty('--item-background', cur.background ?? 'var(--bg)');
    slot.append(tab(deck));
    slot.addEventListener('mouseenter', () => setHover(deck.key));
    slot.addEventListener('mouseleave', () => setHover(null));
    elements.push(slot);
    return elements;
  }

  // A deck: its top card's kind and a short title below, with how many cards the deck holds if
  // more than one; in narrow gutters its kind's icon alone, with that number at its corner. Clicking
  // it opens the top card beside it, over the page (see showOpened), and clicking it again closes it. A comment needing no further action, on its own, folds to one line: its outcome,
  // then the comment.
  function tab(deck) {
    const cur = deck.cur;
    const folded = !iconOnly && cur.done && deck.order.length === 1;
    const button = el('button', folded ? 'margin-tab folded' : iconOnly ? 'margin-tab icon' : 'margin-tab');
    button.type = 'button';
    const icon = el('span', 'margin-icon');
    icon.innerHTML = kindIcon(cur);
    if (iconOnly) {
      button.append(icon);
      if (deck.order.length > 1) button.append(el('span', 'margin-count', String(deck.order.length)));
      button.title = `${cur.label}: ${cur.title}`;
    } else if (folded) {
      button.append(el('span', 'margin-outcome', cur.status), el('span', 'margin-title', cur.title));
      button.title = `${cur.status}: ${cur.title}`;
    } else {
      const head = el('span', 'margin-tab-head');
      head.append(el('span', 'margin-kind', cur.whole ? `${cur.label} · whole document` : cur.label));
      if (cur.decided) head.append(el('span', 'margin-done', '✓'));
      if (deck.order.length > 1) head.append(el('span', 'margin-stack', String(deck.order.length)));
      button.append(head, el('span', 'margin-title', cur.title));
      button.title = deck.order.length > 1 ? `${cur.title} (and ${deck.order.length - 1} more here)` : cur.title;
    }
    button.setAttribute('aria-label', `${cur.label}: ${cur.title}`);
    button.addEventListener('click', () => openCard(focused === cur.id ? null : cur.id));
    return button;
  }

  // The card in full, for the chat's tray: everything to read and decide.
  function fullCard(cur) {
    const card = el('div', `margin-card review-card${cur.decided ? ' decided' : ''}${cur.type === 'earlier' ? ' earlier' : ''}`);
    card.style.setProperty('--item-color', cur.color);
    card.style.setProperty('--item-kind-color', cur.kindColor ?? cur.color);
    card.style.setProperty('--item-background', cur.background ?? 'var(--bg)');
    const head = el('div', 'margin-card-head');
    head.append(el('span', 'margin-kind', cur.whole ? `${cur.label} · whole document` : cur.label), el('span', 'margin-status', cur.status));
    card.append(head);
    if (cur.type === 'finding') findingBody(card, cur.item);
    else if (cur.type === 'note') noteBody(card, cur.note);
    else if (cur.type === 'comment') commentBody(card, cur);
    else if (cur.type === 'earlier') earlierBody(card, cur);
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
      if (request) card.append(el('p', 'finding-reply', request.kind === 'comment' ? `In response to your comment: “${request.note}”` : `In response to your ${request.kind} request`));
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

  // The comment, editable while it can still change what happens; once its review has become a
  // draft it's only there to read.
  function commentBody(card, cur) {
    const { request } = cur;
    if (state.commentable) {
      const input = el('textarea', 'comment-edit');
      input.rows = 3;
      input.value = request.note;
      input.setAttribute('aria-label', 'Your comment');
      input.addEventListener('change', () => {
        const note = input.value.trim();
        if (note) api.updateRequest(request.id, { note });
        else input.value = request.note;
      });
      card.append(input);
    } else {
      card.append(el('p', 'finding-body', request.note));
    }
    if (request.anchors.length) card.append(el('blockquote', 'finding-quote', quoteOf(request.anchors)));
    // The AI's replies, each with how it dealt with the comment, in its own words.
    for (const reply of request.replies ?? []) {
      const line = el('p', 'comment-ai-reply');
      if (reply.outcome) line.append(el('span', 'comment-outcome', reply.outcome));
      if (reply.text) line.append(document.createTextNode(reply.text));
      card.append(line);
    }
    if (!request.replies?.length) card.append(el('p', 'finding-reply', cur.status));
    else if (cur.done) card.append(el('p', 'finding-reply', 'No further action required'));
    // Whether anything more is needed: the AI says when it replies, and the user can say too.
    const actions = el('div', 'comment-actions');
    const flag = el('button', 'secondary-button', cur.done ? 'Open again' : 'No further action required');
    flag.type = 'button';
    flag.addEventListener('click', () => api.setNoFurtherAction(request.id, !cur.done));
    // Comments are never removed: they're the record of what was asked on each version.
    actions.append(flag);
    card.append(actions);
  }

  // A comment from an earlier version, not dealt with there, whose text is still here, with what the
  // AI said about it. Commenting again makes it this version's, anchored where its text is now.
  function earlierBody(card, cur) {
    card.append(el('p', 'finding-body', cur.title));
    card.append(el('blockquote', 'finding-quote', quoteOf(cur.anchors)));
    for (const reply of cur.earlier.replies ?? []) {
      const line = el('p', 'comment-ai-reply');
      if (reply.outcome) line.append(el('span', 'comment-outcome', reply.outcome));
      if (reply.text) line.append(document.createTextNode(reply.text));
      card.append(line);
    }
    card.append(el('p', 'finding-reply', `Written on ${cur.earlier.from} and not dealt with there. It isn’t on this version.`));
    if (!state.commentable) return;
    const actions = el('div', 'comment-actions');
    const again = el('button', 'secondary-button', 'Comment again');
    again.type = 'button';
    again.addEventListener('click', () => api.addRequest({ kind: 'comment', anchors: cur.anchors, note: cur.earlier.note, from: cur.earlier.id }));
    actions.append(again);
    card.append(actions);
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
  // brings them back to change it. Options are picked, then confirmed.
  function decisionControls(item) {
    const box = el('div', 'decision');
    const decided = item.decision.status !== 'pending';
    // Making a decision ends any change to it; a comment alone doesn't.
    const decide = (decision) => {
      editing.delete(item.id);
      noteDecision(reviewed(item), decision);
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
          picked.delete(item.id);
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
      const row = buttons(['Reject', { status: 'rejected' }], ['Accept', { status: 'accepted' }, true]);
      if (row.classList.contains('decision-buttons')) {
        // Editing happens in the suggestion itself: its green box becomes a text box, looking the
        // same, and leaving it accepts the change as edited.
        const editButton = el('button', 'secondary-button', 'Edit');
        editButton.type = 'button';
        editButton.addEventListener('click', () => {
          const ins = box.closest('.margin-card')?.querySelector('.diff ins');
          if (!ins) return;
          const edit = el('textarea', 'diff-edit');
          edit.value = item.decision.edited ?? item.proposal?.after ?? '';
          edit.setAttribute('aria-label', 'Your wording');
          edit.addEventListener('change', () => decide({ status: 'accepted', edited: edit.value }));
          ins.replaceWith(edit);
          edit.focus();
          edit.setSelectionRange(edit.value.length, edit.value.length);
          editButton.disabled = true;
        });
        const cancel = row.querySelector('.decision-cancel');
        if (cancel) cancel.after(editButton);
        else row.prepend(editButton);
      }
      box.append(row);
    } else if (item.kind === 'options') {
      // Picking an option only picks it; Confirm decides (the user's choice: a choice made by a
      // click alone was too easy to make by mistake).
      const locked = decided && !editing.has(item.id);
      box.append(optionList(item, !locked));
      const row = buttons();
      if (!locked) {
        const pick = picked.get(item.id);
        const confirm = el('button', 'primary-button', 'Confirm');
        confirm.type = 'button';
        confirm.disabled = !pick;
        confirm.title = pick ? `Choose “${pick.title}”` : 'Pick one of these first';
        confirm.addEventListener('click', () => {
          picked.delete(item.id);
          editing.delete(item.id);
          noteDecision(reviewed(item), pick.decision, pick.title);
          api.decide(item.id, pick.decision);
        });
        row.append(confirm);
      }
      box.append(row);
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
  // The options, as radio buttons: picking one only picks it (see decisionControls' Confirm).
  function optionList(item, selectable) {
    const list = el('div', 'option-list');
    const pick = picked.get(item.id);
    const addOption = (title, description, checked, decision) => {
      const label = el('label', 'option');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `option-${item.id}`;
      radio.checked = pick ? pick.title === title : checked;
      radio.disabled = !selectable;
      radio.addEventListener('change', () => {
        picked.set(item.id, { decision, title });
        render();
      });
      const text = el('span', 'option-text');
      text.append(el('strong', null, title));
      if (description) text.append(el('span', null, description));
      label.append(radio, text);
      list.append(label);
    };
    item.options?.forEach((option, i) => addOption(option.label, option.text, item.decision.choice === i, { status: 'accepted', choice: i }));
    if (selectable || item.decision.status === 'rejected') addOption('None of these', null, item.decision.status === 'rejected', { status: 'rejected', choice: null });
    return list;
  }

  // --- The bar under the pages ----------------------------------------------------------------

  // One line: a short sentence on the left on where the review stands or what needs doing, and on
  // the right what to do about it. The sentence gives way (an ellipsis) only when the window is too
  // narrow for it; the actions never do.
  // The bottom bar is the actions bar (as SmartSpec's): what's being worked on (the review and its
  // focus, or the draft preview) over a sentence on where it stands, on the left, and what to do
  // about it on the right; with nothing being worked on, the sentence alone.
  function renderBar() {
    const review = state.review;
    suggestion = null;
    bar.replaceChildren();
    const card = el('div', 'review-bar-card');
    const heading = el('div', 'review-bar-title');
    heading.hidden = true;
    const text = el('p', 'review-bar-text');
    card.append(heading, text);
    const end = el('div', 'review-bar-end');
    bar.append(card, end);
    const say = (sentence) => {
      text.textContent = sentence;
      text.title = sentence;
    };
    const title = (words) => {
      heading.textContent = words;
      heading.title = words;
      heading.hidden = !words;
    };
    if (state.preview) {
      title(`Draft ${state.preview.number} preview`);
      return renderPreviewBar(say, end);
    }
    if (review && !state.filter) {
      const focus = review.title ?? review.goal ?? null;
      title(isHighlights(review) ? `Key information${focus ? `: ${focus}` : ''}` : `Review${focus ? `: ${focus}` : ''}`);
    }
    const comments = items.filter((i) => i.type === 'comment' && !i.done).length;
    const yourComments = comments === 1 ? 'your comment' : `your ${comments} comments`;
    // A review only the user's comments have started: nothing has happened until the AI is told.
    const waitingForAi = review?.status === 'open' && !isHighlights(review) && review.history?.[0]?.who === 'user' && !review.items.length;
    if (waitingForAi && comments && !state.filter) {
      say(`Send ${yourComments} to your AI to review.`);
      appendPrompt(end, `I’ve added comments in SmartDoc to ${documentName()}. Review the document and respond to each one.`, 'Answer my comments');
      return;
    }
    if (!review || (waitingForAi && !state.filter)) {
      // The prompts are in the focus menu at the top.
      say('Choose a focus at the top, or ask your AI in the chat, to start a review.');
      if (state.document && !state.filter) {
        suggestion = state.tool === 'highlights'
          ? { what: 'start', label: 'Find the key information', prompt: `Find the key information in ${documentName()} for me. Ask me what I’m looking for first.` }
          : { what: 'start', label: 'Review this draft', prompt: `Review ${documentName()} and suggest improvements.` };
      }
      return;
    }
    const decidable = items.filter((i) => i.decidable);
    const decided = decidable.filter((i) => i.decided).length;
    const committed = review.status === 'committed';
    const findings = (n) => (n === 1 ? '1 finding' : `${n} findings`);
    const highlights = (n) => (n === 1 ? '1 highlight' : `${n} highlights`);
    if (state.filter) {
      const count = items.filter((i) => overlapsFilter(i.anchors)).length;
      say(count ? `${count === 1 ? '1 card is' : `${count} cards are`} about the text you selected.` : 'Nothing in the review is about the text you selected.');
      const all = el('button', 'secondary-button', 'Show all');
      all.type = 'button';
      all.addEventListener('click', onClearFilter);
      end.append(all);
      return;
    }
    if (!committed) {
      if (isHighlights(review)) say(items.length ? `Your AI has picked out ${highlights(items.length)} so far.` : 'Your AI is picking out the key information.');
      else say(items.length ? `Your AI has raised ${findings(items.length)} so far.` : 'Your AI is reviewing this draft.');
    } else if (isHighlights(review)) {
      say(items.length ? `Your AI picked out ${highlights(items.length)}.` : 'Your AI found nothing to highlight.');
    } else if (!decidable.length && comments) {
      say(nextStep('decisions', {
        sent: 'Your AI is writing the next draft from your comments.',
        waiting: `Your AI is waiting for ${yourComments}.`,
        send: `Send ${yourComments} to your AI for the next draft.`,
      }));
      appendPrompt(end);
      if (review.preview) end.append(viewPreviewButton('secondary-button'));
      return;
    } else if (!decidable.length) {
      say('Your AI found nothing to change.');
    } else if (decided === decidable.length && review.preview && !review.preview.outdated) {
      // Everything decided and the AI has written it up: just the preview to look at.
      say('Your AI has written a draft preview from your decisions.');
      end.append(viewPreviewButton('primary-button'));
      return;
    } else if (decided === decidable.length && !review.applications?.length) {
      // Everything decided: nothing left to step through, just the prompt to send.
      say(review.preview
        ? nextStep('decisions', {
          sent: 'Your AI is writing its draft preview again.',
          waiting: 'Your AI is waiting for the decisions you’ve changed.',
          send: 'You’ve changed your decisions since your AI wrote its draft preview.',
        })
        : nextStep('decisions', {
          sent: 'Your AI is writing the next draft from your decisions.',
          waiting: `Your AI is waiting for your decisions on ${findings(decided)}.`,
          send: `You’ve decided all ${findings(decided)}. Send them to your AI.`,
        }));
      appendPrompt(end);
      if (review.preview) end.append(viewPreviewButton('secondary-button'));
      return;
    } else {
      say(decided === decidable.length ? `You’ve decided all ${findings(decided)}.` : `You’ve decided ${decided} of ${findings(decidable.length)}.`);
    }
    if (review.preview) end.append(viewPreviewButton('secondary-button'));
  }

  function viewPreviewButton(className) {
    const button = el('button', className, 'View the draft preview');
    button.type = 'button';
    button.addEventListener('click', () => api.openPreview());
    return button;
  }

  // The AI's preview of the next draft is showing: it's the user's to accept or discard. The
  // sentence is the one thing most worth knowing before answering.
  function renderPreviewBar(say, end) {
    const { number, setsAside, comparesWith } = state.preview;
    const comments = items.filter((i) => !i.done).length;
    const yourComments = comments === 1 ? 'your comment' : `your ${comments} comments`;
    const undecided = (state.review?.items ?? []).filter((i) => i.decision.status === 'pending').length;
    if (comments) {
      say(nextStep('preview', {
        sent: 'Your AI is changing its draft preview from your comments.',
        waiting: `Your AI is waiting for ${yourComments} on its draft preview.`,
        send: `Send ${yourComments} on the draft preview to your AI.`,
      }));
    } else if (undecided) say(`You haven’t decided on ${undecided === 1 ? '1 finding' : `${undecided} findings`} in this review.`);
    else if (state.review?.preview?.outdated) say('You’ve changed your decisions since your AI wrote this preview.');
    else if (setsAside) say(`Accepting this preview sets aside the ${setsAside === 1 ? 'draft' : `${setsAside} drafts`} after this one.`);
    else say(`This is your AI’s draft preview of Draft ${number}.`);
    if (comments) appendPrompt(end, `I’ve commented on the draft preview of ${documentName()}. Update it to do what my comments ask.`, 'Update the preview from my comments');
    for (const [label, className, action] of [
      [state.comparing ? 'Hide the comparison' : `Compare with ${comparesWith}`, 'secondary-button', onCompare],
      ['Back to the review', 'secondary-button', api.closePreview],
      ['Discard', 'secondary-button', api.discardPreview],
      [`Accept as Draft ${number}`, comments ? 'secondary-button' : 'primary-button', api.acceptPreview],
    ]) {
      const button = el('button', className, label);
      button.type = 'button';
      button.addEventListener('click', () => action());
      end.append(button);
    }
  }

  const aiIsWaiting = (what) => state.aiWaiting.some((w) => w.what === what && w.reviewId === state.review?.id);
  const sentToAi = (what) => (what === 'preview' ? state.review?.previewCommentsSentAt : state.review?.decisionsSentAt);
  // The bar's sentence for the next step, by whether the AI has been told, is waiting to be, or
  // needs the prompt.
  function nextStep(what, { sent, waiting, send }) {
    if (sentToAi(what)) return sent;
    return aiIsWaiting(what) ? waiting : send;
  }

  // What to ask the AI next goes to the chat, which offers it (and, to an AI waiting with
  // `smartdoc wait` elsewhere, a way to tell it to go ahead): the bar only says what's happening.
  function appendPrompt(_parent, prompt, label) {
    const what = prompt ? 'preview' : 'decisions';
    suggestion = { what, label: label ?? 'Write the next draft', prompt: prompt ?? defaultPrompt(), waiting: aiIsWaiting(what), sent: Boolean(sentToAi(what)) };
  }

  const documentName = () => (state.document ? `“${state.document.name}” (document ${state.document.id})` : 'my document');
  const defaultPrompt = () => `I’ve made my decisions in SmartDoc. Apply the review and write the next draft of ${documentName()}.`;

  // Hovering only restyles the decks and the page, so the deck under the pointer stays put.
  function setHover(key) {
    if (hover === key) return;
    hover = key;
    for (const slot of layer.querySelectorAll('.margin-slot')) slot.classList.toggle('hovered', slot.dataset.key === key);
    sendMarks();
  }

  function sendMarks() {
    // The item open in the chat's tray stands out on the page; otherwise the deck hovered.
    const reviewed = focused ? shown.find((i) => i.id === focused) : null;
    const hovered = reviewed ? null : decks.find((d) => d.key === hover)?.cur;
    const focus = reviewed ? [reviewed.id] : hovered ? [hovered.id] : [];
    const lit = reviewed ?? hovered;
    onMarks({
      // A comment needing no further action keeps its card but not its colour on the page.
      items: shown.filter((i) => i.anchors.length && !i.done && i.type !== 'earlier').map((i) => ({ id: i.id, anchors: i.anchors, tint: i.tint ?? tint(i.color, 0.14), strong: i.strong ?? tint(i.color, 0.3) })),
      focus,
      veil: Boolean(lit) && lit.type !== 'earlier' && lit.anchors.length > 0, // an earlier comment has no mark to bring forward
    });
  }

  render();
  return {
    update(next) {
      state = { ...state, ...next };
      render();
    },
    // Redraws in place, e.g. once a page is drawn or the window is resized.
    layout: render,
    // Where a card in the right margin goes, in the layer's coordinates.
    cardPlace() {
      const geo = geometry();
      return geo && { left: geo.right + PAGE_SPACE, width: cardWidth(geo) };
    },
    // Opens an item beside the pages (from the highlights list, say).
    openItem(id) {
      if (shown.some((i) => i.id === id)) openCard(id);
    },
    // Everything in the review, in the order to work through it, for the chat's list.
    items: () => order,
    // When the review was finished, so the chat's list sits at that point in the conversation.
    finishedAt: () => state.review?.committedAt ?? null,
    // What the chat's own window needs to show the same review: the state, with the earlier
    // comments found in the pages (it has none to look in).
    snapshot: () => ({ ...state, filter: null, earlierResolved: shown.filter((i) => i.type === 'earlier').map((i) => ({ ...i.earlier, anchors: i.anchors })) }),
    // Whether an item's decision is being changed (its buttons back after Change), which redraws it.
    editing: (id) => editing.has(id),
    // An item's card in full, for the chat's tray: what it is, and its decision.
    cardFor(id) {
      const item = order.find((i) => i.id === id);
      return item ? fullCard(item) : null;
    },
    // The item open in the chat's tray stands out on the page, its text brought into view; null for none.
    focus(id) {
      if (focused === id) return;
      focused = id;
      for (const slot of layer.querySelectorAll('.margin-slot')) slot.classList.toggle('focused', decks.find((d) => d.key === slot.dataset.key)?.cur.id === id);
      sendMarks();
      const item = id && shown.find((i) => i.id === id);
      if (item?.anchors.length) onReveal(item.anchors);
    },
    // On opening a document or draft: every deck back on its first card.
    reset() {
      focused = null;
      hover = null;
      editing.clear();
      picked.clear();
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
