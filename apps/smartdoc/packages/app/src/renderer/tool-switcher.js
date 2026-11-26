// The tool switcher, at the left of the top bar: it names the active tool, and clicking it opens a
// card listing both tools, each a card of its own, the active one highlighted. The active tool
// lives in the main process, where the AI can switch it too (switch_tool, start_review); the
// window just shows it.

// Each tool has its own icon and colour, used wherever it's named (here, on the home screen's
// cards and on the bar under the pages), so it's always clear which kind of review is showing.
const icon = (paths) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const TOOLS = [
  {
    id: 'improve', label: 'Review and draft', color: '#2f6fde',
    icon: icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    description: 'Your AI suggests changes for you to accept or reject, then writes the next draft from your decisions.',
  },
  {
    id: 'highlights', label: 'Review and highlight', color: '#b45309',
    icon: icon('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
    description: 'Your AI picks out the key information for what you’re looking for, including anything the document doesn’t say.',
  },
];
export const toolOf = (id) => TOOLS.find((t) => t.id === id) ?? TOOLS[0];

export function createToolSwitcher({ button, label, card, api }) {
  let tool = 'improve';

  function render() {
    const active = toolOf(tool);
    label.innerHTML = active.icon;
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = active.label;
    label.append(name);
    // The name can be hidden when the top bar is short of room, leaving the icon.
    button.title = active.label;
    // The active tool's colour, for everything that names it.
    document.body.dataset.tool = tool;
    document.documentElement.style.setProperty('--tool-color', active.color);
    card.replaceChildren();
    for (const t of TOOLS) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'tool-option';
      option.style.setProperty('--option-color', t.color);
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(t.id === tool));
      const text = document.createElement('span');
      text.className = 'tool-option-text';
      const name = document.createElement('strong');
      name.textContent = t.label;
      const description = document.createElement('span');
      description.textContent = t.description;
      text.append(name, description);
      const mark = document.createElement('span');
      mark.className = 'tool-option-icon';
      mark.innerHTML = t.icon;
      option.append(mark, text);
      option.addEventListener('click', () => {
        setOpen(false);
        if (t.id !== tool) api.setTool(t.id);
      });
      card.append(option);
    }
  }

  function setOpen(open) {
    card.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  button.addEventListener('click', () => setOpen(card.hidden));
  // Clicking anywhere else, or Escape, closes the card.
  document.addEventListener('pointerdown', (e) => {
    if (!card.hidden && !card.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !card.hidden) {
      setOpen(false);
      button.focus();
    }
  });

  render();
  return {
    update(next) {
      tool = next;
      render();
    },
    close: () => setOpen(false),
  };
}
