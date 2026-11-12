// The chat window's layout (the user's choice, after openp41ge code's tab grid): a row of columns
// side by side, each with its own row of chat tabs and one of them showing (`active`), and how wide
// each column is, as shares of the window (`widths`, adding up to 1). A chat is in one column at
// most; a column with no chats goes; closing a chat's tab keeps the chat (agent.js), it just isn't
// in the layout. Kept in settings.json (`chatLayout`). No Electron here, so it can be tested.
//
//   { columns: [{ chats: [chat id, …], active: chat id }], widths: [share, …] }

export const empty = () => ({ columns: [], widths: [] });

// Evens the columns' widths.
export function even(layout) {
  const n = layout.columns.length;
  return { ...layout, widths: layout.columns.map(() => 1 / n) };
}

// A layout as it should be, whatever was kept: no empty columns, no chat twice, an active chat in
// each column that's one of its own, and a width for each column, adding up to 1.
export function normalize(layout, known = null) {
  const seen = new Set();
  const columns = [];
  const widths = [];
  (layout?.columns ?? []).forEach((column, i) => {
    const chats = [];
    for (const id of column?.chats ?? []) {
      if (typeof id !== 'string' || seen.has(id) || (known && !known.has(id))) continue;
      seen.add(id);
      chats.push(id);
    }
    if (!chats.length) return;
    columns.push({ chats, active: chats.includes(column.active) ? column.active : chats[0] });
    widths.push(Number(layout.widths?.[i]) > 0 ? Number(layout.widths[i]) : 0);
  });
  const total = widths.reduce((a, b) => a + b, 0);
  if (!columns.length) return empty();
  if (!(total > 0) || widths.some((w) => !(w > 0))) return even({ columns, widths });
  return { columns, widths: widths.map((w) => w / total) };
}

const clone = (layout) => ({ columns: layout.columns.map((c) => ({ chats: [...c.chats], active: c.active })), widths: [...layout.widths] });

// Where a chat is: its column's index, or -1.
export const columnOf = (layout, chatId) => layout.columns.findIndex((c) => c.chats.includes(chatId));

// Takes a chat out of the layout (its tab closed, or before it's put elsewhere). Its column's next
// chat shows in its place; a column left with none goes, its width shared among the rest.
function take(layout, chatId) {
  const at = columnOf(layout, chatId);
  if (at < 0) return layout;
  const column = layout.columns[at];
  const index = column.chats.indexOf(chatId);
  column.chats.splice(index, 1);
  if (column.active === chatId) column.active = column.chats[index] ?? column.chats[index - 1] ?? null;
  if (!column.chats.length) {
    const [gone] = layout.widths.splice(at, 1);
    layout.columns.splice(at, 1);
    const rest = layout.widths.reduce((a, b) => a + b, 0);
    layout.widths = layout.widths.map((w) => (rest > 0 ? w + (gone * w) / rest : 1 / layout.widths.length));
  }
  return layout;
}

// A chat in a column (at `index` in its tabs, or at the end), showing. With no columns, the first.
export function place(layout, chatId, column = 0, index = null) {
  const next = take(clone(layout), chatId);
  if (!next.columns.length) return { columns: [{ chats: [chatId], active: chatId }], widths: [1] };
  const target = next.columns[Math.max(0, Math.min(column, next.columns.length - 1))];
  const at = index === null ? target.chats.length : Math.max(0, Math.min(index, target.chats.length));
  target.chats.splice(at, 0, chatId);
  target.active = chatId;
  return next;
}

// A chat in a column of its own, beside `column` (on its 'left' or 'right'), which halves to make
// room. Splitting a column that holds only this chat moves nothing.
export function split(layout, chatId, column, side) {
  const from = columnOf(layout, chatId);
  if (from === column && layout.columns[column]?.chats.length === 1) return layout;
  let next = clone(layout);
  // Taking it out may remove a column before the target: the target moves along with it.
  const before = next.columns.length;
  next = take(next, chatId);
  if (next.columns.length < before && from >= 0 && from < column) column -= 1;
  if (!next.columns.length) return { columns: [{ chats: [chatId], active: chatId }], widths: [1] };
  column = Math.max(0, Math.min(column, next.columns.length - 1));
  const at = side === 'left' ? column : column + 1;
  const half = next.widths[column] / 2;
  next.widths[column] = half;
  next.columns.splice(at, 0, { chats: [chatId], active: chatId });
  next.widths.splice(at, 0, half);
  return next;
}

// A chat's tab closed: it leaves the layout (the chat is kept).
export const close = (layout, chatId) => take(clone(layout), chatId);

// Shows a chat in its column.
export function show(layout, chatId) {
  const next = clone(layout);
  const at = columnOf(next, chatId);
  if (at >= 0) next.columns[at].active = chatId;
  return next;
}

// The columns' widths, as dragged (each at least `min` of the whole).
export function resize(layout, widths, min = 0) {
  if (!Array.isArray(widths) || widths.length !== layout.columns.length) return layout;
  const clamped = widths.map((w) => Math.max(min, Number(w) || 0));
  const total = clamped.reduce((a, b) => a + b, 0);
  return { ...clone(layout), widths: clamped.map((w) => w / total) };
}
