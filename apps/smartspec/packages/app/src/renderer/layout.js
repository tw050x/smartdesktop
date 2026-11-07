import dagre from '@dagrejs/dagre';
import { edgeId } from '../main/items.js';

// Where a flow diagram's nodes and connections go, worked out each time it's drawn: nothing about
// position is stored. This is the only place that knows about dagre, so it can be swapped.
// `measure(label)` gives a node or connection label's { width, height }.
const NODE_PADDING = { x: 16, y: 12 };

// Top to bottom unless told otherwise: tall diagrams spread what they link to down the page, where
// the side cards can line up with it, and wide ones squeeze the middle card.
export function layoutFlow({ direction = 'TB', nodes, edges = [] }, measure) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: direction, nodesep: 32, edgesep: 16, ranksep: 64, marginx: 8, marginy: 8 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    const size = measure(node.label);
    graph.setNode(node.id, { width: size.width + 2 * NODE_PADDING.x, height: size.height + 2 * NODE_PADDING.y });
  }
  for (const edge of edges) {
    const size = edge.label ? measure(edge.label) : { width: 0, height: 0 };
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
const COLUMN_MIN = 150;
const ROW = 46;
const HEAD = 44;
const BOX_TITLE = 22;
const GROUP_TITLE = 24; // the room a group's title, or a section's, takes above its first message
const GROUP_END = 12;
const GROUP_PAD = 26;
const NEST_PAD = 8;
const SELF_EXTRA = 14;
const ABOVE_MESSAGE = 30; // a message's label sits above its line

export function layoutSequence({ participants, messages = [], groups = [], activations = [], boxes = [] }, measure) {
  const column = Math.max(COLUMN_MIN, ...messages.map((message) => measure(message.label).width + 40), ...participants.map((one) => measure(one.label).width + 40));
  const at = new Map(participants.map((one, index) => [one.id, column / 2 + index * column]));
  const index = new Map(messages.map((message, i) => [message.id, i]));
  const headTop = boxes.length ? BOX_TITLE : 0;
  const head = headTop + HEAD;

  // Where each group sits among the others: those holding more messages are outside those with fewer.
  const size = (group) => index.get(group.to) - index.get(group.from);
  const inside = (a, b) => a !== b && index.get(a.from) >= index.get(b.from) && index.get(a.to) <= index.get(b.to) && (size(a) < size(b) || groups.indexOf(a) > groups.indexOf(b));
  const depth = (group) => groups.filter((other) => inside(group, other)).length;

  let y = head;
  const ys = messages.map((message) => {
    const opening = groups.filter((group) => group.from === message.id).length;
    const sections = groups.flatMap((group) => group.sections ?? []).filter((section) => section.at === message.id).length;
    y += ROW + (opening + sections) * GROUP_TITLE;
    const here = y;
    y += groups.filter((group) => group.to === message.id).length * GROUP_END;
    if (message.from === message.to) y += SELF_EXTRA; // its arrow loops below its line
    return here;
  });
  const yOf = (id) => ys[index.get(id)];
  const height = y + ROW * 0.75;

  const laidGroups = groups.map((group) => {
    const within = messages.slice(index.get(group.from), index.get(group.to) + 1);
    const xs = within.flatMap((message) => [at.get(message.from), at.get(message.to)]);
    const self = within.some((message) => message.from === message.to && at.get(message.from) === Math.max(...xs));
    const pad = GROUP_PAD - depth(group) * NEST_PAD + groups.filter((other) => inside(other, group)).length * NEST_PAD;
    const left = Math.min(...xs) - pad;
    const right = Math.max(...xs) + pad + (self ? column / 2 : 0);
    const stackedAbove = groups.filter((other) => other.from === group.from && inside(other, group)).length;
    const top = yOf(group.from) - ABOVE_MESSAGE - (stackedAbove + 1) * GROUP_TITLE;
    const after = groups.filter((other) => other.to === group.to && inside(other, group)).length;
    const bottom = yOf(group.to) + GROUP_END + after * GROUP_END;
    const sections = (group.sections ?? []).map((section) => ({ ...section, y: yOf(section.at) - ABOVE_MESSAGE - GROUP_TITLE }));
    return { ...group, left, right, top, bottom, sections };
  });

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

  return {
    width: column * participants.length,
    height,
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
  const width = cards[0].width;
  const colW = width + GAP_X;
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
  const colX = (c) => GAP_X + c * colW;
  const gutterX = (k) => GAP_X / 2 + k * colW; // the gap left of column k
  const gutterY = (k) => rowTop[k] - GAP_Y / 2; // the gap above row k

  const box = new Map(cards.map(({ id, height }) => {
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
        right: { x: card.left + width, y: card.top + card.height * share },
        top: { x: card.left + width * share, y: card.top },
        bottom: { x: card.left + width * share, y: card.top + card.height },
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
    points.push(end);
    return { pair: route.pair, points: points.filter((one, i) => i === 0 || one.x !== points[i - 1].x || one.y !== points[i - 1].y) };
  });

  return {
    width: GAP_X + columns * colW,
    height: rowTop[rows],
    columns,
    cards: cards.map(({ id }) => {
      const { left: x, top: y, height } = box.get(id);
      return { id, x: x + width / 2, y: y + height / 2, width, height };
    }),
    lines,
  };
}
