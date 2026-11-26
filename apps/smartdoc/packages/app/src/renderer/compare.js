import { getDocument } from './pdf-engine.js';
import { pageModel, rangeRects } from './anchors.js';
import { drawPage, fitPageTo } from './pdf-page.js';
import { diffPages } from './word-diff.js';

// The AI's preview beside the draft it was written from, as pages side by side scrolling together:
// removed text marked on the left, added text on the right. The marks exist only here, on this
// view's own copies of the pages, so nothing about the document view (or what the AI reads from
// it, see anchors.js) changes. `onTrack(marks)` gives where the changes are, for the scrollbar, as
// the review's cards do (see scrollbar.js): [{ at, color, bright }], a mark for each change on each
// side, red where text was removed and green where it was added, on that side's half of the strip.
export function createCompareView({ el, api, onTrack = () => {} }) {
  const PAGE_GAP = 16;
  const SIDE_PADDING = 24;
  let ticket = 0; // closing or reopening stops a drawing still under way
  let at = -1; // the change stepped to
  let marksByChange = [];

  const availableWidth = () => (el.clientWidth - PAGE_GAP - 2 * SIDE_PADDING) / 2;
  new ResizeObserver(() => {
    el.querySelectorAll('.page').forEach((pageEl) => fitPageTo(pageEl, availableWidth()));
    track();
  }).observe(el);

  // Each change's place along the scrollbar: where its first mark on each side is, as a fraction of
  // this view's scrolling height. All bright, until changes are stepped through: then the one
  // stepped to, as the others fade on the pages.
  const TRACK_COLORS = { removed: '#e23c3c', added: '#28af55' };
  function track() {
    if (!marksByChange.length) return onTrack([]);
    const top = el.getBoundingClientRect().top - el.scrollTop;
    const height = el.scrollHeight || 1;
    onTrack(marksByChange.flatMap((marks, i) => ['removed', 'added'].flatMap((kind) => {
      const first = marks.find((m) => m.classList.contains(kind));
      if (!first?.isConnected) return [];
      // The draft's (removed) on the left half of the mark, the preview's (added) on the right, as
      // the pages are, so a change that does both shows both.
      return [{ at: (first.getBoundingClientRect().top - top) / height, color: TRACK_COLORS[kind], bright: at === -1 || at === i, side: kind === 'removed' ? 'left' : 'right' }];
    })));
  }

  function title(label, kind) {
    const span = document.createElement('span');
    span.className = `compare-title ${kind}`;
    span.textContent = label;
    return span;
  }

  function button(label, symbol, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary-button compare-step';
    b.textContent = symbol;
    b.setAttribute('aria-label', label);
    b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }

  function step(delta, status) {
    const total = marksByChange.length;
    at = at === -1 ? (delta > 0 ? 0 : total - 1) : (at + delta + total) % total;
    el.classList.add('stepping'); // the other changes fade, so this one is easy to pick out
    el.querySelectorAll('.compare-mark.current').forEach((m) => m.classList.remove('current'));
    const marks = marksByChange[at];
    marks.forEach((m) => m.classList.add('current'));
    // Only this view scrolls: scrollIntoView would also scroll inside the page it's on, which clips
    // its content, and put the two sides out of line.
    const target = (marks.find((m) => m.classList.contains('added')) ?? marks[0]).getBoundingClientRect();
    const top = el.scrollTop + target.top - el.getBoundingClientRect().top - el.clientHeight / 2;
    el.scrollTo({ top, behavior: 'smooth' });
    status.textContent = `Change ${at + 1} of ${total}`;
    track();
  }

  function markChange(pages, ranges, kind, marks) {
    for (const { page, start, end } of ranges) {
      const model = pages[page - 1];
      for (const r of rangeRects(model, start, end)) {
        const mark = document.createElement('div');
        mark.className = `compare-mark ${kind}`;
        Object.assign(mark.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
        model.contentEl.append(mark);
        marks.push(mark);
      }
    }
  }

  return {
    async open() {
      const mine = ++ticket;
      at = -1;
      marksByChange = [];
      onTrack([]);
      el.classList.remove('stepping');
      el.scrollTop = 0;

      const status = document.createElement('span');
      status.className = 'compare-status';
      status.textContent = 'Comparing…';
      const prev = button('Previous change', '‹', () => step(-1, status));
      const next = button('Next change', '›', () => step(1, status));
      const nav = document.createElement('div');
      nav.className = 'compare-nav';
      nav.append(prev, status, next);
      const head = document.createElement('div');
      head.className = 'compare-head';
      const rows = document.createElement('div');
      rows.className = 'compare-pages';
      el.replaceChildren(head, rows);

      const tasks = [];
      const drawings = []; // pages are drawn in turn, after their text is laid out (see pdf-page.js)
      try {
        const { before, after } = await api.previewComparison();
        if (mine !== ticket) return;
        head.append(title(before.label, 'removed'), nav, title(after.label, 'added'));
        tasks.push(getDocument({ data: before.pdf }), getDocument({ data: after.pdf }));
        const [beforePdf, afterPdf] = await Promise.all(tasks.map((t) => t.promise));
        if (mine !== ticket) return;

        const beforePages = [];
        const afterPages = [];
        for (let n = 1; n <= Math.max(beforePdf.numPages, afterPdf.numPages); n++) {
          for (const [pdf, models] of [[beforePdf, beforePages], [afterPdf, afterPages]]) {
            if (n > pdf.numPages) {
              rows.append(document.createElement('div')); // keeps the page opposite in its column
              continue;
            }
            const drawn = await drawPage(await pdf.getPage(n), (pageEl) => {
              rows.append(pageEl);
              fitPageTo(pageEl, availableWidth());
            });
            drawings.push(drawn.drawn);
            if (mine !== ticket) return;
            models.push(pageModel(drawn.items, drawn.textDivs, drawn.contentEl));
          }
        }

        const changes = diffPages(beforePages.map((p) => p.text), afterPages.map((p) => p.text));
        marksByChange = changes.map(({ removed, added }) => {
          const marks = [];
          markChange(beforePages, removed, 'removed', marks);
          markChange(afterPages, added, 'added', marks);
          return marks;
        });
        status.textContent = changes.length === 0 ? 'No text changes' : changes.length === 1 ? '1 change' : `${changes.length} changes`;
        track();
        prev.disabled = next.disabled = changes.length === 0;
      } catch (error) {
        if (mine === ticket) status.textContent = 'Couldn’t compare';
        console.error(error);
      } finally {
        // What's drawn stays on the page; the PDFs themselves aren't needed once it is.
        Promise.all(drawings).finally(() => {
          for (const task of tasks) task.destroy();
        });
      }
    },
    close() {
      ticket++;
      el.classList.remove('stepping');
      el.replaceChildren();
      marksByChange = [];
      onTrack([]);
    },
  };
}
