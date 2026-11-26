// An app's menus shown in SmartDesktop's menu bar while one of its tabs is in front (the user's choice,
// 2026-11-26: the menu bar is SmartDesktop's, the tab's app adding its own items). The app gives its
// menu as data (`toData`: labels, shortcuts, enabled and checked, each item it can run by an id), and
// runs the item SmartDesktop says was chosen (`clicks`). What SmartDesktop has its own of is left
// out: the app menu's standard items (About, Services, Hide, Quit…) and the Window menu, and the
// Edit menu's standard items (its own, Find say, go at the end of SmartDesktop's: `edit`); items
// macOS does itself (a role) are left out too, as they'd act on SmartDesktop's windows.
export function toData(menu) {
  const clicks = new Map(); // id → the MenuItem to run
  let next = 0;
  const items = (list) => list.flatMap((item) => {
    if (item.visible === false) return [];
    if (item.type === 'separator') return [{ separator: true }];
    if (item.submenu) {
      const inner = items(item.submenu.items);
      return inner.some((one) => !one.separator) ? [{ label: item.label, submenu: inner }] : [];
    }
    if (item.role) return [];
    const id = String(++next);
    clicks.set(id, item);
    return [{ id, label: item.label, accelerator: item.accelerator ?? null, enabled: item.enabled !== false, checked: item.type === 'checkbox' || item.type === 'radio' ? Boolean(item.checked) : null }];
  });
  const menus = [];
  let appItems = [];
  let editItems = [];
  for (const top of menu.items) {
    const role = String(top.role ?? '').toLowerCase();
    if (role === 'windowmenu' || top.label === 'Window') continue;
    if (role === 'editmenu' || top.label === 'Edit') {
      editItems = items(top.submenu?.items ?? []);
      continue;
    }
    if (role === 'appmenu') {
      appItems = items(top.submenu?.items ?? []);
      continue;
    }
    if (!top.submenu) continue;
    const inner = items(top.submenu.items);
    if (inner.some((one) => !one.separator)) menus.push({ label: top.label, submenu: inner });
  }
  // Separators only between items, never at the ends or twice.
  const tidy = (list) => list.filter((one, i, all) => !one.separator || (i > 0 && i < all.length - 1 && !all[i - 1].separator)).map((one) => (one.submenu ? { ...one, submenu: tidy(one.submenu) } : one));
  return { data: { app: tidy(appItems), edit: tidy(editItems), menus: menus.map((one) => ({ ...one, submenu: tidy(one.submenu) })) }, clicks };
}

// SmartDesktop's side: an app's menu data as a template for Electron's Menu, each item's click
// running `choose(id)`.
export function toTemplate(items, choose) {
  return items.map((item) => {
    if (item.separator) return { type: 'separator' };
    if (item.submenu) return { label: item.label, submenu: toTemplate(item.submenu, choose) };
    return {
      label: item.label,
      ...(item.accelerator ? { accelerator: item.accelerator } : {}),
      enabled: item.enabled !== false,
      ...(item.checked === null || item.checked === undefined ? {} : { type: 'checkbox', checked: item.checked }),
      click: () => choose(item.id),
    };
  });
}
