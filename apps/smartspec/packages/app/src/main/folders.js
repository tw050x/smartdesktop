// Folders on the home screen, as SmartDoc's (its main/folders.js), holding domains instead of
// documents. They only organise the list: a domain's schematics don't change when it moves. The state
// is { folders: [{ id, name, parentId }], placement: { domainId: folderId } }; null is the top level,
// and a domain with no placement is there. Each function returns the next state. (A domain is a
// "group" in the store, so its id is a group's.)

export const NO_FOLDERS = { folders: [], placement: {} };

const cleanName = (name) => {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!clean) throw new Error('A folder needs a name.');
  if (clean.length > 80) throw new Error('A folder\'s name can be up to 80 characters.');
  return clean;
};

function requireFolder(state, id) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) throw new Error(`There's no folder ${id}. list_folders shows the ones there are.`);
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

// What was in the folder moves up a level: deleting one never deletes domains.
export function deleteFolder(state, id) {
  const { parentId } = requireFolder(state, id);
  const placement = { ...state.placement };
  for (const [domainId, folderId] of Object.entries(placement)) {
    if (folderId !== id) continue;
    if (parentId) placement[domainId] = parentId;
    else delete placement[domainId];
  }
  return { folders: state.folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId } : f)), placement };
}

export function moveDomain(state, domainId, folderId) {
  const placement = { ...state.placement };
  if (requirePlace(state, folderId)) placement[domainId] = folderId;
  else delete placement[domainId];
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

export function removeDomain(state, domainId) {
  if (!(domainId in state.placement)) return state;
  const placement = { ...state.placement };
  delete placement[domainId];
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
