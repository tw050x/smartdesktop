import { ICONS, iconSvg } from '../main/icons.js';

// Choosing a document's icon (see main/icons.js): a card of every icon, opened from its tab's or
// its home row's right-click menu, under the tab or beside the row. Choosing one sets it (it's the
// user's, which the AI never replaces); Escape or a click outside closes it.
export function createIconPicker({ api }) {
  const card = Object.assign(document.createElement('div'), { className: 'tool-card icon-picker', hidden: true });
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Choose an icon');
  const title = Object.assign(document.createElement('div'), { className: 'icon-picker-title' });
  const grid = Object.assign(document.createElement('div'), { className: 'icon-picker-grid' });
  card.append(title, grid);
  document.body.append(card);
  let target = null;

  function close() {
    card.hidden = true;
    target = null;
  }
  // `docId`: whose icon; `current`: the icon it shows; `name`: what it's called; `at`: { left, top }
  // in this page, where the card's top left goes.
  function open({ docId, current, name, at }) {
    target = docId;
    title.textContent = name ? `Icon for “${name}”` : 'Icon';
    grid.replaceChildren(...ICONS.map((icon) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `icon-picker-option${icon.name === current ? ' chosen' : ''}`;
      button.innerHTML = iconSvg(icon.name, 18);
      button.title = icon.label;
      button.setAttribute('aria-label', icon.label);
      button.addEventListener('click', () => {
        const id = target;
        close();
        api.setIcon?.(id, icon.name);
      });
      return button;
    }));
    card.hidden = false;
    const { width, height } = card.getBoundingClientRect();
    card.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, at.left))}px`;
    card.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, at.top))}px`;
    card.querySelector('.chosen, button')?.focus();
  }
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !card.hidden) close();
  });
  addEventListener('pointerdown', (event) => {
    if (!card.hidden && !card.contains(event.target)) close();
  }, true);
  return { open, close };
}
