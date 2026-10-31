// A page's story (see story.css): the app's window pinned on a stage while the page scrolls past a
// step per scene (its data-scene, with its caption on data-side: left, right, or none). Between each
// two steps is a gap where the change between them happens, tied to how far the page has scrolled
// through it, so nothing has to wait and nothing stops the scrolling:
//   - over the gap's first fifth, the last scene's caption fades out, moving the way the page goes
//   - there, the demo builds the next scene (once the scrolling slows, so a fast scroll or a jump
//     past several builds only the one it lands on)
//   - over the middle, the camera travels from the last scene's framing to the next's
//   - over the last fifth, the next scene's caption fades in
// Scrolling back up plays it all the other way. On a step itself everything holds still and the
// scene's moment plays: the cursor working the app, and the .agent window floating over it while
// the agent's at work (in a scene whose caption says so, data-agent). Progress dots track the
// scenes. A page can change a step's scene and call story.replay() (the home page's hero does, as
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

// Where each scene's focus is (in the window's own pixels), as the demo says once it's built it.
const focuses = new Map();
const focusOf = (step) => (step.dataset.scene === 'settle' ? WINDOW : focuses.get(step.dataset.scene) ?? WINDOW);

// The camera's framing for a step: its focus fitted into the room its caption leaves, beside it on
// wide screens, above it on narrow ones. A whole window is never enlarged; a detail can be, a
// little. The window never reaches into the caption's column: what doesn't fit goes off the other
// edge of the screen. Where the focus allows, the window's edge meets the column's, so the gap
// between caption and window is the same in every scene.
const COLUMN = 440; // the caption's column, at the screen's edge (story.css places the captions in it)
function framing(step) {
  const focus = focusOf(step);
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const side = step.dataset.side;
  const gap = 28;
  const room = !wide.matches
    ? { x: 12, y: 12, width: W - 24, height: side === 'none' ? H - 24 : H * 0.58 }
    : side === 'left' ? { x: COLUMN, y: gap, width: W - COLUMN - gap, height: H - 2 * gap }
    : side === 'right' ? { x: gap, y: gap, width: W - COLUMN - gap, height: H - 2 * gap }
    : { x: 40, y: gap, width: W - 80, height: H - 2 * gap };
  const whole = focus.width >= WINDOW.width;
  const k = Math.min(room.width / focus.width, room.height / focus.height, whole ? 1 : 1.4);
  let x = room.x + (room.width - focus.width * k) / 2 - focus.x * k;
  let y = room.y + (room.height - focus.height * k) / 2 - focus.y * k;
  if (!wide.matches) {
    if (side !== 'none') y = Math.min(y, room.y + room.height - WINDOW.height * k);
  } else if (side === 'left') {
    const against = room.x; // the window's left edge on the column's
    x = against + (focus.x + focus.width) * k <= room.x + room.width ? against : Math.max(x, room.x);
  } else if (side === 'right') {
    const against = room.x + room.width - WINDOW.width * k; // its right edge on the column's
    x = against + focus.x * k >= room.x ? against : Math.min(x, against);
  }
  return { x, y, k };
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
let started = null; // the step whose moment has been started
function want(step) {
  if (step === wanted) return;
  wanted = step;
  clearTimeout(wantTimer);
  if (step.dataset.scene === 'settle') return; // the last scene stays as it is, the window seen whole
  wantTimer = setTimeout(() => build(step), BUILD_AFTER);
}
async function build(step) {
  if (!demo) return;
  const n = ++builds;
  scene = step;
  built = null;
  started = null;
  putBackFiles();
  document.dispatchEvent(new CustomEvent('story:scene', { detail: step }));
  const focus = await demo.show(step.dataset.scene);
  if (n !== builds) return;
  if (focus) focuses.set(step.dataset.scene, focus);
  built = step;
  render();
}

// --- Drawing the story at the page's scroll position ------------------------------------------

let glide = false; // the next framing glides (a scene moving its own focus), not follows the scroll
function render() {
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
  camera.style.transition = glide ? '' : 'none';
  glide = false;
  camera.style.transform = `translate(${x}px, ${lerp(fa.y, fb.y, u)}px) scale(${lerp(fa.k, fb.k, u)})`;
  placeAgent(x);

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

  // On a step, once its scene is built, its moment plays (once per build).
  if (t === 0 && built === a && started !== a && a.dataset.scene !== 'settle') {
    started = a;
    demo.start();
    dragIn(a, builds);
  }

  track(from, to, t, within);
}
let rendering = false;
const schedule = () => {
  if (!rendering) requestAnimationFrame(render);
  rendering = true;
};
addEventListener('scroll', schedule, { passive: true });
addEventListener('resize', schedule);
new ResizeObserver(schedule).observe(stage);

// --- The first scene's file --------------------------------------------------------------------

// A caption's file (the first scene's CV) is picked up and dragged onto the window: over its middle
// the app shows its drop indicator, and on the drop the document opens. Another scene puts it back.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, still.matches ? 0 : ms));
async function dragIn(step, n) {
  const file = captionOf(step)?.querySelector('.drag-file');
  if (!file || !demo) return;
  await wait(500);
  if (n !== builds) return;
  const s = stage.getBoundingClientRect();
  const from = file.getBoundingClientRect();
  const ghost = file.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { left: `${from.left - s.left}px`, top: `${from.top - s.top}px` });
  stage.append(ghost);
  file.classList.add('picked');
  // To the window's middle, where the camera has it.
  const m = new DOMMatrix(getComputedStyle(camera).transform);
  const to = { x: m.e + (WINDOW.width / 2) * m.a - from.width / 2, y: m.f + (WINDOW.height / 2) * m.d - from.height / 2 };
  ghost.getBoundingClientRect();
  ghost.style.transform = `translate(${to.x - (from.left - s.left)}px, ${to.y - (from.top - s.top)}px)`;
  await wait(800);
  if (n === builds) demo.dragOver();
  await wait(900);
  ghost.style.opacity = '0';
  if (n === builds) await demo.drop();
  ghost.remove();
}
function putBackFiles() {
  for (const ghost of stage.querySelectorAll('.drag-ghost')) ghost.remove();
  for (const file of stage.querySelectorAll('.drag-file.picked')) file.classList.remove('picked');
}

// --- The agent's side ----------------------------------------------------------------------

const agentWindow = stage.querySelector('.agent');
const agentBody = agentWindow?.querySelector('.agent-body');
let typing = null; // the reply being typed out, finished at once when the next thing arrives
function add(className, text) {
  const el = Object.assign(document.createElement('p'), { className, textContent: text });
  agentBody.append(el);
  return el;
}
// The agent's replies type themselves out, a few characters at a time.
function typeOut(el, text) {
  typing?.finish();
  if (still.matches) return void (el.textContent = text);
  let n = 0;
  const timer = setInterval(() => {
    n = Math.min(text.length, n + 3);
    el.textContent = text.slice(0, n);
    if (n === text.length) finish();
  }, 30);
  const finish = () => {
    clearInterval(timer);
    el.textContent = text;
    typing = null;
  };
  typing = { finish };
}
function showAgent(event) {
  if (!agentWindow) return;
  if (event.type === 'clear') {
    typing?.finish();
    agentWindow.classList.remove('shown');
    agentBody.replaceChildren();
    return;
  }
  // Only in a scene whose caption has the agent at work (data-agent).
  if (!captionOf(scene)?.hasAttribute('data-agent')) return;
  agentWindow.classList.add('shown');
  if (event.type === 'prompt') add('agent-prompt', event.text);
  if (event.type === 'say') typeOut(add('agent-say', ''), event.text);
  if (event.type === 'tool') {
    typing?.finish();
    const line = add('agent-tool', '');
    line.dataset.key = event.key;
    line.append(Object.assign(document.createElement('b'), { textContent: event.name }), Object.assign(document.createElement('span'), { textContent: event.detail }));
  }
  if (event.type === 'tool-done') {
    const line = agentBody.querySelector(`.agent-tool[data-key="${event.key}"]`);
    if (line) {
      line.querySelector('span').textContent = event.detail;
      line.classList.add('done');
    }
  }
}

// The agent window sits over the left side of the app window (clear of the cards that appear in
// its right margin), a little in from the window's visible edge.
function placeAgent(x) {
  if (!agentWindow) return;
  agentWindow.style.left = wide.matches ? `${Math.max(x, 0) + 32}px` : ''; // narrow: over the top (story.css)
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
  const side = current === -1 ? null : step.dataset.side;
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
  // A scene moving its own focus part-way through (the highlight scene, as the agent starts): the
  // camera glides there.
  demo.onFocus((next) => {
    focuses.set(scene.dataset.scene, next);
    glide = true;
    render();
  });
  frame.classList.add('loaded');
  wanted = null; // build whatever the page is at, now the demo's here
  render();
});

window.story = {
  get scene() { return scene; },
  steps,
  // Builds the current step's scene again (after a page changes it).
  replay() {
    wanted = null;
    render();
  },
};
