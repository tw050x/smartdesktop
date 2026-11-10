import { edgeId } from '../main/items.js';

// What a proposal changes in a diagram or a table, for its card's Changes view: the item as both
// versions together, so what's removed keeps its place (faded, for the user to look at on hover)
// beside what's new, and a `status` for each part that changed: 'added', 'removed' or 'changed',
// with what a changed part said before (`was`). A table's changed cells say what they held before
// (`cells`: row id → column id → the old text). Pure, so it's tested on its own.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Both lists in one, in order: `after`'s, with each part only in `before` put back just after the
// part it followed there (or first, if it followed nothing that's still here). `key` names a part.
export function mergeOrder(after, before, key = (one) => one.id) {
  const merged = [...after];
  const at = new Map(merged.map((one, index) => [key(one), index]));
  let previous = null; // the last part of `before` that's in `merged`, by key
  for (const one of before) {
    const id = key(one);
    if (at.has(id)) {
      previous = id;
      continue;
    }
    const index = previous === null ? 0 : merged.findIndex((other) => key(other) === previous) + 1;
    merged.splice(index, 0, one);
    previous = id;
    merged.forEach((other, i) => at.set(key(other), i));
  }
  return merged;
}

// Each part of `after` and `before` that isn't the same in both: added, removed or changed, by key,
// with what a changed one was labelled before.
function compare(after, before, key, status, was, label = (one) => one.label) {
  const old = new Map(before.map((one) => [key(one), one]));
  const kept = new Set(after.map(key));
  for (const one of after) {
    const id = key(one);
    if (!old.has(id)) status.set(id, 'added');
    else if (!same(one, old.get(id))) {
      status.set(id, 'changed');
      if (label(old.get(id)) !== label(one)) was.set(id, label(old.get(id)));
    }
  }
  for (const one of before) if (!kept.has(key(one))) status.set(key(one), 'removed');
}

export function flowDiff(after, before) {
  const status = new Map();
  const was = new Map();
  compare(after.nodes, before.nodes, (node) => node.id, status, was);
  compare(after.edges ?? [], before.edges ?? [], edgeId, status, was);
  return {
    item: { ...after, nodes: mergeOrder(after.nodes, before.nodes), edges: mergeOrder(after.edges ?? [], before.edges ?? [], edgeId) },
    status,
    was,
  };
}

// Where a message sits in a sequence: the boxes (loop, alt and the like) it's inside, and which of
// each one's sections.
function placesOf(item) {
  const order = new Map((item.messages ?? []).map((message, index) => [message.id, index]));
  const places = new Map();
  for (const message of item.messages ?? []) {
    const at = order.get(message.id);
    const inside = (item.groups ?? []).filter((group) => order.get(group.from) <= at && at <= order.get(group.to)).map((group) => {
      const section = (group.sections ?? []).filter((one) => order.get(one.at) <= at).length;
      return `${group.id}:${section}`;
    });
    places.set(message.id, inside.sort().join('|'));
  }
  return places;
}

// A sequence reads as rows, so a message that's changed, in what it says or where it sits (taken
// into a new box, say), shows as both: the old row where it was, removed, and the new one, added,
// as a text diff would show a changed line (the user wanted the removal seen, even when the new
// rows hold the old ones). The old row's id gets `~was`, as it's drawn beside the new one.
export const WAS = '~was';
export function sequenceDiff(after, before) {
  const status = new Map();
  const was = new Map();
  for (const part of ['participants', 'activations', 'boxes', 'groups']) compare(after[part] ?? [], before[part] ?? [], (one) => one.id, status, was);
  const afterPlaces = placesOf(after);
  const beforePlaces = placesOf(before);
  const afterMessages = new Map((after.messages ?? []).map((message) => [message.id, message]));
  const rename = new Map(); // a before message's id → its row's id in the drawing
  for (const message of before.messages ?? []) {
    const now = afterMessages.get(message.id);
    if (!now) {
      status.set(message.id, 'removed');
    } else if (!same(now, message) || afterPlaces.get(message.id) !== beforePlaces.get(message.id)) {
      rename.set(message.id, `${message.id}${WAS}`);
      status.set(`${message.id}${WAS}`, 'removed');
      status.set(message.id, 'added');
    }
  }
  for (const message of after.messages ?? []) if (!(before.messages ?? []).some((one) => one.id === message.id)) status.set(message.id, 'added');
  const renamed = (id) => rename.get(id) ?? id;
  const beforeMessages = (before.messages ?? []).map((message) => ({ ...message, id: renamed(message.id) }));
  const item = { ...after, messages: mergeOrder(after.messages ?? [], beforeMessages) };
  // What's only in the earlier version spans its own rows, as they were.
  const earlier = (one) => ({ ...one, from: renamed(one.from), to: renamed(one.to), ...(one.sections && { sections: one.sections.map((section) => ({ ...section, at: renamed(section.at) })) }) });
  item.groups = mergeOrder(after.groups ?? [], (before.groups ?? []).map((group) => ((after.groups ?? []).some((one) => one.id === group.id) ? group : earlier(group))));
  item.activations = mergeOrder(after.activations ?? [], (before.activations ?? []).map((one) => ((after.activations ?? []).some((other) => other.id === one.id) ? one : earlier(one))));
  for (const part of ['participants', 'boxes']) item[part] = mergeOrder(after[part] ?? [], before[part] ?? []);
  return { item, status, was };
}

export function tableDiff(after, before) {
  const status = new Map();
  const was = new Map();
  const cells = new Map();
  compare(after.columns, before.columns, (column) => column.id, status, was);
  const old = new Map(before.rows.map((row) => [row.id, row]));
  const kept = new Set(after.rows.map((row) => row.id));
  for (const row of after.rows) {
    const earlier = old.get(row.id);
    if (!earlier) {
      status.set(row.id, 'added');
      continue;
    }
    // A row that's there in both is changed where its cells are: each says what it held before.
    const changed = new Map();
    for (const column of after.columns) {
      const now = row.cells?.[column.id] ?? '';
      const then = earlier.cells?.[column.id] ?? '';
      if (now !== then && before.columns.some((one) => one.id === column.id)) changed.set(column.id, then);
    }
    if (changed.size) cells.set(row.id, changed);
    if (changed.size || !same({ ...row, cells: null }, { ...earlier, cells: null })) status.set(row.id, 'changed');
  }
  for (const row of before.rows) if (!kept.has(row.id)) status.set(row.id, 'removed');
  return {
    item: { ...after, columns: mergeOrder(after.columns, before.columns), rows: mergeOrder(after.rows, before.rows) },
    status,
    was,
    cells,
  };
}

// The Changes view of an item kind that has one drawn from both versions; null for one that doesn't.
export function diffOf(after, before) {
  if (!before || after.kind !== before.kind) return null;
  if (after.kind === 'flow') return flowDiff(after, before);
  if (after.kind === 'sequence') return sequenceDiff(after, before);
  if (after.kind === 'table') return tableDiff(after, before);
  return null;
}
