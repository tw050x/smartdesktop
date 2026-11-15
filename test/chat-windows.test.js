import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as wins from '../packages/app/src/main/chat-windows.js';

const layout = (...columns) => ({ columns: columns.map((chats) => ({ chats, active: chats[0] })), widths: columns.map(() => 1 / columns.length) });
const bounds = { x: 100, y: 80, width: 600, height: 500 };

test('the one window from before there were several is the first window, as it was', () => {
  const [win, ...rest] = wins.restore({ chatLayout: layout(['a', 'b'], ['c']), chatBounds: bounds, focusedChat: 'c' });
  assert.equal(rest.length, 0);
  assert.deepEqual(win.layout.columns.map((c) => c.chats), [['a', 'b'], ['c']]);
  assert.deepEqual(win.bounds, bounds);
  assert.equal(win.focused, 'c');
});

test('kept windows come back, a chat in two only in the first, and windows left empty go', () => {
  const windows = wins.restore({ chatWindows: [
    { id: 'one', layout: layout(['a', 'b']), bounds, focused: 'b' },
    { id: 'two', layout: layout(['b', 'c']), focused: 'b' },
    { id: 'three', layout: layout(['a']) },
  ] });
  assert.deepEqual(windows.map((w) => w.id), ['one', 'two']);
  assert.deepEqual(wins.chatsIn(windows[1]), ['c']);
  assert.equal(windows[1].focused, 'c'); // its own, as b went
});

test('chats that no longer exist leave their windows; with none left there is still one window', () => {
  const windows = wins.restore({ chatWindows: [{ id: 'one', layout: layout(['gone']), bounds }] }, new Set(['a']));
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].layout.columns, []);
  assert.deepEqual(windows[0].bounds, bounds); // it opens where the last one was
  assert.equal(wins.restore({}).length, 1);
});

test('a chat put in one window leaves the others, which tidy their focus', () => {
  const windows = wins.restore({ chatWindows: [{ id: 'one', layout: layout(['a', 'b']), focused: 'a' }, { id: 'two', layout: layout(['c']) }] });
  const [one, two] = windows;
  const left = wins.takeOut(windows, 'a', two);
  assert.deepEqual(left, [one]);
  assert.deepEqual(wins.chatsIn(one), ['b']);
  assert.equal(one.focused, 'b');
  assert.equal(wins.holding(windows, 'c'), two);
  assert.equal(wins.holding(windows, 'a'), null);
});

test('a new window cascades from the last one, to the left at the screen’s edge and back up at its foot', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(wins.cascade(bounds, area), { x: 128, y: 108, width: 600, height: 500 });
  assert.deepEqual(wins.cascade({ x: 840, y: 380, width: 600, height: 500 }, area), { x: 812, y: 53, width: 600, height: 500 });
  assert.equal(wins.cascade(null, area), null);
});

test('windows by use, the one with the focus last first', () => {
  const a = { id: 'a', focusedAt: 5 };
  const b = { id: 'b', focusedAt: 9 };
  assert.deepEqual(wins.byUse([a, b]).map((w) => w.id), ['b', 'a']);
});
