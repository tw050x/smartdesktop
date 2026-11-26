import { iconSvg } from '../main/icons.js';
import { showAd } from './ad-view.js';
import { createDraftPicker } from './draft-picker.js';
import { rubberBand } from './rubber-band.js';

// The tab's content: home (the user's ads, in one column), or one ad, at a draft or the proposal
// waiting on it. The main process owns the ads; this asks for what it shows, again whenever they
// change. The ad itself is drawn by ad-view.js, in the stage; this draws everything round it: the
// toolbar's drafts, and the bottom bar.

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key === 'className' ? 'class' : key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}
const pill = (text, kind = '') => h('span', { className: `pill ${kind}` }, text);
// Status pills come from the app, for what needs the user's attention: here, a proposal waiting
// for them to review. They sit on the title row if they all fit, else beneath it.
const REVIEW = () => pill('Review', 'proposed');
const statusPills = (...pills) => (pills.some(Boolean) ? h('span', { className: 'status-pills' }, ...pills) : null);

// `onShown({ chatId, name, line })` hears where the tab is, for the chat (see app-shell.js), with
// the chat's line of context for going there: home ('home', name null), or an ad: a draft
// (`<ad>/<draft>`), the proposal waiting on it (`<ad>/proposal`) or a new ad's first proposal
// (`<ad>/new`). `onCards(cards, shortcuts)` hears what there is to decide about what it shows
// (drawn in the bottom bar: see showBar) and what to ask the AI about it, as the chat's shortcuts;
// `onNote(note)` gives the chat a line of context for the AI, about what the user did; and
// `onChooseIcon(request)` opens the icon picker for an ad.
export function createAds({ el, adView, bottomBar, draftNav, api, onShown = () => {}, onCards = () => {}, onNote = () => {}, onChooseIcon = () => {} }) {
  // What the tab shows: null for home, else { adId, draftId (null for the latest), proposal, name }.
  let here = null;
  let rendering = 0;
  let naming = null; // the ad being renamed on home
  let homeShowing = false; // home's column rises in only as it arrives, not each time it's drawn again
  let aiWaiting = []; // the proposals an AI in another app is waiting on (`smartad wait`)
  let showingKey = null; // what the stage shows, so it's drawn again only when that changes

  // Which tab this is (see main.js): Home, the only one showing home, which opens an ad in a tab of
  // its own; or an ad's, which never shows home (going home shows the Home tab).
  const inHome = api.tabKind === 'home';
  const inTab = api.tabKind === 'document';
  let hadAd = false; // an ad's tab has shown its ad (and closes once it's gone)

  const drafts = createDraftPicker({
    listDrafts: (id) => api.listDrafts(id),
    onChoose: ({ proposal = false, draftId = null }) => {
      if (!here) return;
      here = { ...here, proposal, draftId };
      remember();
      render();
    },
  });

  // Back and forward: where this tab has been, as a browser keeps it: each stop is the draft or
  // proposal showing. Choosing somewhere new drops what was ahead. The buttons are in the window's
  // top bar (tab-strip.js), which asks this tab to go back or forward (`onHistoryStep`) and is told
  // when it can (`historyState`).
  const HISTORY_LIMIT = 200;
  const stop = () => JSON.stringify(here && { adId: here.adId, draftId: here.draftId, proposal: here.proposal, name: here.name });
  // (An ad's tab starts with nothing: its first stop is its ad, never home.)
  let visited = inTab ? [] : [stop()];
  let visiting = visited.length - 1;
  let historyShown = null;
  const showHistory = () => {
    const state = { back: visiting > 0, forward: visiting < visited.length - 1 };
    if (JSON.stringify(state) === historyShown) return;
    historyShown = JSON.stringify(state);
    api.historyState?.(state);
  };
  function remember() {
    const now = stop();
    if (visited[visiting] === now) return;
    visited = [...visited.slice(0, visiting + 1), now].slice(-HISTORY_LIMIT);
    visiting = visited.length - 1;
    showHistory();
  }
  function travel(delta) {
    const next = visiting + delta;
    if (next < 0 || next >= visited.length) return;
    visiting = next;
    here = JSON.parse(visited[next]);
    showHistory();
    drafts.close();
    render();
  }
  api.onHistoryStep?.((delta) => travel(delta));
  showHistory();
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.key === '[') travel(-1);
    else if (event.key === ']') travel(1);
  });

  // Shows an ad: from Home, in a tab of its own (the one already showing it, unless `newTab`);
  // in an ad's tab, here.
  function open(next, { newTab = false } = {}) {
    if (inHome) {
      api.openInTab({ ...next, newTab });
      return;
    }
    here = { adId: next.adId, draftId: next.draftId ?? null, proposal: Boolean(next.proposal), name: next.name ?? '' };
    remember();
    render();
  }

  async function render() {
    const ticket = ++rendering;
    const view = here ? await adPage(here) : inTab ? waitingView() : await homeView();
    if (ticket !== rendering) return;
    // Home's list keeps its place when it's drawn again.
    const listTop = el.querySelector('.browser-list')?.scrollTop ?? 0;
    const focused = document.activeElement?.dataset?.ad && `[data-ad="${CSS.escape(document.activeElement.dataset.ad)}"]`;
    const showingAd = Boolean(here && view.shown);
    document.body.classList.toggle('has-ad', showingAd);
    adView.hidden = !showingAd;
    el.hidden = showingAd;
    if (!showingAd) {
      // Home arriving (at launch): its column rises in, as SmartDoc's and SmartSpec's do.
      if (!homeShowing && !inTab) view.classList.add('arriving');
      homeShowing = !inTab;
      el.replaceChildren(view);
      const list = el.querySelector('.browser-list');
      if (list) {
        list.scrollTop = listTop;
        if (!list.dataset.banded) {
          rubberBand(list);
          list.dataset.banded = '1';
        }
      }
      if (focused) el.querySelector(focused)?.focus({ preventScroll: true });
    } else {
      homeShowing = false;
      // The ad itself, drawn again only when what's showing changes.
      const key = view.stageKey;
      if (key !== showingKey) {
        showingKey = key;
        showAd(view.shown.content, here.proposal ? { proposal: view.shown, getAd: (adId, draftId) => api.getAd(adId, draftId) } : { draft: view.shown });
      }
    }
    if (!showingAd) showingKey = null;
    draftNav.replaceChildren(...(view.draftNav ?? []));
    draftNav.hidden = !view.draftNav;
    showBar(view.bottomBar);
    onCards(view.bottomBar?.cards ?? [], view.bottomBar?.shortcuts ?? []);
  }

  // An ad's tab with no ad yet (an AI's, opening one): nothing, under the line saying so
  // (#tab-waiting).
  const waitingView = () => h('div', { className: 'tab-waiting-view' });

  // --- Home ---------------------------------------------------------------------------------

  // Home: the user's ads, one column, most recently changed first (the user's choice for now:
  // home screens are to be redesigned across the family). Each row is the ad's icon and name, when
  // it last changed, and Review while a proposal waits on it. Clicking one opens it in its tab;
  // its right-click menu opens it in a new tab, renames it, changes its icon or deletes it.
  async function homeView() {
    onShown({ chatId: 'home', name: null, line: { text: 'Went home', detail: 'The window shows SmartAd\'s home.' } });
    const ads = await api.listAds();
    if (naming && !ads.some((ad) => ad.id === naming)) naming = null;
    const rows = ads.map((ad) => (naming === ad.id ? namingRow(ad) : adRow(ad)));
    return h('div', { className: 'browser home-ads' }, column('Ads', rows));
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // An ad with no draft yet opens on its proposal; else on its latest draft, which says when a
  // proposal is waiting.
  const openTarget = (ad) => ({ adId: ad.id, name: ad.name, draftId: null, proposal: !ad.drafts && Boolean(ad.proposal) });

  function adRow(ad) {
    const mark = h('span', { className: 'home-doc-icon', 'aria-hidden': 'true' });
    mark.innerHTML = iconSvg(ad.icon, 15);
    const drafted = ad.drafts === 1 ? '1 draft' : ad.drafts ? `${ad.drafts} drafts` : 'No draft yet';
    const button = h('button', { className: 'browser-row', type: 'button', 'data-ad': ad.id, title: ad.name, onclick: () => open(openTarget(ad)) },
      h('span', { className: 'title-row' }, h('strong', {}, mark, ad.name), statusPills(ad.proposal && REVIEW())),
      h('span', { className: 'browser-row-text' }, ad.proposal?.note ?? drafted),
      h('span', { className: 'browser-row-meta' }, `${drafted} · ${when(ad.updatedAt)}`));
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      const box = button.getBoundingClientRect();
      const chosen = await api.showHomeMenu([
        { id: 'open', label: 'Open in New Tab' },
        { separator: true },
        { id: 'rename', label: 'Rename…' },
        { id: 'icon', label: 'Change Icon…' },
        { separator: true },
        { id: 'delete', label: 'Delete Ad…' },
      ]);
      if (chosen === 'open') open(openTarget(ad), { newTab: true });
      else if (chosen === 'rename') {
        naming = ad.id;
        render();
      } else if (chosen === 'icon') onChooseIcon({ docId: ad.id, current: ad.icon, name: ad.name, at: { left: box.left + 24, top: box.bottom + 4 } });
      else if (chosen === 'delete' && await api.deleteAd(ad.id)) render();
    });
    return button;
  }

  // An ad's name being written over its row. Enter or leaving it saves, Escape doesn't, and a name
  // that's refused says why, keeping what was typed.
  function namingRow(ad) {
    const field = h('input', { className: 'name-input', type: 'text', value: ad.name, 'aria-label': 'Ad name', maxlength: '200' });
    const said = h('span', { className: 'name-error', role: 'alert' });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      const named = field.value.trim();
      done = true;
      if (!save || !named || named === ad.name) {
        naming = null;
        return render();
      }
      try {
        await api.renameAd(ad.id, named);
        onNote({ text: `Renamed “${ad.name}” to “${named}”`, detail: `Renamed the ad “${ad.name}” (ad_id ${ad.id}) to “${named}”` });
        naming = null;
        render();
      } catch (error) {
        done = false;
        said.textContent = String(error.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        field.focus();
      }
    };
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    field.addEventListener('blur', () => setTimeout(() => document.activeElement !== field && finish(true)));
    setTimeout(() => {
      field.focus();
      field.select();
    });
    return h('div', { className: 'naming' }, field, said);
  }

  // A column of rows. With none, it shows placeholder rows instead, fading out, with no text and no
  // buttons, as the family's homes do: each placeholder is a row's line widths, in percent (an ad's
  // name, then its line).
  const SKELETON = [[44, 82, 30], [58, 70, 26], [36, 88, 32]];
  function column(title, rows) {
    const placeholder = (widths) => h('div', { className: 'browser-row' }, ...widths.map((width) => h('span', { className: 'skeleton-bar', style: `width: ${width}%` })));
    return h('section', { className: `browser-column${rows.length ? '' : ' browser-column-unused'}`, 'aria-label': title },
      h('div', { className: 'browser-head' }, h('h2', {}, title)),
      rows.length
        ? h('ul', { className: 'browser-list' }, ...rows.map((one) => h('li', {}, one)))
        : h('div', { className: 'browser-list browser-skeleton', 'aria-hidden': 'true' }, ...SKELETON.map(placeholder)));
  }

  // A new ad: what it's for, and a prompt asking the AI to design it, from the File menu.
  function newAd() {
    if (document.querySelector('.prompt-dialog')) return;
    const field = h('textarea', { className: 'prompt-input', id: 'new-ad-goal', rows: 3, 'aria-label': 'What the ad is for', placeholder: 'What should your AI design? For example: a banner for our spring sale, in every display size' });
    const copy = h('button', { className: 'primary-button', type: 'button', id: 'new-ad-copy' }, 'Copy the prompt');
    let reset;
    copy.addEventListener('click', async () => {
      await api.copyText([
        field.value.trim() ? `Design a new ad in SmartAd: ${field.value.trim()}` : 'Ask me what the ad is for, then propose a new ad in SmartAd.',
        api.windowId && `Take over SmartAd window ${api.windowId} with use_window first.`,
      ].filter(Boolean).join(' '));
      copy.textContent = 'Copied';
      clearTimeout(reset);
      reset = setTimeout(() => { copy.textContent = 'Copy the prompt'; }, 1500);
    });
    const dialog = h('dialog', { className: 'prompt-dialog', 'aria-labelledby': 'prompt-title' },
      h('h2', { id: 'prompt-title' }, 'New ad'),
      h('p', {}, 'Your AI designs it, and you accept it here.'),
      field,
      h('div', { className: 'prompt-buttons' },
        h('button', { className: 'secondary-button', type: 'button', id: 'new-ad-close', onclick: () => dialog.close() }, 'Close'),
        copy));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    field.focus();
  }

  // --- One ad -------------------------------------------------------------------------------

  // An ad's page: its draft or proposal (the stage, timeline and sizes are ad-view.js's), its
  // drafts in the toolbar and its bottom bar. Refreshes overlap (a change arrives as the user's
  // answer returns), so each works out for itself what to show: a proposal that has gone means the
  // draft it became, or the one it was set against.
  async function adPage(at) {
    let shown = null;
    if (at.proposal) {
      shown = await api.getProposal(at.adId).catch(() => null);
      if (!shown) {
        at.proposal = false;
        at.draftId = null;
      }
    }
    if (!shown) shown = await api.getAd(at.adId, at.draftId).catch(() => null);
    // A new ad has only its proposal.
    if (!shown && !at.draftId) {
      shown = await api.getProposal(at.adId).catch(() => null);
      if (shown) at.proposal = true;
    }
    if (!shown) {
      // It's gone (discarded, or deleted): an ad's tab with nothing left in it closes.
      if (inTab && hadAd) api.tabClose();
      here = null;
      return inTab ? waitingView() : homeView();
    }
    hadAd = true;
    at.name = shown.name;
    const isNew = at.proposal && !shown.total;
    const opened = at.proposal ? (isNew ? `Reviewing the new ad “${shown.name}”` : `Reviewing the proposed changes to “${shown.name}”`) : `Opened “${shown.name}”, draft ${shown.number} of ${shown.total}`;
    onShown({ chatId: `${at.adId}/${at.proposal ? (isNew ? 'new' : 'proposal') : shown.draftId}`, name: shown.name, line: { text: opened, detail: `${opened} (ad_id ${at.adId})` } });
    return {
      shown,
      stageKey: at.proposal ? `${at.adId}/proposal/${shown.proposalId}/${shown.updatedAt}` : `${at.adId}/${shown.draftId}`,
      draftNav: [drafts.button(at, shown)],
      bottomBar: reviewBar(at, shown),
    };
  }

  // The bottom bar is the actions bar: what there is to decide about the view (a card), what it is
  // and a line on what's happening now and what deciding does, on the left, with its buttons on the
  // right; with nothing to decide, its sentence on what's going on. It explains, and no more: what's
  // in the proposal, and the AI's note on it, are for the stage and the chat (the family's rule).
  const reviewLine = (said) => h('p', { className: 'review-bar-text', title: said }, said);
  function showBar(view) {
    bottomBar.hidden = !view;
    if (!view) return bottomBar.replaceChildren();
    const card = view.cards?.[0];
    if (!card) return bottomBar.replaceChildren(reviewLine(view.said));
    const line = [...(card.lines ?? []), card.decide].filter(Boolean).join(' ');
    bottomBar.replaceChildren(
      h('div', { className: 'review-bar-card' },
        h('div', { className: 'review-bar-title' }, card.title),
        line && h('div', { className: 'review-bar-line', title: line }, line),
      ),
      h('div', { className: 'review-bar-actions' }, ...(card.actions ?? []).map((action) => h('button', {
        className: action.kind === 'primary' ? 'primary-button' : 'secondary-button',
        type: 'button',
        'data-action': action.id,
        title: action.title ?? null,
        onclick: () => action.run?.(),
      }, action.label))));
  }
  const bar = (said, card = null, shortcuts = []) => ({ said, cards: card ? [card] : [], shortcuts: shortcuts.filter(Boolean) });

  // What the bar says, in the first of these that applies: a proposal under review (Discard,
  // Accept); a proposal waiting on the ad (Review); an earlier draft (Go to the latest); else what
  // the user is doing.
  function reviewBar(at, shown) {
    const name = shown.name;
    if (at.proposal) {
      const isNew = !shown.total;
      const aiWaits = aiWaiting.includes(shown.proposalId);
      return bar(isNew ? `You're reviewing ${name}, a new ad the AI has proposed.` : `You're reviewing changes the AI has proposed to ${name}.`, {
        id: `proposal-${shown.proposalId}`,
        at: shown.updatedAt ?? null,
        title: isNew ? `New ad: ${name}` : `Proposed changes to ${name}`,
        lines: [aiWaits ? 'Your AI is waiting for your answer.' : null].filter(Boolean),
        decide: isNew ? 'Accept to make it an ad, or discard it.' : `Accept to make it draft ${shown.total + 1} of ${name}, or discard it.`,
        actions: [
          { id: 'proposal-discard', label: 'Discard', run: () => answer(async () => {
            await api.discardProposal(at.adId);
            // The chat stays the draft's, so it knows what became of the proposal.
            onNote({ text: `Discarded the proposed ${isNew ? 'new ad' : 'changes to'} ${name}`, detail: `Discarded the proposed ${isNew ? 'new ad' : 'changes to'} ${name} (ad_id ${at.adId})` });
          }) },
          { id: 'proposal-accept', label: 'Accept', kind: 'primary', run: () => answer(async () => {
            if (await api.acceptProposal(at.adId) === 'accepted') onNote({ text: `Accepted ${isNew ? name : `the changes to ${name}`}`, detail: `Accepted the proposed ${isNew ? 'new ad' : 'changes to'} ${name} (ad_id ${at.adId}), as draft ${shown.total + 1}` });
          }) },
        ],
      });
    }
    if (shown.proposal) {
      return bar(`The AI has proposed changes to ${name} for you to review.`, {
        id: `proposal-${shown.proposal.id}`,
        at: shown.proposal.createdAt ?? null,
        title: `Proposed changes to ${name}`,
        decide: 'Review them to accept or discard them.',
        actions: [{ id: 'view-proposal', label: 'Review', kind: 'primary', run: () => { here = { ...at, proposal: true, draftId: null }; remember(); render(); } }],
      });
    }
    if (shown.number < shown.total) {
      return bar(`You're looking at draft ${shown.number} of ${name}. Draft ${shown.total} is the latest.`, {
        id: `earlier-${shown.draftId}`,
        at: null,
        title: `Draft ${shown.number} of ${shown.total}`,
        decide: `This is an earlier draft of ${name}. Draft ${shown.total} is the latest.`,
        actions: [{ id: 'latest-draft', label: 'Go to the latest', run: () => { here = { ...at, draftId: null }; remember(); render(); } }],
      });
    }
    return bar(`You're working on ${name}. Ask your AI in the chat for what you'd like changed.`);
  }

  // The answer can be refused, or asked about first: either way the tab then shows what's so.
  async function answer(act) {
    try {
      await act();
    } finally {
      render();
    }
  }

  api.onAdsChanged(render);
  // While an AI in another app waits on a proposal, the bar says so.
  const heardWaiting = (list) => {
    aiWaiting = list ?? [];
    if (here) render();
  };
  api.aiWaiting?.().then(heardWaiting, () => {});
  api.onAiWaiting?.(heardWaiting);
  api.onNewAd(newAd);
  // An ad opened from Home, or an AI's proposal, in this tab (see main.js's openInTab).
  api.onOpenAd?.((request) => {
    if (!request?.adId) return;
    if (inHome) return open(request);
    here = { adId: request.adId, draftId: request.draftId ?? null, proposal: Boolean(request.proposal), name: request.name ?? '' };
    remember();
    render();
  });
  render();
}
