// Up and Down move through a menu's items, wrapping round at either end; Home and End go to the
// first and last.
export function arrowKeysIn(menu) {
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role^="menuitem"]')].filter((i) => !i.disabled);
    const at = items.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined || !items.length) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  });
}
