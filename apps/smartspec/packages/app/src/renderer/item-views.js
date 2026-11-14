import { edgeId } from '../main/items.js';
import { pinOffset } from './canvas-view.js';
import { hideHoverCard, showHoverCard } from './hover-card.js';
import { GROUP_WORDS, layoutFlow, layoutSequence } from './layout.js';
import { inlineMarkdown, renderMarkdown } from './markdown.js';
import { diffText } from './word-diff.js';

// Each kind of item's way of rendering. Whatever the kind, a part that can be linked to has
// data-part, and one that links elsewhere has an arrow that calls `onLink` (see linkPart). Labels are drawn as plain text, so a
// diagram can't carry a script; images go in an <img>, where an SVG's scripts don't run.
//
// Under review, a diagram or table can be drawn as both versions together (see item-diffs.js):
// `diff` marks each part that changed, as a class on it (change-added, change-removed, change-changed),
// what's removed faded where it was, and in a sequence a whole row that's new or gone banded across.

// The class that marks a part's change, if any, and what a changed one said before, as its tooltip.
const diffClass = (diff, id) => (diff?.status.get(id) ? ` change-${diff.status.get(id)}` : '');
function wasTitle(diff, id, element) {
  const before = diff?.was.get(id);
  if (before == null) return element;
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = `Was: ${before}`;
  element.prepend(title);
  return element;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attributes = {}, ...children) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined && value !== null) element.setAttribute(key, value);
  element.append(...children);
  return element;
}

const HEAD_BOX = 36;
const FONT = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const LINE = 18;
const WRAP = 32; // characters on a label's line before it wraps: roomy, as the user wanted the diagrams
const context = document.createElement('canvas').getContext('2d');

// A label broken over a few lines, at the words, about `wrap` characters each.
function linesOf(label, wrap = WRAP) {
  const lines = [];
  for (const word of String(label).split(/\s+/)) {
    if (lines.length && `${lines.at(-1)} ${word}`.length <= wrap) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}
function measure(label, { oneLine = false, wrap = WRAP } = {}) {
  context.font = FONT;
  const lines = oneLine ? [String(label)] : linesOf(label, wrap);
  return { width: Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width))), height: lines.length * LINE };
}
function text(label, x, y, className, wrap = WRAP, anchor = 'middle') {
  const lines = linesOf(label, wrap);
  const element = svg('text', { x, y: y - ((lines.length - 1) * LINE) / 2, class: className, 'text-anchor': anchor, 'dominant-baseline': 'central' });
  lines.forEach((line, index) => {
    const span = svg('tspan', { x, dy: index ? LINE : 0 });
    span.textContent = line;
    element.append(span);
  });
  return element;
}

// A part that links somewhere is outlined in blue; only its arrow (`linkIcon`) follows the link, the
// one way to follow a link in any diagram or table (the user's choice: clicking a whole linked box
// and clicking an arrow beside another were two ways, and confusing).
function linkPart(element, target) {
  if (target) element.classList.add('part-link');
}

let arrows = 0;
function canvas(width, height) {
  const id = `arrow-${++arrows}`;
  const root = svg('svg', { class: 'diagram-svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' },
    svg('defs', {}, svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, svg('path', { d: 'M0 0L10 5L0 10Z', class: 'diagram-arrow' }))));
  return { root, arrow: `url(#${id})` };
}

// A path through the points, with its corners rounded. It stays close to each point, as a
// connection's label sits on one of them.
const CORNER = 14;
export function route(points) {
  let path = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [before, at, after] = [points[i - 1], points[i], points[i + 1]];
    const toward = (other) => {
      const length = Math.hypot(other.x - at.x, other.y - at.y) || 1;
      const reach = Math.min(CORNER, length / 2) / length;
      return `${at.x + (other.x - at.x) * reach} ${at.y + (other.y - at.y) * reach}`;
    };
    path += `L${toward(before)}Q${at.x} ${at.y} ${toward(after)}`;
  }
  const last = points.at(-1);
  return `${path}L${last.x} ${last.y}`;
}

// A connection's label on a grey card, centred on (x, y), or with its left end there if `from` is
// 'left'. Its lines are left-aligned on the card.
const LABEL_PAD = 6;
// A link (`follow`) puts its arrow at the card's right.
function edgeLabel(label, x, y, from = 'middle', follow = null) {
  const words = measure(label);
  const size = { ...words, width: words.width + (follow ? (words.width ? LINK_ROOM : 12) : 0) };
  const left = from === 'left' ? x : x - size.width / 2;
  const lines = linesOf(label);
  const texts = svg('text', { x: left, y: y - ((lines.length - 1) * LINE) / 2, class: 'diagram-label', 'text-anchor': 'start', 'dominant-baseline': 'central' });
  lines.forEach((line, index) => {
    const span = svg('tspan', { x: left, dy: index ? LINE : 0 });
    span.textContent = line;
    texts.append(span);
  });
  return [
    svg('rect', { x: left - LABEL_PAD, y: y - size.height / 2 - 3, width: size.width + 2 * LABEL_PAD, height: size.height + 6, rx: 4, class: 'diagram-label-bg' }),
    texts,
    ...(follow ? [linkIcon(left + size.width - 6, y - (size.height - LINE) / 2, follow)] : []),
  ];
}

// A flow diagram: its boxes and the connections between them, each box by its label, on one line
// unless it's long (the user's choice: `NODE_WRAP`), left-aligned, so opening a box never moves it
// (the user's choice: centred, it moved as the box widened). A box's description shows under its label with
// Details on (`details`, the button beside the zoom), or for a box opened on its own (`opened`,
// `onToggle`): a click anywhere on its header, its label's row with the arrow before it, opens or
// closes it (the user's choice: only the arrow did, and a click elsewhere followed its link). A box's
// link is an icon at its header's right (`linkIcon`); a box with no arrow follows it on a click
// anywhere, as before. A connection's description shows under its label with Details on. Under review the descriptions carry their changes:
// words removed struck through in red, words added in green, and a label that changed its old one,
// struck through, above (the user's choice: one way to read what changed, in place).
const DESC_FONT = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DESC_LINE = 16;
const DESC_WRAP = 44; // characters on a description's line
const DESC_GAP = 8; // between a label and what's under it
const TOGGLE = 20; // room for the arrow that opens a box
const LINK_ROOM = 22; // room for a box's link icon
const NODE_PADDING_X = 16; // a box's room either side of its content (NODE_PADDING in layout.js)
const NODE_WRAP = 60; // characters on a box's label's line: one line unless it's long
const nodeMeasure = (label) => measure(label, { wrap: NODE_WRAP });
// A changed box, open, has its own switch along its bottom (the user's choice: the marked words can
// be hard to read): its version before, its changes marked, or its version after, for it alone.
const BOX_VIEWS = [['before', 'Before'], ['changes', 'Changed'], ['after', 'After']];
// Before shows the old words with those removed in red; After the new with those added in green;
// Changed both, the removed struck through (the user's choice).

const SWITCH_FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const SWITCH_HEIGHT = 20;
const SWITCH_PAD = 9; // each segment's room either side of its word

function flowView(item, onLink, diff = null, { details = false, opened = new Set(), onToggle = null, boxViews = {}, onBoxView = null } = {}) {
  // Whether a part's change shows in its words (its label or description), so it can be switched.
  const switchable = (id) => {
    const change = diff?.parts?.get(id);
    return diff?.status.get(id) === 'changed' && (change.before.label !== change.after.label || (change.before.description ?? '') !== (change.after.description ?? ''));
  };
  // The whole item shown before or after (its switch, see sideDiff) shows every box that way, with no
  // switch of its own; otherwise each changed box has its own.
  const viewOf = (id) => (switchable(id) ? diff.side ?? boxViews[id] ?? 'changes' : null);
  // The label a box shows: its old one, switched to Before.
  const labelOf = (node) => (viewOf(node.id) === 'before' ? diff.parts.get(node.id).before.label : node.label);
  // What shows under each part's label when it's open: lines of pieces, each with its kind of change.
  const extraOf = (id, part) => {
    const change = diff?.parts?.get(id);
    const status = diff?.status.get(id);
    const view = viewOf(id);
    if (view === 'before' || view === 'after') return wrapPieces(sidePieces(change.before.description ?? '', change.after.description ?? '', view));
    const lines = [];
    if (status === 'changed' && change.before.label && change.before.label !== change.after.label) lines.push([{ text: change.before.label, kind: 'removed' }]);
    const description = status === 'changed' ? markedPieces(change.before.description ?? '', change.after.description ?? '') : part.description ? [{ text: part.description, kind: null }] : [];
    lines.push(...wrapPieces(description));
    return lines;
  };
  context.font = SWITCH_FONT;
  const segments = BOX_VIEWS.map(([view, word]) => ({ view, word, width: Math.ceil(context.measureText(word).width) + 2 * SWITCH_PAD }));
  const switchWidth = segments.reduce((sum, one) => sum + one.width, 0) + 4;
  const extras = new Map();
  for (const node of item.nodes) {
    const lines = extraOf(node.id, node);
    if (lines.length || switchable(node.id)) extras.set(node.id, lines);
  }
  const edgeExtras = new Map();
  if (details) {
    for (const edge of item.edges ?? []) {
      const lines = extraOf(edgeId(edge), edge);
      if (lines.length) edgeExtras.set(edgeId(edge), lines);
    }
  }
  const isOpen = (id) => (extras.has(id) || switchable(id)) && (details || opened.has(id));
  const hasSwitch = (id) => Boolean(onBoxView) && !diff?.side && isOpen(id) && switchable(id);
  const toggles = !details && Boolean(onToggle);
  const extraSize = (lines) => {
    context.font = DESC_FONT;
    return { width: Math.ceil(Math.max(0, ...lines.map((line) => context.measureText(line.map((piece) => piece.text).join('')).width))), height: lines.length * DESC_LINE };
  };
  const nodeSize = (node) => {
    const label = nodeMeasure(labelOf(node));
    const width = label.width + (toggles && (extras.has(node.id) || switchable(node.id)) ? TOGGLE : 0) + (node.link ? LINK_ROOM : 0);
    if (!isOpen(node.id)) return { width, height: label.height };
    const more = extraSize(extras.get(node.id) ?? []);
    const room = hasSwitch(node.id) ? DESC_GAP + SWITCH_HEIGHT : 0;
    return { width: Math.max(width, more.width, hasSwitch(node.id) ? switchWidth : 0), height: label.height + (more.height ? DESC_GAP + more.height : 0) + room };
  };
  // A linked connection's card has its arrow at its right (see edgeLabel).
  const edgeSize = (edge) => {
    const words = edge.label ? measure(edge.label) : { width: 0, height: edge.link ? LINE : 0 };
    const label = { ...words, width: words.width + (edge.link ? (words.width ? LINK_ROOM : 12) : 0) };
    const lines = edgeExtras.get(edgeId(edge));
    if (!lines) return label;
    const more = extraSize(lines);
    return { width: Math.max(label.width, more.width), height: label.height + (label.height ? DESC_GAP : 0) + more.height };
  };

  const layout = layoutFlow(item, nodeMeasure, { nodeSize, edgeSize });
  const { root, arrow } = canvas(layout.width, layout.height);
  for (const edge of layout.edges) {
    const id = edgeId(edge);
    const group = svg('g', { class: `diagram-edge${diffClass(diff, id)}`, 'data-part': id }, svg('path', { d: route(edge.points), class: 'diagram-line', 'marker-end': arrow }), svg('path', { d: route(edge.points), class: 'diagram-hit' }));
    const lines = edgeExtras.get(id);
    const follow = edge.link ? followOf(edge.link, onLink) : null;
    if (lines) group.append(...edgeDetails(edge.label, lines, edge.labelX, edge.labelY, edgeSize(edge), follow));
    else if (edge.label || follow) group.append(...edgeLabel(edge.label ?? '', edge.labelX, edge.labelY, 'middle', follow));
    linkPart(group, edge.link);
    root.append(wasTitle(diff, id, group));
  }
  for (const node of layout.nodes) {
    const open = isOpen(node.id);
    const shownLabel = labelOf(node);
    const label = nodeMeasure(shownLabel);
    const top = node.y - node.height / 2;
    const left = node.x - node.width / 2;
    const labelY = open ? top + 12 + label.height / 2 : node.y;
    const firstLine = labelY - (label.height - LINE) / 2; // the icons sit beside the label's first line
    const toggleable = toggles && (extras.has(node.id) || switchable(node.id));
    const labelX = left + NODE_PADDING_X + (toggleable ? TOGGLE : 0);
    const group = svg('g', { class: `diagram-node${diffClass(diff, node.id)}${open ? ' open' : ''}`, 'data-part': node.id },
      svg('rect', { x: left, y: top, width: node.width, height: node.height, rx: 8, class: 'diagram-box' }));
    const words = text(shownLabel, labelX, labelY, 'diagram-text', NODE_WRAP, 'start');
    if (toggleable) {
      const headHeight = open ? 12 + label.height + DESC_GAP / 2 : node.height;
      group.append(boxHead(left, top, node.width, headHeight, words, left + 18, firstLine, open, () => onToggle(node.id)));
    } else group.append(words);
    if (open && extras.get(node.id)?.length) group.append(piecesText(extras.get(node.id), left + 12, labelY + label.height / 2 + DESC_GAP + DESC_LINE / 2));
    if (hasSwitch(node.id)) group.append(boxSwitch(segments, node.x, top + node.height - 8 - SWITCH_HEIGHT / 2, switchWidth, viewOf(node.id), (view) => onBoxView(node.id, view)));
    if (node.link) group.append(linkIcon(node.x + node.width / 2 - 16, firstLine, followOf(node.link, onLink)));
    linkPart(group, node.link);
    root.append(open ? group : wasTitle(diff, node.id, group));
  }
  return root;
}

// A changed box's own switch, centred on (x, y): Before, Changed, After. Choosing one never follows
// the box's link or moves the canvas.
function boxSwitch(segments, x, y, width, showing, onChoose) {
  const left = x - width / 2;
  const element = svg('g', { class: 'box-switch', role: 'group', 'aria-label': 'Show this box' },
    svg('rect', { x: left, y: y - SWITCH_HEIGHT / 2, width, height: SWITCH_HEIGHT, rx: 6, class: 'box-switch-bg' }));
  let at = left + 2;
  for (const { view, word, width: w } of segments) {
    const chosen = view === showing;
    const segment = svg('g', { class: `box-switch-option${chosen ? ' chosen' : ''}`, role: 'button', tabindex: '0', 'aria-pressed': String(chosen) },
      svg('rect', { x: at, y: y - SWITCH_HEIGHT / 2 + 2, width: w, height: SWITCH_HEIGHT - 4, rx: 4, class: 'box-switch-hit' }),
      Object.assign(svg('text', { x: at + w / 2, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'box-switch-word' }), { textContent: word }));
    const choose = (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (!chosen) onChoose(view);
    };
    segment.addEventListener('click', choose);
    segment.addEventListener('pointerdown', (event) => event.stopPropagation());
    segment.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') choose(event);
    });
    element.append(segment);
    at += w;
  }
  return element;
}

// A box's header, the `width` × `height` from (left, top): its label, with the arrow before it at
// (x, y), pointing right shut and down open. A click anywhere on it opens the box to its description,
// or closes it. Dragging from it still moves the canvas, and a long press there still comments on the
// box (neither is a click).
function boxHead(left, top, width, height, words, x, y, open, onClick) {
  const shape = open ? `M${x - 4} ${y - 2}L${x} ${y + 2}L${x + 4} ${y - 2}` : `M${x - 2} ${y - 4}L${x + 2} ${y}L${x - 2} ${y + 4}`;
  const element = svg('g', { class: 'diagram-toggle', role: 'button', tabindex: '0', 'aria-expanded': String(open), 'aria-label': open ? 'Close this box' : 'Open this box to its description' },
    svg('rect', { x: left, y: top, width, height, rx: 8, class: 'diagram-toggle-hit' }),
    words,
    svg('path', { d: shape, class: 'diagram-toggle-arrow' }));
  const toggle = (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick();
  };
  element.addEventListener('click', toggle);
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') toggle(event);
  });
  return element;
}

// Following a link, as its arrow does: `onLink(link)`, and what it goes to, for the arrow's hover card
// (`onLink.describe`, if the view gives one: see schemas.js).
const followOf = (link, onLink) => Object.assign(() => onLink(link), { describe: () => onLink.describe?.(link) });

// Pointing at a link's arrow shows where it goes, on the window's hover card (the user's choice: the
// arrow alone didn't say): what it goes to, its kind, and the part of it if the link is to one.
function showsWhereTo(element, follow) {
  const show = () => {
    const box = element.getBoundingClientRect();
    showHoverCard(element, async (card) => {
      const where = await follow.describe?.();
      if (!where) return;
      const line = (className, words) => Object.assign(document.createElement('div'), { className, textContent: words });
      card.replaceChildren(...[
        line('part-card-kind', 'Goes to'),
        line('part-card-title', where.title),
        where.part && line('part-card-text', where.part),
        where.kind && line('part-card-note', where.kind),
      ].filter(Boolean));
    }, { left: box.left, top: box.top, bottom: box.bottom, width: box.width }, 'part-card link-card');
  };
  element.addEventListener('pointerenter', show);
  element.addEventListener('focus', show);
  element.addEventListener('pointerleave', () => hideHoverCard());
  element.addEventListener('blur', () => hideHoverCard());
}

// A box's link, an icon (an arrow out of a corner) centred on (x, y): it brings what the box links to
// into view, as following any link does. Clicking it never opens or closes the box.
function linkIcon(x, y, onClick) {
  const element = svg('g', { class: 'diagram-link-icon', role: 'link', tabindex: '0', 'aria-label': 'Go to what this links to' },
    svg('rect', { x: x - 9, y: y - 9, width: 18, height: 18, rx: 4, class: 'diagram-link-hit' }),
    svg('path', { d: `M${x - 3.5} ${y + 3.5}L${x + 3.5} ${y - 3.5}M${x - 1.5} ${y - 3.5}H${x + 3.5}V${y + 1.5}`, class: 'diagram-link-arrow' }));
  const follow = (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick();
  };
  element.addEventListener('click', follow);
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') follow(event);
  });
  showsWhereTo(element, onClick);
  return element;
}

// Lines of pieces as SVG text, left-aligned at `x`, the first line's middle at `y`, each piece's
// change as its class (added, removed).
function piecesText(lines, x, y) {
  const element = svg('text', { x, y, class: 'diagram-desc', 'dominant-baseline': 'central' });
  lines.forEach((line, index) => {
    line.forEach((piece, at) => {
      const span = svg('tspan', { class: piece.kind ?? undefined, ...(at === 0 ? { x, dy: index ? DESC_LINE : 0 } : {}) });
      span.textContent = piece.text;
      element.append(span);
    });
  });
  return element;
}

// A connection's label and its description (Details on), on one grey card centred on (x, y).
function edgeDetails(label, lines, x, y, size, follow = null) {
  const left = x - size.width / 2;
  const top = y - size.height / 2;
  const elements = [svg('rect', { x: left - LABEL_PAD, y: top - 3, width: size.width + 2 * LABEL_PAD, height: size.height + 6, rx: 4, class: 'diagram-label-bg' })];
  let below = top;
  if (label) {
    const words = svg('text', { x: left, y: top + LINE / 2, class: 'diagram-label', 'text-anchor': 'start', 'dominant-baseline': 'central' });
    linesOf(label).forEach((line, index) => {
      const span = svg('tspan', { x: left, dy: index ? LINE : 0 });
      span.textContent = line;
      words.append(span);
    });
    elements.push(words);
    below = top + measure(label).height + DESC_GAP;
  }
  elements.push(piecesText(lines, left, below + DESC_LINE / 2));
  if (follow) elements.push(linkIcon(left + size.width - 6, top + LINE / 2, follow));
  return elements;
}

// `after` as pieces, with the words removed put back where they were (kind 'removed') and those
// added marked ('added').
function markedPieces(before, after) {
  const pieces = [];
  let at = 0;
  const plain = (to) => {
    if (to > at) pieces.push({ text: after.slice(at, to), kind: null });
    at = Math.max(at, to);
  };
  for (const change of diffText(before, after)) {
    for (const { removed, added, at: where } of change.parts) {
      plain(where);
      if (removed) {
        if (pieces.length && !/\s$/.test(pieces.at(-1).text)) pieces.push({ text: ' ', kind: null });
        pieces.push({ text: before.slice(removed.start, removed.end), kind: 'removed' }, { text: ' ', kind: null });
      }
      if (added) {
        plain(added.start);
        pieces.push({ text: after.slice(added.start, added.end), kind: 'added' });
        at = added.end;
      }
    }
  }
  plain(after.length);
  return pieces;
}

// One side of a change as pieces: `before` with the words removed marked ('gone'), or `after` with
// the words added marked ('added').
function sidePieces(before, after, side) {
  const text = side === 'before' ? before : after;
  const ranges = diffText(before, after).flatMap((change) => change.parts).map((part) => (side === 'before' ? part.removed : part.added)).filter(Boolean);
  const pieces = [];
  let at = 0;
  for (const { start, end } of ranges) {
    if (start > at) pieces.push({ text: text.slice(at, start), kind: null });
    pieces.push({ text: text.slice(start, end), kind: side === 'before' ? 'gone' : 'added' });
    at = end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), kind: null });
  return pieces;
}

// Pieces broken into lines at the words, about DESC_WRAP characters each, each word keeping its kind
// and whether a space came before it (so a change ending at a comma doesn't gain a space before it).
function wrapPieces(pieces) {
  const words = [];
  let spaced = false;
  for (const piece of pieces) {
    for (const [, space, word] of piece.text.matchAll(/(\s*)(\S+)/g)) {
      words.push({ text: word, kind: piece.kind, space: words.length > 0 && (spaced || space.length > 0) });
      spaced = false;
    }
    if (/\s$/.test(piece.text)) spaced = true;
  }
  const lines = [];
  let line = [];
  let length = 0;
  for (const word of words) {
    const gap = word.space && line.length ? 1 : 0;
    if (length && length + gap + word.text.length > DESC_WRAP && word.space) {
      lines.push(line);
      line = [];
      length = 0;
    }
    const last = line.at(-1);
    const space = word.space && line.length ? ' ' : '';
    if (last && last.kind === word.kind) last.text += space + word.text;
    else {
      if (space) line.push({ text: space, kind: null }); // a space between kinds is neither's
      line.push({ text: word.text, kind: word.kind });
    }
    length += space.length + word.text.length;
  }
  if (line.length) lines.push(line);
  return lines;
}

function groupView(group) {
  const word = GROUP_WORDS[group.kind];
  context.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const tab = Math.ceil(context.measureText(word).width) + 14;
  // Its title beside its tab, wrapped onto the lines under it as the layout wrapped it, in a header
  // that's only a line under it.
  const title = svg('text', { x: group.left + tab + 8, y: group.top + 11, class: 'diagram-label', 'dominant-baseline': 'central' });
  (group.titleLines ?? [group.label ?? '']).forEach((line, index) => {
    const span = svg('tspan', { x: index ? group.left + 8 : group.left + tab + 8, dy: index === 1 ? LINE + 6 : index ? LINE : 0 }); // clear of the tab (UNDER_TAB in layout.js)
    span.textContent = line;
    title.append(span);
  });
  const header = group.header != null && svg('line', { x1: group.left, x2: group.right, y1: group.header, y2: group.header, class: 'diagram-group-header' });
  const tag = svg('text', { x: group.left + 7, y: group.top + 11, class: 'diagram-group-word', 'dominant-baseline': 'central' });
  tag.textContent = word;
  const element = svg('g', { class: `diagram-group ${group.kind}`, 'data-part': group.id },
    svg('rect', { x: group.left, y: group.top, width: group.right - group.left, height: group.bottom - group.top, rx: 4, class: 'diagram-group-frame' }),
    svg('path', { d: `M${group.left} ${group.top + 22}H${group.left + tab}L${group.left + tab + 6} ${group.top + 14}V${group.top}H${group.left + 4}Q${group.left} ${group.top} ${group.left} ${group.top + 4}Z`, class: 'diagram-group-tab' }),
    ...(header ? [header] : []), tag, title);
  for (const section of group.sections) {
    element.append(svg('line', { x1: group.left, x2: group.right, y1: section.y, y2: section.y, class: 'diagram-group-divider' }));
    if (section.label) {
      const words = svg('text', { x: (group.left + group.right) / 2, y: section.y + 12, class: 'diagram-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      words.textContent = `[${section.label}]`;
      element.append(words);
    }
  }
  return element;
}

// What each kind of group means, for its hover card and the key.
const GROUP_MEANINGS = {
  loop: 'Repeats what’s inside while its condition holds.',
  alt: 'Alternatives: only one of its sections happens, the first whose condition holds.',
  opt: 'Optional: what’s inside happens only if its condition holds.',
  par: 'Parallel: its sections happen at the same time.',
  critical: 'Critical: what’s inside happens as one, without anything coming between.',
  break: 'Break: if its condition holds, what’s inside happens and the rest of the sequence is skipped.',
  group: 'A group of steps, named for what they do together.',
};

// Pointing at a part of a sequence diagram shows what it is (see hover-card.js): its kind, what it
// says, what it means here, and anything the AI wrote about it. Not while the canvas is moved.
function watchSequenceHover(root, about) {
  const partAt = (event) => {
    const element = event.target.closest?.('[data-about], [data-part]');
    const id = element?.dataset.about ?? element?.dataset.part;
    return id && about.has(id) ? { element, info: about.get(id) } : null;
  };
  root.addEventListener('pointermove', (event) => {
    if (event.target.closest?.('.diagram-link-icon')) return; // its arrow says where it goes
    const found = partAt(event);
    if (!found || event.buttons || root.closest('.panning')) return hideHoverCard();
    showHoverCard(found.element, (card) => {
      const { kind, title, text: meaning, description, link } = found.info;
      const line = (className, words) => Object.assign(document.createElement('div'), { className, textContent: words });
      card.replaceChildren(...[
        line('part-card-kind', kind),
        title && line('part-card-title', title),
        meaning && line('part-card-text', meaning),
        description && line('part-card-note', description),
        link && line('part-card-text', 'It links to another part of this schematic: its arrow goes there.'),
      ].filter(Boolean));
    }, { x: event.clientX, y: event.clientY }, 'part-card');
  });
  root.addEventListener('pointerleave', () => hideHoverCard());
}

// The kinds of line and box a sequence diagram uses, for its key: only what's in it.
function sequenceKeyParts(item) {
  const messages = item.messages ?? [];
  const parts = ['participant', 'lifeline', 'message'];
  if (messages.some((message) => message.reply)) parts.push('reply');
  if (messages.some((message) => message.from === message.to)) parts.push('self');
  parts.push('label');
  if (item.activations?.length) parts.push('activation');
  if (item.boxes?.length) parts.push('box');
  for (const kind of Object.keys(GROUP_WORDS)) if ((item.groups ?? []).some((group) => group.kind === kind)) parts.push(`group:${kind}`);
  if ((item.groups ?? []).some((group) => group.sections?.length)) parts.push('section');
  parts.push('end');
  const linked = [item.participants, item.messages, item.activations, item.groups, item.boxes].some((list) => (list ?? []).some((part) => part.link));
  if (linked) parts.push('link');
  return parts;
}

// A sequence diagram's key: each kind of line and box it uses, drawn as it is in the diagram, with
// what it means.
export function sequenceKey(parts) {
  const W = 72;
  const H = 30;
  const swatch = (draw) => {
    const id = `key-arrow-${++arrows}`;
    const element = svg('svg', { class: 'diagram-svg key-swatch', viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' },
      svg('defs', {}, svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, svg('path', { d: 'M0 0L10 5L0 10Z', class: 'diagram-arrow' }))));
    element.append(...draw(`url(#${id})`));
    return element;
  };
  const frame = (word) => () => [
    svg('rect', { x: 2, y: 2, width: W - 4, height: H - 4, rx: 3, class: 'diagram-group-frame' }),
    svg('path', { d: `M2 15H${word.length * 6 + 10}L${word.length * 6 + 14} 10V2H4Q2 2 2 4Z`, class: 'diagram-group-tab' }),
    Object.assign(svg('text', { x: 6, y: 9, class: 'diagram-group-word', 'dominant-baseline': 'central' }), { textContent: word }),
  ];
  const ROWS = {
    participant: ['Participant', 'Someone or something that takes part: a person, a service or a part of the system.', () => [svg('rect', { x: 6, y: 4, width: W - 12, height: H - 8, rx: 6, class: 'diagram-box' })]],
    lifeline: ['Lifeline', 'A participant’s line down the diagram. Time runs from top to bottom.', () => [svg('line', { x1: W / 2, x2: W / 2, y1: 2, y2: H - 2, class: 'diagram-lifeline' })]],
    message: ['Message', 'A call or message from one participant to another, in the order they happen.', (arrow) => [svg('path', { d: `M4 ${H / 2}H${W - 6}`, class: 'diagram-line', 'marker-end': arrow })]],
    reply: ['Reply', 'An answer to an earlier message, going back.', (arrow) => [svg('path', { d: `M${W - 4} ${H / 2}H6`, class: 'diagram-line reply', 'marker-end': arrow })]],
    self: ['Message to itself', 'Something a participant does itself, such as waiting or deciding.', (arrow) => [svg('path', { d: `M14 6H44V22H16`, class: 'diagram-line', 'marker-end': arrow }), svg('line', { x1: 14, x2: 14, y1: 0, y2: H, class: 'diagram-lifeline' })]],
    label: ['Label', 'Says what a message is, on a grey card beside its line.', () => [svg('rect', { x: 6, y: 7, width: W - 12, height: H - 14, rx: 4, class: 'diagram-label-bg' })]],
    activation: ['Activation', 'A participant busy with something, from the message that starts it to the one that ends it.', () => [svg('line', { x1: W / 2, x2: W / 2, y1: 0, y2: H, class: 'diagram-lifeline' }), svg('rect', { x: W / 2 - 5, y: 3, width: 10, height: H - 6, rx: 2, class: 'diagram-activation' })]],
    box: ['Box', 'Participants that belong together, such as the parts of one system.', () => [svg('rect', { x: 2, y: 2, width: W - 4, height: H - 4, rx: 6, class: 'diagram-participants-box' })]],
    section: ['Section', 'Divides a box into its sections, each with its condition in brackets.', () => [svg('rect', { x: 2, y: 2, width: W - 4, height: H - 4, rx: 3, class: 'diagram-group-frame' }), svg('line', { x1: 2, x2: W - 2, y1: H / 2, y2: H / 2, class: 'diagram-group-divider' })]],
    end: ['End of sequence', 'Where the sequence ends: the lifelines stop here.', () => [svg('rect', { x: 2, y: 6, width: W - 4, height: H - 12, rx: 4, class: 'diagram-end-box' })]],
    link: ['Link', 'Outlined in blue, with this arrow: it links to another part of this schematic. The arrow goes there.', () => [svg('g', { class: 'part-link' }, svg('rect', { x: 6, y: 4, width: W - 12, height: H - 8, rx: 6, class: 'diagram-box' })), svg('path', { d: `M${W - 22.5} ${H / 2 + 3.5}L${W - 15.5} ${H / 2 - 3.5}M${W - 20.5} ${H / 2 - 3.5}H${W - 15.5}V${H / 2 + 1.5}`, class: 'diagram-link-arrow' })]],
  };
  for (const [kind, word] of Object.entries(GROUP_WORDS)) ROWS[`group:${kind}`] = [`${word[0].toUpperCase()}${word.slice(1)} box`, `${GROUP_MEANINGS[kind]} Its condition is in its header.`, frame(word)];
  const list = document.createElement('dl');
  list.className = 'diagram-key';
  for (const part of parts) {
    const [name, meaning, draw] = ROWS[part];
    const term = document.createElement('dt');
    term.append(swatch(draw));
    const said = document.createElement('dd');
    said.append(Object.assign(document.createElement('strong'), { textContent: name }), Object.assign(document.createElement('span'), { textContent: meaning }));
    list.append(term, said);
  }
  return list;
}

// How far below the pinned heads what scrolls under them takes to fade out, in the drawing's units.
const FADE = 28;
let fades = 0;

function sequenceView(item, onLink, diff = null) {
  const layout = layoutSequence(item, measure);
  const { root, arrow } = canvas(layout.width, layout.height);
  // A row that's new or gone is banded across the whole diagram, behind what's in it: a message's,
  // or a box's (loop, alt and the like) from its top to its bottom.
  const band = (id, top, bottom, inBox = false) => svg('rect', { x: 0, y: top, width: layout.width, height: bottom - top, class: `change-band change-band-${diff.status.get(id)}${inBox ? ' change-row' : ''}`, 'data-about': id });
  // A part inside a box that's itself new or gone is in that box's band, so it isn't banded again.
  const order = new Map((item.messages ?? []).map((message, index) => [message.id, index]));
  const inBandedGroup = (id) => (item.groups ?? []).some((group) => group.id !== id && ['added', 'removed'].includes(diff?.status.get(group.id))
    && order.get(group.from) <= order.get(id) && order.get(id) <= order.get(group.to));
  const banded = (id) => ['added', 'removed'].includes(diff?.status.get(id)) && !inBandedGroup(id);
  // Its messages are still rows of their own, unshaded (the box's band shades them) until pointed at,
  // as each row of something new or gone is.
  const rowed = (id) => banded(id) || (['added', 'removed'].includes(diff?.status.get(id)) && inBandedGroup(id));
  // The heads say what each column is, so they're drawn last and stay in view as the canvas moves
  // down (see onView below). The lifelines and everything else stay where they are.
  const headsTop = layout.boxes.length ? 2 : layout.headTop + 4;
  const headsBottom = layout.headTop + 4 + HEAD_BOX;
  const heads = svg('g', { class: 'diagram-heads' });
  for (const box of layout.boxes) {
    const group = svg('g', { class: `diagram-box-group${diffClass(diff, box.id)}`, 'data-part': box.id },
      svg('rect', { x: box.left, y: 2, width: box.right - box.left, height: layout.end.top - 6, rx: 8, class: 'diagram-participants-box' }), svg('rect', { x: box.left, y: 2, width: box.right - box.left, height: 22, rx: 8, class: 'diagram-box-hit' }));
    if (box.label) heads.append(text(box.label, (box.left + box.right) / 2, 13, 'diagram-label'));
    if (box.link) heads.append(linkIcon(box.right - 14, 13, followOf(box.link, onLink)));
    linkPart(group, box.link);
    root.append(group);
  }
  for (const one of layout.participants) {
    const size = measure(one.label);
    // A linked participant has the link's icon at its right, as a flow diagram's box has (the user's
    // choice: the blue ring alone didn't say what it was).
    const width = size.width + 24 + (one.link ? LINK_ROOM : 0);
    const middle = layout.headTop + 4 + HEAD_BOX / 2;
    const line = svg('g', { class: `diagram-life${diffClass(diff, one.id)}`, 'data-about': one.id }, svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.end.top, class: 'diagram-lifeline' }), svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.end.top, class: 'diagram-hit' }));
    const head = svg('g', { class: `diagram-node${diffClass(diff, one.id)}`, 'data-part': one.id },
      svg('g', {}, svg('rect', { x: one.x - width / 2, y: layout.headTop + 4, width, height: HEAD_BOX, rx: 8, class: 'diagram-box' }), text(one.label, one.x - (one.link ? LINK_ROOM / 2 : 0), middle, 'diagram-text')));
    if (one.link) head.append(linkIcon(one.x + width / 2 - 16, middle - (size.height - LINE) / 2, followOf(one.link, onLink)));
    linkPart(head, one.link);
    root.append(line);
    heads.append(wasTitle(diff, one.id, head));
  }
  for (const bar of layout.activations) {
    const element = svg('rect', { x: bar.x - 5, y: bar.top, width: 10, height: bar.bottom - bar.top, rx: 2, class: `diagram-activation${diffClass(diff, bar.id)}`, 'data-part': bar.id });
    linkPart(element, bar.link);
    root.append(element);
    if (bar.link) root.append(linkIcon(bar.x + 16, bar.top + 9, followOf(bar.link, onLink)));
  }
  for (const group of layout.groups) {
    const element = groupView(group);
    if (diff?.status.get(group.id)) element.classList.add(`change-${diff.status.get(group.id)}`);
    if (banded(group.id)) element.prepend(band(group.id, group.top - 4, group.bottom + 4));
    if (group.link) element.append(linkIcon(group.right - 14, group.top + 11, followOf(group.link, onLink)));
    linkPart(element, group.link);
    root.append(wasTitle(diff, group.id, element));
  }
  // Each banded message's row, from above its label to below its line; rows of the same kind one
  // after another join into one band, a block that's new or gone.
  const rows = new Map();
  if (diff) {
    let previous = null;
    for (const message of layout.messages) {
      if (!rowed(message.id)) {
        previous = null;
        continue;
      }
      const self = message.x1 === message.x2;
      const height = measure(message.label).height;
      const labelTop = self ? message.y + 2 - height / 2 - 3 : message.y - 12 - (height - LINE) / 2 - height / 2 - 3;
      const row = { top: Math.min(labelTop, message.y - 10) - 6, bottom: message.y + (self ? 18 : 6) + 8, status: diff.status.get(message.id), inBox: !banded(message.id) };
      if (previous && previous.status === row.status) {
        const middle = (previous.bottom + row.top) / 2;
        previous.bottom = Math.max(previous.bottom, middle);
        row.top = Math.min(row.top, middle);
      }
      rows.set(message.id, row);
      previous = row;
    }
  }
  for (const message of layout.messages) {
    const self = message.x1 === message.x2;
    const inset = message.x2 > message.x1 ? -2 : 2;
    const path = self
      ? `M${message.x1} ${message.y - 8}H${message.x1 + 36}V${message.y + 12}H${message.x1 + 2}`
      : `M${message.x1} ${message.y}H${message.x2 + inset}`;
    // A message's label sits above its line, its lines all above it; a message to its own lifeline
    // has its label beside its loop, clear of the lifeline.
    const above = message.y - 12 - (measure(message.label).height - LINE) / 2;
    const row = rows.get(message.id);
    const follow = message.link ? followOf(message.link, onLink) : null;
    const group = svg('g', { class: `diagram-edge${diffClass(diff, message.id)}`, 'data-part': message.id },
      ...(row ? [band(message.id, row.top, row.bottom, row.inBox)] : []),
      svg('path', { d: path, class: `diagram-line${message.reply ? ' reply' : ''}`, 'marker-end': arrow }),
      svg('path', { d: path, class: 'diagram-hit' }),
      ...(self ? edgeLabel(message.label, message.x1 + 44, message.y + 2, 'left', follow) : edgeLabel(message.label, (message.x1 + message.x2) / 2, above, 'middle', follow)));
    linkPart(group, message.link);
    root.append(wasTitle(diff, message.id, group));
  }
  // Where the sequence ends: a box across the lifelines, which stop at it.
  const end = layout.end;
  root.append(svg('g', { class: 'diagram-end', 'data-part': 'end' },
    svg('rect', { x: end.left, y: end.top, width: end.right - end.left, height: end.height, rx: 6, class: 'diagram-end-box' }),
    text('End of sequence', (end.left + end.right) / 2, end.top + end.height / 2, 'diagram-end-text')));

  // What each part is, for its hover card and the diagram's key (see sequenceKey).
  const said = (label) => `“${label}”`;
  const names = new Map(layout.participants.map((one) => [one.id, one.label]));
  const messageNamed = new Map(layout.messages.map((message) => [message.id, message.label]));
  const about = new Map();
  for (const one of layout.participants) about.set(one.id, { kind: 'Participant', title: one.label, text: 'Takes part in the sequence. Its dashed lifeline runs down the diagram: what it sends and receives, in order, top to bottom.', description: one.description });
  for (const message of layout.messages) {
    const self = message.from === message.to;
    about.set(message.id, {
      kind: message.reply ? 'Reply' : self ? 'Message to itself' : 'Message',
      title: message.label,
      text: self ? `${names.get(message.from)} does this itself.` : message.reply ? `${names.get(message.from)} answers ${names.get(message.to)}.` : `${names.get(message.from)} calls or sends to ${names.get(message.to)}.`,
      description: message.description,
    });
  }
  for (const bar of layout.activations) {
    about.set(bar.id, {
      kind: 'Activation',
      title: names.get(bar.participant),
      text: `${names.get(bar.participant)} is busy with this, from ${said(messageNamed.get(bar.from))} to ${said(messageNamed.get(bar.to))}.`,
      description: bar.description,
    });
  }
  for (const group of layout.groups) about.set(group.id, { kind: GROUP_WORDS[group.kind], title: group.label, text: GROUP_MEANINGS[group.kind], description: group.description });
  for (const box of layout.boxes) about.set(box.id, { kind: 'Box', title: box.label, text: `Groups ${box.participants.map((id) => names.get(id)).join(', ')}, which belong together.`, description: box.description });
  about.set('end', { kind: 'End of sequence', text: 'Nothing happens after this.' });
  for (const part of [...layout.participants, ...layout.messages, ...layout.activations, ...layout.groups, ...layout.boxes]) {
    if (part.link && about.has(part.id)) about.get(part.id).link = true;
  }
  watchSequenceHover(root, about);
  root.keyParts = sequenceKeyParts(item);

  // Pinned, the heads have nothing behind them: what scrolls under them fades out instead, through a
  // mask over everything else that's clear until they pin, then hides what's behind them and fades
  // to nothing just below.
  const id = `heads-fade-${++fades}`;
  const top = headsTop - 8;
  const fadeTo = headsBottom + FADE;
  const fading = svg('g', { visibility: 'hidden' },
    svg('rect', { x: -20000, y: top, width: 40000 + layout.width, height: fadeTo - top, fill: `url(#${id}-gradient)` }),
    // And everything above them, so nothing shows through between the heads and the card's top.
    svg('rect', { x: -20000, y: top - 20000, width: 40000 + layout.width, height: 20000, fill: 'black' }));
  root.querySelector('defs').append(
    svg('linearGradient', { id: `${id}-gradient`, x1: 0, y1: 0, x2: 0, y2: 1 },
      svg('stop', { offset: 0, 'stop-color': 'black' }),
      svg('stop', { offset: (headsBottom + 4 - top) / (fadeTo - top), 'stop-color': 'black' }),
      svg('stop', { offset: 1, 'stop-color': 'white' })),
    svg('mask', { id, maskUnits: 'userSpaceOnUse', x: -20000, y: -20000, width: 40000 + layout.width, height: 40000 + layout.height },
      svg('rect', { x: -20000, y: -20000, width: 40000 + layout.width, height: 40000 + layout.height, fill: 'white' }),
      fading));
  const behind = svg('g', { mask: `url(#${id})` });
  behind.append(...[...root.children].filter((child) => child.tagName !== 'defs'));
  root.append(behind, heads);
  root.onView = (view) => {
    const moved = pinOffset(view, { top: headsTop, bottom: headsBottom, height: layout.height });
    heads.setAttribute('transform', `translate(0 ${moved})`);
    heads.classList.toggle('pinned', moved > 0);
    fading.setAttribute('transform', `translate(0 ${moved})`);
    fading.setAttribute('visibility', moved > 0 ? 'visible' : 'hidden');
  };
  return root;
}

function tableView(item, onLink, diff = null) {
  const table = document.createElement('table');
  table.className = 'item-table';
  const head = table.createTHead().insertRow();
  for (const column of item.columns) {
    const cell = document.createElement('th');
    cell.textContent = column.label;
    if (diff?.status.get(column.id)) cell.className = `change-${diff.status.get(column.id)}`;
    if (diff?.was.has(column.id)) cell.title = `Was: ${diff.was.get(column.id)}`;
    head.append(cell);
  }
  // Rows that link somewhere have their arrow in a narrow last column.
  const linked = item.rows.some((row) => row.link);
  if (linked) head.append(Object.assign(document.createElement('th'), { className: 'row-link' }));
  const body = table.createTBody();
  for (const row of item.rows) {
    const line = body.insertRow();
    line.dataset.part = row.id;
    if (['added', 'removed'].includes(diff?.status.get(row.id))) line.className = `change-${diff.status.get(row.id)}`;
    for (const column of item.columns) {
      const cell = line.insertCell();
      inlineMarkdown(cell, row.cells?.[column.id] ?? '');
      // A column that's new or gone is marked down its cells; a cell that changed shows what it held,
      // struck through, before what it holds now.
      const columnChange = diff?.status.get(column.id);
      if (columnChange === 'added' || columnChange === 'removed') cell.classList.add(`change-${columnChange}`);
      const before = diff?.cells?.get(row.id)?.get(column.id);
      if (before !== undefined) {
        cell.classList.add('change-changed');
        // Before or After alone shows only its own value, marked as changed (see sideDiff).
        if (diff.side) continue;
        const old = document.createElement('del');
        old.className = 'change-was';
        inlineMarkdown(old, before || '—');
        cell.prepend(old, ' ');
      }
    }
    if (linked) {
      const cell = line.insertCell();
      cell.className = 'row-link';
      if (row.link) cell.append(rowLinkButton(followOf(row.link, onLink)));
    }
    linkPart(line, row.link);
  }
  const holder = document.createElement('div');
  holder.className = 'item-table-holder';
  holder.append(table);
  return holder;
}

// A table row's link, as a diagram's (see linkIcon).
function rowLinkButton(onClick) {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'row-link-button' });
  button.setAttribute('aria-label', 'Go to what this links to');
  button.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="M5.5 12.5L12.5 5.5M7.5 5.5H12.5V10.5" class="diagram-link-arrow"/></svg>';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  showsWhereTo(button, onClick);
  return button;
}

function imageView(item) {
  const image = document.createElement('img');
  image.className = 'item-image';
  image.alt = item.alt ?? item.title;
  image.src = `data:${item.mediaType};base64,${item.data}`;
  return image;
}

// An image the proposal changes, as both together: the new one over the old, wiped away from the
// left by dragging the line between them (or pressing anywhere on it), to show the old one under it.
// It starts on the new one (the user's choice), the line at the left edge.
export function wipeView(after, before) {
  const holder = document.createElement('div');
  holder.className = 'image-wipe';
  const under = imageView(before);
  under.classList.add('image-wipe-before');
  const over = imageView(after);
  over.classList.add('image-wipe-after');
  const line = document.createElement('div');
  line.className = 'image-wipe-line';
  line.setAttribute('role', 'slider');
  line.setAttribute('aria-label', 'Wipe between the old image and the new one');
  line.setAttribute('aria-valuemin', '0');
  line.setAttribute('aria-valuemax', '100');
  line.tabIndex = 0;
  const label = (words, className) => Object.assign(document.createElement('span'), { className: `image-wipe-label ${className}`, textContent: words });
  holder.append(under, over, line, label('Before', 'before'), label('After', 'after'));
  const set = (fraction) => {
    const at = Math.max(0, Math.min(1, fraction));
    holder.style.setProperty('--wipe', `${at * 100}%`);
    line.setAttribute('aria-valuenow', String(Math.round(at * 100)));
  };
  set(0);
  const follow = (event) => {
    const box = holder.getBoundingClientRect();
    set((event.clientX - box.left) / box.width);
  };
  holder.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation(); // not a drag of the card it's in
    holder.setPointerCapture(event.pointerId);
    follow(event);
    const move = (m) => follow(m);
    const end = () => {
      holder.removeEventListener('pointermove', move);
      holder.removeEventListener('lostpointercapture', end);
    };
    holder.addEventListener('pointermove', move);
    holder.addEventListener('lostpointercapture', end);
  });
  line.addEventListener('keydown', (event) => {
    const now = Number(line.getAttribute('aria-valuenow')) / 100;
    if (event.key === 'ArrowRight') set(now + 0.05);
    else if (event.key === 'ArrowLeft') set(now - 0.05);
    else return;
    event.preventDefault();
  });
  return holder;
}

function documentView(item) {
  const element = document.createElement('div');
  renderMarkdown(element, item.markdown);
  return element;
}

const VIEWS = { document: documentView, flow: flowView, sequence: sequenceView, table: tableView, image: imageView };

// An item's view. `onLink(target)` follows a link, in the form it's written. `diff` (a diagram's or
// table's, from item-diffs.js) draws `item`, both versions together, with what changed marked.
// `options` go to the kind's view: a flow's Details and opened boxes (see flowView).
export function itemView(item, onLink, diff = null, options = undefined) {
  const view = VIEWS[item.kind](item, onLink, diff, options);
  if (view.classList.contains('diagram-svg')) {
    const holder = document.createElement('div');
    holder.className = 'diagram';
    holder.append(view);
    return holder;
  }
  return view;
}

// What an item is, as a person would say it.
const KIND_LABELS = { document: 'Markdown', flow: 'Flow diagram', sequence: 'Sequence diagram', table: 'Table' };
const IMAGE_LABELS = { 'image/svg+xml': 'SVG image', 'image/png': 'PNG image', 'image/jpeg': 'JPEG image', 'image/webp': 'WebP image' };
export const kindLabel = (item) => (item.kind === 'image' ? IMAGE_LABELS[item.mediaType] ?? 'Image' : KIND_LABELS[item.kind]);
