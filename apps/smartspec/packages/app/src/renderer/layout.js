import dagre from '@dagrejs/dagre';
import { edgeId } from '../main/items.js';

// Where a flow diagram's nodes and connections go, worked out each time it's drawn: nothing about
// position is stored. This is the only place that knows about dagre, so it can be swapped.
// `measure(label)` gives a node or connection label's { width, height }.
const NODE_PADDING = { x: 16, y: 12 };

// Top to bottom unless told otherwise: tall diagrams spread what they link to down the page, where
// the side cards can line up with it, and wide ones squeeze the middle card.
// `nodeSize` and `edgeSize`, if given, size a box's or a connection label's content (a box open to its
// description is taller); otherwise each is its label, measured.
export function layoutFlow({ direction = 'TB', nodes, edges = [] }, measure, { nodeSize = null, edgeSize = null } = {}) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: direction, nodesep: 32, edgesep: 16, ranksep: 64, marginx: 8, marginy: 8 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    const size = nodeSize ? nodeSize(node) : measure(node.label);
    graph.setNode(node.id, { width: size.width + 2 * NODE_PADDING.x, height: size.height + 2 * NODE_PADDING.y });
  }
  for (const edge of edges) {
    const size = edgeSize ? edgeSize(edge) : edge.label ? measure(edge.label) : { width: 0, height: 0 };
    graph.setEdge(edge.from, edge.to, { width: size.width, height: size.height, labelpos: 'c' }, edgeId(edge));
  }
  dagre.layout(graph);
  const { width, height } = graph.graph();
  return {
    width,
    height,
    nodes: nodes.map((node) => {
      const { x, y, width: w, height: h } = graph.node(node.id);
      return { ...node, x, y, width: w, height: h };
    }),
    edges: edges.map((edge) => {
      const { points, x, y } = graph.edge(edge.from, edge.to, edgeId(edge));
      return { ...edge, points, labelX: x, labelY: y };
    }),
  };
}

// A sequence diagram's columns and rows, with room for the groups wrapped around its messages, the
// bars on its lifelines and the boxes around its participants.
// Roomy rather than compact: the user wanted space between things, not the smallest drawing.
const COLUMN_MIN = 200;
const COLUMN_PAD = 72; // a column's room beyond the widest label in it
const ROW = 60;
const HEAD = 52;
const BOX_TITLE = 22;
const GROUP_TITLE = 24; // the room a group's tab, or a section's label, takes above its first message (a group's title lines go under its tab)
const GROUP_END = 12;
const GROUP_PAD = 32;
const NEST_PAD = 8;
const ABOVE_MESSAGE = 30; // a message's label sits above its line
const LABEL_LINE = 18; // a label's line, as item-views.js draws it
const END_HEIGHT = 30; // the End of sequence box
const SELF_LOOP = 36; // how far a message to its own lifeline loops out, its label beside the loop
const TAB_PAD = 22; // a group's tab round its word, and the gap before its title
const TITLE_END = 12; // room after a group's title, inside its frame
const TITLE_INSET = 8; // the lines of a group's title under its tab, in from its left edge
const UNDER_TAB = 6; // a title's second line starts this far below its tab's row, clear of the tab
const HEADER_GAP = 6; // room under a title of more than one line, above the header's line
const TITLE_LEAST = 180; // a group's title wraps to its box's width, or this, whichever is wider

// `label` broken at its words into lines no wider than `first` for the first and `rest` after it,
// as measured on one line.
function wrapTo(label, first, rest, measure) {
  const lines = [];
  for (const word of String(label ?? '').split(/\s+/).filter(Boolean)) {
    const longer = lines.length ? `${lines.at(-1)} ${word}` : null;
    if (longer && measure(longer, { oneLine: true }).width <= (lines.length === 1 ? first : rest)) lines[lines.length - 1] = longer;
    else lines.push(word);
  }
  return lines;
}

// What each kind of group says in its tab.
export const GROUP_WORDS = { loop: 'loop', alt: 'alternative', opt: 'optional', par: 'parallel', critical: 'critical', break: 'break', group: 'group' };

export function layoutSequence({ participants, messages = [], groups = [], activations = [], boxes = [] }, measure) {
  const column = Math.max(COLUMN_MIN, ...messages.map((message) => measure(message.label).width + COLUMN_PAD), ...participants.map((one) => measure(one.label).width + COLUMN_PAD));
  // The lifelines are a column apart, or further where what's beside one needs the room: the labels
  // beside its own loops, and the boxes of groups that end at it (see below).
  const gaps = participants.slice(1).map(() => column);
  const place = () => {
    let x = column / 2;
    return new Map(participants.map((one, i) => {
      if (i) x += gaps[i - 1];
      return [one.id, x];
    }));
  };
  const isSelf = (message) => message.from === message.to;
  participants.forEach((one, i) => {
    if (i >= gaps.length) return;
    const beside = messages.filter((message) => isSelf(message) && message.from === one.id).map((message) => SELF_LOOP + 8 + measure(message.label).width + 16);
    gaps[i] = Math.max(gaps[i], ...beside);
  });
  let at = place();
  const index = new Map(messages.map((message, i) => [message.id, i]));
  const order = new Map(participants.map((one, i) => [one.id, i]));
  const headTop = boxes.length ? BOX_TITLE : 0;
  const head = headTop + HEAD;

  // Where each group sits among the others: those holding more messages are outside those with fewer.
  const size = (group) => index.get(group.to) - index.get(group.from);
  const inside = (a, b) => a !== b && index.get(a.from) >= index.get(b.from) && index.get(a.to) <= index.get(b.to) && (size(a) < size(b) || groups.indexOf(a) > groups.indexOf(b));
  const depth = (group) => groups.filter((other) => inside(group, other)).length;

  // A label over more than one line takes the room for them above its line; a message to its own
  // lifeline has its label beside its loop, reaching below its line as far as the label or loop does.
  const above = (message) => (isSelf(message) ? 0 : Math.max(0, measure(message.label).height - LABEL_LINE));
  const below = (message) => (isSelf(message) ? Math.max(12, 2 + measure(message.label).height / 2) + 6 : 0);

  // Each group's title, which says something about the box, starts beside its tab and wraps onto
  // the lines under the tab, to the width of its box as its lifelines and loops make it; a line
  // under it makes a header of it, so the box is as tall as its title needs.
  const padOf = (group) => GROUP_PAD - depth(group) * NEST_PAD + groups.filter((other) => inside(other, group)).length * NEST_PAD;
  const tabOf = (group) => measure(GROUP_WORDS[group.kind] ?? group.kind, { oneLine: true }).width + TAB_PAD;
  const titleLines = new Map(groups.map((group) => {
    const within = messages.slice(index.get(group.from), index.get(group.to) + 1);
    const xs = within.flatMap((message) => [at.get(message.from), at.get(message.to)]);
    const loops = within.filter(isSelf).map((message) => at.get(message.from) + SELF_LOOP + 8 + measure(message.label).width);
    const span = Math.max(TITLE_LEAST, Math.max(...xs, ...loops) - Math.min(...xs) + 2 * padOf(group));
    return [group, wrapTo(group.label, span - tabOf(group) - TITLE_END, span - TITLE_INSET - TITLE_END, measure)];
  }));
  // The tab's row, and a line for each further line of the title, with room under the header.
  const titleMore = (lines) => {
    const more = Math.max(0, lines.length - 1);
    return more ? UNDER_TAB + more * LABEL_LINE + HEADER_GAP : 0;
  };
  const titleRoom = (group) => GROUP_TITLE + titleMore(titleLines.get(group));

  let y = head;
  const ys = messages.map((message) => {
    const opening = groups.filter((group) => group.from === message.id).reduce((sum, group) => sum + titleRoom(group), 0);
    const sections = groups.flatMap((group) => group.sections ?? []).filter((section) => section.at === message.id).length;
    y += ROW + opening + sections * GROUP_TITLE + above(message);
    const here = y;
    y += below(message) + groups.filter((group) => group.to === message.id).length * GROUP_END;
    return here;
  });
  const yOf = (id) => ys[index.get(id)];
  const messageOf = (id) => messages[index.get(id)];
  // The sequence ends in a box across its lifelines, which stop there.
  const endY = y + ROW * 0.6;
  const height = endY + END_HEIGHT + 12;

  const layGroups = () => {
    const laid = groups.map((group) => {
      const within = messages.slice(index.get(group.from), index.get(group.to) + 1);
      const xs = within.flatMap((message) => [at.get(message.from), at.get(message.to)]);
      const self = within.some((message) => isSelf(message) && at.get(message.from) === Math.max(...xs));
      const pad = padOf(group);
      const left = Math.min(...xs) - pad;
      const right = Math.max(...xs) + pad + (self ? column / 2 : 0);
      const stacked = groups.filter((other) => other.from === group.from && inside(other, group)).reduce((sum, other) => sum + titleRoom(other), 0);
      const top = yOf(group.from) - ABOVE_MESSAGE - above(messageOf(group.from)) - stacked - titleRoom(group);
      const after = groups.filter((other) => other.to === group.to && inside(other, group)).length;
      const bottom = yOf(group.to) + below(messageOf(group.to)) + GROUP_END + after * GROUP_END;
      const sections = (group.sections ?? []).map((section) => ({ ...section, y: yOf(section.at) - ABOVE_MESSAGE - above(messageOf(section.at)) - GROUP_TITLE }));
      // Wide enough for its tab, the lines of its title, and the labels beside loops inside it.
      const lines = titleLines.get(group);
      const titled = Math.max(
        left + tabOf(group),
        ...lines.map((line, i) => left + (i ? TITLE_INSET : tabOf(group)) + measure(line, { oneLine: true }).width + TITLE_END),
      );
      const besideLoops = within.filter(isSelf).map((message) => at.get(message.from) + SELF_LOOP + 8 + measure(message.label).width + pad);
      const last = Math.max(...within.flatMap((message) => [order.get(message.from), order.get(message.to)]));
      // The header's bottom line: under the tab, or under the title's last line.
      const header = lines.length ? top + GROUP_TITLE - 2 + titleMore(lines) : null;
      return { ...group, left, right: Math.max(right, titled, ...besideLoops), top, bottom, sections, titleLines: lines, header, last };
    });
    // Each group round the groups inside it, however much they grew.
    for (const group of [...laid].sort((a, b) => depth(groups[laid.indexOf(b)]) - depth(groups[laid.indexOf(a)]))) {
      const own = groups[laid.indexOf(group)];
      const inner = laid.filter((other, i) => inside(groups[i], own));
      if (inner.length) group.right = Math.max(group.right, ...inner.map((other) => other.right + NEST_PAD));
    }
    return laid;
  };
  // A group's box stops short of the next lifeline after the last it involves: that lifeline moves
  // out as far as it takes.
  let laid = layGroups();
  for (let round = 0; round < participants.length; round++) {
    let moved = false;
    for (const group of laid) {
      const next = participants[group.last + 1];
      if (!next) continue;
      const short = group.right + 16 - at.get(next.id);
      if (short > 0) {
        gaps[group.last] += short;
        moved = true;
      }
    }
    if (!moved) break;
    at = place();
    laid = layGroups();
  }
  const laidGroups = laid.map(({ last, ...group }) => group);

  const placed = [];
  const laidActivations = activations.map((activation) => {
    const [from, to] = [index.get(activation.from), index.get(activation.to)];
    const level = placed.filter((other) => other.participant === activation.participant && other.fromAt <= to && other.toAt >= from).length;
    placed.push({ participant: activation.participant, fromAt: from, toAt: to });
    return { ...activation, x: at.get(activation.participant) + level * 6, top: yOf(activation.from) - 4, bottom: yOf(activation.to) + 4 };
  });

  const laidBoxes = boxes.map((box) => {
    const xs = box.participants.map((id) => at.get(id));
    return { ...box, left: Math.min(...xs) - column / 2 + 6, right: Math.max(...xs) + column / 2 - 6 };
  });

  // As wide as its columns, or what runs past the last of them: groups, and labels beside loops.
  const selfEnds = messages.filter((message) => message.from === message.to).map((message) => at.get(message.from) + SELF_LOOP + 8 + measure(message.label).width + 8);
  const lastX = participants.length ? at.get(participants.at(-1).id) : 0;
  const width = Math.ceil(Math.max(lastX + column / 2, ...laidGroups.map((group) => group.right + 8), ...selfEnds));

  const firstX = participants.length ? at.get(participants[0].id) : 0;
  const end = { top: endY, height: END_HEIGHT, left: Math.min(firstX - column / 2 + 12, ...laidGroups.map((group) => group.left)), right: Math.max(lastX + column / 2 - 12, ...laidGroups.map((group) => group.right)) };

  return {
    width,
    height,
    end,
    head,
    headTop,
    column,
    participants: participants.map((one) => ({ ...one, x: at.get(one.id) })),
    messages: messages.map((message, i) => ({ ...message, x1: at.get(message.from), x2: at.get(message.to), y: ys[i] })),
    groups: laidGroups,
    activations: laidActivations,
    boxes: laidBoxes,
  };
}

// Where the cards of a schematic's overview go: each { id, width, height } (all the same width), joined
// by `pairs` of ids, in a grid shaped like `room`, the space it's shown in, so it fills it whichever
// way the window is drawn. The most linked card goes in the middle, and each card after it goes as near
// as it can to the cards it links to; cards nothing links to fill what's left. Lines run in the gaps
// between cards, never across one: straight to a card beside or below, otherwise along the gaps, each
// line in its own lane where several share a gap.
const GAP_X = 96;
const GAP_Y = 64;
const LANE = 7;

export function layoutCards(cards, pairs, room = { width: 1280, height: 720 }) {
  if (!cards.length) return { width: 2 * GAP_X, height: 2 * GAP_Y, columns: 0, cards: [], lines: [] };
  // Cards can differ in width: the grid is shaped by the average, and each column is as wide as its widest.
  const colW = cards.reduce((sum, card) => sum + card.width, 0) / cards.length + GAP_X;
  const rowH = cards.reduce((sum, card) => sum + card.height, 0) / cards.length + GAP_Y;
  const n = cards.length;
  const aspect = Math.max(0.2, room.width / Math.max(1, room.height));
  const C = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * aspect * rowH) / colW))));
  const R = Math.ceil(n / C);

  const linked = new Map(cards.map(({ id }) => [id, new Set()]));
  for (const [a, b] of pairs) {
    linked.get(a)?.add(b);
    linked.get(b)?.add(a);
  }
  const middle = { r: (R - 1) / 2, c: (C - 1) / 2 };
  const apart = (one, other) => Math.hypot((one.c - other.c) * colW, (one.r - other.r) * rowH);
  const free = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) free.push({ r, c });
  const at = new Map();
  const left = [...cards];
  while (left.length) {
    // Next, the card with most links to cards already placed; then the most linked; then in order.
    const reach = (card) => [...linked.get(card.id)].filter((id) => at.has(id)).length;
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      const [one, other] = [left[i], left[best]];
      if (reach(one) > reach(other) || (reach(one) === reach(other) && linked.get(one.id).size > linked.get(other.id).size)) best = i;
    }
    const [card] = left.splice(best, 1);
    const near = [...linked.get(card.id)].filter((id) => at.has(id)).map((id) => at.get(id));
    const cost = (cell) => near.reduce((sum, other) => sum + apart(cell, other), 0) + apart(cell, middle) * (near.length ? 0.01 : 1);
    let cell = 0;
    for (let i = 1; i < free.length; i++) if (cost(free[i]) < cost(free[cell])) cell = i;
    at.set(card.id, free.splice(cell, 1)[0]);
  }

  // Rows and columns left empty go.
  const rowsUsed = [...new Set([...at.values()].map(({ r }) => r))].sort((a, b) => a - b);
  const colsUsed = [...new Set([...at.values()].map(({ c }) => c))].sort((a, b) => a - b);
  for (const cell of at.values()) Object.assign(cell, { r: rowsUsed.indexOf(cell.r), c: colsUsed.indexOf(cell.c) });
  const rows = rowsUsed.length;
  const columns = colsUsed.length;
  const rowHeights = Array.from({ length: rows }, (_, r) => Math.max(...cards.filter(({ id }) => at.get(id).r === r).map(({ height }) => height)));
  const rowTop = [GAP_Y];
  for (let r = 0; r < rows; r++) rowTop.push(rowTop[r] + rowHeights[r] + GAP_Y);
  const colWidths = Array.from({ length: columns }, (_, c) => Math.max(...cards.filter(({ id }) => at.get(id).c === c).map(({ width }) => width)));
  const colLeft = [GAP_X];
  for (let c = 0; c < columns; c++) colLeft.push(colLeft[c] + colWidths[c] + GAP_X);
  const colX = (c) => colLeft[c];
  const gutterX = (k) => colLeft[k] - GAP_X / 2; // the gap left of column k
  const gutterY = (k) => rowTop[k] - GAP_Y / 2; // the gap above row k

  // Each card at the top left of its place, so lines leaving its left or top meet it at the gap.
  const box = new Map(cards.map(({ id, width, height }) => {
    const { r, c } = at.get(id);
    return [id, { r, c, left: colX(c), top: rowTop[r], width, height }];
  }));

  // Each line: the side it leaves from, the gaps it runs along (a vertical gap, then a horizontal one,
  // and so on, ending on a vertical one), and the side it arrives at.
  const routes = pairs.filter(([a, b]) => box.has(a) && box.has(b) && a !== b).map((pair) => {
    let [a, b] = pair.map((id) => box.get(id));
    let [from, to] = pair;
    if (a.c > b.c || (a.c === b.c && a.r > b.r)) [a, b, from, to] = [b, a, to, from];
    if (a.c === b.c && b.r === a.r + 1) return { pair, ends: [{ id: from, side: 'bottom' }, { id: to, side: 'top' }], gaps: [] };
    if (a.c === b.c) return { pair, ends: [{ id: from, side: 'right' }, { id: to, side: 'right' }], gaps: [`v${a.c + 1}`] };
    if (b.c === a.c + 1) return { pair, ends: [{ id: from, side: 'right' }, { id: to, side: 'left' }], gaps: [`v${b.c}`] };
    const across = b.r < a.r ? a.r : a.r + 1;
    return { pair, ends: [{ id: from, side: 'right' }, { id: to, side: 'left' }], gaps: [`v${a.c + 1}`, `h${across}`, `v${b.c}`] };
  });

  // Lanes: the lines sharing a gap spread across it.
  const sharing = new Map();
  routes.forEach((route) => route.gaps.forEach((gap) => sharing.set(gap, [...(sharing.get(gap) ?? []), route])));
  const lane = (gap, route) => {
    const all = sharing.get(gap);
    const room = (gap[0] === 'v' ? GAP_X : GAP_Y) - 16;
    const step = Math.min(LANE, room / Math.max(1, all.length - 1));
    return (all.indexOf(route) - (all.length - 1) / 2) * step;
  };
  const gapAt = (gap, route) => (gap[0] === 'v' ? gutterX(Number(gap.slice(1))) : gutterY(Number(gap.slice(1)))) + lane(gap, route);

  // Where lines meet a card: spread along its side, in the order of where they go, so they don't cross there.
  const meeting = new Map();
  for (const route of routes) {
    route.ends.forEach((end, i) => {
      const other = box.get(route.ends[1 - i].id);
      const key = `${end.id} ${end.side}`;
      meeting.set(key, [...(meeting.get(key) ?? []), { route, end, toward: end.side === 'top' || end.side === 'bottom' ? other.left : other.top + other.height / 2 }]);
    });
  }
  const point = new Map();
  for (const all of meeting.values()) {
    all.sort((one, other) => one.toward - other.toward);
    all.forEach(({ end }, i) => {
      const card = box.get(end.id);
      const share = (i + 1) / (all.length + 1);
      point.set(end, {
        left: { x: card.left, y: card.top + card.height * share },
        right: { x: card.left + card.width, y: card.top + card.height * share },
        top: { x: card.left + card.width * share, y: card.top },
        bottom: { x: card.left + card.width * share, y: card.top + card.height },
      }[end.side]);
    });
  }

  const lines = routes.map((route) => {
    const start = point.get(route.ends[0]);
    const end = point.get(route.ends[1]);
    const points = [start];
    let y = start.y;
    route.gaps.forEach((gap, i) => {
      if (gap[0] !== 'v') return;
      const x = gapAt(gap, route);
      const next = route.gaps[i + 1] ? gapAt(route.gaps[i + 1], route) : end.y;
      points.push({ x, y }, { x, y: next });
      y = next;
    });
    // One card straight above another, of different widths: across in the gap between them, not slanting.
    if (!route.gaps.length && start.x !== end.x && route.ends[0].side === 'bottom') {
      const across = gutterY(box.get(route.ends[1].id).r);
      points.push({ x: start.x, y: across }, { x: end.x, y: across });
    }
    points.push(end);
    return { pair: route.pair, points: points.filter((one, i) => i === 0 || one.x !== points[i - 1].x || one.y !== points[i - 1].y) };
  });

  return {
    width: colLeft[columns],
    height: rowTop[rows],
    columns,
    cards: cards.map(({ id }) => {
      const { left: x, top: y, width, height } = box.get(id);
      return { id, x: x + width / 2, y: y + height / 2, width, height };
    }),
    lines,
  };
}
