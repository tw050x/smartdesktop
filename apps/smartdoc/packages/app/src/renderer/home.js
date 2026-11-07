// The home screen, shown with no document open: three columns to browse the documents in the
// list. Choosing a document lists its variations ("Original", its own drafts, then one per
// purpose, such as a job a CV is tailored to); choosing a variation lists its drafts, newest
// first, each with a line for each review it has (one per tool: where it stands), which opens
// the draft in that tool. Clicking a draft opens it in the tool it was last used in. Right-clicking a draft gives a menu to start a new variation
// from it (the variation card, with a prompt for the AI) or make it a document of its own.
// Right-clicking a document gives a menu to cut it or delete it for good.
//
// The documents column shows one folder at a time, its folders and documents sorted together (see
// home-level.js): opening one replaces the list, and a row under the column's title shows the path back, so folders can nest to any depth. Things move by
// dragging onto a folder, the path or the list, where hovering over a folder or the back arrow
// opens it on the way; or by Cut and Paste. Folders only organise the list (see main/folders.js).
//
// Documents, variations and drafts can have labels the user defines, at the bottom of their rows:
// right-click an item to add one, typing a name or choosing one of its scope, and right-click a label
// for its color. Labels show on everything below the item they're on (see main/labels.js).

import { fillFocusCard } from './focus-picker.js';
import { TOOLS } from './tool-switcher.js';
import { takeOverNote } from './take-over-note.js';
import { levelOf } from './home-level.js';
import { actionFor } from './home-review-state.js';
import { LABEL_COLORS, NO_LABELS, labelsOn, labelsToChoose } from '../main/labels.js';
import { arrowKeysIn } from './menu-keys.js';

const icon = (paths, size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const arrowIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.18,13H4V11H16.18l-5.6-5.6L12,4l8,8l-8,8l-1.42-1.4l5.6-5.6Z"/></svg>';
// Drafts open rather than lead to another column, so theirs is an open icon.
const openIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5,21q-0.83,0-1.41-0.59T3,19V5Q3,4.17 3.59,3.59T5,3h7V5H5V19H19V12h2v7q0,0.82-0.59,1.41T19,21H5Zm4.7-5.3L8.3,14.3L17.6,5H14V3h7v7H19V6.4L9.7,15.7Z"/></svg>';
const folderIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const newFolderIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>';
const newDocumentIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
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
  // A button at the right of each column's title: the sort's name, then its icon. It opens a menu
  // of the sorts, as the MCP panel's app picker does.
  for (const [column, list] of [['documents', documentsEl], ['variations', variationsEl], ['drafts', draftsEl]]) {
    const options = SORTS[column];
    sorts[column] = options.find(([id]) => id === remembered(column)) ?? options[0];
    const picker = el('div', 'home-sort-picker');
    const button = el('button', 'home-sort');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', `Sort by: ${sorts[column][1]}`);
    const text = el('span', 'home-sort-text', sorts[column][1]);
    button.append(text);
    button.insertAdjacentHTML('beforeend', sortIcon);
    const menu = el('div', 'app-picker-menu home-sort-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const items = options.map(([id, label]) => {
      const item = el('button', null, label);
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(id === sorts[column][0]));
      item.addEventListener('click', () => choose(id));
      return item;
    });
    menu.append(...items);
    const setOpen = (open) => {
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) items.find((i) => i.getAttribute('aria-checked') === 'true')?.focus();
    };
    const choose = (id) => {
      sorts[column] = options.find(([o]) => o === id);
      text.textContent = sorts[column][1];
      button.setAttribute('aria-label', `Sort by: ${sorts[column][1]}`);
      items.forEach((item, i) => item.setAttribute('aria-checked', String(options[i][0] === id)));
      setOpen(false);
      button.focus();
      try {
        localStorage.setItem(`home-sort-${column}`, id);
      } catch {}
      ({ documents: renderDocuments, variations: renderVariations, drafts: renderDrafts })[column]();
    };
    button.addEventListener('click', () => setOpen(menu.hidden));
    // Up or Down on the button opens the menu too.
    button.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu.hidden) {
        e.preventDefault();
        setOpen(true);
      }
    });
    // A press elsewhere, or the focus moving on, closes it; Escape closes it back onto the button.
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !picker.contains(e.target)) setOpen(false);
    });
    picker.addEventListener('focusout', (e) => {
      if (!menu.hidden && e.relatedTarget && !picker.contains(e.relatedTarget)) setOpen(false);
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      button.focus();
    });
    arrowKeysIn(menu);
    picker.append(button, menu);
    list.previousElementSibling.append(picker);
  }
  const sorted = (column, list) => sorts[column][2](list);

  // With a row focused, Up and Down move to the row above or below in its column, choosing it as a
  // click would if it's a document or a variation (not a folder, which a click opens, or a draft).
  // Left and Right move to the column either side, onto its chosen row or else its first. In a
  // folder, Up from the top row goes to the back button, and Down from there comes back. The
  // arrows do nothing here anywhere else.
  const columns = [documentsEl, variationsEl, draftsEl];
  const rowsIn = (list) => [...list.querySelectorAll('.home-row')];
  const focusRow = (row) => {
    row.focus({ focusVisible: true });
    row.scrollIntoView({ block: 'nearest' });
  };
  document.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (document.activeElement === backButton && e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const first = rowsIn(documentsEl)[0];
      if (first) {
        e.preventDefault();
        focusRow(first);
      }
      return;
    }
    const row = document.activeElement?.closest?.('.home-row');
    const column = row && columns.findIndex((list) => list.contains(row));
    if (!row || column < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const list = columns[column];
      const rows = rowsIn(list);
      const at = rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1);
      const next = rows[at];
      if (!next && at < 0 && column === 0 && !pathRow.hidden) return backButton.focus({ focusVisible: true });
      if (!next) return;
      if (column < 2 && !next.dataset.folder) {
        next.click(); // redraws the column
        return focusRow(rowsIn(list)[at] ?? next);
      }
      return focusRow(next);
    }
    const list = columns[column + (e.key === 'ArrowRight' ? 1 : -1)];
    if (!list) return;
    const rows = rowsIn(list);
    const next = rows.find((r) => r.getAttribute('aria-pressed') === 'true') ?? rows[0];
    if (next) focusRow(next);
  });

  // --- Labels --------------------------------------------------------------------------------
  const labelsEnabled = Boolean(api.labels);
  let labelState = NO_LABELS;
  let labelling = null; // the path of the item a label is being added to, and what's typed so far
  let labelTyped = '';
  const sameItem = (a, b) => a?.join('/') === b?.join('/');
  function renderLabelled() {
    renderDocuments();
    renderVariations();
    renderDrafts();
  }
  function startLabelling(item) {
    labelling = item;
    labelTyped = '';
    renderLabelled();
  }
  function stopLabelling() {
    if (!labelling) return;
    labelling = null;
    renderLabelled();
  }
  if (labelsEnabled) {
    api.onLabels((next) => {
      labelState = next;
      renderLabelled();
    });
    api.labels().then((next) => {
      labelState = next;
      renderLabelled();
    });
    api.onLabelRequested(startLabelling);
    document.addEventListener('pointerdown', (e) => {
      if (labelling && !e.target.closest?.('.home-label-editor')) stopLabelling();
    });
  }
  // A label's right-click menu: its color, and taking it off the item it's on. `item` is null where
  // it isn't on the item, inherited from above or still to be chosen.
  function labelMenu(label, item) {
    openMenu([
      ...LABEL_COLORS.map(([id, name]) => ({ id, label: id === label.color ? `✓ ${name}` : name })),
      ...(item ? [{ separator: true }, { id: 'remove', label: 'Remove Label' }] : []),
    ], {
      ...Object.fromEntries(LABEL_COLORS.map(([id]) => [id, () => api.setLabelColor(label.id, id)])),
      remove: () => api.removeLabel(item, label.id),
    });
  }
  function labelChip(label, onMenu) {
    const chip = el('span', 'home-label', label.name);
    chip.style.setProperty('--label-color', LABEL_COLORS.find(([id]) => id === label.color)[2]);
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onMenu();
    });
    return chip;
  }
  // The labels at the bottom of an item's row, if it has any.
  function labelsRow(item) {
    const shown = labelsOn(labelState, item);
    if (!shown.length) return null;
    const row = el('span', 'home-labels');
    for (const label of shown) {
      const chip = labelChip(label, () => labelMenu(label, label.inherited ? null : item));
      if (label.inherited) chip.title = 'Inherited from above';
      row.append(chip);
    }
    return row;
  }
  // Where a label is typed, or chosen from those its scope already has. It stays open to add more,
  // until Esc, Enter with nothing typed or a click elsewhere.
  function labelEditor(item) {
    if (!sameItem(labelling, item)) return null;
    const editor = el('div', 'home-label-editor');
    const input = el('input', 'home-folder-name');
    input.value = labelTyped;
    input.placeholder = 'Label name';
    input.setAttribute('aria-label', 'Label name');
    input.addEventListener('input', () => {
      labelTyped = input.value;
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') stopLabelling();
      if (e.key !== 'Enter') return;
      const name = input.value.trim();
      if (!name) return stopLabelling();
      labelTyped = '';
      input.value = '';
      api.addLabel(item, name);
    });
    editor.append(input);
    const choices = labelsToChoose(labelState, item);
    if (choices.length) {
      const list = el('div', 'home-labels');
      for (const label of choices) {
        const chip = labelChip(label, () => labelMenu(label, null));
        chip.classList.add('home-label-choice');
        chip.addEventListener('click', () => api.addLabel(item, label.name));
        list.append(chip);
      }
      editor.append(list);
    }
    requestAnimationFrame(() => input.focus());
    return editor;
  }

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

  // Opened by the user (not by a drag), the folder's first row takes the focus, or with none the
  // back button, so the keyboard carries on from there.
  function showFolder(id, { keepSelection = false, focus = false } = {}) {
    shownFolder = id;
    naming = null;
    api.setHomeFolder?.(id);
    if (!keepSelection) followList();
    renderDocuments();
    if (focus) (documentsEl.querySelector('.home-row') ?? (pathRow.hidden ? null : backButton))?.focus();
  }

  const backButton = el('button', 'icon-button home-back');
  backButton.type = 'button';
  backButton.innerHTML = backIcon;
  backButton.setAttribute('aria-label', 'Back');
  backButton.title = 'Back';
  backButton.addEventListener('click', () => showFolder(folderById(shownFolder)?.parentId ?? null, { focus: true }));
  const pathRow = el('nav', 'home-path');
  pathRow.setAttribute('aria-label', 'Folder path');
  pathRow.hidden = true;
  const newFolderButton = el('button', 'icon-button home-new-folder');
  newFolderButton.type = 'button';
  newFolderButton.innerHTML = newFolderIcon;
  newFolderButton.setAttribute('aria-label', 'New folder');
  newFolderButton.title = 'New folder';
  newFolderButton.addEventListener('click', () => startNaming({ parentId: shownFolder }));
  // An empty document, named here, in the folder showing (as SmartSpec's + makes a domain).
  const newDocumentButton = el('button', 'icon-button home-new-folder');
  newDocumentButton.type = 'button';
  newDocumentButton.innerHTML = newDocumentIcon;
  newDocumentButton.setAttribute('aria-label', 'New document');
  newDocumentButton.title = 'New document';
  newDocumentButton.addEventListener('click', () => startNaming({ parentId: shownFolder, document: true }));
  if (foldersOn) {
    columnHead.after(pathRow);
    title.after(newFolderButton);
    if (api.createDocument) newFolderButton.after(newDocumentButton);
    dropTarget(backButton, () => folderById(shownFolder)?.parentId ?? null, { opens: true, key: 'back' });
    dropTarget(documentsEl, () => shownFolder);
    documentsEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.home-item')) return;
      e.preventDefault();
      openMenu([...(api.createDocument ? [{ id: 'document', label: 'New Document' }] : []), { id: 'new', label: 'New Folder' }, pasteItem()], { document: () => startNaming({ parentId: shownFolder, document: true }), new: () => startNaming({ parentId: shownFolder }), paste });
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
  // With `suffix` (a document's ".pdf"), it shows faintly just after what's typed, as if part of it,
  // but isn't in the field: it's added to the name when it's kept, unless typed already.
  function nameRow(value, placeholder, save, done, { suffix = null } = {}) {
    const item = el('li', 'home-item home-naming');
    const input = el('input', 'home-folder-name');
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    if (suffix) {
      // A copy of the text, invisible, with the suffix after it, laid over the field in its font and
      // padding, and scrolled with it, so the suffix always sits at the end of the text.
      const typed = el('span', 'home-name-typed');
      const after = el('span', 'home-name-suffix', suffix);
      const ghost = el('span', 'home-name-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.append(typed, after);
      const field = el('span', 'home-name-field');
      field.append(input, ghost);
      const follow = () => {
        typed.textContent = input.value;
        after.hidden = !input.value || input.value.trim().toLowerCase().endsWith(suffix.toLowerCase());
        ghost.scrollLeft = input.scrollLeft;
      };
      for (const event of ['input', 'scroll', 'keyup', 'select', 'focus']) input.addEventListener(event, () => requestAnimationFrame(follow));
      follow();
      const keep = save;
      save = (name) => keep(name.toLowerCase().endsWith(suffix.toLowerCase()) ? name : `${name}${suffix}`);
      item.append(field);
    }
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
    if (!suffix) item.append(input);
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
    if (target.document) return nameRow('', 'Document name', (name) => api.createDocument(name, target.parentId), done, { suffix: '.pdf' });
    if (target.docId) {
      const name = documents.find((d) => d.id === target.docId)?.name ?? '';
      return nameRow(name.replace(/\.pdf$/i, ''), 'Document name', (next) => api.renameDocument(target.docId, next), done, { suffix: '.pdf' });
    }
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
      button.addEventListener('click', () => showFolder(id, { focus: true }));
      dropTarget(button, () => id);
      return button;
    };
    title.replaceChildren(path.length ? crumb('Documents', null) : 'Documents');
    pathRow.hidden = !path.length;
    pathRow.replaceChildren(backButton);
    const hidden = path.length - PATH_SHOWN;
    if (hidden > 0) pathRow.append(el('span', 'home-crumb-more', '…'));
    path.slice(Math.max(hidden, 0)).forEach((f) => {
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
    const row = rowButton(false, () => showFolder(f.id, { focus: true }));
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
        open: () => showFolder(f.id, { focus: true }),
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
    const shown = sorted('documents', levelOf(folderState, documents, shownFolder));
    // With no document here, nothing can be chosen for the other columns to show, so they show
    // placeholder rows instead. They keep their room, so the list doesn't shift under a drag.
    for (const list of [variationsEl, draftsEl]) list.parentElement.classList.toggle('home-column-unused', foldersOn && !shown.some((i) => i.kind === 'document'));
    if (!shown.length && naming?.parentId === undefined) {
      documentsEl.append(el('li', 'home-empty', shownFolder ? 'This folder is empty. Drag documents here, or right-click to paste.' : 'No documents yet. Drop a PDF here, or use File › Open.'));
      return;
    }
    for (const i of shown) documentsEl.append(i.kind === 'folder' ? folderRow(folderById(i.id)) : documentRow(i));
  }

  function documentRow(d) {
    if (naming?.docId === d.id) return namingRow();
    const item = el('li', 'home-item');
    if (cut?.kind === 'document' && cut.id === d.id) item.classList.add('home-cut');
    const row = rowButton(d.id === selected.doc, () => choose(d.id));
    row.append(el('span', 'home-title', d.name), el('span', 'home-meta', `Added ${formatDate(d.importedAt)}`));
    const labelled = labelsRow([d.id]);
    if (labelled) row.append(labelled);
    row.title = d.name;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!foldersOn) return;
      openMenu([
        { id: 'rename', label: 'Rename' },
        { id: 'cut', label: 'Cut' },
        { id: 'label', label: 'Add Label…' },
        { separator: true },
        { id: 'delete', label: 'Delete Document…' },
      ], {
        rename: () => startNaming({ docId: d.id }),
        cut: () => cutItem({ kind: 'document', id: d.id }),
        label: () => startLabelling([d.id]),
        delete: () => api.deleteDocument(d.id),
      });
    });
    makeDraggable(item, 'document', d.id);
    item.append(row);
    const editor = labelEditor([d.id]);
    if (editor) item.append(editor);
    return item;
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
      const labelled = labelsRow([tree.id, v.id]);
      if (labelled) row.append(labelled);
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showVariationMenu({ docId: tree.id, variationId: v.id });
      });
      item.append(row);
      const editor = labelEditor([tree.id, v.id]);
      if (editor) item.append(editor);
      variationsEl.append(item);
    }
  }

  function renderDrafts() {
    draftsEl.replaceChildren();
    const variation = tree?.variations.find((v) => v.id === selected.variation);
    if (!variation) return;
    // Drafts come newest first; each keeps its number in the variation whatever the order.
    const numbered = variation.drafts.map((d, i) => ({ d, number: variation.drafts.length - 1 - i }));
    // A draft preview waiting comes first, whatever the order, as a proposal does on SmartSpec's
    // home: it's the next draft, if the user accepts it. Opening it opens the draft it was written
    // from, then the preview.
    for (const { d, number } of numbered) {
      const preview = d.reviews?.improve?.preview;
      if (!preview) continue;
      const item = el('li', 'home-item home-draft home-preview');
      const row = rowButton(false, async () => {
        await api.openDraft(tree.id, variation.id, d.id, 'improve');
        await api.openPreview();
      }, openIcon);
      row.title = `Open the draft preview written from ${d.label}`;
      const head = el('span', 'home-title-row');
      head.append(el('span', 'home-title', `Draft ${number + 1} preview`));
      const pills = el('span', 'home-pills');
      pills.append(el('span', 'home-pill', 'Waiting for you'));
      head.append(pills);
      row.append(head, el('span', 'home-meta', [preview.at && formatDate(preview.at), `from ${d.label}`].filter(Boolean).join(' · ')));
      if (preview.summary) row.append(el('span', 'home-summary', preview.summary));
      item.append(row);
      draftsEl.append(item);
    }
    for (const { d, number } of sorted('drafts', numbered)) {
      const item = el('li', 'home-item home-draft');
      const row = rowButton(false, () => api.openDraft(tree.id, variation.id, d.id), openIcon);
      row.title = `Open ${d.label}`;
      // What the draft's review is waiting for the user to do: its labels all beside the title, or
      // all under it if they don't fit.
      const head = el('span', 'home-title-row');
      head.append(el('span', 'home-title', d.label));
      const action = actionFor(d.reviews?.improve);
      if (action) {
        const pills = el('span', 'home-pills');
        pills.append(el('span', 'home-pill', action));
        head.append(pills);
      }
      row.append(head, el('span', 'home-meta', [formatDate(d.createdAt), d.shared && `from ${d.shared}`].filter(Boolean).join(' · ')));
      if (d.summary) row.append(el('span', 'home-summary', d.summary));
      const labelled = labelsRow([tree.id, variation.id, d.id]);
      if (labelled) row.append(labelled);
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showDraftMenu({ docId: tree.id, variationId: variation.id, draftId: d.id, draft: number });
      });
      item.append(row);
      const editor = labelEditor([tree.id, variation.id, d.id]);
      if (editor) item.append(editor);
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
