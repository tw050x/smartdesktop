import { edgeId } from '../main/items.js';
import { pinOffset } from './canvas-view.js';
import { layoutFlow, layoutSequence } from './layout.js';
import { inlineMarkdown, renderMarkdown } from './markdown.js';

// Each kind of item's way of rendering. Whatever the kind, a part that can be linked to has
// data-part, and one that links elsewhere calls `onLink`. Labels are drawn as plain text, so a
// diagram can't carry a script; images go in an <img>, where an SVG's scripts don't run.

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
const WRAP = 24;
const context = document.createElement('canvas').getContext('2d');

// A label broken over a few lines, at the words.
function linesOf(label) {
  const lines = [];
  for (const word of String(label).split(/\s+/)) {
    if (lines.length && `${lines.at(-1)} ${word}`.length <= WRAP) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}
function measure(label) {
  context.font = FONT;
  const lines = linesOf(label);
  return { width: Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width))), height: lines.length * LINE };
}
function text(label, x, y, className) {
  const lines = linesOf(label);
  const element = svg('text', { x, y: y - ((lines.length - 1) * LINE) / 2, class: className, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  lines.forEach((line, index) => {
    const span = svg('tspan', { x, dy: index ? LINE : 0 });
    span.textContent = line;
    element.append(span);
  });
  return element;
}

function linkPart(element, target, onLink) {
  if (!target) return;
  element.classList.add('part-link');
  element.setAttribute('role', 'link');
  element.setAttribute('tabindex', '0');
  element.addEventListener('click', () => onLink(target));
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onLink(target);
  });
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

function edgeLabel(label, x, y) {
  const size = measure(label);
  return [
    svg('rect', { x: x - size.width / 2 - 4, y: y - size.height / 2 - 2, width: size.width + 8, height: size.height + 4, rx: 4, class: 'diagram-label-bg' }),
    text(label, x, y, 'diagram-label'),
  ];
}

function flowView(item, onLink) {
  const layout = layoutFlow(item, measure);
  const { root, arrow } = canvas(layout.width, layout.height);
  for (const edge of layout.edges) {
    const group = svg('g', { class: 'diagram-edge', 'data-part': edgeId(edge) }, svg('path', { d: route(edge.points), class: 'diagram-line', 'marker-end': arrow }), svg('path', { d: route(edge.points), class: 'diagram-hit' }));
    if (edge.label) group.append(...edgeLabel(edge.label, edge.labelX, edge.labelY));
    linkPart(group, edge.link, onLink);
    root.append(group);
  }
  for (const node of layout.nodes) {
    const group = svg('g', { class: 'diagram-node', 'data-part': node.id },
      svg('rect', { x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height, rx: 8, class: 'diagram-box' }),
      text(node.label, node.x, node.y, 'diagram-text'));
    linkPart(group, node.link, onLink);
    root.append(group);
  }
  return root;
}

const GROUP_WORDS = { loop: 'loop', alt: 'alternative', opt: 'optional', par: 'parallel', critical: 'critical', break: 'break', group: 'group' };

function groupView(group) {
  const word = GROUP_WORDS[group.kind];
  context.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const tab = Math.ceil(context.measureText(word).width) + 14;
  const title = svg('text', { x: group.left + tab + 8, y: group.top + 11, class: 'diagram-label', 'dominant-baseline': 'central' });
  title.textContent = group.label ?? '';
  const tag = svg('text', { x: group.left + 7, y: group.top + 11, class: 'diagram-group-word', 'dominant-baseline': 'central' });
  tag.textContent = word;
  const element = svg('g', { class: `diagram-group ${group.kind}`, 'data-part': group.id },
    svg('rect', { x: group.left, y: group.top, width: group.right - group.left, height: group.bottom - group.top, rx: 4, class: 'diagram-group-frame' }),
    svg('path', { d: `M${group.left} ${group.top + 22}H${group.left + tab}L${group.left + tab + 6} ${group.top + 14}V${group.top}H${group.left + 4}Q${group.left} ${group.top} ${group.left} ${group.top + 4}Z`, class: 'diagram-group-tab' }),
    tag, title);
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

// How far below the pinned heads what scrolls under them takes to fade out, in the drawing's units.
const FADE = 28;
let fades = 0;

function sequenceView(item, onLink) {
  const layout = layoutSequence(item, measure);
  const { root, arrow } = canvas(layout.width, layout.height);
  // The heads say what each column is, so they're drawn last and stay in view as the canvas moves
  // down (see onView below). The lifelines and everything else stay where they are.
  const headsTop = layout.boxes.length ? 2 : layout.headTop + 4;
  const headsBottom = layout.headTop + 4 + HEAD_BOX;
  const heads = svg('g', { class: 'diagram-heads' });
  for (const box of layout.boxes) {
    const group = svg('g', { class: 'diagram-box-group', 'data-part': box.id },
      svg('rect', { x: box.left, y: 2, width: box.right - box.left, height: layout.height - 6, rx: 8, class: 'diagram-participants-box' }), svg('rect', { x: box.left, y: 2, width: box.right - box.left, height: 22, rx: 8, class: 'diagram-box-hit' }));
    if (box.label) heads.append(text(box.label, (box.left + box.right) / 2, 13, 'diagram-label'));
    linkPart(group, box.link, onLink);
    root.append(group);
  }
  for (const one of layout.participants) {
    const size = measure(one.label);
    const width = size.width + 24;
    const line = svg('g', {}, svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.height - 8, class: 'diagram-lifeline' }), svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.height - 8, class: 'diagram-hit' }));
    const head = svg('g', { class: 'diagram-node', 'data-part': one.id },
      svg('g', {}, svg('rect', { x: one.x - width / 2, y: layout.headTop + 4, width, height: HEAD_BOX, rx: 8, class: 'diagram-box' }), text(one.label, one.x, layout.headTop + 4 + HEAD_BOX / 2, 'diagram-text')));
    linkPart(line, one.link, onLink);
    linkPart(head, one.link, onLink);
    root.append(line);
    heads.append(head);
  }
  for (const bar of layout.activations) {
    const element = svg('rect', { x: bar.x - 5, y: bar.top, width: 10, height: bar.bottom - bar.top, rx: 2, class: 'diagram-activation', 'data-part': bar.id });
    linkPart(element, bar.link, onLink);
    root.append(element);
  }
  for (const group of layout.groups) {
    const element = groupView(group);
    linkPart(element, group.link, onLink);
    root.append(element);
  }
  for (const message of layout.messages) {
    const self = message.x1 === message.x2;
    const inset = message.x2 > message.x1 ? -2 : 2;
    const path = self
      ? `M${message.x1} ${message.y - 8}H${message.x1 + 36}V${message.y + 12}H${message.x1 + 2}`
      : `M${message.x1} ${message.y}H${message.x2 + inset}`;
    const labelX = self ? message.x1 + 36 : (message.x1 + message.x2) / 2;
    const group = svg('g', { class: 'diagram-edge', 'data-part': message.id },
      svg('path', { d: path, class: `diagram-line${message.reply ? ' reply' : ''}`, 'marker-end': arrow }),
      svg('path', { d: path, class: 'diagram-hit' }),
      ...edgeLabel(message.label, labelX, message.y - 12));
    linkPart(group, message.link, onLink);
    root.append(group);
  }
  // Pinned, the heads have nothing behind them: what scrolls under them fades out instead, through a
  // mask over everything else that's clear until they pin, then hides what's behind them and fades
  // to nothing just below.
  const id = `heads-fade-${++fades}`;
  const top = headsTop - 8;
  const fadeTo = headsBottom + FADE;
  const fading = svg('rect', { x: -20000, y: top, width: 40000 + layout.width, height: fadeTo - top, fill: `url(#${id}-gradient)`, visibility: 'hidden' });
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

function tableView(item, onLink) {
  const table = document.createElement('table');
  table.className = 'item-table';
  const head = table.createTHead().insertRow();
  for (const column of item.columns) {
    const cell = document.createElement('th');
    cell.textContent = column.label;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of item.rows) {
    const line = body.insertRow();
    line.dataset.part = row.id;
    for (const column of item.columns) inlineMarkdown(line.insertCell(), row.cells?.[column.id] ?? '');
    linkPart(line, row.link, onLink);
  }
  const holder = document.createElement('div');
  holder.className = 'item-table-holder';
  holder.append(table);
  return holder;
}

function imageView(item) {
  const image = document.createElement('img');
  image.className = 'item-image';
  image.alt = item.alt ?? item.title;
  image.src = `data:${item.mediaType};base64,${item.data}`;
  return image;
}

function documentView(item) {
  const element = document.createElement('div');
  renderMarkdown(element, item.markdown);
  return element;
}

const VIEWS = { document: documentView, flow: flowView, sequence: sequenceView, table: tableView, image: imageView };

// An item's view. `onLink(target)` follows a link, in the form it's written.
export function itemView(item, onLink) {
  const view = VIEWS[item.kind](item, onLink);
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
