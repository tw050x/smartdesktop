// The mode switcher, in the top bar's breadcrumb: it names the mode, and clicking it opens a card
// listing the modes, each a card of its own, the active one highlighted. The choice is remembered on
// this computer, as a convenience.

const icon = (paths) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
export const MODES = [
  {
    id: 'design', label: 'Design', color: '#2f6fde',
    icon: icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    description: 'The schema’s contract, documents, diagrams and tables, and how they link together.',
  },
  {
    id: 'test', label: 'Test', color: '#b45309',
    icon: icon('<path d="M9 2h6"/><path d="M10 2v7l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V2"/><path d="M7.5 15h9"/>'),
    description: 'What’s implemented and tested, and what’s passing or failing against the contract.',
  },
];
const STORED = 'mode';

function remembered() {
  try {
    return localStorage.getItem(STORED);
  } catch {
    return null;
  }
}

export function createModeSwitcher({ card, onChange }) {
  let mode = MODES.find((one) => one.id === remembered())?.id ?? 'design';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-button';
  button.id = 'mode-button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', card.id);

  const setOpen = (open) => {
    card.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  function draw() {
    const active = MODES.find((one) => one.id === mode);
    document.documentElement.style.setProperty('--tool-color', active.color);
    button.title = active.label;
    button.innerHTML = `<span class="tool-label">${active.icon}<span class="tool-name">${active.label}</span></span>${CHEVRON}`;
    card.replaceChildren(...MODES.map((one) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'tool-option';
      option.dataset.mode = one.id;
      option.style.setProperty('--option-color', one.color);
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(one.id === mode));
      option.innerHTML = `<span class="tool-option-icon">${one.icon}</span><span class="tool-option-text"><strong>${one.label}</strong><span>${one.description}</span></span>`;
      option.addEventListener('click', () => {
        setOpen(false);
        if (one.id === mode) return;
        mode = one.id;
        try {
          localStorage.setItem(STORED, mode);
        } catch {}
        draw();
        onChange(mode);
      });
      return option;
    }));
  }

  button.addEventListener('click', () => setOpen(card.hidden));
  // Clicking anywhere else, or Escape, closes the card.
  document.addEventListener('pointerdown', (event) => {
    if (!card.hidden && !card.contains(event.target) && !button.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !card.hidden) {
      setOpen(false);
      button.focus();
    }
  });
  draw();
  return { button, mode: () => mode, close: () => setOpen(false) };
}
