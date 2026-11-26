// The ad's player and timeline. The timeline is for pointing, not editing (the user's choice):
// the user plays, scrubs and steps through the ad, and points at a moment or a span (of the whole
// ad or of one layer) to comment on it, but nothing on it can be dragged except the playhead.
//
//   const player = createAdPlayer({ stageEl, timelineEl, renderer })
//   player.load(ad, sizeId, { marks })
//   player.onPoint(({ t } | { from, to }, with layer, clientX, clientY) => …)
//
// Pointing: ⌘-click (or Ctrl) on the ruler or a layer's row is a moment, ⌘-drag across it a span;
// a long press (half a second, held still, a ring growing meanwhile, as the family's comments are
// made) is a moment too. On a layer's row it's that layer's. ⌥-drag across the ruler sets a span
// to loop, ⌥-click clears it. A plain press or drag on the ruler or a row scrubs.
// Keys: Space plays and pauses, ← and → step a frame (30 fps; with Shift a second), Home and End.
// marks: comments { t | from, to, layer?, state: 'open' | 'answered' } as small markers (onMark
// fires when one is clicked), and a proposal's changes { from, to, layer, kind: 'added' |
// 'removed' | 'changed' } as tinted spans on the layers' rows. A still ad (duration 0) has no
// timeline: the strip hides.

import { layerAt, normalizeAd, seconds } from '../main/ad-model.js';
import { createAdRenderer } from './ad-render.js';

export const FPS = 30;
const HOLD_MS = 500;
const STILL = 4; // px the pointer may wander and still be held
const RING_AFTER = 120; // ms before the ring shows, so a click doesn't flash it

const icon = (body) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;
const ICONS = {
  play: icon('<path d="M5 3.2v9.6c0 .5.5.8.9.5l7.2-4.8a.6.6 0 0 0 0-1L5.9 2.7c-.4-.3-.9 0-.9.5z" fill="currentColor"/>'),
  pause: icon('<rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/>'),
  back: icon('<path d="M4 3.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12.5 4.2v7.6c0 .4-.5.7-.8.4L6.6 8.4a.5.5 0 0 1 0-.8l5.1-3.8c.3-.3.8 0 .8.4z" fill="currentColor"/>'),
  forward: icon('<path d="M12 3.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3.5 4.2v7.6c0 .4.5.7.8.4l5.1-3.8a.5.5 0 0 0 0-.8L4.3 3.8c-.3-.3-.8 0-.8.4z" fill="currentColor"/>'),
  loop: icon('<path d="M2.8 8V6.8A2.3 2.3 0 0 1 5.1 4.5h7.4M10.6 2.5l2 2-2 2M13.2 8v1.2a2.3 2.3 0 0 1-2.3 2.3H3.5M5.4 13.5l-2-2 2-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
};

const TEMPLATE = `
  <div class="adt-controls">
    <button class="adt-button adt-play" type="button" aria-label="Play">${ICONS.play}</button>
    <div class="adt-time" aria-live="off"><span class="adt-now">0.00 s</span><span class="adt-total"></span></div>
    <div class="adt-steps">
      <button class="adt-button adt-back" type="button" aria-label="Back a frame">${ICONS.back}</button>
      <button class="adt-button adt-forward" type="button" aria-label="Forward a frame">${ICONS.forward}</button>
      <button class="adt-button adt-loop" type="button" aria-label="Loop" aria-pressed="false">${ICONS.loop}</button>
    </div>
  </div>
  <div class="adt-main">
    <div class="adt-head"><div class="adt-corner"></div><div class="adt-ruler"><div class="adt-lane adt-ruler-lane"></div></div></div>
    <div class="adt-body"></div>
    <div class="adt-playhead"><div class="adt-knob" role="slider" tabindex="-1" aria-label="Time"></div></div>
  </div>`;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const el = (tag, className, parent) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.append(node);
  return node;
};

export function createAdPlayer({ stageEl, timelineEl, renderer, assetUrl, keys = true }) {
  renderer ??= createAdRenderer(stageEl, { assetUrl });
  timelineEl.classList.add('ad-timeline');
  timelineEl.innerHTML = TEMPLATE;
  const $ = (selector) => timelineEl.querySelector(selector);
  const playButton = $('.adt-play');
  const loopButton = $('.adt-loop');
  const now = $('.adt-now');
  const total = $('.adt-total');
  const main = $('.adt-main');
  const ruler = $('.adt-ruler-lane');
  const body = $('.adt-body');
  const knob = $('.adt-knob');

  let ad = null;
  let sizeId = null;
  let marks = [];
  let t = 0;
  let playing = false;
  let pass = 0; // which of the ad's loops is playing
  let looping = false;
  let span = null; // { from, to }: the span looped, if one is set
  let raf = 0;
  let last = 0;
  const listeners = { time: new Set(), point: new Set(), mark: new Set() };
  const emit = (kind, value) => { for (const cb of listeners[kind]) cb(value); };
  const subscribe = (kind) => (cb) => { listeners[kind].add(cb); return () => listeners[kind].delete(cb); };

  const duration = () => ad?.duration ?? 0;
  const still = () => !ad || ad.duration === 0;
  const at = (time) => (duration() ? time / duration() : 0);

  function setTime(time, { quiet = false } = {}) {
    t = clamp(time, 0, duration());
    renderer.seek(t);
    timelineEl.style.setProperty('--p', at(t).toFixed(5));
    now.textContent = `${t.toFixed(2)} s`;
    knob.setAttribute('aria-valuenow', t.toFixed(2));
    if (!quiet) emit('time', t);
  }

  function showPlaying() {
    playButton.innerHTML = playing ? ICONS.pause : ICONS.play;
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    timelineEl.classList.toggle('playing', playing);
  }

  function tick(stamp) {
    const dt = Math.min(0.25, (stamp - last) / 1000);
    last = stamp;
    let next = t + dt;
    const d = duration();
    if (looping && span) {
      if (next >= span.to) next = span.from + ((next - span.to) % (span.to - span.from));
    } else if (next >= d) {
      if (looping) next -= d;
      else if (pass + 1 < ad.loops) { pass++; next -= d; }
      else { setTime(d); pause(); return; }
    }
    setTime(next);
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (still() || playing) return;
    if (looping && span && (t < span.from || t >= span.to)) setTime(span.from);
    else if (t >= duration() - 1e-6) { pass = 0; setTime(0); }
    playing = true;
    showPlaying();
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    showPlaying();
  }

  const toggle = () => (playing ? pause() : play());

  function step(frames) {
    if (still()) return;
    pause();
    const frame = Math.round(t * FPS) + frames;
    setTime(frame / FPS);
  }

  function setLoop(next, on = true) {
    span = next && next.to > next.from ? { from: clamp(next.from, 0, duration()), to: clamp(next.to, 0, duration()) } : null;
    looping = span ? on : looping && on;
    loopButton.setAttribute('aria-pressed', String(looping));
    loopButton.setAttribute('aria-label', span ? `Loop ${seconds(span.from)}–${seconds(span.to)} s` : 'Loop');
    drawLoopBand();
  }

  // --- Drawing the timeline -------------------------------------------------------------------

  function place(node, from, to) {
    node.style.left = `${(at(from) * 100).toFixed(4)}%`;
    if (to !== undefined) node.style.width = `${(Math.max(0, at(to) - at(from)) * 100).toFixed(4)}%`;
  }

  function drawRuler() {
    for (const node of ruler.querySelectorAll('.adt-tick')) node.remove();
    const d = duration();
    const width = ruler.clientWidth;
    if (!d || !width) return;
    const perSecond = width / d;
    const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30];
    const major = steps.find((s) => s * perSecond >= 46) ?? 30;
    const minor = [5, 4, 2].map((n) => major / n).find((s) => s * perSecond >= 7);
    const fragment = document.createDocumentFragment();
    const count = Math.round(d / (minor ?? major));
    for (let i = 0; i <= count; i++) {
      const time = i * (minor ?? major);
      if (time > d + 1e-9) break;
      const isMajor = Math.abs(time / major - Math.round(time / major)) < 1e-6;
      const tick = el('div', `adt-tick${isMajor ? ' major' : ''}`, fragment);
      place(tick, time);
      if (isMajor && time < d - major / 2) el('span', 'adt-tick-label', tick).textContent = `${Math.round(time * 100) / 100} s`;
    }
    ruler.prepend(fragment);
  }

  function drawLoopBand() {
    ruler.querySelector('.adt-loop-band')?.remove();
    if (!span) return;
    const band = el('div', `adt-loop-band${looping ? ' on' : ''}`);
    place(band, span.from, span.to);
    ruler.append(band);
  }

  function keyTimes(layer) {
    const times = new Set();
    for (const track of layer.animation) for (const k of track.keyframes) times.add(k.t);
    return [...times].sort((a, b) => a - b);
  }

  function drawRows() {
    body.replaceChildren();
    for (const node of ruler.querySelectorAll('.adt-mark, .adt-comment-span, .adt-change')) node.remove();
    const lanes = new Map();
    const rows = [...ad.layers].reverse(); // the front first, as layers are listed elsewhere
    const removed = marks.filter((m) => m.kind === 'removed' && m.layer && !ad.layers.some((l) => l.id === m.layer));
    const addRow = (id, label, title, className) => {
      const row = el('div', `adt-row${className ? ` ${className}` : ''}`, body);
      row.dataset.layer = id;
      const name = el('div', 'adt-name', row);
      name.textContent = label;
      name.title = title;
      const lane = el('div', 'adt-lane', row);
      lanes.set(id, lane);
      return lane;
    };
    for (const base of rows) {
      const layer = layerAt(ad, base, sizeId);
      const label = base.name ?? base.id;
      if (!layer) {
        addRow(base.id, label, `${label}: hidden at this size`, 'hidden');
        continue;
      }
      const lane = addRow(base.id, label, `${label} (${base.kind})`);
      const bar = el('div', 'adt-bar', lane);
      place(bar, layer.from, layer.until);
      for (const time of keyTimes(layer)) {
        const dot = el('div', 'adt-key', lane);
        place(dot, time);
      }
    }
    for (const m of removed) {
      if (!lanes.has(m.layer)) addRow(m.layer, m.layer, `${m.layer}: removed by the proposal`, 'removed');
    }
    // Changes under the layers' bars, comments over everything.
    for (const m of marks) {
      if (!m.kind) continue;
      const lane = lanes.get(m.layer) ?? (m.layer == null ? ruler : null);
      if (!lane) continue;
      const band = el('div', `adt-change ${m.kind}`);
      place(band, m.from ?? 0, m.to ?? duration());
      band.title = `${m.kind === 'added' ? 'Added' : m.kind === 'removed' ? 'Removed' : 'Changed'} ${seconds(m.from ?? 0)}–${seconds(m.to ?? duration())} s`;
      lane.prepend(band);
    }
    for (const m of marks) {
      if (m.kind) continue;
      const lane = (m.layer && lanes.get(m.layer)) || ruler;
      const isSpan = m.from !== undefined && m.to !== undefined;
      const from = isSpan ? m.from : m.t ?? 0;
      if (isSpan) {
        const band = el('div', `adt-comment-span ${m.state === 'answered' ? 'answered' : 'open'}`, lane);
        place(band, from, m.to);
      }
      const marker = el('button', `adt-mark ${m.state === 'answered' ? 'answered' : 'open'}`, lane);
      marker.type = 'button';
      marker.setAttribute('aria-label', `Comment at ${seconds(from)} s${isSpan ? `–${seconds(m.to)} s` : ''}${m.state === 'answered' ? ', answered' : ''}`);
      place(marker, from);
      marker.addEventListener('click', (event) => { event.stopPropagation(); emit('mark', m); });
      marker.addEventListener('pointerdown', (event) => event.stopPropagation());
    }
  }

  function draw() {
    total.textContent = ` / ${seconds(duration())} s${ad.loops > 1 ? ` × ${ad.loops}` : ''}`;
    knob.setAttribute('aria-valuemax', String(duration()));
    knob.setAttribute('aria-valuemin', '0');
    drawRows();
    drawRuler();
    drawLoopBand();
  }

  const resizes = new ResizeObserver(() => { if (ad && !still()) drawRuler(); });
  resizes.observe(ruler);

  function load(next, nextSize, { marks: nextMarks = marks } = {}) {
    ad = normalizeAd(next);
    sizeId = ad.sizes.some((s) => s.id === nextSize) ? nextSize : ad.sizes[0].id;
    marks = nextMarks ?? [];
    renderer.show(ad, sizeId);
    if (still()) {
      pause();
      timelineEl.hidden = true;
      setTime(0, { quiet: true });
      return;
    }
    timelineEl.hidden = false;
    if (span && span.to > duration()) setLoop(null, looping);
    draw();
    setTime(t);
  }

  // --- Pointing and scrubbing -----------------------------------------------------------------

  const timeAt = (clientX) => {
    const rect = ruler.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * duration();
  };
  const round = (n) => Math.round(n * 100) / 100;

  main.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || still()) return;
    const onKnob = down.target.closest('.adt-knob');
    const lane = down.target.closest('.adt-lane, .adt-ruler');
    if (!onKnob && !lane) return;
    down.preventDefault();
    const row = down.target.closest('.adt-row');
    const layer = onKnob ? null : row?.dataset.layer ?? null;
    const mode = onKnob ? 'scrub' : down.metaKey || down.ctrlKey ? 'point' : down.altKey && !row ? 'loop' : 'scrub';
    const t0 = round(timeAt(down.clientX));
    const resume = playing && mode === 'scrub';
    let moved = false;
    let done = false;
    let band = null;
    main.setPointerCapture(down.pointerId);
    if (mode === 'scrub') { pause(); if (!onKnob) setTime(timeAt(down.clientX)); }
    timelineEl.classList.add(mode === 'scrub' ? 'scrubbing' : 'pointing');

    const ring = el('div', 'adt-press-ring');
    Object.assign(ring.style, { left: `${down.clientX}px`, top: `${down.clientY}px` });
    const showing = setTimeout(() => document.body.append(ring), RING_AFTER);
    const stopHold = () => { clearTimeout(showing); clearTimeout(hold); ring.remove(); };
    const hold = mode === 'loop' ? 0 : setTimeout(() => {
      stopHold();
      finish();
      emit('point', { t: t0, layer, clientX: down.clientX, clientY: down.clientY });
    }, HOLD_MS);

    const showBand = (time) => {
      if (!band) {
        band = el('div', `adt-select${mode === 'loop' ? ' loop' : ''}`);
        (row ? row.querySelector('.adt-lane') : ruler).append(band);
      }
      place(band, Math.min(t0, time), Math.max(t0, time));
    };
    const move = (event) => {
      if (!moved && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > STILL) { moved = true; stopHold(); }
      if (!moved) return;
      if (mode === 'scrub') setTime(timeAt(event.clientX));
      else showBand(timeAt(event.clientX));
    };
    const up = (event) => {
      if (done) return;
      stopHold();
      finish();
      const t1 = round(timeAt(event.clientX));
      if (mode === 'point') {
        if (moved && Math.abs(t1 - t0) >= 1 / FPS) emit('point', { from: Math.min(t0, t1), to: Math.max(t0, t1), layer, clientX: event.clientX, clientY: event.clientY });
        else emit('point', { t: t0, layer, clientX: down.clientX, clientY: down.clientY });
      } else if (mode === 'loop') {
        if (moved && Math.abs(t1 - t0) >= 1 / FPS) setLoop({ from: Math.min(t0, t1), to: Math.max(t0, t1) }, true);
        else setLoop(null, false);
      } else if (resume) play();
    };
    function finish() {
      done = true;
      band?.remove();
      timelineEl.classList.remove('scrubbing', 'pointing');
      main.removeEventListener('pointermove', move);
      main.removeEventListener('pointerup', up);
      main.removeEventListener('pointercancel', cancel);
    }
    const cancel = () => { stopHold(); finish(); };
    main.addEventListener('pointermove', move);
    main.addEventListener('pointerup', up);
    main.addEventListener('pointercancel', cancel);
  });

  // --- Buttons and keys -----------------------------------------------------------------------

  playButton.addEventListener('click', toggle);
  $('.adt-back').addEventListener('click', () => step(-1));
  $('.adt-forward').addEventListener('click', () => step(1));
  loopButton.addEventListener('click', () => {
    looping = !looping;
    loopButton.setAttribute('aria-pressed', String(looping));
    drawLoopBand();
  });

  const typing = (target) => target instanceof Element && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  const onKey = (event) => {
    if (!keys || still() || timelineEl.hidden || !timelineEl.isConnected) return;
    if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
    const handled = {
      ' ': () => toggle(),
      ArrowLeft: () => step(event.shiftKey ? -FPS : -1),
      ArrowRight: () => step(event.shiftKey ? FPS : 1),
      Home: () => { pause(); pass = 0; setTime(0); },
      End: () => { pause(); setTime(duration()); },
    }[event.key];
    if (!handled) return;
    event.preventDefault();
    handled();
  };
  // A focused button would also click on Space's keyup: the keydown has done it already.
  const onKeyUp = (event) => { if (event.key === ' ' && timelineEl.contains(event.target)) event.preventDefault(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);

  return {
    load,
    play,
    pause,
    toggle,
    seek: (time) => { pass = 0; setTime(time); },
    step,
    setMarks: (next) => { marks = next ?? []; if (ad && !still()) drawRows(); },
    setLoop,
    onTime: subscribe('time'),
    onPoint: subscribe('point'),
    onMark: subscribe('mark'),
    destroy() {
      pause();
      resizes.disconnect();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
      timelineEl.replaceChildren();
      timelineEl.classList.remove('ad-timeline', 'playing');
    },
    renderer,
    get time() { return t; },
    get playing() { return playing; },
    get ad() { return ad; },
    get sizeId() { return sizeId; },
  };
}
