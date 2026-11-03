// Folders on the home screen. They only organise the list: a document's files stay where they are,
// so moving one can't touch its drafts. The state is { folders: [{ id, name, parentId }],
// placement: { documentId: folderId } }; null is the top level, and a document with no placement
// is there. Each function returns the next state.

export const NO_FOLDERS = { folders: [], placement: {} };

const cleanName = (name) => {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) throw new Error('A folder needs a name.');
  return clean;
};

function requireFolder(state, id) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) throw new Error(`There's no folder ${id}.`);
  return folder;
}
// A destination: null, the top level, or a folder that exists.
const requirePlace = (state, id) => {
  if (id !== null) requireFolder(state, id);
  return id;
};

export function createFolder(state, { id, name, parentId = null }) {
  return { ...state, folders: [...state.folders, { id, name: cleanName(name), parentId: requirePlace(state, parentId) }] };
}

export function renameFolder(state, id, name) {
  requireFolder(state, id);
  const clean = cleanName(name);
  return { ...state, folders: state.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)) };
}

// What was in the folder moves up a level: deleting one never deletes documents.
export function deleteFolder(state, id) {
  const { parentId } = requireFolder(state, id);
  const placement = { ...state.placement };
  for (const [docId, folderId] of Object.entries(placement)) {
    if (folderId !== id) continue;
    if (parentId) placement[docId] = parentId;
    else delete placement[docId];
  }
  return { folders: state.folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId } : f)), placement };
}

export function moveDocument(state, docId, folderId) {
  const placement = { ...state.placement };
  if (requirePlace(state, folderId)) placement[docId] = folderId;
  else delete placement[docId];
  return { ...state, placement };
}

// Whether a folder can go into a place: not into itself or anything inside it.
export function canMoveFolder(state, id, parentId) {
  for (let at = parentId; at; at = state.folders.find((f) => f.id === at)?.parentId) {
    if (at === id) return false;
  }
  return true;
}

export function moveFolder(state, id, parentId) {
  requireFolder(state, id);
  requirePlace(state, parentId);
  if (!canMoveFolder(state, id, parentId)) throw new Error("A folder can't go inside itself.");
  return { ...state, folders: state.folders.map((f) => (f.id === id ? { ...f, parentId } : f)) };
}

export function removeDocument(state, docId) {
  if (!(docId in state.placement)) return state;
  const placement = { ...state.placement };
  delete placement[docId];
  return { ...state, placement };
}

// A folder's names from the top level down, [] for the top level. Stops at a loop or a missing
// folder rather than hanging on a damaged file.
export function pathOf(state, folderId) {
  const path = [];
  const seen = new Set();
  for (let at = state.folders.find((f) => f.id === folderId); at && !seen.has(at.id); at = state.folders.find((f) => f.id === at.parentId)) {
    seen.add(at.id);
    path.unshift(at);
  }
  return path;
}

// A saved file as the state, dropping what can't be used.
export function readFolders(saved) {
  const folders = (Array.isArray(saved?.folders) ? saved.folders : []).filter((f) => typeof f?.id === 'string' && typeof f.name === 'string');
  const ids = new Set(folders.map((f) => f.id));
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: ids.has(f.parentId) ? f.parentId : null })),
    placement: Object.fromEntries(Object.entries(saved?.placement ?? {}).filter(([, folderId]) => ids.has(folderId))),
  };
}
