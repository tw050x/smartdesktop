import { markSides } from './diff-marks.js';
import { markScrolling } from './scroll-marks.js';
import { PAGE_WIDTH } from './page-view.js';

// Writing the AI proposes to change, beside the draft it changes, across the whole window, as
// SmartDoc compares a preview with its draft (its compare.js): two pages side by side, scrolling
// together, removed words marked on the left and added ones on the right, with the changes to step
// through. Closed by Close or Escape.

const GAP = 16;
export const CROSS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PADDING = 24;

// `render(element, which)` draws 'before' or 'after' into a page. `actions`, elements for the head
// beside Close (the change's Approve, the user's choice: it had none here).
export function openCompare({ title, beforeLabel, afterLabel, render, actions = [] }) {
  const overlay = document.createElement('div');
  overlay.className = 'compare-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${title}: changes`);

  const label = (words, kind) => Object.assign(document.createElement('span'), { className: `compare-title ${kind}`, textContent: words });
  const button = (words, name, run, className = 'secondary-button') => {
    const element = Object.assign(document.createElement('button'), { type: 'button', className, textContent: words, onclick: run });
    element.setAttribute('aria-label', name);
    return element;
  };
  const status = Object.assign(document.createElement('span'), { className: 'compare-status' });
  let at = -1;
  let marks = [];
  const pages = Object.assign(document.createElement('div'), { className: 'compare-pages' });
  const step = (delta) => {
    if (!marks.length) return;
    at = at === -1 ? (delta > 0 ? 0 : marks.length - 1) : (at + delta + marks.length) % marks.length;
    pages.classList.add('stepping'); // the other changes fade, so this one is easy to pick out
    for (const mark of pages.querySelectorAll('.current')) mark.classList.remove('current');
    for (const mark of marks[at]) mark.classList.add('current');
    const target = (marks[at].find((mark) => mark.classList.contains('diff-added')) ?? marks[at][0]).getBoundingClientRect();
    pages.scrollTo({ top: pages.scrollTop + target.top - pages.getBoundingClientRect().top - pages.clientHeight / 2, behavior: 'smooth' });
    status.textContent = `Change ${at + 1} of ${marks.length}`;
  };
  const previous = button('‹', 'Previous change', () => step(-1), 'secondary-button compare-step');
  const next = button('›', 'Next change', () => step(1), 'secondary-button compare-step');
  const nav = Object.assign(document.createElement('div'), { className: 'compare-nav' });
  nav.append(previous, status, next);
  const close = () => {
    removeEventListener('keydown', keys, true);
    sizes.disconnect();
    overlay.remove();
  };
  const keys = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  const head = Object.assign(document.createElement('div'), { className: 'compare-head' });
  const shut = button('', 'Close the comparison', close, 'icon-button compare-close');
  shut.title = 'Close';
  shut.innerHTML = CROSS;
  const extra = Object.assign(document.createElement('div'), { className: 'compare-actions' });
  extra.append(...actions);
  head.append(label(beforeLabel, 'removed'), nav, label(afterLabel, 'added'), extra, shut);

  // Each side a page, as writing is everywhere (see page-view.js), as large as half the window allows.
  const page = (which) => {
    const sheet = Object.assign(document.createElement('div'), { className: 'document-sheet compare-page' });
    const writing = document.createElement('div');
    render(writing, which);
    sheet.append(writing);
    return sheet;
  };
  const before = page('before');
  const after = page('after');
  pages.append(before, after);
  overlay.append(head, pages);
  document.body.append(overlay);

  const fit = () => {
    const zoom = Math.min(1, Math.max(0.3, (pages.clientWidth - GAP - 2 * PADDING) / 2 / PAGE_WIDTH));
    pages.style.setProperty('--page-zoom', String(zoom));
  };
  const sizes = new ResizeObserver(fit);
  sizes.observe(pages);
  fit();

  marks = markSides(before.firstChild, after.firstChild);
  // Where the changes are, along the scrollbar: removed on its left half, added on its right.
  markScrolling(pages, { sides: true });
  status.textContent = marks.length === 0 ? 'No changes to the words' : marks.length === 1 ? '1 change' : `${marks.length} changes`;
  previous.disabled = next.disabled = marks.length === 0;
  addEventListener('keydown', keys, true);
  next.focus();
  return close;
}
