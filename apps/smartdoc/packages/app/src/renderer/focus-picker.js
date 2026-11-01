// The focus picker: the breadcrumb's last level names the focus showing in the active tool (what
// the review is for), and opens a card with everything about focuses, and the prompts to send:
//   - this draft's focuses, the one showing highlighted. In the highlight tool there's one
//     highlights review per goal, and choosing one shows it; in the draft tool, the draft's review
//     and, once everything in it is decided, the prompt to write the next draft
//   - earlier drafts' focuses not yet run on this draft, greyed, each with a prompt to run it
//     again (a new draft shows none of their reviews until then)
//   - a new focus: what you're looking for, and a prompt to send your AI (in the draft tool it can
//     be left empty, for a general review)
// The focuses come from the main process when the card opens (list-focuses). The card's contents
// (fillFocusCard) are the home screen's too, for starting a review on a draft from there.

export function createFocusPicker({ button, label, separator, card, api }) {
  let state = { doc: null, tool: 'improve', review: null };
  const drafting = () => state.tool === 'improve';

  function renderButton() {
    const visible = Boolean(state.doc);
    button.hidden = !visible;
    separator.hidden = !visible;
    const r = state.review && (state.review.type ?? 'improve') === state.tool ? state.review : null;
    label.textContent = r ? r.title ?? shorten(r.goal) ?? (drafting() ? 'General review' : 'Highlights') : 'No focus yet';
    button.title = r ? [r.title, r.goal].filter(Boolean).join(': ') : '';
    if (!visible) setOpen(false);
  }

  async function renderCard() {
    card.replaceChildren(el('p', 'focus-loading', 'Loading…'));
    let focuses;
    try {
      focuses = await api.listFocuses(state.tool);
    } catch {
      focuses = { current: [], earlier: [] };
    }
    fillFocusCard(card, {
      tool: state.tool,
      doc: state.doc,
      focuses,
      copyText: api.copyText,
      onChoose: async (f) => {
        setOpen(false);
        if (!f.showing) await api.setFocus(f.id);
      },
    });
  }

  function setOpen(open) {
    if (open) {
      // Under its button, left edges aligned.
      card.style.left = `${button.getBoundingClientRect().left}px`;
      renderCard();
    }
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

  renderButton();
  return {
    update(next) {
      state = { ...state, ...next };
      renderButton();
    },
  };
}

// Fills a focus card for a tool's focuses on a draft of a document ({ id, name }):
//   - with onChoose, the draft's own focuses ({ current }), each chosen with onChoose(focus)
//   - the earlier drafts' focuses ({ earlier }), each with a prompt to run it again
//   - a new focus, with its prompt
// Each prompt is copied with copyText, after onCopy (if given) has run.
export function fillFocusCard(card, { tool, doc, focuses, copyText, onChoose, onCopy }) {
  const drafting = tool === 'improve';
  card.replaceChildren();

  if (onChoose) {
    card.append(el('h2', 'focus-heading', 'On this draft'));
    if (!focuses.current.length) card.append(el('p', 'focus-empty', drafting ? 'No review of this draft yet.' : 'No focuses on this draft yet.'));
    for (const f of focuses.current) {
      const option = el('button', 'tool-option focus-option');
      option.type = 'button';
      option.setAttribute('aria-pressed', String(f.showing));
      const text = el('span', 'tool-option-text');
      text.append(el('strong', null, f.title));
      if (f.goal && f.goal !== f.title) text.append(el('span', 'focus-goal', f.goal));
      text.append(el('span', 'focus-meta', [progress(drafting, f), formatDate(f.createdAt)].join(' · ')));
      option.append(text);
      option.addEventListener('click', () => onChoose(f));
      card.append(option);
      // Everything decided: the next step is the AI writing the next draft.
      if (drafting && f.status === 'committed' && f.findings && f.decided === f.findings && !f.applied) {
        const next = el('div', 'focus-next');
        next.append(
          el('p', 'focus-next-text', `All ${f.decided} decided. Send your AI the prompt to write the next draft.`),
          copyButton('primary-button', 'Copy the prompt', () => `I’ve made my decisions in SmartDoc. Apply the review and write the next draft of ${named(doc)}.`),
        );
        card.append(next);
      }
    }
  }

  if (focuses.earlier.length) {
    card.append(el('h2', 'focus-heading', 'From earlier drafts'));
    for (const f of focuses.earlier) {
      const box = el('div', 'tool-option focus-option focus-earlier');
      const text = el('span', 'tool-option-text');
      text.append(el('strong', null, f.title));
      if (f.goal && f.goal !== f.title) text.append(el('span', 'focus-goal', f.goal));
      text.append(el('span', 'focus-meta', `From ${f.draft} · not run on this draft`));
      box.append(text, copyButton('secondary-button', 'Copy the prompt to run it again', () => prompt(f.goal, f.title)));
      card.append(box);
    }
  }

  card.append(el('h2', 'focus-heading', 'New focus'));
  const box = el('div', 'focus-new');
  const field = el('textarea', 'focus-goal-input');
  field.rows = 2;
  field.placeholder = drafting
    ? 'What should the review focus on? Leave empty for a general review. For example: fit it to 3 pages'
    : 'What are you looking for? For example: what an engineering manager role would look for';
  field.setAttribute('aria-label', drafting ? 'What the review should focus on' : 'What you’re looking for');
  const copy = copyButton('secondary-button', 'Copy the prompt', () => prompt(field.value.trim()));
  // A highlights review needs a goal; a review for the next draft can be a general one.
  const sync = () => (copy.disabled = !drafting && !field.value.trim());
  field.addEventListener('input', sync);
  sync();
  box.append(field, copy);
  card.append(box);

  // The prompt to send the AI: review this document for a goal (and, run again, keep its name).
  function prompt(goal, title) {
    const nameIt = title ? ` Call this focus “${title}”.` : '';
    if (drafting) return `Review ${named(doc)} in SmartDoc and suggest improvements${goal ? `, focusing on: ${goal}` : '.'}${nameIt}`;
    return `Go through ${named(doc)} in SmartDoc and highlight the key information for: ${goal}${nameIt}`;
  }

  function copyButton(kind, text, getPrompt) {
    const b = el('button', `${kind} focus-copy`, text);
    b.type = 'button';
    let reset;
    b.addEventListener('click', async () => {
      await onCopy?.();
      await copyText(getPrompt());
      b.textContent = 'Copied';
      clearTimeout(reset);
      reset = setTimeout(() => (b.textContent = text), 1500);
    });
    return b;
  }
}

function progress(drafting, f) {
  if (f.status !== 'committed') return 'AI still working';
  if (!drafting) return `${f.highlights} highlight${f.highlights === 1 ? '' : 's'}`;
  if (f.applied) return 'Next draft written';
  return `${f.findings} finding${f.findings === 1 ? '' : 's'} · ${f.decided} decided`;
}

const named = (doc) => (doc ? `“${doc.name}” (document ${doc.id})` : 'my document');
const shorten = (goal) => (goal && goal.length > 48 ? `${goal.slice(0, 47).trimEnd()}…` : goal);
const formatDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
