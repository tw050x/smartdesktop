import { getDocument } from './pdf-engine.js';
import { anchorRects, pageContent, pageText, pageTexts, textOfItems } from './anchors.js';
import { historyVerdict, matchesInPages, matchesOnPage, snippetOf } from './text-search.js';

// Find, in the draft showing and the other drafts on its line. The draft showing has its matches
// marked on its pages, on a layer of their own, stepped through in turn. The other drafts are
// listed by what they hold, and choosing a match opens that draft on it. Their text is read from
// their PDFs the first time it's needed, and kept while the document is open: a draft never changes.
const SNIPPETS_PER_DRAFT = 3;
const TYPING_PAUSE_MS = 120;

export function createFindBar({ el, api, scroller, reveal, beforeOpen, onToggle }) {
  const input = el.querySelector('#find-input');
  const status = el.querySelector('#find-status');
  const history = el.querySelector('#find-history');
  const verdictEl = el.querySelector('#find-verdict');
  const draftsEl = el.querySelector('#find-drafts');

  let shown = null; // the draft showing: { docId, draftId }
  let query = '';
  let matches = [];
  let at = -1; // the match stepped to
  let landing = null; // the match to land on in a draft being opened: { page, start }
  let line = []; // the drafts on the line, oldest first: { id, label }
  let texts = new Map(); // draft id → a promise of its page texts (null if it couldn't be read)
  let textsOf = null; // the document `texts` belongs to
  let historyTicket = 0; // a newer search stops an older one
  let typing;

  const isOpen = () => !el.hidden;

  // --- The draft showing ---------------------------------------------------------------------

  function clearMarks() {
    for (const layer of document.querySelectorAll('.find-marks')) layer.remove();
  }

  function markMatch(match, index) {
    const content = pageContent(match.page);
    if (!content) return;
    let layer = content.querySelector('.find-marks');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'find-marks';
      content.append(layer);
    }
    for (const r of anchorRects(match)) {
      const mark = document.createElement('div');
      mark.className = 'find-mark';
      mark.dataset.match = String(index);
      Object.assign(mark.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
      layer.append(mark);
    }
  }

  function showStatus() {
    status.textContent = !query ? '' : matches.length ? `${at + 1} of ${matches.length}` : 'No matches';
    el.classList.toggle('no-matches', Boolean(query) && !matches.length);
    for (const button of el.querySelectorAll('.find-step')) button.disabled = !matches.length;
  }

  function stepTo(index) {
    document.querySelectorAll('.find-mark.current').forEach((m) => m.classList.remove('current'));
    at = index;
    if (at >= 0) {
      document.querySelectorAll(`.find-mark[data-match="${at}"]`).forEach((m) => m.classList.add('current'));
      reveal(matches[at]);
    }
    showStatus();
  }

  // The first match from the top of the view down, or the document's first if there's none below.
  function firstInView() {
    const top = scroller.getBoundingClientRect().top;
    const index = matches.findIndex((m) => {
      const box = pageContent(m.page)?.getBoundingClientRect();
      if (!box || box.bottom < top) return false;
      const [rect] = anchorRects(m);
      return rect && box.top + rect.y * (box.width / pageContent(m.page).offsetWidth || 1) >= top;
    });
    return Math.max(index, 0);
  }

  function searchPages() {
    clearMarks();
    matches = matchesInPages(pageTexts(), query);
    matches.forEach(markMatch);
    stepTo(matches.length ? firstInView() : -1);
  }

  function step(delta) {
    if (matches.length) stepTo((at + delta + matches.length) % matches.length);
  }

  // --- The other drafts ----------------------------------------------------------------------

  async function readDraft(draftId) {
    const task = getDocument({ data: await api.draftPdf(draftId) });
    try {
      const pdf = await task.promise;
      const read = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        read.push(textOfItems((await (await pdf.getPage(n)).getTextContent()).items));
      }
      return read;
    } finally {
      task.destroy();
    }
  }

  function textsOfDraft(draftId) {
    if (textsOf !== shown?.docId) {
      texts = new Map();
      textsOf = shown?.docId;
    }
    if (!texts.has(draftId)) texts.set(draftId, readDraft(draftId).catch(() => null));
    return texts.get(draftId);
  }

  function snippetButton(draft, match) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'find-snippet';
    const { before, match: text, after } = snippetOf(draft.texts[match.page - 1], match);
    const page = document.createElement('span');
    page.className = 'find-snippet-page';
    page.textContent = `p. ${match.page}`;
    const found = document.createElement('mark');
    found.textContent = text;
    const line = document.createElement('span');
    line.append(before, found, after);
    button.append(page, line);
    button.addEventListener('click', () => openAt(draft, match));
    return button;
  }

  // Each draft with matches, newest first, as the home screen lists them.
  function showDrafts(results) {
    const rows = results.filter((d) => d.id !== shown?.draftId && d.count > 0).reverse().map((draft) => {
      const row = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'find-draft-head';
      const name = document.createElement('span');
      name.className = 'find-draft-name';
      name.textContent = draft.label;
      const count = document.createElement('span');
      count.textContent = `${draft.count} match${draft.count === 1 ? '' : 'es'}`;
      head.append(name, count);
      row.append(head, ...draft.matches.slice(0, SNIPPETS_PER_DRAFT).map((m) => snippetButton(draft, m)));
      const more = draft.count - SNIPPETS_PER_DRAFT;
      if (more > 0) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'find-more';
        button.textContent = `${more} more in ${draft.label}`;
        button.addEventListener('click', () => openAt(draft, draft.matches[SNIPPETS_PER_DRAFT]));
        row.append(button);
      }
      return row;
    });
    draftsEl.replaceChildren(...rows);
  }

  async function searchDrafts() {
    const ticket = ++historyTicket;
    history.hidden = !query || line.length < 2;
    if (history.hidden) return;
    verdictEl.textContent = 'Searching the drafts…';
    draftsEl.replaceChildren();
    const results = [];
    let unread = 0;
    for (const { id, label } of line) {
      const read = await textsOfDraft(id);
      if (ticket !== historyTicket) return;
      if (!read) unread++;
      const found = read ? matchesInPages(read, query) : [];
      results.push({ id, label, texts: read, matches: found, count: found.length });
      showDrafts(results);
    }
    // With a draft missing, the history can't say where the text was or wasn't.
    verdictEl.textContent = unread ? `${unread} draft${unread === 1 ? '' : 's'} couldn’t be searched` : historyVerdict(results, shown?.draftId);
  }

  function openAt(draft, match) {
    landing = { page: match.page, start: match.start };
    api.goToDraft(draft.id);
  }

  function search() {
    clearTimeout(typing);
    query = input.value.trim();
    landing = null;
    searchPages();
    searchDrafts();
  }

  async function refreshLine() {
    line = (await api.draftLine?.()) ?? [];
  }

  // --- The bar -------------------------------------------------------------------------------

  async function open() {
    beforeOpen();
    const reopening = isOpen();
    el.hidden = false;
    onToggle();
    const selected = getSelection().toString().trim().replace(/\s+/g, ' ');
    if (selected && !el.contains(document.activeElement)) input.value = selected;
    input.focus();
    input.select();
    if (reopening && input.value.trim() === query) return;
    await refreshLine();
    if (isOpen()) search();
  }

  function close() {
    clearTimeout(typing);
    historyTicket++;
    el.hidden = true;
    onToggle();
    clearMarks();
    matches = [];
    at = -1;
    landing = null;
    query = '';
    history.hidden = true;
  }

  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(search, TYPING_PAUSE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.value.trim() !== query) search();
      else step(e.shiftKey ? -1 : 1);
    }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  el.querySelector('#find-prev').addEventListener('click', () => step(-1));
  el.querySelector('#find-next').addEventListener('click', () => step(1));
  el.querySelector('#find-close').addEventListener('click', close);

  return {
    isOpen,

    command(which) {
      if (which === 'open' || !isOpen()) return open();
      step(which === 'previous' ? -1 : 1);
    },

    // A draft has been opened: its pages are about to be drawn, each reported with pageDrawn.
    async draftOpened(next) {
      const stayed = shown?.docId === next.docId && shown?.draftId === next.draftId;
      shown = next;
      if (!isOpen()) return;
      clearMarks();
      matches = [];
      at = -1;
      showStatus();
      if (stayed) return;
      await refreshLine();
      if (isOpen()) searchDrafts();
    },

    pageDrawn(page) {
      if (!isOpen() || !query) return;
      const offset = matches.length;
      const found = matchesOnPage(pageText(page), page, query);
      matches.push(...found);
      found.forEach((m, i) => markMatch(m, offset + i));
      const landed = landing?.page === page ? found.findIndex((m) => m.start === landing.start) : -1;
      if (landing && page >= landing.page) landing = null;
      if (landed !== -1) {
        stepTo(offset + landed);
      } else if (at === -1 && found.length && !landing) {
        stepTo(0);
      } else {
        showStatus();
      }
    },

    close,
  };
}
