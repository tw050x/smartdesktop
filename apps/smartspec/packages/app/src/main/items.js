// What's inside a schema: its items, each of a kind with its own way of rendering, and the links
// between them. Plain data and no Node or Electron, as the store and the interface both use it.
//
// A link is `item` or `item#part`: an item, or a part inside it (a heading, node, connection,
// participant, message or row). `#part` is a part of the same item. Links reach `contract` and the
// schemas this one embeds, but stop at their boundary: an embedded schema's insides can change with
// a new draft, and reaching into them would break the modularity embedding is for.

export const KINDS = ['document', 'flow', 'sequence', 'table', 'image'];
export const CONTRACT = 'contract';
export const GROUP_KINDS = ['loop', 'alt', 'opt', 'par', 'critical', 'break', 'group'];
export const IMAGE_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ID = /^[a-z0-9][\w-]*$/i;

// A heading's part id. `_` goes too, so it's the same for the source and the rendered text.
export const slug = (text) => text.toLowerCase().replace(/_/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

const withoutCode = (markdown) => markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');

// A link's or emphasis's marks taken out of a bit of Markdown, leaving what it reads as.
const plainText = (markdown) => markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*~`]/g, '');

function headingTexts(markdown) {
  return [...withoutCode(markdown ?? '').matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((match) => plainText(match[1]));
}

const headings = (markdown) => headingTexts(markdown).map(slug);

// Whether a link in Markdown is to something in the schema: no scheme, and not a path.
export const isInternalLink = (href) => Boolean(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('//');

// The internal links in some Markdown, leaving out images and code.
function markdownLinks(markdown) {
  return [...withoutCode(markdown ?? '').matchAll(/(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g)]
    .filter((match) => isInternalLink(match[2]))
    .map((match) => ({ to: match[2], label: match[1] }));
}

export const edgeId = (edge) => edge.id ?? `${edge.from}-${edge.to}`;

// The ids of what can be linked to inside an item.
export function partsOf(item) {
  switch (item.kind) {
    case 'document': return headings(item.markdown);
    case 'flow': return [...item.nodes.map((node) => node.id), ...item.edges.map(edgeId)];
    case 'sequence': return [...item.participants, ...item.messages, ...(item.groups ?? []), ...(item.activations ?? []), ...(item.boxes ?? [])].map((one) => one.id);
    case 'table': return item.rows.map((row) => row.id);
    default: return [];
  }
}

// What a part of an item is called, to show someone. Its id if it has nothing better.
export function partName(item, part) {
  const called = (list, name = (one) => one.label) => {
    const found = list?.find((one) => one.id === part);
    return found && name(found);
  };
  switch (item.kind) {
    case 'document': return headingTexts(item.markdown).find((text) => slug(text) === part)?.replace(/\s+/g, ' ') ?? part;
    case 'flow': {
      const node = (id) => item.nodes.find((one) => one.id === id)?.label ?? id;
      return called(item.nodes) ?? item.edges?.filter((edge) => edgeId(edge) === part).map((edge) => edge.label ?? `${node(edge.from)} → ${node(edge.to)}`)[0] ?? part;
    }
    case 'sequence': return called(item.participants) ?? called(item.messages) ?? called(item.groups) ?? called(item.boxes)
      ?? called(item.activations, (one) => item.participants.find(({ id }) => id === one.participant)?.label) ?? part;
    case 'table': {
      const row = item.rows.find((one) => one.id === part);
      const first = row && item.columns.map((column) => row.cells?.[column.id]).find(Boolean);
      return first ? plainText(String(first)) : part;
    }
    default: return part;
  }
}

// A short account of a table, for a card beside `focus`: up to two of its rows, those the links between
// them are about, and how much there is.
export const TABLE_ROWS_SHOWN = 2;
export function tableSummary(table, focus, links) {
  const linked = new Set();
  for (const { from, to } of links) {
    const [source, target] = [parseLink(from), parseLink(to)];
    if (source.target === table.id && target.target === focus && source.part) linked.add(source.part);
    if (target.target === table.id && source.target === focus && target.part) linked.add(target.part);
  }
  const about = table.rows.filter((row) => linked.has(row.id));
  const cells = (row) => table.columns.map((column) => row.cells?.[column.id]).filter(Boolean).map((cell) => plainText(String(cell)));
  return {
    rows: about.slice(0, TABLE_ROWS_SHOWN).map((row) => ({ id: row.id, name: partName(table, row.id), detail: cells(row)[1] ?? null })),
    linked: about.length,
    rowCount: table.rows.length,
    columnCount: table.columns.length,
  };
}

// The links out of an item: [{ part, to, label }], `part` being where it's from, if inside it.
export function linksOf(item) {
  const linked = (list, id = (one) => one.id) => list.filter((one) => one.link).map((one) => ({ part: id(one), to: one.link, label: one.label ?? null }));
  const own = (item.links ?? []).map(({ to, label }) => ({ part: null, to, label: label ?? null }));
  switch (item.kind) {
    case 'document': return [...markdownLinks(item.markdown).map((link) => ({ part: null, ...link })), ...own];
    case 'flow': return [...linked(item.nodes), ...linked(item.edges, edgeId), ...own];
    case 'sequence': return [...linked(item.participants), ...linked(item.messages), ...linked(item.groups ?? []), ...linked(item.activations ?? []), ...linked(item.boxes ?? []), ...own];
    case 'table': return [
      ...item.rows.flatMap((row) => [
        ...(row.link ? [{ part: row.id, to: row.link, label: null }] : []),
        ...Object.values(row.cells ?? {}).flatMap((cell) => markdownLinks(String(cell)).map((link) => ({ part: row.id, ...link }))),
      ]),
      ...own,
    ];
    default: return own;
  }
}

function uniqueIds(what, ids) {
  const seen = new Set();
  for (const id of ids) {
    if (!ID.test(id)) throw new Error(`"${id}" can't be the id of ${what}: use letters, numbers, - and _.`);
    if (seen.has(id)) throw new Error(`Two of ${what} have the id ${id}. Give each its own.`);
    seen.add(id);
  }
  return seen;
}

// Throws saying what's wrong with an item, naming the part.
export function checkItem(item) {
  const where = `Item ${item.id}`;
  if (!KINDS.includes(item.kind)) throw new Error(`${where} has an unknown kind, "${item.kind}". The kinds are: ${KINDS.join(', ')}.`);
  if (!item.title?.trim()) throw new Error(`${where} needs a title.`);
  if (item.kind === 'document' && typeof item.markdown !== 'string') throw new Error(`${where} is a document, so it needs markdown.`);
  if (item.kind === 'flow') {
    if (!item.nodes?.length) throw new Error(`${where} is a flow diagram, so it needs nodes.`);
    item.edges ??= [];
    const nodes = uniqueIds(`the nodes in ${item.id}`, item.nodes.map((node) => node.id));
    uniqueIds(`the connections in ${item.id}`, item.edges.map(edgeId));
    for (const edge of item.edges) {
      for (const end of [edge.from, edge.to]) if (!nodes.has(end)) throw new Error(`${where} has a connection ${edge.from} → ${edge.to}, but no node ${end}.`);
    }
    if (item.direction && !['LR', 'TB'].includes(item.direction)) throw new Error(`${where} has an unknown direction, "${item.direction}". Use LR or TB.`);
  }
  if (item.kind === 'sequence') {
    if (!item.participants?.length) throw new Error(`${where} is a sequence diagram, so it needs participants.`);
    item.messages ??= [];
    const participants = uniqueIds(`the participants in ${item.id}`, item.participants.map((one) => one.id));
    uniqueIds(`the messages in ${item.id}`, item.messages.map((one) => one.id));
    for (const message of item.messages) {
      for (const end of [message.from, message.to]) if (!participants.has(end)) throw new Error(`${where} has message ${message.id} involving ${end}, who isn't a participant.`);
    }
    const order = new Map(item.messages.map((message, index) => [message.id, index]));
    const spans = (kind, one) => {
      for (const end of [one.from, one.to]) if (!order.has(end)) throw new Error(`${where} has ${kind} ${one.id} starting or ending at ${end}, which isn't a message.`);
      if (order.get(one.from) > order.get(one.to)) throw new Error(`${where} has ${kind} ${one.id} ending before it starts.`);
    };
    for (const group of item.groups ?? []) {
      if (!GROUP_KINDS.includes(group.kind)) throw new Error(`${where} has group ${group.id} of an unknown kind, "${group.kind}". The kinds are: ${GROUP_KINDS.join(', ')}.`);
      spans('group', group);
      for (const section of group.sections ?? []) {
        const at = order.get(section.at);
        if (at === undefined || at <= order.get(group.from) || at > order.get(group.to)) throw new Error(`${where} has group ${group.id} with a section starting at ${section.at}, which isn't a later message inside it.`);
      }
    }
    for (const activation of item.activations ?? []) {
      if (!participants.has(activation.participant)) throw new Error(`${where} has activation ${activation.id} on ${activation.participant}, who isn't a participant.`);
      spans('activation', activation);
    }
    const columns = item.participants.map((one) => one.id);
    const boxed = new Set();
    for (const box of item.boxes ?? []) {
      const at = box.participants.map((id) => columns.indexOf(id));
      if (!at.length || at.includes(-1)) throw new Error(`${where} has box ${box.id} around someone who isn't a participant.`);
      if (Math.max(...at) - Math.min(...at) !== at.length - 1) throw new Error(`${where} has box ${box.id} around participants who aren't next to each other. Reorder the participants, or split the box.`);
      for (const id of box.participants) {
        if (boxed.has(id)) throw new Error(`${where} has ${id} in two boxes.`);
        boxed.add(id);
      }
    }
    uniqueIds(`the parts of ${item.id}`, partsOf(item));
  }
  if (item.kind === 'table') {
    if (!item.columns?.length) throw new Error(`${where} is a table, so it needs columns.`);
    item.rows ??= [];
    const columns = uniqueIds(`the columns in ${item.id}`, item.columns.map((column) => column.id));
    uniqueIds(`the rows in ${item.id}`, item.rows.map((row) => row.id));
    for (const row of item.rows) {
      for (const key of Object.keys(row.cells ?? {})) if (!columns.has(key)) throw new Error(`${where} has row ${row.id} with a value for ${key}, which isn't a column.`);
    }
  }
  if (item.kind === 'image') {
    if (!IMAGE_TYPES.includes(item.mediaType)) throw new Error(`${where} has an unsupported image type, "${item.mediaType}". The types are: ${IMAGE_TYPES.join(', ')}.`);
    if (!item.data || !/^[A-Za-z0-9+/]+=*$/.test(item.data)) throw new Error(`${where} needs its image as base64 data.`);
    if ((item.data.length * 3) / 4 > MAX_IMAGE_BYTES) throw new Error(`${where} is too large: an image can be up to 5 MB.`);
  }
}

// Splits a link, resolving `#part` to the item it's in.
export function parseLink(link, fromItem = null) {
  const at = link.indexOf('#');
  const target = at === -1 ? link : link.slice(0, at);
  return { target: target || fromItem, part: at === -1 ? null : link.slice(at + 1) || null };
}

// Every link in a schema's record, as [{ from, to, label }]: `from` and `to` are in link form.
export function linkGraph({ contract, items }) {
  const links = markdownLinks(contract).map(({ to, label }) => ({ item: CONTRACT, part: null, to, label }));
  for (const item of items) for (const link of linksOf(item)) links.push({ item: item.id, ...link });
  return links.map(({ item, part, to, label }) => {
    const { target, part: toPart } = parseLink(to, item);
    return { from: part ? `${item}#${part}` : item, to: toPart ? `${target}#${toPart}` : target, label: label ?? null };
  });
}

// Throws if a link goes nowhere, or past an embedded schema's boundary.
export function checkLinks(record) {
  const items = new Map(record.items.map((item) => [item.id, item]));
  const uses = new Set(record.uses.map((use) => use.id));
  for (const { from, to } of linkGraph(record)) {
    const { target, part } = parseLink(to);
    if (target === CONTRACT) {
      if (part) throw new Error(`The link from ${from} to ${to} can't work: the contract has no parts to link to.`);
    } else if (uses.has(target)) {
      if (part && part !== CONTRACT) throw new Error(`The link from ${from} to ${to} reaches inside an embedded schema. Link to ${target}, or to ${target}#${CONTRACT}.`);
    } else if (!items.has(target)) {
      throw new Error(`The link from ${from} goes to ${target}, which isn't an item or embedded schema here.`);
    } else if (part && !partsOf(items.get(target)).includes(part)) {
      throw new Error(`The link from ${from} goes to ${to}, but ${target} has no part ${part}. Its parts are: ${partsOf(items.get(target)).join(', ') || 'none'}.`);
    }
  }
}

// A name for a pair of items, whichever way round they're given.
export const pairKey = (a, b) => JSON.stringify([a, b].sort());

// Which items are connected: each pair once, however many links there are between them and whichever
// way they go. A link within an item connects nothing.
export function connectedPairs(links) {
  const pairs = new Map();
  for (const { from, to } of links) {
    const a = parseLink(from).target;
    const b = parseLink(to).target;
    if (a !== b) pairs.set(pairKey(a, b), [a, b]);
  }
  return [...pairs.values()];
}

// What's behind each connected pair, by pairKey: { count, ways }, a way being the links going one way
// between them, as { from, to, links }. Each link is { from, to, label } in words: the parts it joins,
// null for an item as a whole, and what it's called if that adds anything.
export function connectionDetails({ items, uses = [], links }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const title = (id) => (id === CONTRACT ? 'Contract' : byId.get(id)?.title ?? uses.find((use) => use.id === id)?.name ?? id);
  const inItem = (id, part) => {
    if (part === null) return null;
    if (part === CONTRACT) return 'Contract';
    return byId.has(id) ? partName(byId.get(id), part) : part;
  };
  const details = {};
  for (const { from, to, label } of links) {
    const source = parseLink(from);
    const target = parseLink(to);
    if (source.target === target.target) continue;
    const pair = (details[pairKey(source.target, target.target)] ??= { count: 0, ways: [] });
    const way = pair.ways.find((one) => one.id === source.target) ?? pair.ways[pair.ways.push({ id: source.target, from: title(source.target), to: title(target.target), links: [] }) - 1];
    const words = { from: inItem(source.target, source.part), to: inItem(target.target, target.part) };
    const link = { ...words, label: label && label !== words.from && label !== words.to ? label : null };
    if (way.links.some((one) => JSON.stringify(one) === JSON.stringify(link))) continue;
    way.links.push(link);
    pair.count += 1;
  }
  return details;
}

// What surrounds an item when it's in focus: `left`, what links to it, and `right`, what it links to
// (or both ways). Each is { id, parts, count }: `parts` are the parts of the focused item the links
// are about, in the order those parts come, so lines cross less. One line per part: `[null]` means
// the links are only about the item as a whole, and a specific part replaces that.
export function neighboursOf(focus, links, partOrder = []) {
  const found = new Map();
  const note = (id, side, part) => {
    const entry = found.get(id) ?? found.set(id, { id, side, parts: [], count: 0 }).get(id);
    if (side === 'right') entry.side = 'right';
    if (!entry.parts.includes(part)) entry.parts.push(part);
    entry.count += 1;
  };
  for (const { from, to } of links) {
    const source = parseLink(from);
    const target = parseLink(to);
    if (source.target === target.target) continue;
    if (source.target === focus) note(target.target, 'right', source.part);
    else if (target.target === focus) note(source.target, 'left', target.part);
  }
  const rank = (part) => (part === null ? -1 : partOrder.indexOf(part));
  const first = (entry) => Math.min(...entry.parts.map(rank));
  const ordered = [...found.values()]
    .map((entry) => {
      const specific = entry.parts.filter((part) => part !== null);
      return { ...entry, parts: specific.length ? specific.sort((a, b) => rank(a) - rank(b)) : [null] };
    })
    .sort((a, b) => first(a) - first(b));
  return { left: ordered.filter((entry) => entry.side === 'left'), right: ordered.filter((entry) => entry.side === 'right') };
}

// Which neighbours are relevant enough for a small preview: those with two or more links to the
// focused item, at most two of them. With nothing standing out, there are none.
export const MAX_PREVIEWS = 2;
export function previewsFor({ left, right }) {
  return [...left, ...right]
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_PREVIEWS)
    .map((entry) => entry.id);
}

// What differs between two records' items, for reviewing a proposal.
export function itemChanges(before, after) {
  const was = new Map((before?.items ?? []).map((item) => [item.id, item]));
  const changes = {};
  for (const item of after.items) {
    if (!was.has(item.id)) changes[item.id] = 'added';
    else if (JSON.stringify(was.get(item.id)) !== JSON.stringify(item)) changes[item.id] = 'changed';
  }
  const ids = new Set(after.items.map((item) => item.id));
  return {
    items: changes,
    removed: [...was.values()].filter((item) => !ids.has(item.id)).map(({ id, title, kind }) => ({ id, title, kind })),
    contract: Boolean(before) && before.contract !== after.contract,
  };
}
