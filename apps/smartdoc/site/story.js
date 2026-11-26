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
// working the app, typing, and the AI at work: answering in the app's own chat, in a window of its
// own (.camera.chat, the demo's demo-chat.html) floating by the app window's right edge, as it does
// in the app (SmartDoc), or in the .agent window floating over it, standing for an AI app of the
// visitor's (SmartSpec, in a scene whose caption says so, data-agent). Scrolling back up runs it
// backwards. A step with no caption (the hero) plays its moment through in time instead. The
// first scene's file is dragged onto the window as the page scrolls through its step: over the
// window the app shows its drop indicator, then the file drops and the document opens. Progress
// dots track the scenes. A page can change a step's scene and call story.replay() (the home page's
// hero does, as it swaps tools), and hears 'story:scene' as a scene is built.

const stage = document.querySelector('.stage');
const camera = stage.querySelector('.camera');
const frame = camera.querySelector('iframe');
// The home page's hero has a second window (.camera.alt, its own copy of the demo) for its other
// tool: the two slide and fade past each other as the hero swaps tools (see showHero).
const altCamera = stage.querySelector('.camera.alt');
// A step with data-windows="2" shows two windows side by side: this one, its own copy of the demo,
// playing its own scene while the page's scrolling plays the first window's. Narrow, there's only
// room for one, so it takes over from the first halfway through the step.
const secondCamera = stage.querySelector('.camera.second');
let secondDemo = null;
let secondShowing = false;
const twoWindows = (step) => Boolean(step.dataset.windows);
// The chat's window: placed with the app's, at the demo's chatPlace, while the demo says it shows.
const chatCamera = stage.querySelector('.camera.chat');
const CHAT = { x: 1000, y: 70, width: 400, height: 660, scale: 1 }; // the demo's chatPlace, until it says
// Where each scene has the chat's window (in the app window's pixels, with its scale): a wide
// screen's scenes vary it, beside the app window on either side, apart, larger or smaller. Each
// step's comes from its focus, or from the demo as it's dragged; the chat travels between them
// with the camera.
const chatPlaces = new Map(); // scene → its place as dragged
function chatAt(step) {
  return chatPlaces.get(step.dataset.scene) ?? focusOf(step).chatAt ?? CHAT;
}
let chatShown = false;
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
// A step's caption: the one for its scene (or its data-caption, for a step whose scene changes, like
// the home page's hero), unless the step has none (data-side "none", like the features page's
// opening step, which shows its first scene without one).
const captionOf = (step) => (step.dataset.side === 'none' ? undefined : captions.find((c) => c.dataset.scene === (step.dataset.caption ?? step.dataset.scene)));
// A step whose moment plays through in time, not as the page scrolls, and that isn't a chapter of
// the story (no progress dot): one with no caption, or with its caption below the window (the
// home page's hero, its tools under it).
const plays = (step) => ['none', 'below'].includes(step.dataset.side);

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
  // The hero (a step that plays by itself) and the last step show the whole window, whatever the
  // scene's about, so the hero never zooms in once its scene is built.
  if (step.dataset.scene === 'settle' || plays(step)) return WINDOW;
  return focuses.get(step.dataset.scene) ?? WINDOW;
}

// The camera's framing for a step: the scene's focus (what its moment is about, in the window's
// pixels: where the cursor works, what appears, the chat's window if it's used) in the room its
// caption leaves, at least large enough to read (READABLE), and no larger than MOST. It's fixed for
// the whole step: the camera moves only between steps (the user's choice: following the cursor, it
// slid back and forth within a step).
// No window's edge is ever squeezed against the screen's (or the header's) (the user's choice: a
// window just the height of the view, or a chat's foot at the screen's foot, looked squashed):
// each edge of the app's window and the chat's is either well inside, with MARGIN round it, or
// well past it, by CUT at least, so it's plainly cut off. A window too tall for the view runs off
// the top or the foot, whichever's away from the focus, with room on the other side.
// Wide, the windows are never cut off beside the caption (the user found a cut through the middle
// of the window wrong): they stop at its column (or band), and what doesn't fit runs off the
// screen's other edges, or up under the page's header. So each step's caption goes on whichever
// side shows the whole focus with no edge squeezed (its own side first, then left, right, across
// the foot, across the top; across the foot rather than the top when the window has to be cropped
// up and down, as it then goes under the header), or failing that its main part whole. Narrow, the
// caption and the window are one above the other (narrowLayout), the window cut off at its room's
// top and foot, and what doesn't fit across runs off the screen's sides, round the scene's anchor
// (where its cursor stays longest).
const COLUMN = 440; // the caption's column, at the screen's edge (story.css places the captions in it)
const READABLE = { wide: 0.8, narrow: 0.5 }; // the smallest the window is drawn, wide and narrow
const MOST = 1.3; // the largest a part of the window is drawn
const MARGIN = { wide: 32, narrow: 12 }; // the least room between a window's edge and the screen's
const CUT = { wide: 64, narrow: 32 }; // the least a window's edge is past the screen's, when cut off
const OFF = 100000; // an edge that isn't cut
const NO_CLIP = { left: -OFF, top: -OFF, right: OFF, bottom: OFF };
function framing(step) {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const gap = 28;
  if (step.dataset.windows && wide.matches) {
    // Under its caption, the two windows the same size, centred with a gap between them.
    const y = gap + (captionOf(step)?.offsetHeight ?? 0) + gap;
    const between = 20;
    const k = Math.min((W - 80 - between) / 2 / WINDOW.width, (H - y - gap) / WINDOW.height);
    const x = (W - WINDOW.width * k * 2 - between) / 2;
    return { x, y, k, clip: NO_CLIP, second: { x: x + WINDOW.width * k + between, y, k } };
  }
  const focus = shownFocus(step);
  if (wide.matches) {
    const side = sideOf(step);
    return placeFor(step, side, focus, W, H, sides.get(step)?.k);
  }
  const { room } = narrowLayout(step);
  const box = { x: EDGE, y: room.top, width: W - 2 * EDGE, height: room.bottom - room.top };
  const k = scaleFor(focus, box, READABLE.narrow);
  const anchor = anchorOf(focus);
  const content = contentOf(step);
  const fit = { margin: MARGIN.narrow, over: CUT.narrow };
  const x = along({ ...fit, roomStart: box.x, roomSize: box.width, viewStart: 0, viewEnd: W, content: [content.x, content.x + content.width], focus: [focus.x, focus.x + focus.width], anchor: anchor.x, edges: edgesOf(step, 'x') }, k);
  const y = along({ ...fit, roomStart: box.y, roomSize: box.height, viewStart: room.top, viewEnd: room.bottom, content: [content.y, content.y + content.height], focus: [focus.y, focus.y + focus.height], anchor: anchor.y, edges: edgesOf(step, 'y') }, k);
  return { x: x.v, y: y.v, k, clip: { ...NO_CLIP, top: room.top, bottom: room.bottom } };
}
const anchorOf = (focus) => focus.anchor ?? { x: focus.x + focus.width / 2, y: focus.y + focus.height / 2 };
// How large the focus is drawn: fitted to its room, but no smaller than `least`, nor larger than
// MOST (a whole window, no larger than it is).
function scaleFor(focus, room, least) {
  const most = focus.width >= WINDOW.width ? 1 : MOST;
  return Math.min(most, Math.max(least, Math.min(room.width / focus.width, room.height / focus.height)));
}
// What there is to show: the app's window, the chat's beside it while it shows (where the scene
// puts it: a drag never moves the framing), the focus, and wherever else the scene's windows go
// in its moment (its reach, such as the chat dragged aside), so a caption is never over them.
function contentOf(step) {
  const focus = focusOf(step);
  const parts = [WINDOW, focus, focus.reach, chatBoxOf(focus)].filter(Boolean);
  const x = Math.min(...parts.map((p) => p.x));
  const y = Math.min(...parts.map((p) => p.y));
  return { x, y, width: Math.max(...parts.map((p) => p.x + p.width)) - x, height: Math.max(...parts.map((p) => p.y + p.height)) - y };
}
// The chat's window, where the scene puts it (in the app window's pixels), while it shows.
function chatBoxOf(focus) {
  if (!focus.chat || !chatCamera || !focus.chatAt) return null;
  const s = focus.chatAt.scale ?? 1;
  return { x: focus.chatAt.x, y: focus.chatAt.y, width: CHAT.width * s, height: CHAT.height * s };
}
// Each window's edges along one axis (in the app window's pixels): the app's, the chat's, and the
// chat's where it's dragged to.
function edgesOf(step, axis) {
  const focus = focusOf(step);
  const [at, size] = axis === 'x' ? ['x', 'width'] : ['y', 'height'];
  return [WINDOW, chatBoxOf(focus), focus.reach].filter(Boolean).flatMap((box) => [box[at], box[at] + box[size]]);
}
// Where the window goes along one axis (v: its edge's place on the stage), at scale k, in the room
// (roomStart, roomSize), able to run out as far as the view (viewStart, viewEnd: the screen's
// edges, the header's, or the caption's). Against the caption (`closed`: 'start' or 'end'), its
// edge (or the chat's) is at the room's, or a little further off. Otherwise all of it is in the
// middle, with room round it, if it fits; if not, the anchor is. Either way the focus is kept in
// view, and then it's moved as little as it takes to leave no window's edge squeezed against the
// view's (`squeezed` says how many still are).
function along(a, k) {
  const { roomStart, roomSize, viewStart, viewEnd, closed, margin, over } = a;
  const [cs, ce] = a.content;
  const [fs, fe] = a.focus;
  let lo;
  let hi;
  let preferred;
  if (closed === 'start') {
    lo = roomStart - cs * k;
    hi = lo + 160;
    preferred = lo;
  } else if (closed === 'end') {
    hi = roomStart + roomSize - ce * k;
    lo = hi - 160;
    preferred = hi;
  } else {
    const size = (ce - cs) * k;
    preferred = size <= viewEnd - viewStart - 2 * margin
      ? (viewStart + viewEnd - size) / 2 - cs * k
      : (viewStart + viewEnd) / 2 - Math.min(fe, Math.max(fs, a.anchor)) * k;
    lo = viewEnd - margin - fe * k; // the focus in view, with room round it
    hi = viewStart + margin - fs * k;
    if (lo > hi) {
      lo = viewEnd - fe * k; // or just in view
      hi = viewStart - fs * k;
    }
    if (lo > hi) lo = hi = preferred;
  }
  preferred = Math.min(hi, Math.max(lo, preferred));
  // (The caption's side is spaced already, by its column or band.)
  const vs = closed === 'start' ? -OFF : viewStart;
  const ve = closed === 'end' ? OFF : viewEnd;
  const squeezedAt = (v) => a.edges.filter((e) => {
    const p = v + e * k;
    return (p > vs - over && p < vs + margin) || (p > ve - margin && p < ve + over);
  }).length;
  let best = preferred;
  let bestCost = squeezedAt(preferred) * OFF;
  const by = Math.max(1, (hi - lo) / 300);
  for (let v = lo; v <= hi + 0.01; v += by) {
    const cost = squeezedAt(v) * OFF + Math.abs(v - preferred);
    if (cost < bestCost) {
      bestCost = cost;
      best = v;
    }
  }
  return { v: best, squeezed: squeezedAt(best) };
}
// The framing with the caption on `side` (wide), at scale `scale` (or fitted to the room), how much
// of the focus it shows (seen, 0 to 1), and how many window edges are squeezed against the view's.
function placeFor(step, side, focus, W, H, scale) {
  const gap = MARGIN.wide;
  const band = ['top', 'bottom', 'below'].includes(side) ? captionHeight(step, side) + 2 * gap : 0;
  const room = side === 'left' ? { x: COLUMN, y: gap, width: W - COLUMN - gap, height: H - 2 * gap }
    : side === 'right' ? { x: gap, y: gap, width: W - COLUMN - gap, height: H - 2 * gap }
    : side === 'top' ? { x: 40, y: band, width: W - 80, height: H - band - gap }
    : side === 'bottom' || side === 'below' ? { x: 40, y: gap, width: W - 80, height: H - band - gap }
    : { x: 40, y: gap, width: W - 80, height: H - 2 * gap };
  const view = {
    left: side === 'left' ? room.x : 0,
    right: side === 'right' ? room.x + room.width : W,
    top: side === 'top' ? room.y : 0,
    bottom: side === 'bottom' || side === 'below' ? room.y + room.height : H,
  };
  // The hero (a step that plays by itself) shows the whole window: it's seen before the stage is
  // pinned under the header, so nothing it crops would go under the header.
  const k = scale ?? scaleFor(focus, room, plays(step) ? 0 : READABLE.wide);
  // (It's fitted to its room, with room round it: there's no edge to keep from squeezing.)
  const whole = plays(step);
  const anchor = anchorOf(focus);
  const content = contentOf(step);
  const fit = { margin: MARGIN.wide, over: CUT.wide };
  const x = along({ ...fit, roomStart: room.x, roomSize: room.width, viewStart: view.left, viewEnd: view.right, closed: side === 'left' ? 'start' : side === 'right' ? 'end' : null, content: [content.x, content.x + content.width], focus: [focus.x, focus.x + focus.width], anchor: anchor.x, edges: whole ? [] : edgesOf(step, 'x') }, k);
  const y = along({ ...fit, roomStart: room.y, roomSize: room.height, viewStart: view.top, viewEnd: view.bottom, closed: side === 'top' ? 'start' : side === 'bottom' || side === 'below' ? 'end' : null, content: [content.y, content.y + content.height], focus: [focus.y, focus.y + focus.height], anchor: anchor.y, edges: whole ? [] : edgesOf(step, 'y') }, k);
  const shownX = Math.max(0, Math.min(view.right, x.v + (focus.x + focus.width) * k) - Math.max(view.left, x.v + focus.x * k));
  const shownY = Math.max(0, Math.min(view.bottom, y.v + (focus.y + focus.height) * k) - Math.max(view.top, y.v + focus.y * k));
  let seen = (shownX * shownY) / (focus.width * k * focus.height * k);
  // Across the top, a window cut off at the foot is the wrong way round: across the foot, it'd go
  // under the header instead.
  if (side === 'top' && y.v + (content.y + content.height) * k > H + 1) seen *= 0.99;
  // Whether the focus's main part (the card or field the moment's about) shows whole.
  const main = focus.main;
  const mainWhole = !main || (x.v + main.x * k >= view.left - 1 && x.v + (main.x + main.width) * k <= view.right + 1 && y.v + main.y * k >= view.top - 1 && y.v + (main.y + main.height) * k <= view.bottom + 1);
  const squeezed = x.squeezed + y.squeezed;
  // A squeezed edge counts for more than a little of the focus, but less than its main part whole;
  // a little under READABLE is allowed, but only to make room.
  return { x: x.v, y: y.v, k, clip: NO_CLIP, side, seen, squeezed, score: seen + (mainWhole ? 1 : 0) - 0.6 * squeezed - (k < READABLE.wide - 0.001 ? 0.3 : 0) };
}
// The best framing with the caption on `side`: at the size that fits the focus to the room, or
// a little smaller (down to nine tenths of READABLE, so a window just too tall for the view fits it
// with room round it), or larger (so it plainly runs off it), rather than squeezed into it.
function bestFor(step, side, focus, W, H) {
  const fitted = placeFor(step, side, focus, W, H);
  if (plays(step) || (fitted.seen >= 0.999 && !fitted.squeezed)) return fitted;
  let best = fitted;
  const least = READABLE.wide * 0.9;
  for (const k of [READABLE.wide, READABLE.wide * 0.95, least, fitted.k * 0.95, fitted.k * 0.9, fitted.k * 1.12, fitted.k * 1.25, fitted.k * 1.4]) {
    if (k < least - 0.001 || k > MOST) continue;
    const tried = placeFor(step, side, focus, W, H, k);
    if (tried.score > best.score + 0.001) best = tried;
  }
  return best;
}
// The side a step's caption is on: wide, the first that shows the whole of its focus with no edge
// squeezed, or failing that the best (its main part whole, most of the rest, fewest edges
// squeezed), worked out once for each screen size and focus, and the caption moved there; narrow,
// its own.
const sides = new Map(); // step → { key, side, k }
function sideOf(step) {
  const own = step.dataset.side;
  if (!wide.matches || !captionOf(step) || ['below', 'none'].includes(own) || step.dataset.windows) return own;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const focus = focusOf(step);
  const key = `${W}x${H}:${[focus.x, focus.y, focus.width, focus.height].map(Math.round)}:${focus.chat ? JSON.stringify(focus.chatAt ?? null) : ''}`;
  const known = sides.get(step);
  if (known?.key === key) return known.side;
  let best = null;
  for (const side of [...new Set([own, 'left', 'right', 'bottom', 'top'])]) {
    const tried = bestFor(step, side, focus, W, H);
    if (!best || tried.score > best.score + 0.001) best = tried;
    if (tried.seen >= 0.999 && !tried.squeezed) break;
  }
  sides.set(step, { key, side: best.side, k: best.k });
  captionOf(step).dataset.side = best.side;
  return best.side;
}
// How tall a step's caption is on `side` (its width differs from side to side).
function captionHeight(step, side) {
  const caption = captionOf(step);
  if (!caption) return 0;
  const was = caption.dataset.side;
  caption.dataset.side = side;
  const height = caption.offsetHeight;
  caption.dataset.side = was;
  return height;
}
// What of a window placed at (x, y), k, its own size w × h, is cut off by `clip` (in the stage's
// pixels), as a clip-path: its edges inside the clip are cut, the rest left with room for the shadow.
function insetOf(x, y, k, w, h, clip) {
  const out = -80 / k;
  const top = clip.top > y ? (clip.top - y) / k : out;
  const left = clip.left > x ? (clip.left - x) / k : out;
  const right = clip.right < x + w * k ? (x + w * k - clip.right) / k : out;
  const bottom = clip.bottom < y + h * k ? (y + h * k - clip.bottom) / k : out;
  return top === out && left === out && right === out && bottom === out ? '' : `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

// Narrow: the caption and the window one above the other, the window over it on one step and
// under it (down by the progress dots) on the next.
const EDGE = 12; // the space around the window
const GAP = 20; // between the caption and the window
const DOTS = 36; // the progress dots' row, at the foot
// Which way round each captioned step goes: the window 'over' its caption, or 'under' it.
// (A caption below always goes under its window, without counting in the alternation.)
const order = new Map(steps.filter((step) => !plays(step)).map((step, i) => [step, i % 2 ? 'under' : 'over']));
// The window's room on a step, and where its caption goes (its top), in the stage's pixels.
function narrowLayout(step) {
  const H = stage.clientHeight;
  const way = order.get(step) ?? (step.dataset.side === 'below' ? 'over' : null);
  if (!way) return { room: { top: EDGE, bottom: H - EDGE } };
  const caption = captionOf(step)?.offsetHeight ?? 0;
  return way === 'over'
    ? { room: { top: EDGE, bottom: H - DOTS - caption - 2 * GAP }, captionTop: H - DOTS - caption - GAP }
    : { room: { top: 2 * GAP + caption, bottom: H - DOTS }, captionTop: GAP };
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
  started = null;
  document.dispatchEvent(new CustomEvent('story:scene', { detail: step }));
  const focus = await demo.show(step.dataset.scene);
  if (n !== builds) return;
  if (focus) focuses.set(step.dataset.scene, focus);
  chatPlaces.delete(step.dataset.scene); // not dragged yet
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
  Object.assign(now, { anchor: target.anchor, main: target.main, reach: target.reach, chat: target.chat, chatAt: target.chatAt });
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
  const k = lerp(fa.k, fb.k, u);
  const y = lerp(fa.y, fb.y, u);
  camera.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  // What's cut off at the room's edge on the caption's side, moving with the camera between steps.
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const edge = (key, none) => lerp(Math.max(-W, Math.min(2 * W, fa.clip[key] ?? none)), Math.max(-W, Math.min(2 * W, fb.clip[key] ?? none)), u);
  const clip = { left: edge('left', -OFF), top: edge('top', -OFF), right: edge('right', OFF), bottom: edge('bottom', OFF) };
  if (clip.top <= -W + 1) clip.top = -OFF;
  if (clip.left <= -W + 1) clip.left = -OFF;
  if (clip.right >= 2 * W - 1) clip.right = OFF;
  if (clip.bottom >= 2 * W - 1) clip.bottom = OFF;
  camera.style.clipPath = insetOf(x, y, k, WINDOW.width, WINDOW.height, clip);
  // The hero's second window, framed as the first, showing while the hero is (until the gap after
  // it's under way, as its caption fades).
  if (altCamera) {
    altCamera.style.transform = camera.style.transform;
    altCamera.style.clipPath = camera.style.clipPath;
  }
  placeSecond(a, b, fa, fb, u, t, within, { x, y, k });
  stage.classList.toggle('on-hero', a.dataset.side === 'below' && t < 0.2);
  if (!wide.matches) for (const step of steps) if (captionOf(step)) captionOf(step).style.setProperty('--narrow-top', `${narrowLayout(step).captionTop}px`);
  placeAgent(x, { top: Math.max(y, clip.top), bottom: Math.min(y + WINDOW.height * k, clip.bottom) }, k, clip);
  const ca = chatAt(a);
  const cb = chatAt(b);
  const at = { x: lerp(ca.x, cb.x, u), y: lerp(ca.y, cb.y, u), scale: lerp(ca.scale ?? 1, cb.scale ?? 1, u) };
  placeChat(x, y, k, clip, at);
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
    if (plays(built)) {
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
// Wide and narrow place the chat's window differently (a narrow screen keeps it by the app
// window's edge), so crossing between them builds the scene again.
wide.addEventListener('change', () => {
  sides.clear();
  for (const step of steps) if (captionOf(step) && !['below', 'none'].includes(step.dataset.side)) captionOf(step).dataset.side = step.dataset.side;
  if (!demo?.setShots) return;
  demo.setShots(wide.matches);
  focuses.clear();
  chatPlaces.clear();
  shown.clear();
  for (const [name, focus] of Object.entries(demo.focusHints())) focuses.set(name, focus);
  built = null;
  wanted = null;
  render();
});
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

// --- The agent's side (SmartSpec's) ----------------------------------------------------------

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
// Wide, it's drawn at the app window's scale, as the chat's window is, so its text is the app's size.
function placeAgent(x, shown, k, clip) {
  if (!agentWindow) return;
  agentWindow.style.left = wide.matches ? `${Math.max(x, clip.left === -OFF ? 0 : clip.left) + 32}px` : '';
  agentWindow.style.scale = wide.matches ? String(k) : '';
  agentWindow.style.top = wide.matches ? '' : `${shown.top + (shown.bottom - shown.top) * 0.4}px`;
  agentWindow.style.height = wide.matches ? '' : `${(shown.bottom - shown.top) * 0.6 - EDGE}px`;
}

// --- The chat's window (SmartDoc's) -----------------------------------------------------------

// Placed as the app's window is, at its place beside it (in the app window's pixels, scaled with
// it), cut off where the app's window is (clip), showing while the demo says.
function placeChat(x, y, k, clip, at) {
  if (!chatCamera) return;
  const cx = x + at.x * k;
  const cy = y + at.y * k;
  const ck = k * at.scale;
  chatCamera.style.transform = `translate(${cx}px, ${cy}px) scale(${ck})`;
  chatCamera.style.clipPath = insetOf(cx, cy, ck, CHAT.width, CHAT.height, clip);
  chatCamera.classList.toggle('shown', chatShown);
}

// --- Progress ------------------------------------------------------------------------------

// The progress dots: one per captioned scene, on the side of the scene's caption. Scenes passed are
// filled, the current one fills as the page scrolls through its step, and the next takes over half
// way through the gap. Hidden before the first and after the last. A step with its caption below
// (the home page's hero) isn't one of them: it has a dot of its own, long, on the left, filling as
// the page scrolls through it.
const chapters = steps.filter((step) => !plays(step));
const progress = [...stage.querySelectorAll('.progress')];
for (const set of progress) set.append(...chapters.map(() => Object.assign(document.createElement('span'), { className: 'dot' })));
const ownDot = Object.assign(document.createElement('span'), { className: 'dot current' });
const ownProgress = Object.assign(document.createElement('div'), { className: 'progress' });
ownProgress.dataset.side = 'left';
ownProgress.setAttribute('aria-hidden', 'true');
ownProgress.append(ownDot);
stage.append(ownProgress);
function track(from, to, t, within) {
  const step = steps[t >= 0.5 ? to : from];
  const current = chapters.indexOf(step);
  const fill = t === 0 ? clamp(within) : t >= 0.5 ? 0 : 1;
  const placed = current === -1 ? null : sideOf(step);
  const side = placed === 'top' || placed === 'bottom' ? 'left' : placed; // a caption across the top or foot has its dots on the left
  const own = step.dataset.side === 'below';
  ownProgress.classList.toggle('shown', own);
  if (own) ownDot.style.setProperty('--fill', fill.toFixed(3));
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

// The chat's page loads beside the app's; the demo starts it once both have.
const chatLoaded = new Promise((resolve) => {
  const chatFrame = chatCamera?.querySelector('iframe');
  if (!chatFrame || location.protocol === 'file:') return resolve(null);
  if (chatFrame.contentDocument?.readyState === 'complete' && chatFrame.contentWindow.startChat) return resolve(chatFrame);
  chatFrame.addEventListener('load', () => resolve(chatFrame));
});
frame.addEventListener('load', async () => {
  while (!frame.contentWindow.demo) await new Promise((resolve) => setTimeout(resolve, 50));
  const loaded = frame.contentWindow.demo;
  const chatFrame = await chatLoaded;
  if (chatFrame) {
    Object.assign(CHAT, loaded.chatPlace);
    await loaded.attachChat(chatFrame.contentWindow, loaded.chatPlace);
    loaded.onChatShown((on) => {
      chatShown = on;
      schedule();
    });
    // Dragged out of the way (in a scene that shows it can be), it goes with the drag.
    loaded.onChatMoved?.((at) => {
      if (at.scene) chatPlaces.set(at.scene, at);
      schedule();
    });
    chatFrame.classList.add('loaded');
  }
  demo = loaded;
  demo.setInstant(still.matches);
  demo.setShots?.(wide.matches);
  demo.onAgent?.(showAgent);
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
    if (!plays(step) && ms) step.style.minHeight = `calc(var(--stage-height) * 0.5 + ${Math.round(ms * PX_PER_MS)}px)`;
  }
  if (before.t === 0) {
    const r = steps[before.from].getBoundingClientRect();
    scrollTo(0, scrollY + r.top + r.height * before.within - innerHeight / 2);
  }
}

// The second window: how far it's in, where it goes, its demo loaded as the step comes near, and
// its scene playing while it shows.
function playSecond() {
  secondDemo?.show(secondCamera.dataset.scene).then((focus) => focus && secondDemo.start());
}
function placeSecond(a, b, fa, fb, u, t, within, first) {
  if (!secondCamera) return;
  const near = steps.findIndex(twoWindows) - steps.indexOf(a);
  const secondFrame = secondCamera.querySelector('iframe');
  if (near <= 2 && secondFrame.dataset.src && location.protocol !== 'file:') {
    secondFrame.src = secondFrame.dataset.src;
    delete secondFrame.dataset.src;
  }
  const amount = (twoWindows(a) ? 1 - u : 0) + (twoWindows(b) ? u : 0);
  let shows = amount;
  if (wide.matches) {
    const to = (twoWindows(b) ? fb : fa).second;
    if (to) secondCamera.style.transform = `translate(${to.x + (1 - amount) * 80}px, ${to.y}px) scale(${to.k})`;
  } else {
    secondCamera.style.transform = `translate(${first.x}px, ${first.y}px) scale(${first.k})`;
    secondCamera.style.clipPath = camera.style.clipPath;
    shows = t === 0 && twoWindows(a) && within > 0.5 ? 1 : 0;
  }
  secondCamera.style.opacity = shows.toFixed(3);
  const showing = amount > 0.5;
  if (showing && !secondShowing) playSecond();
  secondShowing = showing;
}
secondCamera?.querySelector('iframe').addEventListener('load', async (e) => {
  const secondFrame = e.currentTarget;
  if (!secondFrame.src) return;
  while (!secondFrame.contentWindow.demo) await new Promise((resolve) => setTimeout(resolve, 50));
  secondDemo = secondFrame.contentWindow.demo;
  secondDemo.setInstant(still.matches);
  secondFrame.classList.add('loaded');
  if (secondShowing) playSecond();
});

// The hero's tool: 'improve' shows the first window (its scene the hero step's), anything else the
// second (its scene in its data-scene), each sliding in as the other slides out, the way they go
// (stage.dataset.hero, in story.css). The window coming in plays its moment again.
let altDemo = null;
function showHero(tool) {
  stage.dataset.hero = tool;
  if (tool === 'improve') {
    if (scene === steps[0]) window.story.replay();
  }
  else altDemo?.show(altCamera.dataset.scene).then((focus) => focus && altDemo.start());
}
altCamera?.querySelector('iframe').addEventListener('load', async (e) => {
  const altFrame = e.currentTarget;
  while (!altFrame.contentWindow.demo) await new Promise((resolve) => setTimeout(resolve, 50));
  altDemo = altFrame.contentWindow.demo;
  altDemo.setInstant(still.matches);
  await altDemo.show(altCamera.dataset.scene);
  altFrame.classList.add('loaded');
  if (stage.dataset.hero !== 'improve') altDemo.start();
});

// --- Phones and upright tablets: the story as stills -------------------------------------------

// Below 900px wide the story isn't played: the pinned window, framed for a narrow screen, cropped
// too much (the user's choice). Instead each step is a block of the page, its caption over a still
// of its scene, made from the demo (scripts/shots.mjs, site/shots/<scene>-dark.webp and -light.webp,
// as the visitor's system is), showing the part of the window the step's about. The live demo
// isn't loaded there at all: its frames load only on a wide screen.
const flat = Object.assign(document.createElement('div'), { className: 'story-flat' });
let lastScene = null;
for (const step of steps) {
  const name = step.dataset.scene;
  if (name === 'settle' || name === lastScene) continue;
  lastScene = name;
  const block = Object.assign(document.createElement('section'), { className: 'flat-step' });
  const caption = captionOf(step);
  if (caption) {
    const copy = caption.cloneNode(true);
    copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    copy.removeAttribute('style');
    block.append(copy);
  }
  const alt = caption?.querySelector('h2')?.textContent ?? '';
  block.append(stillOf(name, alt));
  if (step.dataset.windows && secondCamera) block.append(stillOf(secondCamera.dataset.scene, alt));
  flat.append(block);
}
stage.closest('.story').after(flat);
function stillOf(scene, alt) {
  const picture = document.createElement('picture');
  const dark = Object.assign(document.createElement('source'), { srcset: `shots/${scene}-dark.webp`, media: '(prefers-color-scheme: dark)' });
  const img = Object.assign(document.createElement('img'), { src: `shots/${scene}-light.webp`, alt, loading: 'lazy', decoding: 'async' });
  picture.append(dark, img);
  return picture;
}
function loadDemos() {
  if (!wide.matches || location.protocol === 'file:') return;
  for (const f of [frame, chatCamera?.querySelector('iframe'), altCamera?.querySelector('iframe')]) {
    if (!f?.dataset.src) continue;
    f.src = f.dataset.src;
    delete f.dataset.src;
  }
}
loadDemos();
wide.addEventListener('change', loadDemos);

window.story = {
  get scene() { return scene; },
  steps,
  showHero,
  // Builds the current step's scene again (after a page changes it).
  replay() {
    wanted = null;
    built = null;
    render();
  },
};
