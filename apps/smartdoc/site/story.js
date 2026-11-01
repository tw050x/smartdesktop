// A page's story (see story.css): the app's window pinned on a stage while the page scrolls past a
// step per scene (its data-scene, with its caption on data-side: left, right, or none). Between each
// two steps is a gap where the change between them happens, tied to how far the page has scrolled
// through it, so nothing has to wait and nothing stops the scrolling:
//   - over the gap's first fifth, the last scene's caption fades out, moving the way the page goes
//   - there, the demo builds the next scene (once the scrolling slows, so a fast scroll or a jump
//     past several builds only the one it lands on)
//   - over the middle, the camera travels from the last scene's framing to the next's
//   - over the last fifth, the next scene's caption fades in
// Scrolling back up plays it all the other way. On a step the camera holds still and the scene's
// moment plays as the page scrolls through it, the step as long as the moment needs: the cursor
// working the app, typing, and the .agent window floating over it while the agent's at work (in a
// scene whose caption says so, data-agent). Scrolling back up runs it backwards. A step with no
// caption (the hero) plays its moment through in time instead. The first scene's file is dragged
// onto the window as the page scrolls through its step: over the window the app shows its drop
// indicator, then the file drops and the document opens. Progress dots track the scenes. A page can change a step's scene and call story.replay() (the home page's hero does, as
// it swaps tools), and hears 'story:scene' as a scene is built.

const stage = document.querySelector('.stage');
const camera = stage.querySelector('.camera');
const frame = camera.querySelector('iframe');
const steps = [...document.querySelectorAll('.step')];
const captions = [...stage.querySelectorAll('.caption')];
const WINDOW = { x: 0, y: 0, width: 1280, height: 800 };
const wide = matchMedia('(min-width: 900px)');
const still = matchMedia('(prefers-reduced-motion: reduce)');
let demo = null;

// Ties each caption heading's and paragraph's last two words together, so a short word (“it”)
// is never left on a line of its own.
for (const el of stage.querySelectorAll('.caption h2, .caption > p:not(.kicker)')) {
  el.textContent = el.textContent.trim().replace(/ (\S+)$/, ' $1');
}

// The gaps, one before each step after the first.
const gaps = steps.slice(1).map((step) => {
  const gap = Object.assign(document.createElement('div'), { className: 'gap' });
  step.before(gap);
  return gap;
});

const clamp = (v) => Math.min(1, Math.max(0, v));
const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
const lerp = (a, b, u) => a + (b - a) * u;
// A step's caption: the one for its scene, unless the step has none (data-side "none", like the
// features page's opening step, which shows its first scene without one).
const captionOf = (step) => (step.dataset.side === 'none' ? undefined : captions.find((c) => c.dataset.scene === step.dataset.scene));

// Where the page is in the story, at the middle of the view: on a step ({ from, to: from, t: 0 }) or
// a way (t) through the gap from one step to the next. Before the first step it's on the first;
// after the last, on the last.
function position() {
  const middle = innerHeight / 2;
  for (let i = 0; i < steps.length; i++) {
    const r = steps[i].getBoundingClientRect();
    if (r.top <= middle && r.bottom > middle) return { from: i, to: i, t: 0, within: (middle - r.top) / r.height };
    const g = gaps[i]?.getBoundingClientRect();
    if (g && g.top <= middle && g.bottom > middle) return { from: i, to: i + 1, t: (middle - g.top) / g.height };
  }
  const last = steps.length - 1;
  return steps[0].getBoundingClientRect().top > middle ? { from: 0, to: 0, t: 0, within: 0 } : { from: last, to: last, t: 0, within: 1 };
}

// --- Framing ---------------------------------------------------------------------------------

// Where each scene's focus is (in the window's own pixels), as the demo says once it's built it,
// kept for coming back to it.
const focuses = new Map();
function focusOf(step) {
  if (step.dataset.scene === 'settle') return WINDOW;
  return focuses.get(step.dataset.scene) ?? WINDOW;
}

// The camera's framing for a step: its focus fitted into the room its caption leaves, beside it on
// wide screens. A whole window is never enlarged; a detail can be, a little. The window never
// reaches into the caption's column: what doesn't fit goes off the other edge of the screen. Where
// the focus allows, the window's edge meets the column's, so the gap between caption and window
// is the same in every scene. Narrow screens have a framing of their own (narrowFraming).
const COLUMN = 440; // the caption's column, at the screen's edge (story.css places the captions in it)
function framing(step) {
  if (!wide.matches) return narrowFraming(step);
  const focus = shownFocus(step);
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const side = step.dataset.side;
  const gap = 28;
  // A caption across the top (data-side "top") leaves the full width under it, for a focus that's
  // wide and short, which can then be enlarged more.
  const top = side === 'top' ? gap + (captionOf(step)?.offsetHeight ?? 0) + gap : 0;
  const room = side === 'left' ? { x: COLUMN, y: gap, width: W - COLUMN - gap, height: H - 2 * gap }
    : side === 'right' ? { x: gap, y: gap, width: W - COLUMN - gap, height: H - 2 * gap }
    : side === 'top' ? { x: 40, y: top, width: W - 80, height: H - top - gap }
    : { x: 40, y: gap, width: W - 80, height: H - 2 * gap };
  const whole = focus.width >= WINDOW.width;
  const k = Math.min(room.width / focus.width, room.height / focus.height, whole ? 1 : side === 'top' ? 1.8 : 1.4);
  let x = room.x + (room.width - focus.width * k) / 2 - focus.x * k;
  // Centred in its room, or, under a top caption, at the room's top.
  let y = side === 'top' ? room.y - focus.y * k : room.y + (room.height - focus.height * k) / 2 - focus.y * k;
  if (side === 'left') {
    const against = room.x; // the window's left edge on the column's
    x = against + (focus.x + focus.width) * k <= room.x + room.width ? against : Math.max(x, room.x);
  } else if (side === 'right') {
    const against = room.x + room.width - WINDOW.width * k; // its right edge on the column's
    x = against + focus.x * k >= room.x ? against : Math.min(x, against);
  }
  return { x, y, k };
}

// Narrow: the caption and the window one above the other, the window over it on one step and
// under it (down by the progress dots) on the next. On a phone, shown whole, the window would be
// too small to read, so it's larger, with only part of its width on screen, and how much larger
// depends on the scene: a whole window filling its room (or WHOLE, at the least), a detail (a menu,
// a card, a column) up to its full size. A tablet shows a whole window whole.
// What doesn't fit in the window's room is cut off at the room's edges (clip). The camera pans
// across it: to the cursor while it's working, otherwise to the middle of what the scene's about
// (or, for the agent at work, where the demo says, narrowX). The pan eases there frame by frame,
// as the focus does.
const EDGE = 12; // the space around the window
const GAP = 20; // between the caption and the window
const DOTS = 36; // the progress dots' row, at the foot
const WHOLE = 0.5; // a whole window's size, at the least
const SPARE = 1.25; // how much wider than the screen a focus can be, the rest panned to
let cursorAt = null; // where the demo's cursor is, in the window's pixels, while it's shown
const cursorWas = new Map(); // step → where its cursor was last, kept while it's hidden
const pans = new Map(); // step → { x } the camera centres on, on its way to where it should
// Which way round each captioned step goes: the window 'over' its caption, or 'under' it.
const order = new Map(steps.filter((step) => step.dataset.side !== 'none').map((step, i) => [step, i % 2 ? 'under' : 'over']));
// The window's room on a step, and where its caption goes (its top), in the stage's pixels.
function narrowLayout(step) {
  const H = stage.clientHeight;
  const way = order.get(step);
  if (!way) return { room: { top: EDGE, bottom: H - EDGE } };
  const caption = captionOf(step)?.offsetHeight ?? 0;
  return way === 'over'
    ? { room: { top: EDGE, bottom: H - DOTS - caption - 2 * GAP }, captionTop: H - DOTS - caption - GAP }
    : { room: { top: 2 * GAP + caption, bottom: H - DOTS }, captionTop: GAP };
}
function narrowFraming(step) {
  const W = stage.clientWidth;
  const focus = focusOf(step);
  const { room } = narrowLayout(step);
  const fit = (W - 2 * EDGE) / WINDOW.width; // the whole window's width on screen
  const detail = ((W - 2 * EDGE) / focus.width) * SPARE;
  // A phone: at least filling its room from top to bottom, and a detail larger still. A tablet,
  // wide enough to read the whole window (fit ≥ WHOLE): the whole window, fitted to the screen and
  // its room, and a detail larger.
  const k = fit >= WHOLE
    ? Math.min(1, Math.max(Math.min(fit, (room.bottom - room.top) / WINDOW.height), focus.width < WINDOW.width ? detail : 0))
    : Math.min(1, Math.max(WHOLE, (room.bottom - room.top) / WINDOW.height, detail));
  // Across: panned to the cursor, staying where it was while it's hidden (the agent at work, or
  // another scene being built), or before it's shown to where it'll first go (narrowX), or to the
  // middle of the focus; never past the window's edges.
  if (step === built && cursorAt) cursorWas.set(step, cursorAt);
  let target = cursorWas.get(step)?.x ?? focus.narrowX ?? focus.x + focus.width / 2;
  const half = (W - 2 * EDGE) / k / 2;
  target = half * 2 >= WINDOW.width ? WINDOW.width / 2 : Math.min(WINDOW.width - half, Math.max(half, target));
  let pan = pans.get(step);
  if (!pan || still.matches) pans.set(step, (pan = { x: target }));
  else if (pan.frame !== lastFrame) {
    pan.frame = lastFrame;
    const d = target - pan.x;
    if (Math.abs(d) < 0.5) pan.x = target;
    else {
      pan.x += d * (1 - Math.exp(-frameStep / 320));
      easing = true;
    }
  }
  // Up and down: a window that fits its room against the caption's far side (at the top, or down
  // by the dots); one that doesn't, from its top (the top bar showing), moved up only as far as a
  // focus lower down needs, and cut off at the room's edges.
  const height = WINDOW.height * k;
  let y;
  if (height <= room.bottom - room.top) y = order.get(step) === 'under' ? room.bottom - height : room.top;
  else y = Math.max(room.bottom - height, Math.min(room.top, room.bottom - (focus.y + focus.height) * k));
  const clip = { top: Math.max(0, (room.top - y) / k), bottom: Math.max(0, (y + height - room.bottom) / k) };
  return { x: W / 2 - pan.x * k, y, k, clip };
}

// --- Building scenes -------------------------------------------------------------------------

// The scene the app shows (built), and the one it's been asked for. Building waits for the
// scrolling to slow a little, so passing quickly over several scenes builds only the last.
const BUILD_AFTER = 80; // ms
let scene = steps[0]; // the step whose scene the app shows, or is building
let wanted = null;
let wantTimer;
let built = null; // the step whose scene is built and ready
let builds = 0;
let started = null; // the uncaptioned step whose moment has been started (it plays in time)
function want(step) {
  if (step === wanted) return;
  wanted = step;
  clearTimeout(wantTimer);
  if (step.dataset.scene === 'settle') return; // the last scene stays as it is, the window seen whole
  if (step === built) return; // back from the last scene, to the one still built: it stays as it is
  wantTimer = setTimeout(() => build(step), BUILD_AFTER);
}
async function build(step) {
  if (!demo) return;
  const n = ++builds;
  scene = step;
  built = null;
  cursorAt = null;
  started = null;
  document.dispatchEvent(new CustomEvent('story:scene', { detail: step }));
  const focus = await demo.show(step.dataset.scene);
  if (n !== builds) return;
  if (focus) focuses.set(step.dataset.scene, focus);
  pans.delete(step); // narrow: the pan starts where the scene now says, not easing from the guess
  built = step;
  render();
}

// --- Drawing the story at the page's scroll position ------------------------------------------

// The focus the camera frames each step by: its focus (focusOf), or on its way there when that's
// changed (a scene built for the first time turning out to be about another part of the window
// than guessed), easing a little closer each frame. Eased here, frame by
// frame along with the scrolling, rather than by a transition the scrolling would cut short.
const shown = new Map();
let easing = false; // whether a focus is still on its way
let lastFrame = performance.now();
let frameStep = 0; // ms since the last frame, for easing
function shownFocus(step) {
  const target = focusOf(step);
  const now = shown.get(step);
  if (!now || still.matches) {
    shown.set(step, { ...target });
    return target;
  }
  if (now.frame === lastFrame) return now; // once a frame
  now.frame = lastFrame;
  const k = 1 - Math.exp(-frameStep / 160);
  for (const key of ['x', 'y', 'width', 'height']) {
    const d = target[key] - now[key];
    if (Math.abs(d) < 0.5) now[key] = target[key];
    else {
      now[key] += d * k;
      easing = true;
    }
  }
  return now;
}

function render() {
  const time = performance.now();
  frameStep = Math.min(50, time - lastFrame);
  lastFrame = time;
  easing = false;
  rendering = false;
  const { from, to, t, within } = position();
  const a = steps[from];
  const b = steps[to];

  // The scene the app shows: the last one until the gap's first fifth is passed, then the next.
  want(t >= 0.2 ? b : a);

  // The camera, travelling over the gap's middle.
  const u = ease(clamp((t - 0.2) / 0.6));
  const fa = framing(a);
  const fb = framing(b);
  const x = lerp(fa.x, fb.x, u);
  camera.style.transition = 'none';
  const k = lerp(fa.k, fb.k, u);
  const y = lerp(fa.y, fb.y, u);
  camera.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  // Narrow: what's cut off at the window's room, and each caption in its place.
  const clipTop = lerp(fa.clip?.top ?? 0, fb.clip?.top ?? 0, u);
  const clipBottom = lerp(fa.clip?.bottom ?? 0, fb.clip?.bottom ?? 0, u);
  const out = -80 / k; // an edge that isn't cut: past the window, so its shadow still shows
  camera.style.clipPath = clipTop || clipBottom ? `inset(${clipTop || out}px ${out}px ${clipBottom || out}px ${out}px)` : '';
  if (!wide.matches) for (const step of order.keys()) captionOf(step)?.style.setProperty('--narrow-top', `${narrowLayout(step).captionTop}px`);
  placeAgent(x, { top: y + clipTop * k, bottom: y + (WINDOW.height - clipBottom) * k });
  placeFile(from, to, t, within, { x, y: lerp(fa.y, fb.y, u), k: lerp(fa.k, fb.k, u) });

  // The captions: the last fading out over the first fifth, moving up; the next fading in over the
  // last fifth, from below (scrolling up runs it backwards, so they move the other way).
  for (const caption of captions) {
    let show = 0;
    let shift = 32;
    if (caption === captionOf(a)) {
      show = 1 - clamp(t / 0.2);
      shift = -32 * (1 - show);
    } else if (b !== a && caption === captionOf(b)) {
      show = clamp((t - 0.8) / 0.2);
      shift = 32 * (1 - show);
    }
    caption.style.setProperty('--show', show.toFixed(3));
    caption.style.setProperty('--shift', `${shift.toFixed(1)}px`);
    caption.style.visibility = show > 0 ? 'visible' : 'hidden';
  }

  // The built scene's moment, as far as the page has scrolled through its step: none of it in the
  // gap before, all of it in the gap after. A step with no caption plays it through in time.
  if (demo && built && built.dataset.scene !== 'settle') {
    const i = steps.indexOf(built);
    if (built.dataset.side === 'none') {
      if (t === 0 && built === a && started !== a) {
        started = a;
        demo.start();
      }
    } else if (from === i && to === i) {
      demo.seek(clamp((within - MOMENT[0]) / (MOMENT[1] - MOMENT[0])));
    } else if (from === i) {
      demo.seek(1);
    } else if (to === i) {
      demo.seek(0);
    }
  }

  track(from, to, t, within);
  if (easing) schedule();
}
// The part of a step its moment plays over: still for a moment either side.
const MOMENT = [0.08, 0.88];
let rendering = false;
const schedule = () => {
  if (!rendering) requestAnimationFrame(render);
  rendering = true;
};
addEventListener('scroll', schedule, { passive: true });
addEventListener('resize', schedule);
new ResizeObserver(schedule).observe(stage);

// --- The first scene's file --------------------------------------------------------------------

// A caption's file (the first scene's CV) and its step. Through the step, as the page scrolls: it
// rests under the caption, then is picked up and carried to the window's middle; over the window
// the app shows its drop indicator; then it drops and the document opens.
const dragStep = steps.find((step) => captionOf(step)?.querySelector('.drag-file'));
const dragFile = dragStep && captionOf(dragStep).querySelector('.drag-file');
const ghost = dragFile?.cloneNode(true);
if (ghost) {
  ghost.classList.add('drag-ghost');
  ghost.hidden = true;
  stage.append(ghost);
}
const CARRY = [0.12, 0.5]; // the part of the step over which it's carried to the window
const OVER = 0.42; // from here it's over the window: the drop indicator shows
const DROP = 0.62; // and from here it's dropped
function placeFile(from, to, t, within, view) {
  if (!ghost) return;
  const i = steps.indexOf(dragStep);
  // How far through the file's step the page is: none of it before, all of it after.
  const w = from === i && to === i ? within : from >= i ? 1 : 0;
  const p = ease(clamp((w - CARRY[0]) / (CARRY[1] - CARRY[0])));
  if (demo && built === dragStep) demo.dragTo(w >= DROP ? 'dropped' : w >= OVER ? 'over' : 'away');
  const carried = built === dragStep && p > 0 && w < DROP;
  ghost.hidden = !carried;
  dragFile.classList.toggle('picked', carried || w >= DROP);
  if (!carried) return;
  // From the file's place under the caption to the window's middle, where the camera has it.
  const s = stage.getBoundingClientRect();
  const r = dragFile.getBoundingClientRect();
  const fx = r.left - s.left;
  const fy = r.top - s.top;
  const tx = view.x + (WINDOW.width / 2) * view.k - r.width / 2;
  const ty = view.y + (WINDOW.height / 2) * view.k - r.height / 2;
  Object.assign(ghost.style, { left: `${fx}px`, top: `${fy}px`, transform: `translate(${lerp(0, tx - fx, p)}px, ${lerp(0, ty - fy, p)}px)` });
  // Fading as it's let go.
  ghost.style.opacity = (1 - clamp((w - (DROP - 0.06)) / 0.06)).toFixed(3);
}

// --- The agent's side ----------------------------------------------------------------------

const agentWindow = stage.querySelector('.agent');
const agentBody = agentWindow?.querySelector('.agent-body');
// What the agent's done so far, as the demo has it: the window shows it while there's something
// (in a scene whose caption has the agent at work), each entry kept as it changes so only what's
// new comes in.
function showAgent({ entries }) {
  if (!agentWindow) return;
  const shown = entries.length > 0 && captionOf(scene)?.hasAttribute('data-agent');
  agentWindow.classList.toggle('shown', Boolean(shown));
  if (!shown) return void agentBody.replaceChildren();
  const lines = [...agentBody.children];
  entries.forEach((entry, i) => {
    const className = `agent-${entry.kind}`;
    let line = lines[i];
    if (!line || !line.classList.contains(className)) {
      for (const extra of lines.splice(i)) extra.remove();
      line = Object.assign(document.createElement('p'), { className });
      if (entry.kind === 'tool') line.append(document.createElement('b'), document.createElement('span'));
      agentBody.append(line);
      lines.push(line);
    }
    if (entry.kind === 'tool') {
      line.children[0].textContent = entry.name;
      line.children[1].textContent = entry.detail;
      line.classList.toggle('done', entry.done);
    } else {
      line.textContent = entry.text;
    }
  });
  for (const extra of lines.slice(entries.length)) extra.remove();
}

// The agent window sits over the left side of the app window (clear of the cards that appear in
// its right margin), a little in from the window's visible edge.
// Narrow, it's docked over the lower part of what shows of the window (shown: its top and bottom
// on screen), across its width.
function placeAgent(x, shown) {
  if (!agentWindow) return;
  agentWindow.style.left = wide.matches ? `${Math.max(x, 0) + 32}px` : '';
  agentWindow.style.top = wide.matches ? '' : `${shown.top + (shown.bottom - shown.top) * 0.4}px`;
  agentWindow.style.height = wide.matches ? '' : `${(shown.bottom - shown.top) * 0.6 - EDGE}px`;
}

// --- Progress ------------------------------------------------------------------------------

// The progress dots: one per captioned scene, on the side of the scene's caption. Scenes passed are
// filled, the current one fills as the page scrolls through its step, and the next takes over half
// way through the gap. Hidden before the first and after the last.
const chapters = steps.filter((step) => step.dataset.side !== 'none');
const progress = [...stage.querySelectorAll('.progress')];
for (const set of progress) set.append(...chapters.map(() => Object.assign(document.createElement('span'), { className: 'dot' })));
function track(from, to, t, within) {
  const step = steps[t >= 0.5 ? to : from];
  const current = chapters.indexOf(step);
  const fill = t === 0 ? clamp(within) : t >= 0.5 ? 0 : 1;
  const side = current === -1 ? null : step.dataset.side === 'top' ? 'left' : step.dataset.side; // a top caption's dots on the left
  for (const set of progress) {
    // Narrow, the captions are all at the foot of the view, so only the left set is used.
    set.classList.toggle('shown', side !== null && set.dataset.side === (wide.matches ? side : 'left'));
    [...set.children].forEach((dot, i) => {
      dot.classList.toggle('passed', i < current);
      dot.classList.toggle('current', i === current);
      if (i === current) dot.style.setProperty('--fill', fill.toFixed(3));
      else dot.style.removeProperty('--fill');
    });
  }
}

// --- Starting --------------------------------------------------------------------------------

render();

// Opened as a file, the browser blocks the demo: say how to see it instead.
if (location.protocol === 'file:') {
  frame.remove();
  camera.insertAdjacentHTML('beforeend', '<div class="needs-server"><p>The demo needs the site served, not opened as a file. In the repository, run</p><code>npm run site</code><p>and open http://127.0.0.1:8765</p></div>');
}

frame.addEventListener('load', async () => {
  while (!frame.contentWindow.demo) await new Promise((resolve) => setTimeout(resolve, 50));
  demo = frame.contentWindow.demo;
  demo.setInstant(still.matches);
  demo.onAgent(showAgent);
  demo.onCursor((at) => {
    cursorAt = at;
    if (!wide.matches) schedule();
  });
  sizeSteps(demo.lengths());
  // Where each scene's about before it's first built, so the camera heads the right way.
  for (const [name, focus] of Object.entries(demo.focusHints())) if (!focuses.has(name)) focuses.set(name, focus);
  frame.classList.add('loaded');
  wanted = null; // build whatever the page is at, now the demo's here
  render();
});

// Each captioned step as long as its scene's moment needs, so the cursor and the typing go at an
// easy pace as the page scrolls. The page keeps its place in the story as the steps change.
const PX_PER_MS = 0.09;
function sizeSteps(lengths) {
  const before = position();
  for (const step of steps) {
    const ms = lengths[step.dataset.scene];
    if (step.dataset.side !== 'none' && ms) step.style.minHeight = `calc(var(--stage-height) * 0.5 + ${Math.round(ms * PX_PER_MS)}px)`;
  }
  if (before.t === 0) {
    const r = steps[before.from].getBoundingClientRect();
    scrollTo(0, scrollY + r.top + r.height * before.within - innerHeight / 2);
  }
}

window.story = {
  get scene() { return scene; },
  steps,
  // Builds the current step's scene again (after a page changes it).
  replay() {
    wanted = null;
    built = null;
    render();
  },
};
