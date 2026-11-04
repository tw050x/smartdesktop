// What one level of the home screen's documents column holds: its documents and folders together,
// in the list's order (most recently opened first). A folder takes the place of its most recently
// opened document at any depth, and the newest date added among them, so it sorts as that document
// would. Folders with no document anywhere inside come last, by name.

export function levelOf({ folders, placement }, documents, place) {
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId ?? null]));
  // The folder at this level that holds another, if any. Stops at a loop in a damaged file.
  const folderHere = (folderId) => {
    const seen = new Set();
    for (let at = folderId; at !== null && !seen.has(at); at = parentOf.get(at) ?? null) {
      seen.add(at);
      if ((parentOf.get(at) ?? null) === place) return at;
    }
    return null;
  };

  const items = [];
  const placed = new Map();
  for (const d of documents) {
    const folderId = placement[d.id] ?? null;
    if (folderId === place) {
      items.push({ kind: 'document', id: d.id, name: d.name, importedAt: d.importedAt });
      continue;
    }
    const id = folderHere(folderId);
    if (id === null) continue;
    const item = placed.get(id);
    if (!item) {
      const entry = { kind: 'folder', id, name: folders.find((f) => f.id === id).name, importedAt: d.importedAt ?? '' };
      placed.set(id, entry);
      items.push(entry);
    } else if (d.importedAt > item.importedAt) {
      item.importedAt = d.importedAt;
    }
  }
  const empty = folders
    .filter((f) => (f.parentId ?? null) === place && !placed.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ kind: 'folder', id: f.id, name: f.name, importedAt: '' }));
  return [...items, ...empty];
}
