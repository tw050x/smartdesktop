import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toData, toTemplate } from '../main/menu-wire.js';

// Electron's Menu and MenuItem, as far as toData reads them.
const menu = (items) => ({ items });
const item = (label, more = {}) => ({ label, type: 'normal', enabled: true, visible: true, ...more });
const sub = (label, items, more = {}) => ({ label, type: 'submenu', submenu: menu(items), ...more });
const sep = { type: 'separator' };

test('an app’s menu as data: its own items, SmartDesktop’s left out, each run by its id', () => {
  const ran = [];
  const { data, clicks } = toData(menu([
    sub('SmartDoc', [{ role: 'about' }, item('Check for Updates…', { click: () => ran.push('updates') }), sep, item('Settings…', { accelerator: 'CmdOrCtrl+,' }), sep, { role: 'quit' }], { role: 'appMenu' }),
    sub('File', [item('New Tab', { accelerator: 'CmdOrCtrl+T', click: () => ran.push('new tab') }), sep, sep, item('Close Tab', { enabled: false }), sep]),
    sub('Edit', [{ role: 'copy' }, { role: 'paste' }, sep, item('Find…', { accelerator: 'CmdOrCtrl+F' }), sub('Speech', [{ role: 'startSpeaking' }])], { role: 'editMenu' }),
    sub('Review', [item('Highlights', { type: 'checkbox', checked: true }), item('Hidden', { visible: false })]),
    sub('Window', [item('New Window')], { role: 'windowMenu' }),
  ]));
  assert.deepEqual(data.app.map((one) => one.label ?? '—'), ['Check for Updates…', '—', 'Settings…']);
  assert.deepEqual(data.menus.map((one) => one.label), ['File', 'Review']);
  assert.deepEqual(data.menus[0].submenu.map((one) => one.label ?? '—'), ['New Tab', '—', 'Close Tab']);
  assert.equal(data.menus[0].submenu[2].enabled, false);
  assert.deepEqual(data.edit.map((one) => one.label), ['Find…']);
  assert.deepEqual(data.menus[1].submenu, [{ id: data.menus[1].submenu[0].id, label: 'Highlights', accelerator: null, enabled: true, checked: true }]);
  clicks.get(data.menus[0].submenu[0].id).click();
  clicks.get(data.app[0].id).click();
  assert.deepEqual(ran, ['new tab', 'updates']);

  const chosen = [];
  const template = toTemplate(data.menus[0].submenu, (id) => chosen.push(id));
  assert.equal(template[0].accelerator, 'CmdOrCtrl+T');
  assert.equal(template[1].type, 'separator');
  template[0].click();
  assert.deepEqual(chosen, [data.menus[0].submenu[0].id]);
});
