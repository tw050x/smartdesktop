// The chat windows (the user's choice: more than one, each with chats in tabs of its own, so each
// Space, or each piece of work on one, has a chat window organised for it). Each is
// { id, layout, bounds, focused, focusedAt }: its columns of chat tabs (chat-layout.js), where it
// was, the chat in it with the focus, and when it last had the focus. A chat is in one window at
// most. Kept in settings.json (`chatWindows`). No Electron here, so it can be tested.
import * as grid from './chat-layout.js';

const newId = () => Math.random().toString(36).slice(2, 10);

// The windows as kept, as they should be: each layout normalised (chats that no longer exist gone),
// no chat in two windows (the first keeps it), each window's focused chat one of its own, and no
// empty window, but always one. Settings from before there were several windows (`chatLayout`,
// `chatBounds`, `focusedChat`) are the one window.
export function restore(settings = {}, known = null) {
  const saved = Array.isArray(settings.chatWindows)
    ? settings.chatWindows
    : [{ layout: settings.chatLayout, bounds: settings.chatBounds, focused: settings.focusedChat }];
  const seen = new Set();
  const windows = [];
  for (const kept of saved) {
    let layout = grid.normalize(kept?.layout, known);
    for (const chatId of layout.columns.flatMap((c) => c.chats)) {
      if (seen.has(chatId)) layout = grid.close(layout, chatId);
      else seen.add(chatId);
    }
    if (!layout.columns.length) continue;
    windows.push(tidy({
      id: typeof kept.id === 'string' && kept.id ? kept.id : newId(),
      layout,
      bounds: validBounds(kept.bounds),
      focused: kept.focused ?? null,
      focusedAt: Number(kept.focusedAt) || 0,
    }));
  }
  if (!windows.length) {
    const first = saved.find((kept) => validBounds(kept?.bounds));
    windows.push(create({ bounds: validBounds(first?.bounds) }));
  }
  return windows;
}

// A new window, with a chat in it if one's given.
export function create({ chatId = null, bounds = null, id = newId() } = {}) {
  const layout = chatId ? grid.place(grid.empty(), chatId) : grid.empty();
  return { id, layout, bounds, focused: chatId, focusedAt: 0 };
}

// What's kept of a window.
export const saved = ({ id, layout, bounds, focused, focusedAt }) => ({ id, layout, bounds, focused, focusedAt });

// A window's focused chat, one of its own: as it was, else the one showing in its first column.
export function tidy(win) {
  if (grid.columnOf(win.layout, win.focused) < 0) win.focused = win.layout.columns[0]?.active ?? null;
  return win;
}

// The window a chat is in, or null.
export const holding = (windows, chatId) => windows.find((w) => grid.columnOf(w.layout, chatId) >= 0) ?? null;

// The chats in a window.
export const chatsIn = (win) => win.layout.columns.flatMap((c) => c.chats);

// The windows, the one with the focus most recently first.
export const byUse = (windows) => [...windows].sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0));

// Takes a chat out of every window but `except` (it's being put there), tidying their focus.
export function takeOut(windows, chatId, except = null) {
  const left = [];
  for (const win of windows) {
    if (win === except || grid.columnOf(win.layout, chatId) < 0) continue;
    win.layout = grid.close(win.layout, chatId);
    tidy(win);
    left.push(win);
  }
  return left; // the windows it left
}

// Where a new window goes: a little below and to the right of `from` (a window's bounds), kept in
// `area` (its screen's work area): to the left instead at the area's right edge, and back to its
// top at the bottom.
export const STEP = 28;
export function cascade(from, area) {
  if (!from) return null;
  let x = from.x + STEP;
  let y = from.y + STEP;
  if (area && x + from.width > area.x + area.width) x = Math.max(area.x, from.x - STEP);
  if (area && y + from.height > area.y + area.height) y = area.y + STEP;
  return { x, y, width: from.width, height: from.height };
}

function validBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}
