// The development preview of the ad model, renderer and player (ad-preview.html). Not part of the
// app.

import { checkAd, normalizeAd, summarize } from '../main/ad-model.js';
import { createAdRenderer } from './ad-render.js';
import { createAdPlayer } from './ad-player.js';
import { SAMPLES, SAMPLE_MARKS, sampleAssetUrl } from './ad-samples.js';

const params = new URLSearchParams(location.search);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');

const stage = document.getElementById('stage');
const timeline = document.getElementById('timeline');
const renderer = createAdRenderer(stage, { assetUrl: sampleAssetUrl });
const player = createAdPlayer({ stageEl: stage, timelineEl: timeline, renderer });

let which = SAMPLES[params.get('ad')] ? params.get('ad') : 'animated';
let size = params.get('size');

function load() {
  const ad = normalizeAd(SAMPLES[which]);
  if (!ad.sizes.some((s) => s.id === size)) size = ad.sizes[0].id;
  player.load(ad, size, { marks: which === 'animated' && params.get('marks') !== '0' ? SAMPLE_MARKS : [] });
  document.getElementById('summary').textContent = summarize(ad);
  const warnings = checkAd(ad, { measure: renderer.measure });
  document.getElementById('checks').textContent = warnings.length ? warnings.map((w) => w.message).join('\n') : 'Nothing to warn about.';
  buttons('ads', Object.keys(SAMPLES), which, (id) => { which = id; load(); });
  buttons('sizes', ad.sizes.map((s) => s.id), size, (id) => { size = id; load(); });
}

function buttons(id, values, current, choose) {
  const group = document.getElementById(id);
  group.replaceChildren(...values.map((value) => {
    const button = document.createElement('button');
    button.textContent = value;
    button.setAttribute('aria-pressed', String(value === current));
    button.addEventListener('click', () => choose(value));
    return button;
  }));
}

player.onPoint((p) => {
  document.getElementById('pointed').textContent = `Pointed at ${p.from !== undefined ? `${p.from}–${p.to} s` : `${p.t} s`}${p.layer ? ` on ${p.layer}` : ''}`;
});
player.onMark((m) => {
  document.getElementById('pointed').textContent = `Comment ${m.state} at ${m.t ?? `${m.from}–${m.to}`} s`;
});

load();
if (params.has('t')) player.seek(Number(params.get('t')));
if (params.get('play') === '1') player.play();
window.player = player;
