import { changedSpans, normalizeAd } from '../main/ad-model.js';
import { createAdPlayer } from './ad-player.js';
import './ad-player.css';

// The ad, in its tab: drawn on the stage (#ad-stage) at one of its sizes, scaled to fit, with its
// player and timeline in the strip under it (#ad-timeline; hidden for a still ad), and the sizes it's
// made in to choose from at the toolbar's end (#ad-sizes). The timeline is for pointing, not editing
// (the user's choice: the AI makes every change): play, scrub and step, and, for a proposal, the
// spans it changes marked on each layer's row against the draft it's based on (green added, red
// removed, amber changed: changedSpans in ad-model.js). ads.js calls showAd only when what's showing
// changes (another draft, or the proposal revised), not each time the tab is drawn again, so the
// player keeps its place.
//
// `content` is the ad as kept. Then what it is: `draft`, the draft showing (see store.get), or
// `proposal`, the proposal showing (see store.getProposal), whose changes are marked; the other null.
// `getAd(adId, draftId)` reads the draft a proposal is based on.

const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

let player = null;
let sizesCard = null;
const sizeOf = new Map(); // ad id → the size last chosen for it (while the app is open)
let showing = 0; // the latest showAd call: an older one finishing late does nothing

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key === 'className' ? 'class' : key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

const sizeName = (size) => (size.name ? `${size.name}` : `${size.width}×${size.height}`);
const dims = (size) => `${size.width}×${size.height}`;

// The sizes' card, under the size button, as the drafts' card is under theirs: each size the ad is
// made in, its name and pixels, the one showing checked.
function openSizes(ad, current, button, choose) {
  if (!sizesCard) {
    sizesCard = h('div', { className: 'tool-card size-card', role: 'menu', 'aria-label': 'Sizes' });
    sizesCard.hidden = true;
    document.body.append(sizesCard);
    document.addEventListener('pointerdown', (event) => {
      if (!sizesCard.hidden && !sizesCard.contains(event.target) && !event.target.closest?.('.size-button')) closeSizes();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !sizesCard.hidden) closeSizes();
    });
  }
  if (!sizesCard.hidden) return closeSizes();
  const at = button.getBoundingClientRect();
  sizesCard.replaceChildren(...ad.sizes.map((size) => h('button', {
    className: 'tool-option size-option', type: 'button', role: 'menuitemradio', 'aria-checked': String(size.id === current),
    onclick: () => {
      closeSizes();
      if (size.id !== current) choose(size.id);
    },
  }, h('span', { className: 'tool-option-text' }, h('strong', {}, sizeName(size)), h('span', {}, `${dims(size)}${size.kind === 'social' ? ' · social' : size.kind === 'display' ? ' · display' : ''}`)))));
  sizesCard.hidden = false;
  sizesCard.style.left = `${Math.max(8, Math.min(innerWidth - sizesCard.offsetWidth - 8, at.right - sizesCard.offsetWidth))}px`;
  button.setAttribute('aria-expanded', 'true');
}
function closeSizes() {
  if (!sizesCard) return;
  sizesCard.hidden = true;
  document.querySelector('.size-button')?.setAttribute('aria-expanded', 'false');
}

// The size button: the size showing, opening the card (only with more than one size).
function sizeButton(ad, current, choose) {
  const holder = document.getElementById('ad-sizes');
  if (!holder) return;
  const size = ad.sizes.find((s) => s.id === current) ?? ad.sizes[0];
  const button = h('button', { className: 'tool-button size-button', type: 'button', 'aria-haspopup': ad.sizes.length > 1 ? 'menu' : null, 'aria-expanded': 'false', title: `${sizeName(size)}, ${dims(size)}${ad.sizes.length > 1 ? `. The ad is made in ${ad.sizes.length} sizes: choose one to see it.` : ''}` },
    h('span', { className: 'size-label' }, sizeName(size)), h('span', { className: 'size-dims' }, dims(size)));
  if (ad.sizes.length > 1) {
    button.insertAdjacentHTML('beforeend', CHEVRON);
    button.addEventListener('click', () => openSizes(ad, current, button, choose));
  } else button.disabled = true;
  holder.replaceChildren(button);
}

export async function showAd(content, { draft = null, proposal = null, getAd = null } = {}) {
  const stage = document.getElementById('ad-stage');
  const timeline = document.getElementById('ad-timeline');
  if (!stage || !timeline) return;
  const call = ++showing;
  closeSizes();
  let ad;
  try {
    ad = normalizeAd(content);
  } catch (error) {
    // (Only a proposal the app accepted is kept, so this would be an ad from an older format.)
    player?.pause();
    stage.replaceChildren(h('p', { className: 'ad-unreadable' }, `This ad can’t be drawn: ${error.message}`));
    timeline.hidden = true;
    document.getElementById('ad-sizes')?.replaceChildren();
    player = null;
    return;
  }
  if (!player || !stage.contains(player.renderer.element)) {
    stage.replaceChildren();
    player = createAdPlayer({ stageEl: stage, timelineEl: timeline });
  }
  const adId = proposal?.id ?? draft?.id ?? null;
  const show = (sizeId) => {
    if (adId) sizeOf.set(adId, sizeId);
    player.load(ad, sizeId);
    sizeButton(ad, player.sizeId, show);
  };
  // A proposal's changes, marked against the draft it's based on (a new ad's has none to mark).
  let marks = [];
  if (proposal?.basedOn && getAd) {
    const base = await getAd(proposal.id, proposal.basedOn).catch(() => null);
    if (call !== showing) return;
    try {
      if (base) marks = changedSpans(normalizeAd(base.content), ad);
    } catch {}
  }
  const wanted = sizeOf.get(adId);
  player.load(ad, ad.sizes.some((s) => s.id === wanted) ? wanted : ad.sizes[0].id, { marks });
  sizeButton(ad, player.sizeId, show);
}
