// What a diagram's data says about one particular element: its tooltip's specifics, whether or not
// an AI described it. Each gives the element's name, if it has one, and facts about it here.

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const quoted = (text) => `“${text}”`;
const listed = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

const GROUP_NAMES = { loop: 'a loop', alt: 'alternatives', opt: 'an optional box', par: 'a parallel box', critical: 'a critical box', break: 'a break', group: 'a group' };

export function flowDetails({ nodes, edges = [] }) {
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const names = (ids) => listed(ids.map((id) => labels.get(id) ?? id));
  return {
    node(node) {
      const from = edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
      const to = edges.filter((edge) => edge.from === node.id).map((edge) => edge.to);
      return { name: node.label, facts: [from.length ? `Comes from ${names(from)}` : 'Nothing leads into it', to.length ? `Goes to ${names(to)}` : 'It leads nowhere further'] };
    },
    edge: (edge) => ({ name: edge.label, facts: [`${labels.get(edge.from) ?? edge.from} → ${labels.get(edge.to) ?? edge.to}`] }),
  };
}

export function sequenceDetails({ participants, messages = [], groups = [] }) {
  const labels = new Map(participants.map((one) => [one.id, one.label]));
  const label = (id) => labels.get(id) ?? id;
  const order = new Map(messages.map((message, index) => [message.id, index]));
  const messageLabel = (id) => quoted(messages[order.get(id)]?.label ?? id);
  const inside = (group) => messages.slice(order.get(group.from), order.get(group.to) + 1);

  // The section of a group a message falls in, which may have a condition of its own.
  const sectionLabel = (group, index) => {
    let current = group.label;
    for (const section of group.sections ?? []) if (order.get(section.at) <= index) current = section.label;
    return current;
  };
  const participant = (one) => {
    const sent = messages.filter((message) => message.from === one.id && message.to !== one.id).length;
    const received = messages.filter((message) => message.to === one.id && message.from !== one.id).length;
    const itself = messages.filter((message) => message.from === one.id && message.to === one.id).length;
    const parts = [sent && `sends ${plural(sent, 'message')}`, received && `receives ${plural(received, 'message')}`, itself && `does ${plural(itself, 'step')} itself`].filter(Boolean);
    const said = listed(parts);
    return { name: one.label, facts: [said ? said[0].toUpperCase() + said.slice(1) : 'Takes no part in these messages'] };
  };
  return {
    participant,
    message(message) {
      const index = order.get(message.id);
      const within = groups.filter((group) => order.get(group.from) <= index && index <= order.get(group.to));
      return {
        name: message.label,
        facts: [
          message.from === message.to ? `${label(message.from)}, on its own` : `${label(message.from)} → ${label(message.to)}`,
          `Step ${index + 1} of ${messages.length}`,
          ...within.map((group) => {
            const condition = sectionLabel(group, index);
            return `Inside ${GROUP_NAMES[group.kind]}${condition ? `: ${condition}` : ''}`;
          }),
        ],
      };
    },
    activation: (bar) => ({ name: label(bar.participant), facts: [`Busy from ${messageLabel(bar.from)} to ${messageLabel(bar.to)}`] }),
    box: (box) => ({ name: box.label, facts: [listed(box.participants.map(label))] }),
    group(group) {
      const steps = inside(group);
      const among = [...new Set(steps.flatMap((message) => [message.from, message.to]))];
      const span = group.from === group.to ? `Holds ${messageLabel(group.from)}` : `Holds ${plural(steps.length, 'message')}, from ${messageLabel(group.from)} to ${messageLabel(group.to)}`;
      const sections = group.sections?.length ? [`${plural(group.sections.length + 1, 'section')}: ${[group.label, ...group.sections.map((section) => section.label)].map((name) => name ?? 'unnamed').join('; ')}`] : [];
      return { name: group.label, facts: [span, ...sections, `Between ${listed(among.map(label))}`] };
    },
  };
}
