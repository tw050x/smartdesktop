// The draft picker, centred in the top bar: it names the draft showing, and clicking it opens a card
// below it listing the drafts of the variation showing, newest first, each with when it was made and
// the AI's summary of it, the one showing highlighted. Choosing one opens it. It replaced Previous
// and Next draft buttons either side of the name (the Go menu's Previous and Next Draft remain).

export function createDraftPicker({ button, card, api, getTool }) {
  let shown = null; // { doc, variation, draft }

  function setOpen(open) {
    card.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // Under the button, centred on it, inside the window.
    const at = button.getBoundingClientRect();
    const width = card.offsetWidth;
    card.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, at.left + at.width / 2 - width / 2))}px`;
    fill();
  }

  async function fill() {
    if (!shown) return;
    const { doc, variation, draft } = shown;
    card.replaceChildren(note('Loading drafts…'));
    let drafts = [];
    try {
      const tree = await api.variationsOf(doc.id);
      drafts = tree?.variations.find((v) => v.id === variation.id)?.drafts ?? [];
    } catch {}
    if (card.hidden || shown?.draft !== draft) return;
    card.replaceChildren();
    if (!variation.isOriginal) card.append(heading(variation.name));
    if (!drafts.length) card.append(note('No drafts to show.'));
    for (const d of drafts) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'tool-option draft-option';
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(d.id === draft.id && !draft.isPreview));
      const text = document.createElement('span');
      text.className = 'tool-option-text';
      const name = document.createElement('strong');
      name.textContent = d.label;
      text.append(name);
      const when = d.createdAt ? new Date(d.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
      const about = [when, d.summary].filter(Boolean).join(' · ');
      if (about) text.append(Object.assign(document.createElement('span'), { className: 'draft-about', textContent: about }));
      option.append(text);
      option.addEventListener('click', () => {
        setOpen(false);
        if (d.id !== draft.id || draft.isPreview) api.openDraft(doc.id, variation.id, d.id, getTool());
      });
      card.append(option);
    }
  }

  const heading = (text) => Object.assign(document.createElement('p'), { className: 'focus-heading', textContent: text });
  const note = (text) => Object.assign(document.createElement('p'), { className: 'focus-empty', textContent: text });

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

  return {
    update(next) {
      shown = next;
      if (!card.hidden) fill();
    },
    close: () => setOpen(false),
  };
}
