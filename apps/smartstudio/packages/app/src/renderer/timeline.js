// A finished take on a timeline: its waveform (and for a clip, a strip of its frames above, with
// the clip itself above that), a playhead, the notes on it as marks, and for a take remaking part
// of another, the part made again. Dragging across it selects a stretch (its edges can be dragged
// after); a click moves the playhead. Space plays and pauses, Escape lets go of the selection, the
// arrow keys step a second.
//
// How loud the take is over time (its levels: `rate` measures a second, each the peak and average
// amplitude, 0 to 1) is measured here from its sound, once, the first time it's drawn, and kept
// with it (`saveLevels`), for the waveform and for the AI (see main/analysis.js); after that it's
// read back (`loadLevels`).
//
// The file is fetched from studio-media:// (the main process allows the page to): its sound is
// decoded to measure it, and a clip's frames are taken from a copy of it held here (a blob, so the
// canvas they're drawn on can be read).

const RATE = 20; // level measures a second
const FLOOR_DB = -48; // the waveform's quietest
const THUMB_HEIGHT = 44;
const FRAME_WIDTH = 512; // frames for the AI, in pixels across
const EDGE_PX = 6; // how near a selection's edge a drag takes the edge

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (key === 'className') element.className = value;
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// Seconds as the timeline shows them: 1:05, or with tenths for a selection's edges (1:05.3).
export const clock = (seconds, tenths = false) => {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  const shown = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${minutes}:${shown}`;
};

// The levels of a decoded sound: each 1/RATE of a second, its loudest moment and its average, all
// channels together.
export function measureLevels(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const per = Math.max(1, Math.round(buffer.sampleRate / RATE));
  const count = Math.ceil(buffer.length / per);
  const peak = new Array(count).fill(0);
  const rms = new Array(count).fill(0);
  for (let i = 0; i < count; i++) {
    const from = i * per;
    const to = Math.min(buffer.length, from + per);
    let loudest = 0;
    let energy = 0;
    for (const data of channels) {
      for (let j = from; j < to; j++) {
        const value = Math.abs(data[j]);
        if (value > loudest) loudest = value;
        energy += value * value;
      }
    }
    peak[i] = loudest;
    rms[i] = Math.sqrt(energy / Math.max(1, (to - from) * channels.length));
  }
  return { rate: RATE, peak, rms };
}

const toHeight = (amplitude) => {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
};

// `src`, the take's file; `seconds`, how long it was asked to be (the file says exactly, once
// loaded). `onSelect(selection)` hears the stretch selected ({ start, end }) as the user lets go,
// or null as it's let go of; `onPlay()` as it starts playing (so others can stop).
export function createTimeline({ kind, src, seconds, notes = [], remade = null, loadLevels, saveLevels, onSelect = () => {}, onPlay = () => {}, onNoteClick = () => {} }) {
  const isVideo = kind === 'video';
  const media = h(isVideo ? 'video' : 'audio', { preload: 'metadata', src, className: isVideo ? 'take-video timeline-video' : 'timeline-audio' });
  let duration = seconds;
  let levels = null;
  let selection = null; // { start, end }
  let shownNotes = notes;
  let stopAt = null; // playing a selection stops at its end

  const play = h('button', { className: 'icon-button timeline-play', type: 'button', 'aria-label': 'Play', title: 'Play (Space)' });
  const time = h('span', { className: 'timeline-time' }, `0:00 / ${clock(duration)}`);
  const transport = h('div', { className: 'timeline-transport' }, play, time);

  const base = h('canvas', { className: 'timeline-wave', 'aria-hidden': 'true' });
  const played = h('canvas', { className: 'timeline-wave played', 'aria-hidden': 'true' });
  const thumbs = isVideo ? h('canvas', { className: 'timeline-thumbs', 'aria-hidden': 'true' }) : null;
  const marks = h('div', { className: 'timeline-marks' });
  const band = h('div', { className: 'timeline-selection', hidden: '' }, h('span', { className: 'timeline-handle start' }), h('span', { className: 'timeline-handle end' }));
  const head = h('div', { className: 'timeline-playhead' });
  const waiting = h('span', { className: 'timeline-waiting' }, 'Measuring…');
  const track = h('div', {
    className: `timeline-track${isVideo ? ' with-thumbs' : ''}`,
    tabindex: '0',
    role: 'slider',
    'aria-label': 'Timeline: drag to select a part, click to move the playhead',
    'aria-valuemin': '0',
  }, ...(thumbs ? [thumbs] : []), h('div', { className: 'timeline-waves' }, base, played, waiting), marks, band, head);
  const element = h('div', { className: `timeline ${kind}` }, ...(isVideo ? [media] : []), transport, track, ...(isVideo ? [] : [media]));

  // --- Drawing ---
  const width = () => track.clientWidth || 600;
  const at = (seconds) => `${(Math.max(0, Math.min(duration, seconds)) / duration) * 100}%`;

  function drawWave(canvas) {
    const box = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * ratio));
    canvas.height = Math.max(1, Math.round(box.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!levels) return;
    ctx.fillStyle = getComputedStyle(canvas).color;
    const bar = 2 * ratio;
    const gap = 1 * ratio;
    const middle = canvas.height / 2;
    const total = levels.peak.length / levels.rate;
    for (let x = 0; x < canvas.width; x += bar + gap) {
      const from = Math.floor(((x / canvas.width) * duration) * levels.rate);
      const to = Math.max(from + 1, Math.floor((((x + bar) / canvas.width) * duration) * levels.rate));
      if (from / levels.rate > total) break;
      let loudest = 0;
      for (let i = from; i < to && i < levels.peak.length; i++) loudest = Math.max(loudest, levels.peak[i]);
      const height = Math.max(ratio, toHeight(loudest) * (canvas.height - 2 * ratio));
      ctx.fillRect(x, middle - height / 2, bar, height);
    }
  }
  function draw() {
    drawWave(base);
    drawWave(played);
    showTime();
    showMarks();
    showSelection();
  }
  function showTime() {
    const now = media.currentTime || 0;
    head.style.left = at(now);
    played.style.clipPath = `inset(0 ${100 - (Math.min(now, duration) / duration) * 100}% 0 0)`;
    time.textContent = `${clock(now)} / ${clock(duration)}`;
    track.setAttribute('aria-valuemax', String(Math.round(duration)));
    track.setAttribute('aria-valuenow', String(Math.round(now)));
    play.innerHTML = media.paused
      ? '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 2.2v9.6L11.5 7z" fill="currentColor"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 2.5h2.4v9H3.5zM8.1 2.5h2.4v9H8.1z" fill="currentColor"/></svg>';
    play.setAttribute('aria-label', media.paused ? 'Play' : 'Pause');
  }
  function showMarks() {
    const all = [];
    if (remade) all.push(h('span', { className: 'timeline-remade', style: `left: ${at(remade.start)}; width: calc(${at(remade.end)} - ${at(remade.start)})`, title: `Made again: ${clock(remade.start, true)}–${clock(remade.end, true)}` }));
    for (const note of shownNotes) {
      const mark = h('button', {
        className: `timeline-note${note.by === 'ai' ? ' by-ai' : ''}`,
        type: 'button',
        style: `left: ${at(note.start)}; width: max(4px, calc(${at(note.end)} - ${at(note.start)}))`,
        title: `${clock(note.start, true)}–${clock(note.end, true)}: ${note.text}`,
        'aria-label': `Note at ${clock(note.start)}: ${note.text}`,
      });
      mark.addEventListener('pointerdown', (event) => event.stopPropagation());
      mark.addEventListener('click', () => onNoteClick(note));
      all.push(mark);
    }
    marks.replaceChildren(...all);
  }
  function showSelection() {
    band.hidden = !selection;
    if (!selection) return;
    band.style.left = at(selection.start);
    band.style.width = `calc(${at(selection.end)} - ${at(selection.start)})`;
  }

  // --- Levels ---
  let source = null; // the file's bytes, fetched once
  const bytes = async () => {
    source ??= fetch(src).then((res) => {
      if (!res.ok) throw new Error(`The take's file couldn't be read (${res.status}).`);
      return res.blob();
    });
    return source;
  };
  async function measure() {
    const kept = await loadLevels?.().catch(() => null);
    if (kept?.peak?.length) return kept;
    const blob = await bytes();
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const measured = measureLevels(decoded);
      saveLevels?.(measured)?.catch?.(() => {});
      return measured;
    } finally {
      context.close();
    }
  }
  measure().then((found) => {
    levels = found;
    waiting.remove();
    draw();
  }).catch(() => {
    waiting.textContent = isVideo ? '' : 'Couldn’t measure its sound';
  });

  // --- A clip's frames ---
  let frameVideo = null;
  async function frameSource() {
    if (frameVideo) return frameVideo;
    const url = URL.createObjectURL(await bytes());
    const video = h('video', { muted: '', preload: 'auto', src: url });
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('The clip couldn’t be read.')), { once: true });
    });
    frameVideo = video;
    return video;
  }
  // One frame at a time, as the clip is seeked to each in turn.
  let seeking = Promise.resolve();
  const frameAt = (seconds, canvas, box) => {
    const next = seeking.then(async () => {
      const video = await frameSource();
      await new Promise((resolve) => {
        video.addEventListener('seeked', resolve, { once: true });
        video.currentTime = Math.max(0, Math.min(video.duration - 0.04, seconds));
      });
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, box.x, box.y, box.width, box.height);
    });
    seeking = next.catch(() => {});
    return next;
  };
  async function drawThumbs() {
    if (!thumbs) return;
    const ratio = window.devicePixelRatio || 1;
    const box = thumbs.getBoundingClientRect();
    thumbs.width = Math.max(1, Math.round(box.width * ratio));
    thumbs.height = Math.round(THUMB_HEIGHT * ratio);
    const video = await frameSource().catch(() => null);
    if (!video) return;
    const aspect = video.videoWidth / video.videoHeight || 16 / 9;
    const each = thumbs.height * aspect;
    const count = Math.max(1, Math.ceil(thumbs.width / each));
    for (let i = 0; i < count; i++) {
      await frameAt(((i + 0.5) / count) * duration, thumbs, { x: i * each, y: 0, width: each, height: thumbs.height }).catch(() => {});
    }
  }
  // Frames from a stretch, for the AI to look at: one just before it, a few in it, one just after.
  async function frames({ start, end }) {
    if (!isVideo) return [];
    const video = await frameSource();
    const inside = Math.max(3, Math.min(5, Math.round((end - start) / 1.5) + 1));
    const times = [
      ...(start > 0.2 ? [{ at: start - 0.2, inside: false }] : []),
      ...Array.from({ length: inside }, (_, i) => ({ at: start + ((end - start) * i) / (inside - 1), inside: true })),
      ...(end < duration - 0.2 ? [{ at: end + 0.2, inside: false }] : []),
    ];
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_WIDTH;
    canvas.height = Math.round(FRAME_WIDTH / (video.videoWidth / video.videoHeight || 16 / 9));
    const taken = [];
    for (const one of times) {
      await frameAt(one.at, canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height });
      taken.push({ at: Math.round(one.at * 100) / 100, inside: one.inside, mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.8).split(',')[1] });
    }
    return taken;
  }

  // --- Playing ---
  function toggle(fromSelection = false) {
    if (!media.paused) return media.pause();
    if (selection && (fromSelection || media.currentTime < selection.start || media.currentTime >= selection.end - 0.05)) {
      media.currentTime = selection.start;
    }
    stopAt = selection ? selection.end : null;
    onPlay();
    media.play().catch(() => {});
  }
  play.addEventListener('click', () => toggle());
  media.addEventListener('timeupdate', () => {
    if (stopAt !== null && media.currentTime >= stopAt) {
      media.pause();
      media.currentTime = stopAt;
      stopAt = null;
    }
    showTime();
  });
  media.addEventListener('play', showTime);
  media.addEventListener('pause', showTime);
  media.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(media.duration) && media.duration > 0) duration = media.duration;
    draw();
    drawThumbs();
  });
  // Smoother than timeupdate's few a second, while it plays.
  const tick = () => {
    if (!media.paused) showTime();
    if (element.isConnected) requestAnimationFrame(tick);
    else running = false;
  };
  let running = false;
  media.addEventListener('play', () => {
    if (running) return;
    running = true;
    requestAnimationFrame(tick);
  });

  // --- Selecting ---
  const timeAt = (clientX) => {
    const box = track.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - box.left) / box.width) * duration));
  };
  let drag = null; // { anchor, moved, edge }
  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    track.focus();
    track.setPointerCapture(event.pointerId);
    const t = timeAt(event.clientX);
    const px = (seconds) => (seconds / duration) * width();
    let edge = null;
    if (selection) {
      if (Math.abs(px(t) - px(selection.start)) <= EDGE_PX) edge = 'start';
      else if (Math.abs(px(t) - px(selection.end)) <= EDGE_PX) edge = 'end';
    }
    drag = { anchor: edge === 'start' ? selection.end : edge === 'end' ? selection.start : t, x: event.clientX, moved: Boolean(edge), edge };
  });
  track.addEventListener('pointermove', (event) => {
    if (!drag) {
      // An edge of the selection shows it can be dragged.
      if (selection) {
        const t = timeAt(event.clientX);
        const near = [selection.start, selection.end].some((edge) => Math.abs(((t - edge) / duration) * width()) <= EDGE_PX);
        track.classList.toggle('at-edge', near);
      }
      return;
    }
    if (!drag.moved && Math.abs(event.clientX - drag.x) < 4) return;
    drag.moved = true;
    const t = timeAt(event.clientX);
    selection = { start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) };
    showSelection();
  });
  const finish = (event) => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    if (!moved) {
      // A click: the playhead goes there, and a selection it's outside of is let go of.
      const t = timeAt(event.clientX);
      if (selection && (t < selection.start || t > selection.end)) select(null);
      media.currentTime = t;
      stopAt = null;
      showTime();
      return;
    }
    if (!selection || selection.end - selection.start < 0.1) return select(null);
    select({ start: Math.round(selection.start * 10) / 10, end: Math.round(selection.end * 10) / 10 });
  };
  track.addEventListener('pointerup', finish);
  track.addEventListener('pointercancel', () => { drag = null; });
  track.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
      toggle();
    } else if (event.key === 'Escape' && selection) {
      event.stopPropagation();
      select(null);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      media.currentTime = Math.max(0, Math.min(duration, (media.currentTime || 0) + (event.key === 'ArrowLeft' ? -1 : 1)));
      showTime();
    }
  });

  // Selects a stretch (or nothing, with null), as the user would, telling onSelect.
  function select(next, { quiet = false } = {}) {
    selection = next && { start: Math.max(0, next.start), end: Math.min(duration, next.end) };
    if (selection && selection.end <= selection.start) selection = null;
    if (!selection) stopAt = null;
    showSelection();
    if (!quiet) onSelect(selection);
  }

  new ResizeObserver(() => {
    draw();
    if (thumbs && frameVideo) drawThumbs();
  }).observe(track);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

  return {
    element,
    media,
    duration: () => duration,
    selection: () => selection,
    select,
    frames,
    playSelection: () => toggle(true),
    pause: () => media.pause(),
    setNotes(next) {
      shownNotes = next ?? [];
      showMarks();
    },
  };
}
