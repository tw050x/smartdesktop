import { edgeId } from '../main/items.js';
import { pinOffset } from './canvas-view.js';
import { flowDetails, sequenceDetails } from './diagram-details.js';
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
function route(points) {
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
  const details = flowDetails(item);
  for (const edge of layout.edges) {
    const group = tipped(svg('g', { class: 'diagram-edge', 'data-part': edgeId(edge) }, svg('path', { d: route(edge.points), class: 'diagram-line', 'marker-end': arrow }), svg('path', { d: route(edge.points), class: 'diagram-hit' })), 'edge', edge.description, details.edge(edge));
    if (edge.label) group.append(...edgeLabel(edge.label, edge.labelX, edge.labelY));
    linkPart(group, edge.link, onLink);
    root.append(group);
  }
  for (const node of layout.nodes) {
    const group = tipped(svg('g', { class: 'diagram-node', 'data-part': node.id },
      svg('rect', { x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height, rx: 8, class: 'diagram-box' }),
      text(node.label, node.x, node.y, 'diagram-text')), 'node', node.description, details.node(node));
    linkPart(group, node.link, onLink);
    root.append(group);
  }
  return root;
}

// What each thing in a diagram means, for someone who hasn't read one before. The specifics of a
// particular one follow it: its name, what an AI said about it, and what the diagram's data says.
const MEANINGS = {
  participant: ['Participant', 'A person or system taking part.'],
  lifeline: ['Lifeline', 'The dashed line shows this participant over time, which runs from top to bottom.'],
  message: ['Message', 'One participant asks another to do something, and carries on once it’s been asked or answered.'],
  reply: ['Reply', 'The dashed arrow is an answer to an earlier message.'],
  self: ['Message to itself', 'The arrow looping back means this participant does this step itself.'],
  activation: ['Activation', 'The bar on the lifeline shows when this participant is busy working on something.'],
  box: ['Grouped participants', 'These participants belong together, such as being part of one service or team.'],
  loop: ['Loop', 'The steps inside this box repeat, for as long as its label says.'],
  alt: ['Alternatives', 'Only one of the sections in this box happens, depending on the condition each one states.'],
  opt: ['Optional', 'The steps inside this box only happen if its condition is true. Otherwise they’re skipped.'],
  par: ['In parallel', 'The sections in this box happen at the same time, rather than one after another.'],
  critical: ['Critical', 'The steps inside this box must finish together, without anything interrupting them.'],
  break: ['Break', 'If this happens, these steps run and the rest of the sequence stops.'],
  group: ['Group', 'A named set of steps that belong together. It doesn’t change what happens.'],
  node: ['Part', 'One part of the system.'],
  edge: ['Connection', 'The arrow shows this part using or passing something to the one it points at.'],
};
const specifics = new WeakMap();
const tipped = (element, meaning, description, details) => {
  element.dataset.tip = meaning;
  specifics.set(element, { description, ...details });
  return element;
};

const GROUP_WORDS = { loop: 'loop', alt: 'alternative', opt: 'optional', par: 'parallel', critical: 'critical', break: 'break', group: 'group' };

function groupView(group, details) {
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
  return tipped(element, group.kind, group.description, details.group(group));
}

function sequenceView(item, onLink) {
  const layout = layoutSequence(item, measure);
  const { root, arrow } = canvas(layout.width, layout.height);
  const details = sequenceDetails(item);
  // The heads say what each column is, so they're drawn last and stay in view as the canvas moves
  // down (see onView below). The lifelines and everything else stay where they are.
  const headsTop = layout.boxes.length ? 2 : layout.headTop + 4;
  const headsBottom = layout.headTop + 4 + HEAD_BOX;
  const heads = svg('g', { class: 'diagram-heads' },
    svg('rect', { x: -20000, y: headsTop - 8, width: 40000 + layout.width, height: headsBottom - headsTop + 16, class: 'diagram-heads-band' }));
  for (const box of layout.boxes) {
    const group = tipped(svg('g', { class: 'diagram-box-group', 'data-part': box.id },
      svg('rect', { x: box.left, y: 2, width: box.right - box.left, height: layout.height - 6, rx: 8, class: 'diagram-participants-box' }), svg('rect', { x: box.left, y: 2, width: box.right - box.left, height: 22, rx: 8, class: 'diagram-box-hit' })), 'box', box.description, details.box(box));
    if (box.label) heads.append(text(box.label, (box.left + box.right) / 2, 13, 'diagram-label'));
    linkPart(group, box.link, onLink);
    root.append(group);
  }
  for (const one of layout.participants) {
    const size = measure(one.label);
    const width = size.width + 24;
    const line = tipped(svg('g', {}, svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.height - 8, class: 'diagram-lifeline' }), svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.height - 8, class: 'diagram-hit' })), 'lifeline', one.description, details.participant(one));
    const head = svg('g', { class: 'diagram-node', 'data-part': one.id },
      tipped(svg('g', {}, svg('rect', { x: one.x - width / 2, y: layout.headTop + 4, width, height: HEAD_BOX, rx: 8, class: 'diagram-box' }), text(one.label, one.x, layout.headTop + 4 + HEAD_BOX / 2, 'diagram-text')), 'participant', one.description, details.participant(one)));
    linkPart(line, one.link, onLink);
    linkPart(head, one.link, onLink);
    root.append(line);
    heads.append(head);
  }
  for (const bar of layout.activations) {
    const element = tipped(svg('rect', { x: bar.x - 5, y: bar.top, width: 10, height: bar.bottom - bar.top, rx: 2, class: 'diagram-activation', 'data-part': bar.id }), 'activation', bar.description, details.activation(bar));
    linkPart(element, bar.link, onLink);
    root.append(element);
  }
  for (const group of layout.groups) {
    const element = groupView(group, details);
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
    const group = tipped(svg('g', { class: 'diagram-edge', 'data-part': message.id },
      svg('path', { d: path, class: `diagram-line${message.reply ? ' reply' : ''}`, 'marker-end': arrow }),
      svg('path', { d: path, class: 'diagram-hit' }),
      ...edgeLabel(message.label, labelX, message.y - 12)), self ? 'self' : message.reply ? 'reply' : 'message', message.description, details.message(message));
    linkPart(group, message.link, onLink);
    root.append(group);
  }
  root.append(heads);
  root.onView = (view) => {
    const moved = pinOffset(view, { top: headsTop, bottom: headsBottom, height: layout.height });
    heads.setAttribute('transform', `translate(0 ${moved})`);
    heads.classList.toggle('pinned', moved > 0);
  };
  return root;
}

// The tooltip: one for the window, following whatever's under the pointer. It lives outside the
// diagram, so nothing the diagram does can hide it: a click, a key or the AI can take the diagram
// away, or a pan can move the element off, with no event to say the pointer has left. So while it
// shows, every frame asks whether its element is still there and still under the pointer.
let tip = null;
let tipTarget = null;
let tipFrame = 0;
const checkTip = () => {
  if (tipTarget?.isConnected && tipTarget.matches(':hover')) tipFrame = requestAnimationFrame(checkTip);
  else hideTip();
};
function showTip(target, event) {
  tip ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'diagram-tip', hidden: true }));
  const [title, meaning] = MEANINGS[target.dataset.tip] ?? [];
  if (!title) return;
  const line = (className, textContent) => Object.assign(document.createElement('span'), { className, textContent });
  const { name, description, facts = [] } = specifics.get(target) ?? {};
  const specific = [name && line('diagram-tip-name', name), description && line('diagram-tip-said', description), ...facts.map((fact) => line('diagram-tip-fact', fact))].filter(Boolean);
  const here = Object.assign(document.createElement('div'), { className: 'diagram-tip-here' });
  here.append(...specific);
  tip.replaceChildren(Object.assign(document.createElement('strong'), { textContent: title }), line('diagram-tip-meaning', meaning), ...(specific.length ? [here] : []));
  tip.hidden = false;
  tipTarget = target;
  cancelAnimationFrame(tipFrame);
  tipFrame = requestAnimationFrame(checkTip);
  const gap = 14;
  const { width, height } = tip.getBoundingClientRect();
  const x = event.clientX + gap + width > innerWidth ? event.clientX - gap - width : event.clientX + gap;
  const y = event.clientY + gap + height > innerHeight ? event.clientY - gap - height : event.clientY + gap;
  Object.assign(tip.style, { left: `${Math.max(4, x)}px`, top: `${Math.max(4, y)}px` });
}
function hideTip() {
  cancelAnimationFrame(tipFrame);
  tipTarget = null;
  if (tip) tip.hidden = true;
}
function watchTips(root) {
  root.addEventListener('mousemove', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (target) showTip(target, event);
    else hideTip();
  });
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
    watchTips(holder);
    return holder;
  }
  return view;
}

// What an item is, as a person would say it.
const KIND_LABELS = { document: 'Markdown document', flow: 'Flow diagram', sequence: 'Sequence diagram', table: 'Table' };
const IMAGE_LABELS = { 'image/svg+xml': 'SVG image', 'image/png': 'PNG image', 'image/jpeg': 'JPEG image', 'image/webp': 'WebP image' };
export const kindLabel = (item) => (item.kind === 'image' ? IMAGE_LABELS[item.mediaType] ?? 'Image' : KIND_LABELS[item.kind]);
