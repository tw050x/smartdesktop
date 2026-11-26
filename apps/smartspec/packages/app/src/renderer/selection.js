import { longPressed } from './long-press.js';

// Words picked in an item are let go by a click anywhere, as in any text editor, even where nothing
// can be picked (title bars, cards, canvases, the bars), which otherwise leaves the browser's
// selection as it was. It happens when the pointer comes up, not down, so a long press on the picked
// words still comments on them (see comments.js). A drag that picks other words keeps those, Shift
// extends them, and typing somewhere keeps them.
let before = null; // the selection as the pointer went down

addEventListener('pointerdown', (event) => {
  const selection = getSelection();
  before = event.button === 0 && !event.shiftKey && selection?.rangeCount && !selection.isCollapsed
    ? { range: selection.getRangeAt(0).cloneRange(), target: event.target }
    : null;
}, true);

addEventListener('pointerup', () => {
  const was = before;
  before = null;
  if (!was || longPressed()) return;
  if (was.target.closest?.('input, textarea, [contenteditable="true"], .comment-thread, dialog')) return;
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  // Words picked by this drag are the user's new selection.
  const now = selection.getRangeAt(0);
  const same = now.compareBoundaryPoints(Range.START_TO_START, was.range) === 0 && now.compareBoundaryPoints(Range.END_TO_END, was.range) === 0;
  if (same) selection.removeAllRanges();
}, true);
