// The drafts, in an ad's toolbar just after its start, as SmartDoc's and SmartSpec's: a button
// naming the draft showing (or the next draft's preview, for a proposal), opening a card of the
// ad's drafts, newest first, each with when it was made and its note, the proposal waiting on it
// first as the next draft's preview, the one showing marked. Choosing one shows it. It replaced
// Previous and Next buttons either side of the name (the user's choice, in both apps).

const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CARD_WIDTH = 320;

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key === 'className' ? 'class' : key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// `listDrafts(adId)` gives an ad's drafts, newest first (see store.listDrafts). `onChoose` hears the
// choice: { proposal: true } for the proposal, or { draftId } (null for the latest, so the tab
// follows the ad as it changes).
export function createDraftPicker({ listDrafts, onChoose }) {
  const card = Object.assign(document.createElement('div'), { className: 'tool-card draft-card', id: 'draft-card', hidden: true });
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', 'Drafts');
  document.body.append(card);
  let button = null;

  function close() {
    card.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }

  // `here`: what the tab shows ({ adId, proposal }); `shown`: the draft (number, total, draftId,
  // note, proposal) or the proposal (total, note, createdAt) showing.
  async function open(here, shown, from) {
    if (!card.hidden) return close();
    const at = from.getBoundingClientRect();
    card.style.left = `${Math.max(8, Math.min(innerWidth - CARD_WIDTH - 8, at.left))}px`;
    card.replaceChildren(h('p', { className: 'draft-empty' }, 'Loading drafts…'));
    card.hidden = false;
    from.setAttribute('aria-expanded', 'true');
    const drafts = await listDrafts(here.adId).catch(() => []);
    if (card.hidden) return;
    const when = (date) => (date ? new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);
    const option = (name, about, checked, choose) => h('button', { className: 'tool-option draft-option', type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), onclick: () => { close(); if (!checked) choose(); } },
      h('span', { className: 'tool-option-text' }, h('strong', {}, name), about && h('span', { className: 'draft-about' }, about)));
    const waiting = here.proposal ? shown : shown.proposal;
    card.replaceChildren(
      waiting && option(`Draft ${shown.total + 1} preview`, [when(waiting.createdAt), 'Proposed by the AI, for you to review'].filter(Boolean).join(' · '), Boolean(here.proposal), () => onChoose({ proposal: true })),
      ...drafts.map((draft) => option(`Draft ${draft.number}`, [when(draft.createdAt), draft.note].filter(Boolean).join(' · '), !here.proposal && draft.id === shown.draftId,
        () => onChoose({ draftId: draft.latest ? null : draft.id }))),
    );
    if (!drafts.length && !waiting) card.append(h('p', { className: 'draft-empty' }, 'No drafts yet.'));
  }

  document.addEventListener('pointerdown', (event) => {
    if (!card.hidden && !card.contains(event.target) && !button?.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !card.hidden) close();
  });

  return {
    close,
    // The toolbar's button for what the tab shows.
    button(here, shown) {
      const label = here.proposal ? `Draft ${shown.total + 1} preview` : `Draft ${shown.number} of ${shown.total}`;
      const made = h('button', { className: 'tool-button draft-button', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: shown.note ?? null },
        h('span', { className: 'draft-label' }, label));
      made.insertAdjacentHTML('beforeend', CHEVRON);
      made.addEventListener('click', () => open(here, shown, made));
      button = made;
      close();
      return made;
    },
  };
}
