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
