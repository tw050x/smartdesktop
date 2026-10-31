// The home screen, shown with no document open: three columns to browse the documents in the
// list. Choosing a document lists its variations ("Original", its own drafts, then one per
// purpose, such as a job a CV is tailored to); choosing a variation lists its drafts, newest
// first, each with a line for each review it has (one per tool: where it stands), which opens
// the draft in that tool. Clicking a draft opens it in the tool it was last used in. Right-clicking a draft gives a menu to start a new variation
// from it (the variation card, with a prompt for the AI) or make it a document of its own.
// Right-clicking a document gives a menu to remove it from the list (its files stay in the app's
// data folder).

import { TOOLS } from './tool-switcher.js';

const icon = (paths, size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const arrowIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.18,13H4V11H16.18l-5.6-5.6L12,4l8,8l-8,8l-1.42-1.4l5.6-5.6Z"/></svg>';
// Drafts open rather than lead to another column, so theirs is an open icon.
const openIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5,21q-0.83,0-1.41-0.59T3,19V5Q3,4.17 3.59,3.59T5,3h7V5H5V19H19V12h2v7q0,0.82-0.59,1.41T19,21H5Zm4.7-5.3L8.3,14.3L17.6,5H14V3h7v7H19V6.4L9.7,15.7Z"/></svg>';
const sortIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3,18V16H9v2H3Zm0-5V11H15v2H3ZM3,8V6H21V8H3Z"/></svg>';
// Each column's sort orders, the first the default. The list comes in its default order; each
// option reorders a copy. The choice is remembered in this window's storage.
const SORTS = {
  documents: [
    ['recent', 'Recently opened', (list) => list],
    ['added', 'Date added', (list) => [...list].sort((a, b) => b.importedAt.localeCompare(a.importedAt))],
    ['name', 'Name', (list) => [...list].sort((a, b) => a.name.localeCompare(b.name))],
  ],
  variations: [
    ['created', 'Date created', (list) => list],
    ['updated', 'Recently updated', (list) => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))],
    ['name', 'Name', (list) => [...list].sort((a, b) => a.name.localeCompare(b.name))],
  ],
  drafts: [
    ['newest', 'Newest first', (list) => list],
    ['oldest', 'Oldest first', (list) => [...list].reverse()],
  ],
};
const remembered = (column) => {
  try {
    return localStorage.getItem(`home-sort-${column}`);
  } catch {
    return null;
  }
};
const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function createHome({ documentsEl, variationsEl, draftsEl, api }) {
  let documents = [];
  let selected = { doc: null, variation: null };
  let tree = null; // the selected document's variations and drafts
  let loading = 0;
  const sorts = {};
  // A select at the right of each column's title, after the sort icon.
  for (const [column, list] of [['documents', documentsEl], ['variations', variationsEl], ['drafts', draftsEl]]) {
    const options = SORTS[column];
    sorts[column] = options.find(([id]) => id === remembered(column)) ?? options[0];
    const label = el('label', 'home-sort');
    label.innerHTML = sortIcon;
    const select = el('select');
    select.setAttribute('aria-label', 'Sort by');
    for (const [id, text] of options) select.append(new Option(text, id, false, id === sorts[column][0]));
    select.addEventListener('change', () => {
      sorts[column] = options.find(([id]) => id === select.value);
      try {
        localStorage.setItem(`home-sort-${column}`, select.value);
      } catch {}
      ({ documents: renderDocuments, variations: renderVariations, drafts: renderDrafts })[column]();
    });
    label.append(select);
    list.previousElementSibling.append(label);
  }
  const sorted = (column, list) => sorts[column][2](list);

  function renderDocuments() {
    documentsEl.replaceChildren();
    if (!documents.length) {
      documentsEl.append(el('li', 'home-empty', 'No documents yet. Drop a PDF here, or use File › Open.'));
      return;
    }
    for (const d of sorted('documents', documents)) {
      const item = el('li', 'home-item');
      const row = rowButton(d.id === selected.doc, () => choose(d.id));
      row.append(el('span', 'home-title', d.name), el('span', 'home-meta', `Added ${formatDate(d.importedAt)}`));
      row.title = d.name;
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showDocumentMenu(d.id);
      });
      item.append(row);
      documentsEl.append(item);
    }
  }

  function renderVariations() {
    variationsEl.replaceChildren();
    for (const v of sorted('variations', tree?.variations ?? [])) {
      const item = el('li', 'home-item');
      const row = rowButton(v.id === selected.variation, () => {
        selected.variation = v.id;
        renderVariations();
        renderDrafts();
      });
      row.append(el('span', 'home-title', v.name));
      if (v.purpose && v.purpose !== v.name) row.append(el('span', 'home-purpose', v.purpose));
      const count = v.drafts.length - 1;
      row.append(el('span', 'home-meta', [count ? `${count} draft${count === 1 ? '' : 's'}` : 'No drafts yet', v.from && `from ${v.from}`].filter(Boolean).join(' · ')));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showVariationMenu({ docId: tree.id, variationId: v.id });
      });
      item.append(row);
      variationsEl.append(item);
    }
  }

  function renderDrafts() {
    draftsEl.replaceChildren();
    const variation = tree?.variations.find((v) => v.id === selected.variation);
    if (!variation) return;
    // Drafts come newest first; each keeps its number in the variation whatever the order.
    const numbered = variation.drafts.map((d, i) => ({ d, number: variation.drafts.length - 1 - i }));
    for (const { d, number } of sorted('drafts', numbered)) {
      const item = el('li', 'home-item home-draft');
      const row = rowButton(false, () => api.openDraft(tree.id, variation.id, d.id), openIcon);
      row.title = `Open ${d.label}`;
      row.append(el('span', 'home-title', d.label), el('span', 'home-meta', [formatDate(d.createdAt), d.shared && `from ${d.shared}`].filter(Boolean).join(' · ')));
      if (d.summary) row.append(el('span', 'home-summary', d.summary));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showDraftMenu({ docId: tree.id, variationId: variation.id, draftId: d.id, draft: number });
      });
      item.append(row);
      const reviews = TOOLS.filter((t) => d.reviews?.[t.id]);
      if (reviews.length) {
        const list = el('div', 'home-reviews');
        for (const t of reviews) {
          const line = el('button', 'home-review');
          line.type = 'button';
          line.style.setProperty('--review-color', t.color);
          line.innerHTML = t.icon;
          line.append(el('span', 'home-review-text', reviewStatus(t.id, d.reviews[t.id])));
          line.title = `Open ${d.label} in ${t.label}`;
          line.addEventListener('click', () => api.openDraft(tree.id, variation.id, d.id, t.id));
          list.append(line);
        }
        item.append(list);
      }
      draftsEl.append(item);
    }
  }

  async function choose(docId) {
    selected = { doc: docId, variation: null };
    renderDocuments();
    await load();
  }

  async function load() {
    const ticket = ++loading;
    const next = selected.doc ? await api.variationsOf(selected.doc).catch(() => null) : null;
    if (ticket !== loading) return;
    tree = next;
    if (!tree?.variations.some((v) => v.id === selected.variation)) selected.variation = tree?.variations[0]?.id ?? null;
    renderVariations();
    renderDrafts();
  }

  return {
    // The documents in the list, newest first; the selection stays if its document is still there.
    update(list) {
      documents = list;
      if (!documents.some((d) => d.id === selected.doc)) selected = { doc: documents[0]?.id ?? null, variation: null };
      renderDocuments();
      load();
    },
    select: choose,
  };
}

// Where a draft's review stands, in a few words.
function reviewStatus(tool, r) {
  if (tool === 'improve') {
    if (r.status !== 'committed') return `${r.title} · AI reviewing`;
    if (r.applied) return `${r.title} · next draft written`;
    return `${r.title} · ${r.decided} of ${r.findings} decided`;
  }
  const others = r.others ? ` · +${r.others} more` : '';
  if (r.status !== 'committed') return `${r.title} · AI highlighting${others}`;
  return `${r.title} · ${r.count} highlight${r.count === 1 ? '' : 's'}${others}`;
}

function rowButton(selected, onClick, icon = arrowIcon) {
  const row = el('button', 'home-row');
  row.type = 'button';
  row.setAttribute('aria-pressed', String(selected));
  row.addEventListener('click', onClick);
  const arrow = el('span', 'home-arrow');
  arrow.innerHTML = icon;
  row.append(arrow);
  return row;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
