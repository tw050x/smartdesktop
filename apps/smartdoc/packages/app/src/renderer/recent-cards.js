import { getDocument } from 'pdfjs-dist';

// Cards for the recently opened documents in the empty view. Each card is a preview of the document’s current draft
// (first page), with previous/next buttons inside it at the bottom to cycle through its pages
// (wrapping round), and the document name underneath. Clicking the card or the name opens it.

const THUMB_WIDTH = 220; // CSS pixels the preview is drawn for (scaled to fit the card)
const SLOTS = 4; // the empty view shows this many cards; unused slots are skeletons
const chevron = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
const previousIcon = chevron('M14.7 6.3a1 1 0 0 1 0 1.4L10.4 12l4.3 4.3a1 1 0 0 1-1.4 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0Z');
const nextIcon = chevron('M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4l4.3-4.3-4.3-4.3a1 1 0 0 1 0-1.4Z');

let current = []; // loading tasks for the cards on screen, destroyed (closing their documents) when the list changes

export function renderRecentCards({ documents, list, none, readRecent, openRecent }) {
  for (const task of current) task.destroy();
  current = [];
  none.hidden = documents.length > 0;
  const skeletons = Array.from({ length: Math.max(0, SLOTS - documents.length) }, skeleton);
  list.replaceChildren(...documents.map((doc) => card(doc, { readRecent, openRecent })), ...skeletons);
}

function skeleton() {
  const item = document.createElement('li');
  item.className = 'recent-item recent-skeleton';
  item.setAttribute('aria-hidden', 'true');
  item.innerHTML = '<div class="recent-card"></div><div class="recent-name-placeholder"></div>';
  return item;
}

function card(doc, { readRecent, openRecent }) {
  const item = document.createElement('li');
  item.className = 'recent-item';
  item.innerHTML = `
    <div class="recent-card">
      <button class="recent-open recent-preview" type="button" tabindex="-1">
        <canvas></canvas><span class="recent-status">Loading…</span>
      </button>
      <div class="recent-pager" hidden>
        <button class="recent-step" type="button" data-step="-1" aria-label="Previous page">${previousIcon}</button>
        <span class="recent-page"></span>
        <button class="recent-step" type="button" data-step="1" aria-label="Next page">${nextIcon}</button>
      </div>
    </div>
    <button class="recent-open recent-name" type="button"></button>`;

  // The card (the preview) and the name below it both open the document; the name is the
  // keyboard stop.
  for (const open of item.querySelectorAll('.recent-open')) {
    open.title = doc.name;
    open.addEventListener('click', () => openRecent(doc.id));
  }
  item.querySelector('.recent-name').textContent = doc.name;

  loadPreview(item, doc, readRecent);
  return item;
}

async function loadPreview(item, doc, readRecent) {
  const thumb = item.querySelector('.recent-card');
  const canvas = thumb.querySelector('canvas');
  const status = thumb.querySelector('.recent-status');
  const pager = item.querySelector('.recent-pager');
  const pageLabel = item.querySelector('.recent-page');

  const data = await readRecent(doc.id).catch(() => null);
  if (!item.isConnected) return; // the list changed while the file was being read
  if (!data) {
    status.textContent = 'Can’t preview this document';
    item.classList.add('missing');
    return;
  }

  const task = getDocument({ data });
  if (!item.isConnected) {
    task.destroy();
    return;
  }
  current.push(task);
  let pdf;
  try {
    pdf = await task.promise;
  } catch {
    if (item.isConnected) status.textContent = 'Can’t preview this file';
    return;
  }

  let pageNumber = 1;
  let drawing = 0; // newest draw wins if the buttons are clicked quickly
  const draw = async () => {
    const ticket = ++drawing;
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (THUMB_WIDTH * (window.devicePixelRatio || 1)) / base.width });
    const off = document.createElement('canvas');
    off.width = Math.floor(viewport.width);
    off.height = Math.floor(viewport.height);
    await page.render({ canvas: off, viewport }).promise;
    if (ticket !== drawing) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    thumb.style.aspectRatio = `${base.width} / ${base.height}`;
    pageLabel.textContent = `${pageNumber} / ${pdf.numPages}`;
    status.hidden = true;
  };
  // A draw stops early if the list changes meanwhile (its document is closed); that's fine.
  await draw().catch(() => {});

  if (pdf.numPages > 1) {
    pager.hidden = false;
    for (const button of pager.querySelectorAll('.recent-step')) {
      button.addEventListener('click', () => {
        pageNumber = ((pageNumber - 1 + Number(button.dataset.step) + pdf.numPages) % pdf.numPages) + 1;
        draw().catch(() => {});
      });
    }
  }
}
