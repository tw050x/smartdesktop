// Labels the user defines on the home screen, for documents, variations and drafts. An item is its
// path: [documentId], [documentId, variationId] or [documentId, variationId, draftId]. A label
// belongs to the scope it was made in, the item's parent: every document shares one set, a
// document's variations another, a variation's drafts another. So a label can only go on items in
// its scope, never higher up or beside it, and shows on everything below the items it's on. The
// state is { labels: [{ id, name, color, scope }], assigned: { itemKey: [labelId] } }. Each function
// returns the next state. Only pure code here: the home screen uses it too.

export const NO_LABELS = { labels: [], assigned: {} };

export const LABEL_COLORS = [
  ['gray', 'Gray', '#8a8f98'],
  ['red', 'Red', '#d64545'],
  ['orange', 'Orange', '#d9822b'],
  ['yellow', 'Yellow', '#b8950f'],
  ['green', 'Green', '#1f9d55'],
  ['teal', 'Teal', '#148f8f'],
  ['blue', 'Blue', '#3b7dd8'],
  ['purple', 'Purple', '#8557d3'],
  ['pink', 'Pink', '#cf4f92'],
];
const DEFAULT_COLOR = LABEL_COLORS[0][0];
const isColor = (color) => LABEL_COLORS.some(([id]) => id === color);

const keyOf = (path) => path.join('/');
const scopeOf = (path) => keyOf(path.slice(0, -1));
const sameName = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const onItem = (state, path) => (state.assigned[keyOf(path)] ?? []).map((id) => state.labels.find((l) => l.id === id)).filter(Boolean);

function requireItem(path) {
  if (!Array.isArray(path) || path.length < 1 || path.length > 3 || !path.every((p) => typeof p === 'string' && p && !p.includes('/'))) throw new Error('That can\'t have labels.');
}

// What an item shows: those on the items above it first, each marked inherited, then its own. A name
// shows once, the highest one winning.
export function labelsOn(state, path) {
  const shown = [];
  for (let depth = 1; depth <= path.length; depth++) {
    for (const label of onItem(state, path.slice(0, depth))) {
      if (!shown.some((l) => sameName(l.name, label.name))) shown.push({ ...label, inherited: depth < path.length });
    }
  }
  return shown;
}

// The labels that already exist and an item could take: those of its scope it doesn't show already.
export function labelsToChoose(state, path) {
  const shown = labelsOn(state, path);
  const scope = scopeOf(path);
  return state.labels.filter((l) => l.scope === scope && !shown.some((s) => sameName(s.name, l.name))).sort((a, b) => a.name.localeCompare(b.name));
}

// Puts a label on an item by name: the one of that name in its scope, or a new one. `id` is the new
// one's. Nothing changes if the item shows that name already.
export function addLabel(state, path, name, id) {
  requireItem(path);
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) throw new Error('A label needs a name.');
  if (labelsOn(state, path).some((l) => sameName(l.name, clean))) return state;
  const scope = scopeOf(path);
  const existing = state.labels.find((l) => l.scope === scope && sameName(l.name, clean));
  const label = existing ?? { id, name: clean, color: DEFAULT_COLOR, scope };
  const key = keyOf(path);
  return {
    labels: existing ? state.labels : [...state.labels, label],
    assigned: { ...state.assigned, [key]: [...(state.assigned[key] ?? []), label.id] },
  };
}

// A label no item has any more is gone, with its color.
function dropUnused({ labels, assigned }) {
  const used = new Set(Object.values(assigned).flat());
  return { labels: labels.filter((l) => used.has(l.id)), assigned };
}

// Takes a label off the item it was put on. Below that it's inherited, so it can't be taken off.
export function removeLabel(state, path, labelId) {
  requireItem(path);
  const key = keyOf(path);
  const left = (state.assigned[key] ?? []).filter((id) => id !== labelId);
  const assigned = { ...state.assigned };
  if (left.length) assigned[key] = left;
  else delete assigned[key];
  return dropUnused({ labels: state.labels, assigned });
}

export function setLabelColor(state, labelId, color) {
  if (!isColor(color)) throw new Error(`There's no color ${color}.`);
  if (!state.labels.some((l) => l.id === labelId)) throw new Error(`There's no label ${labelId}.`);
  return { ...state, labels: state.labels.map((l) => (l.id === labelId ? { ...l, color } : l)) };
}

// An item has gone: its labels and those of everything below it, with the labels of its scopes below.
export function removeItem(state, path) {
  const key = keyOf(path);
  const inside = (at) => at === key || at.startsWith(`${key}/`);
  return dropUnused({
    labels: state.labels.filter((l) => !inside(l.scope)),
    assigned: Object.fromEntries(Object.entries(state.assigned).filter(([at]) => !inside(at))),
  });
}

// A saved file as the state, dropping what can't be used.
export function readLabels(saved) {
  const labels = (Array.isArray(saved?.labels) ? saved.labels : [])
    .filter((l) => typeof l?.id === 'string' && typeof l.name === 'string' && l.name && typeof l.scope === 'string')
    .map((l) => ({ id: l.id, name: l.name, scope: l.scope, color: isColor(l.color) ? l.color : DEFAULT_COLOR }));
  const assigned = {};
  for (const [key, ids] of Object.entries(saved?.assigned ?? {})) {
    const scope = key.split('/').slice(0, -1).join('/');
    const valid = (Array.isArray(ids) ? ids : []).filter((id) => labels.some((l) => l.id === id && l.scope === scope));
    if (valid.length) assigned[key] = valid;
  }
  return dropUnused({ labels, assigned });
}
