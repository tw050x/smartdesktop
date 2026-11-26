// What a page (page-view.js) takes from SmartSpec's canvas-view.js: a zoom held at its limit gives
// a little and springs back, as SmartSpec's canvases and pages do. SmartPrep has no diagrams, so
// the canvas itself isn't here.

const BOUNCE = 0.06; // how far a zoom-out button pressed at the limit dips before springing back

// Zoomed out past as far as it goes, it gives a little, more and more stiffly, to at most GIVE
// smaller, and springs back when let go, so the user sees the limit rather than nothing happening.
const GIVE = 0.12;
export const SPRING_MS = 260;
export function pastLeast(wanted, least) {
  if (wanted >= least) return wanted;
  const excess = 1 - wanted / least;
  return least * (1 - GIVE * (1 - 1 / (1 + excess / GIVE)));
}

// Moves a number from `from` to `to` over SPRING_MS, easing out, calling `step` with each value.
export function glide(from, to, step, done = () => {}, ms = SPRING_MS) {
  const start = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - start) / ms);
    step(from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(frame);
    else done();
  };
  requestAnimationFrame(frame);
}

// A press of zoom out at the limit: a little dip and back, from `at`, by `step`.
export function bounce(at, step, done) {
  glide(at, at * (1 - BOUNCE), step, () => glide(at * (1 - BOUNCE), at, step, done, SPRING_MS / 2), SPRING_MS / 2);
}
