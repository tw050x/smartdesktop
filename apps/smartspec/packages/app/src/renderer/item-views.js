import { edgeId } from '../main/items.js';
import { pinOffset } from './canvas-view.js';
import { hideHoverCard, showHoverCard } from './hover-card.js';
import { GROUP_WORDS, layoutFlow, layoutSequence } from './layout.js';
import { inlineMarkdown, renderMarkdown } from './markdown.js';

// Each kind of item's way of rendering. Whatever the kind, a part that can be linked to has
// data-part, and one that links elsewhere calls `onLink`. Labels are drawn as plain text, so a
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

// A label broken over a few lines, at the words.
function linesOf(label) {
  const lines = [];
  for (const word of String(label).split(/\s+/)) {
    if (lines.length && `${lines.at(-1)} ${word}`.length <= WRAP) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}
function measure(label, { oneLine = false } = {}) {
  context.font = FONT;
  const lines = oneLine ? [String(label)] : linesOf(label);
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

// A connection's label on a grey card, centred on (x, y), or with its left end there if `from` is
// 'left'. Its lines are left-aligned on the card.
const LABEL_PAD = 6;
function edgeLabel(label, x, y, from = 'middle') {
  const size = measure(label);
  const left = from === 'left' ? x : x - size.width / 2;
  const lines = linesOf(label);
  const words = svg('text', { x: left, y: y - ((lines.length - 1) * LINE) / 2, class: 'diagram-label', 'text-anchor': 'start', 'dominant-baseline': 'central' });
  lines.forEach((line, index) => {
    const span = svg('tspan', { x: left, dy: index ? LINE : 0 });
    span.textContent = line;
    words.append(span);
  });
  return [
    svg('rect', { x: left - LABEL_PAD, y: y - size.height / 2 - 3, width: size.width + 2 * LABEL_PAD, height: size.height + 6, rx: 4, class: 'diagram-label-bg' }),
    words,
  ];
}

function flowView(item, onLink, diff = null) {
  const layout = layoutFlow(item, measure);
  const { root, arrow } = canvas(layout.width, layout.height);
  for (const edge of layout.edges) {
    const id = edgeId(edge);
    const group = svg('g', { class: `diagram-edge${diffClass(diff, id)}`, 'data-part': id }, svg('path', { d: route(edge.points), class: 'diagram-line', 'marker-end': arrow }), svg('path', { d: route(edge.points), class: 'diagram-hit' }));
    if (edge.label) group.append(...edgeLabel(edge.label, edge.labelX, edge.labelY));
    linkPart(group, edge.link, onLink);
    root.append(wasTitle(diff, id, group));
  }
  for (const node of layout.nodes) {
    const group = svg('g', { class: `diagram-node${diffClass(diff, node.id)}`, 'data-part': node.id },
      svg('rect', { x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height, rx: 8, class: 'diagram-box' }),
      text(node.label, node.x, node.y, 'diagram-text'));
    linkPart(group, node.link, onLink);
    root.append(wasTitle(diff, node.id, group));
  }
  return root;
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
    const found = partAt(event);
    if (!found || event.buttons || root.closest('.panning')) return hideHoverCard();
    showHoverCard(found.element, (card) => {
      const { kind, title, text: meaning, description } = found.info;
      const line = (className, words) => Object.assign(document.createElement('div'), { className, textContent: words });
      card.replaceChildren(...[
        line('part-card-kind', kind),
        title && line('part-card-title', title),
        meaning && line('part-card-text', meaning),
        description && line('part-card-note', description),
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
    linkPart(group, box.link, onLink);
    root.append(group);
  }
  for (const one of layout.participants) {
    const size = measure(one.label);
    const width = size.width + 24;
    const line = svg('g', { class: `diagram-life${diffClass(diff, one.id)}`, 'data-about': one.id }, svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.end.top, class: 'diagram-lifeline' }), svg('line', { x1: one.x, x2: one.x, y1: layout.head, y2: layout.end.top, class: 'diagram-hit' }));
    const head = svg('g', { class: `diagram-node${diffClass(diff, one.id)}`, 'data-part': one.id },
      svg('g', {}, svg('rect', { x: one.x - width / 2, y: layout.headTop + 4, width, height: HEAD_BOX, rx: 8, class: 'diagram-box' }), text(one.label, one.x, layout.headTop + 4 + HEAD_BOX / 2, 'diagram-text')));
    linkPart(line, one.link, onLink);
    linkPart(head, one.link, onLink);
    root.append(line);
    heads.append(wasTitle(diff, one.id, head));
  }
  for (const bar of layout.activations) {
    const element = svg('rect', { x: bar.x - 5, y: bar.top, width: 10, height: bar.bottom - bar.top, rx: 2, class: `diagram-activation${diffClass(diff, bar.id)}`, 'data-part': bar.id });
    linkPart(element, bar.link, onLink);
    root.append(element);
  }
  for (const group of layout.groups) {
    const element = groupView(group);
    if (diff?.status.get(group.id)) element.classList.add(`change-${diff.status.get(group.id)}`);
    if (banded(group.id)) element.prepend(band(group.id, group.top - 4, group.bottom + 4));
    linkPart(element, group.link, onLink);
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
    const group = svg('g', { class: `diagram-edge${diffClass(diff, message.id)}`, 'data-part': message.id },
      ...(row ? [band(message.id, row.top, row.bottom, row.inBox)] : []),
      svg('path', { d: path, class: `diagram-line${message.reply ? ' reply' : ''}`, 'marker-end': arrow }),
      svg('path', { d: path, class: 'diagram-hit' }),
      ...(self ? edgeLabel(message.label, message.x1 + 44, message.y + 2, 'left') : edgeLabel(message.label, (message.x1 + message.x2) / 2, above)));
    linkPart(group, message.link, onLink);
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
        const old = document.createElement('del');
        old.className = 'change-was';
        inlineMarkdown(old, before || '—');
        cell.prepend(old, ' ');
      }
    }
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
export function itemView(item, onLink, diff = null) {
  const view = VIEWS[item.kind](item, onLink, diff);
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
