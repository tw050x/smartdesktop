// The home screen, shown with no document open: three columns to browse the documents in the
// list. Choosing a document lists its variations ("Original", its own drafts, then one per
// purpose, such as a job a CV is tailored to); choosing a variation lists its drafts, newest
// first, each with a line for each review it has (one per tool: where it stands), which opens
// the draft in that tool. Clicking a draft opens it in the tool it was last used in. Right-clicking a draft gives a menu to start a new variation
// from it (the variation card, with a prompt for the AI) or make it a document of its own.
// Right-clicking a document gives a menu to cut it or delete it for good.
//
// The documents column shows one folder at a time, folders first: opening one replaces the list,
// and a row under the column's title shows the path back, so folders can nest to any depth. Things move by
// dragging onto a folder, the path or the list, where hovering over a folder or the back arrow
// opens it on the way; or by Cut and Paste. Folders only organise the list (see main/folders.js).

import { fillFocusCard } from './focus-picker.js';
import { TOOLS } from './tool-switcher.js';
import { takeOverNote } from './take-over-note.js';

const icon = (paths, size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const arrowIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.18,13H4V11H16.18l-5.6-5.6L12,4l8,8l-8,8l-1.42-1.4l5.6-5.6Z"/></svg>';
// Drafts open rather than lead to another column, so theirs is an open icon.
const openIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5,21q-0.83,0-1.41-0.59T3,19V5Q3,4.17 3.59,3.59T5,3h7V5H5V19H19V12h2v7q0,0.82-0.59,1.41T19,21H5Zm4.7-5.3L8.3,14.3L17.6,5H14V3h7v7H19V6.4L9.7,15.7Z"/></svg>';
const folderIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const newFolderIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>';
const backIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
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
const HOVER_OPENS_MS = 500; // holding a dragged item over a folder or the back arrow
const PATH_SHOWN = 3; // folders named on the path row; any before them as …
const ITEM_TYPE = 'application/x-smartdoc-item';
const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function createHome({ documentsEl, variationsEl, draftsEl, api }) {
  // The card for starting a review on a draft, as the top bar's focus menu has it, under the
  // draft's line: its earlier drafts' focuses to run again, or a new one. Copying a prompt makes
  // that draft its document's current place (prepare-draft), where the agent then finds it.
  const startCard = Object.assign(document.createElement('div'), { className: 'tool-card focus-card home-start-card', hidden: true });
  startCard.setAttribute('role', 'dialog');
  startCard.setAttribute('aria-label', 'Start a review');
  document.body.append(startCard);
  let startFrom = null; // the line that opened it
  async function openStartCard(line, doc, variationId, draftId, tool) {
    startFrom = line;
    const r = line.getBoundingClientRect();
    startCard.style.left = `${Math.min(r.left, innerWidth - 376)}px`;
    startCard.style.top = `${r.bottom + 6}px`;
    startCard.hidden = false;
    startCard.replaceChildren(Object.assign(document.createElement('p'), { className: 'focus-loading', textContent: 'Loading…' }));
    let focuses;
    try {
      focuses = await api.focusesFor(doc.id, variationId, draftId, tool);
    } catch {
      focuses = { current: [], earlier: [] };
    }
    if (startFrom !== line) return;
    fillFocusCard(startCard, { tool, doc, focuses, copyText: api.copyText, onCopy: () => api.prepareDraft(doc.id, variationId, draftId, tool) });
    const note = takeOverNote(api);
    if (note) startCard.append(note);
    // Above the line instead if it would run off the bottom of the window.
    const h = startCard.offsetHeight;
    if (r.bottom + 6 + h > innerHeight - 8) startCard.style.top = `${Math.max(8, r.top - 6 - h)}px`;
    startCard.querySelector('.focus-goal-input')?.focus();
  }
  function closeStartCard() {
    startCard.hidden = true;
    startFrom = null;
  }
  document.addEventListener('pointerdown', (e) => {
    if (!startCard.hidden && !startCard.contains(e.target) && !startFrom?.contains(e.target)) closeStartCard();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !startCard.hidden) closeStartCard();
  });

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

  // --- Folders -------------------------------------------------------------------------------
  const foldersOn = Boolean(api.showHomeMenu);
  const columnHead = documentsEl.previousElementSibling;
  const title = columnHead.querySelector('h2');
  let folderState = { folders: [], placement: {} };
  let shownFolder = null; // the folder showing, or null for the top level
  let naming = null; // a name being typed: { folderId } to rename, or { parentId } for a new folder
  let cut = null; // { kind: 'document' | 'folder', id }, waiting to be pasted
  let drag = null; // { kind, id, from, itemEl, dropped }
  let hover = null; // { key, timer }: a dragged item held over something that opens

  const folderOf = (docId) => folderState.placement[docId] ?? null;
  const folderById = (id) => folderState.folders.find((f) => f.id === id);
  const foldersIn = (parentId) => folderState.folders.filter((f) => (f.parentId ?? null) === parentId).sort((a, b) => a.name.localeCompare(b.name));
  const documentsIn = (folderId) => documents.filter((d) => folderOf(d.id) === folderId);
  function pathTo(folderId) {
    const path = [];
    const seen = new Set();
    for (let f = folderById(folderId); f && !seen.has(f.id); f = folderById(f.parentId)) {
      seen.add(f.id);
      path.unshift(f);
    }
    return path;
  }
  // Whether an item can go to a place: not where it is already, nor a folder inside itself.
  function canGo({ kind, id }, place) {
    if (kind === 'document') return folderOf(id) !== place;
    if ((folderById(id)?.parentId ?? null) === place) return false;
    return !pathTo(place).some((f) => f.id === id);
  }
  const moveItem = ({ kind, id }, place) => (kind === 'document' ? api.moveDocument(id, place) : api.moveFolder(id, place));

  function showFolder(id, { keepSelection = false } = {}) {
    shownFolder = id;
    naming = null;
    api.setHomeFolder?.(id);
    if (!keepSelection) followList();
    renderDocuments();
  }

  const backButton = el('button', 'icon-button home-back');
  backButton.type = 'button';
  backButton.innerHTML = backIcon;
  backButton.setAttribute('aria-label', 'Back');
  backButton.title = 'Back';
  backButton.addEventListener('click', () => showFolder(folderById(shownFolder)?.parentId ?? null));
  const pathRow = el('nav', 'home-path');
  pathRow.setAttribute('aria-label', 'Folder path');
  pathRow.hidden = true;
  const newFolderButton = el('button', 'icon-button home-new-folder');
  newFolderButton.type = 'button';
  newFolderButton.innerHTML = newFolderIcon;
  newFolderButton.setAttribute('aria-label', 'New folder');
  newFolderButton.title = 'New folder';
  newFolderButton.addEventListener('click', () => startNaming({ parentId: shownFolder }));
  if (foldersOn) {
    columnHead.after(pathRow);
    title.after(newFolderButton);
    dropTarget(backButton, () => folderById(shownFolder)?.parentId ?? null, { opens: true, key: 'back' });
    dropTarget(documentsEl, () => shownFolder);
    documentsEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.home-item')) return;
      e.preventDefault();
      openMenu([{ id: 'new', label: 'New Folder' }, pasteItem()], { new: () => startNaming({ parentId: shownFolder }), paste });
    });
    api.onFolders((next) => {
      folderState = next;
      afterFoldersChange();
    });
    api.folders().then((next) => {
      folderState = next;
      afterFoldersChange();
    });
    // The Edit menu's Cut and Paste, and their keys, outside anything being typed in.
    const typing = (e) => e.target.closest?.('input, textarea, [contenteditable]') || !documentsEl.offsetParent;
    document.addEventListener('cut', (e) => {
      if (typing(e) || window.getSelection()?.toString()) return;
      const folderId = document.activeElement?.closest?.('[data-folder]')?.dataset.folder;
      if (folderId) cutItem({ kind: 'folder', id: folderId });
      else if (selected.doc && folderOf(selected.doc) === shownFolder) cutItem({ kind: 'document', id: selected.doc });
    });
    document.addEventListener('paste', (e) => {
      if (!typing(e) && cut) paste();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cut && documentsEl.offsetParent) cutItem(null);
    });
  }

  function afterFoldersChange() {
    if (shownFolder && !folderById(shownFolder)) shownFolder = null;
    if (cut && !itemExists(cut)) cut = null;
    followList();
    renderDocuments();
  }
  // The other columns show a document in the list: the first, if the selected one isn't, unless a
  // drag is on its way through.
  function followList() {
    if (drag || (selected.doc && folderOf(selected.doc) === shownFolder)) return;
    const first = sorted('documents', documentsIn(shownFolder))[0]?.id ?? null;
    if (first === selected.doc) return;
    selected = { doc: first, variation: null };
    load();
  }
  const itemExists = ({ kind, id }) => (kind === 'folder' ? folderById(id) : documents.some((d) => d.id === id));

  function cutItem(item) {
    cut = item;
    renderDocuments();
  }
  const pasteItem = () => ({ id: 'paste', label: 'Paste', enabled: Boolean(cut && canGo(cut, shownFolder)) });
  async function paste() {
    if (!cut || !canGo(cut, shownFolder)) return;
    const item = cut;
    cut = null;
    await moveItem(item, shownFolder);
  }
  async function openMenu(items, actions) {
    const chosen = await api.showHomeMenu(items);
    actions[chosen]?.();
  }

  function startNaming(target) {
    naming = target;
    renderDocuments();
  }
  // A row to type a name in. Enter or leaving it keeps the name; Esc, nothing typed or no change
  // leaves things as they were.
  function nameRow(value, placeholder, save, done) {
    const item = el('li', 'home-item home-naming');
    const input = el('input', 'home-folder-name');
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    let finished = false;
    const finish = async (keep) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      done();
      if (keep && name && name !== value) await save(name);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    item.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return item;
  }
  function namingRow() {
    const target = naming;
    const done = () => {
      naming = null;
      renderDocuments();
    };
    if (target.docId) return nameRow(documents.find((d) => d.id === target.docId)?.name ?? '', 'Document name', (name) => api.renameDocument(target.docId, name), done);
    const save = target.folderId ? (name) => api.renameFolder(target.folderId, name) : (name) => api.createFolder(name, target.parentId);
    return nameRow(target.folderId ? folderById(target.folderId)?.name ?? '' : '', 'Folder name', save, done);
  }

  // Something a dragged item can be dropped on. `place()` is where that puts it; with `opens`, held
  // over it for a moment it opens there instead, and the drag carries on.
  function dropTarget(node, place, { opens = false, key = null } = {}) {
    const leave = () => {
      node.classList.remove('home-drop');
      if (opens && hover?.key === (key ?? place())) stopHover();
    };
    node.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.stopPropagation();
      const to = place();
      // A folder doesn't open as itself is dragged over it.
      if (opens && !hover && to !== drag.id) {
        hover = { key: key ?? to, timer: setTimeout(() => {
          hover = null;
          showFolder(to, { keepSelection: true });
        }, HOVER_OPENS_MS) };
      }
      if (!canGo(drag, to)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('home-drop');
    });
    // Moving between a target's own parts fires dragleave too; only leaving its bounds counts.
    node.addEventListener('dragleave', (e) => {
      const box = node.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX >= box.right || e.clientY < box.top || e.clientY >= box.bottom) leave();
    });
    node.addEventListener('drop', async (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      leave();
      stopHover();
      const to = place();
      if (!canGo(drag, to)) return;
      drag.dropped = true;
      await moveItem(drag, to);
    });
  }
  function stopHover() {
    clearTimeout(hover?.timer);
    hover = null;
  }
  function makeDraggable(item, kind, id) {
    if (!foldersOn) return;
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(ITEM_TYPE, id);
      e.dataTransfer.effectAllowed = 'move';
      drag = { kind, id, from: shownFolder, itemEl: item, dropped: false };
      item.classList.add('home-dragging');
    });
    item.addEventListener('dragend', () => {
      const { from, dropped } = drag ?? {};
      drag = null;
      stopHover();
      item.remove();
      // Called off: back where it started, with nothing moved.
      if (!dropped && from !== shownFolder) showFolder(from);
      else {
        followList();
        renderDocuments();
      }
    });
  }

  // The column's title is the way back to the top level, and a row under it the way to any folder
  // on the path, with the back arrow first.
  function renderHead() {
    const path = pathTo(shownFolder);
    const crumb = (name, id) => {
      const button = el('button', 'home-crumb', name);
      button.type = 'button';
      button.title = name;
      button.addEventListener('click', () => showFolder(id));
      dropTarget(button, () => id);
      return button;
    };
    title.replaceChildren(path.length ? crumb('Documents', null) : 'Documents');
    pathRow.hidden = !path.length;
    pathRow.replaceChildren(backButton);
    const hidden = path.length - PATH_SHOWN;
    if (hidden > 0) pathRow.append(el('span', 'home-crumb-more', '…'), el('span', 'home-crumb-gap', '/'));
    path.slice(Math.max(hidden, 0)).forEach((f, i, shown) => {
      if (i) pathRow.append(el('span', 'home-crumb-gap', '/'));
      if (f.id !== shownFolder) return pathRow.append(crumb(f.name, f.id));
      const here = el('span', 'home-crumb-here', f.name);
      here.title = f.name;
      pathRow.append(here);
    });
  }

  function folderRow(f) {
    if (naming?.folderId === f.id) return namingRow();
    const item = el('li', 'home-item home-folder');
    if (cut?.kind === 'folder' && cut.id === f.id) item.classList.add('home-cut');
    const row = rowButton(false, () => showFolder(f.id));
    row.dataset.folder = f.id;
    const name = el('span', 'home-title home-folder-title');
    name.innerHTML = folderIcon;
    name.append(el('span', null, f.name));
    const count = foldersIn(f.id).length + documentsIn(f.id).length;
    row.append(name, el('span', 'home-meta', count ? `${count} item${count === 1 ? '' : 's'}` : 'Empty'));
    row.title = f.name;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu([
        { id: 'open', label: 'Open' },
        { id: 'rename', label: 'Rename' },
        { id: 'cut', label: 'Cut' },
        { separator: true },
        { id: 'delete', label: 'Delete Folder' },
      ], {
        open: () => showFolder(f.id),
        rename: () => startNaming({ folderId: f.id }),
        cut: () => cutItem({ kind: 'folder', id: f.id }),
        delete: () => api.deleteFolder(f.id),
      });
    });
    makeDraggable(item, 'folder', f.id);
    dropTarget(item, () => f.id, { opens: true });
    item.append(row);
    return item;
  }

  function renderDocuments() {
    // A dragged row stays in the page while the list changes under it, or the drag would end.
    if (drag?.itemEl) dragHolder().append(drag.itemEl);
    documentsEl.replaceChildren();
    renderHead();
    if (naming?.parentId !== undefined) documentsEl.append(namingRow());
    const subfolders = foldersOn ? foldersIn(shownFolder) : [];
    for (const f of subfolders) documentsEl.append(folderRow(f));
    const shown = sorted('documents', foldersOn ? documentsIn(shownFolder) : documents);
    // With no document here, nothing can be chosen for the other columns to show. They keep their
    // room, so the list doesn't shift under a drag.
    for (const list of [variationsEl, draftsEl]) list.parentElement.classList.toggle('home-column-unused', foldersOn && !shown.length);
    if (!shown.length && !subfolders.length && naming?.parentId === undefined) {
      documentsEl.append(el('li', 'home-empty', shownFolder ? 'This folder is empty. Drag documents here, or right-click to paste.' : 'No documents yet. Drop a PDF here, or use File › Open.'));
      return;
    }
    for (const d of shown) {
      if (naming?.docId === d.id) {
        documentsEl.append(namingRow());
        continue;
      }
      const item = el('li', 'home-item');
      if (cut?.kind === 'document' && cut.id === d.id) item.classList.add('home-cut');
      const row = rowButton(d.id === selected.doc, () => choose(d.id));
      row.append(el('span', 'home-title', d.name), el('span', 'home-meta', `Added ${formatDate(d.importedAt)}`));
      row.title = d.name;
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!foldersOn) return;
        openMenu([
          { id: 'rename', label: 'Rename' },
          { id: 'cut', label: 'Cut' },
          { separator: true },
          { id: 'delete', label: 'Delete Document…' },
        ], {
          rename: () => startNaming({ docId: d.id }),
          cut: () => cutItem({ kind: 'document', id: d.id }),
          delete: () => api.deleteDocument(d.id),
        });
      });
      makeDraggable(item, 'document', d.id);
      item.append(row);
      documentsEl.append(item);
    }
  }
  let holder = null;
  function dragHolder() {
    holder ??= Object.assign(document.body.appendChild(document.createElement('ul')), { className: 'home-drag-holder' });
    return holder;
  }

  let namingVariation = null; // the variation whose name is being typed
  api.onRenameVariation?.(({ docId, variationId }) => {
    if (tree?.id !== docId) return;
    namingVariation = variationId;
    renderVariations();
  });

  function renderVariations() {
    variationsEl.replaceChildren();
    for (const v of sorted('variations', tree?.variations ?? [])) {
      if (namingVariation === v.id) {
        const docId = tree.id;
        variationsEl.append(nameRow(v.name, 'Variation name', (name) => api.renameVariation(docId, v.id, name), () => {
          namingVariation = null;
          renderVariations();
        }));
        continue;
      }
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
      // A line per tool: where its review stands, or, with none yet, a way to start one (a card
      // saying what it's for, see openStartCard).
      const list = el('div', 'home-reviews');
      for (const t of TOOLS) {
        const r = d.reviews?.[t.id];
        const line = el('button', r ? 'home-review' : 'home-review start');
        line.type = 'button';
        line.style.setProperty('--review-color', t.color);
        line.innerHTML = t.icon;
        line.append(el('span', 'home-review-text', r ? reviewStatus(t.id, r) : START[t.id]));
        line.title = r ? `Open ${d.label} in ${t.label}` : `Start ${t.label} on ${d.label}`;
        line.addEventListener('click', () => {
          if (r) return api.openDraft(tree.id, variation.id, d.id, t.id);
          if (startFrom === line) return closeStartCard();
          openStartCard(line, { id: tree.id, name: tree.name }, variation.id, d.id, t.id);
        });
        list.append(line);
      }
      item.append(list);
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
      if (cut && !itemExists(cut)) cut = null;
      // The first in the folder showing, if the selected document has gone.
      if (!documents.some((d) => d.id === selected.doc)) selected = { doc: sorted('documents', foldersOn ? documentsIn(shownFolder) : documents)[0]?.id ?? null, variation: null };
      renderDocuments();
      load();
    },
    // Shows a document in its folder, selected.
    select(docId) {
      if (foldersOn && folderOf(docId) !== shownFolder) {
        shownFolder = folderOf(docId);
        api.setHomeFolder?.(shownFolder);
      }
      return choose(docId);
    },
  };
}

// A tool's line on a draft with no review of its kind yet.
const START = { improve: 'Start a review', highlights: 'Find the key information' };

// Where a draft's review stands, in a few words.
function reviewStatus(tool, r) {
  if (tool === 'improve') {
    if (r.waitingForAi) return `${r.title} · ${r.comments} comment${r.comments === 1 ? '' : 's'}`;
    if (r.status !== 'committed') return `${r.title} · AI reviewing`;
    if (r.preview) return `${r.title} · draft preview to accept`;
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
