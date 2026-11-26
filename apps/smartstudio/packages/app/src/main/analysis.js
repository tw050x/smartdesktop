// What a stretch of a take sounds like, for the AI, from how loud it is over time (the take's
// levels, see store.js's levelsFields: `rate` measures a second, each a peak and an average
// amplitude from 0 to 1). The AI can't listen, so this says what can be told from loudness alone:
// how loud the stretch is against the rest, where it goes quiet or clips, where it jumps, and its
// loudness second by second, with a little either side so the AI hears how it's joined. No Node or
// Electron here, so the tests run it.

const SILENT_DB = -45; // quieter than this, on average, is silence
const CLIP = 0.99; // a peak this close to full scale is clipping
const JUMP_DB = 9; // loudness changing this much from one half second to the next is a jump
const CONTEXT = 2; // seconds either side of the stretch shown in its timeline
const STEP = 0.5; // the timeline's step, in seconds
const MAX_STEPS = 80; // a longer stretch's timeline is coarser

const db = (amplitude) => (amplitude > 0 ? Math.round(20 * Math.log10(amplitude) * 10) / 10 : -120);
const round = (seconds) => Math.round(seconds * 10) / 10;

// The average loudness (as decibels from full scale) and loudest peak between two times.
function measure(levels, from, to) {
  const first = Math.max(0, Math.floor(from * levels.rate));
  const last = Math.min(levels.rms.length, Math.ceil(to * levels.rate));
  if (last <= first) return null;
  let energy = 0;
  let peak = 0;
  for (let i = first; i < last; i++) {
    energy += levels.rms[i] ** 2;
    peak = Math.max(peak, levels.peak[i]);
  }
  return { loudness: db(Math.sqrt(energy / (last - first))), peak: db(peak), peakAmplitude: peak };
}

// Runs of measures matching `test`, at least `min` seconds long, within the stretch.
function runs(levels, from, to, test, min) {
  const found = [];
  const first = Math.max(0, Math.floor(from * levels.rate));
  const last = Math.min(levels.rms.length, Math.ceil(to * levels.rate));
  let start = null;
  for (let i = first; i <= last; i++) {
    const on = i < last && test(i);
    if (on && start === null) start = i;
    if (!on && start !== null) {
      if ((i - start) / levels.rate >= min) found.push({ start: round(start / levels.rate), end: round(i / levels.rate) });
      start = null;
    }
  }
  return found;
}

// What's there between `start` and `end` (seconds) in a take `seconds` long.
export function analyzeStretch(levels, { start, end, seconds }) {
  if (!levels?.rms?.length) return null;
  const length = Math.min(seconds ?? Infinity, levels.rms.length / levels.rate);
  const inside = measure(levels, start, end);
  if (!inside) return null;
  // The rest of the take, either side of it: how loud the song is around the stretch.
  const restIndexes = [];
  for (let i = 0; i < Math.min(levels.rms.length, Math.ceil(length * levels.rate)); i++) {
    if (i < Math.floor(start * levels.rate) || i >= Math.ceil(end * levels.rate)) restIndexes.push(i);
  }
  const rest = restIndexes.length >= levels.rate / 4
    ? db(Math.sqrt(restIndexes.reduce((sum, i) => sum + levels.rms[i] ** 2, 0) / restIndexes.length))
    : null;
  const whole = measure(levels, 0, length);

  // Loudness each half second (coarser for a long stretch), from a little before to a little after.
  const from = Math.max(0, start - CONTEXT);
  const to = Math.min(length, end + CONTEXT);
  const step = Math.max(STEP, Math.ceil(((to - from) / MAX_STEPS) / STEP) * STEP);
  const timeline = [];
  for (let at = from; at < to - 1e-6; at += step) {
    const one = measure(levels, at, Math.min(to, at + step));
    if (one) timeline.push({ at: round(at), loudness: one.loudness });
  }
  const jumps = [];
  for (let i = 1; i < timeline.length; i++) {
    const change = timeline[i].loudness - timeline[i - 1].loudness;
    if (Math.abs(change) >= JUMP_DB && Math.max(timeline[i].loudness, timeline[i - 1].loudness) > SILENT_DB) {
      jumps.push({ at: timeline[i].at, change: Math.round(change * 10) / 10 });
    }
  }
  const silentAt = Math.pow(10, SILENT_DB / 20);
  // Moments at full scale, together (a song mastered loud touches it often, which isn't
  // necessarily distortion: a long run of them, or many more than the rest of the take has, is).
  const full = runs(levels, start, end, (i) => levels.peak[i] >= CLIP, 0);
  const fullSeconds = full.reduce((sum, run) => sum + Math.max(1 / levels.rate, run.end - run.start), 0);
  return {
    loudness: inside.loudness,
    peak: inside.peak,
    // Against the rest of the take (negative: quieter than it).
    rest: rest === null ? null : { loudness: rest, difference: Math.round((inside.loudness - rest) * 10) / 10 },
    whole: whole && { loudness: whole.loudness, peak: whole.peak },
    fullScale: { moments: full.length, seconds: Math.round(fullSeconds * 100) / 100, at: full.slice(0, 8).map((run) => run.start) },
    silences: runs(levels, start, end, (i) => levels.rms[i] < silentAt, 0.3),
    jumps,
    // Loudness each `step` seconds, from `from`: the stretch is `start` to `end` within it.
    timeline: { from: round(from), step, loudness: timeline.map((one) => one.loudness) },
    units: 'Loudness and peaks are decibels from full scale (0 is the loudest there can be; a typical song averages around -14 to -8, and below -45 is silence). fullScale counts the moments the sound touches full scale (moments in a row count once): songs mastered loud do often, so it\'s distortion only if they run long or there are many more than elsewhere. Times are seconds from the take\'s start.',
  };
}
