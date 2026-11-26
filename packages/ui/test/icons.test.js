import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ICONS, guessIcon, iconFor, iconSvg, isIcon } from '../main/icons.js';

test('every app has the same icons, SmartStudio’s among them', () => {
  for (const name of ['music', 'film', 'clapperboard', 'mic', 'file-text', 'clipboard-list', 'file']) assert.ok(isIcon(name), name);
  assert.equal(new Set(ICONS.map((icon) => icon.name)).size, ICONS.length);
});

test('a name suggests its icon, the longest match winning', () => {
  assert.equal(guessIcon('Spring sale ad'), 'clapperboard');
  assert.equal(guessIcon('Podcast notes'), 'mic');
  assert.equal(guessIcon('Album review'), 'music');
  // "production" is a checklist's more often than a shoot's (the user's choice, 2026-11-26).
  assert.equal(guessIcon('Production checklist'), 'clipboard-list');
  assert.equal(guessIcon('Nothing to go on'), 'file');
  assert.equal(guessIcon('Nothing to go on', 'server'), 'server');
});

test('a chosen icon wins over the guess, and an unknown one falls back to it', () => {
  assert.equal(iconFor({ icon: 'rocket' }, 'Podcast notes'), 'rocket');
  assert.equal(iconFor({ icon: 'nonsense' }, 'Podcast notes'), 'mic');
  assert.match(iconSvg('nonsense'), /^<svg /);
});
