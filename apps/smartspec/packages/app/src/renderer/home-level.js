// What one level of home's domains column holds: its folders and domains together, as SmartDoc's
// documents column does (its home-level.js), for the column's sort to order. A folder counts the
// schematics in every domain inside it, at any depth, and takes the newest date among them, so it
// sorts as they would. (A domain is a group in the store.)

export function levelOf({ folders, placement }, groups, place) {
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
  const folderItems = new Map(folders
    .filter((f) => (f.parentId ?? null) === place)
    .map((f) => [f.id, { kind: 'folder', id: f.id, name: f.name, schemas: 0, domains: 0, createdAt: '' }]));
  const items = [...folderItems.values()];
  for (const group of groups) {
    const folderId = placement[group.id] ?? null;
    if (folderId === place) {
      items.push({ kind: 'domain', id: group.id, name: group.name, schemas: group.schemas, createdAt: group.createdAt ?? '' });
      continue;
    }
    const folder = folderItems.get(folderHere(folderId));
    if (!folder) continue;
    folder.schemas += group.schemas;
    folder.domains += 1;
    if ((group.createdAt ?? '') > folder.createdAt) folder.createdAt = group.createdAt;
  }
  return items;
}
