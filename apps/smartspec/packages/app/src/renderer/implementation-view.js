import { SOURCE_LABELS, baseUrlOf, readyTimeout, sourceLine } from '../main/implementation.js';

// A schematic's implementation, drawn for Test mode (see implementation.js): where its code comes
// from, how it's started, how it's known to be ready, how it's tidied up, the logins it needs, and
// where the checks reach it.

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') element.className = value;
    else element.setAttribute(key, value);
  }
  element.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

const row = (label, ...value) => [h('dt', {}, label), h('dd', {}, ...value)];
const commands = (list) => h('ol', { className: 'impl-commands' }, ...list.map((command) => h('li', {}, h('code', {}, command))));

export function renderImplementation(implementation) {
  const { source, start, ready, stop, credentials } = implementation;
  const env = Object.entries(start?.env ?? {});
  return h('dl', { className: 'impl-details' },
    row('From', h('span', { className: 'impl-kind' }, SOURCE_LABELS[source.kind]), ' ', h('code', {}, sourceLine(source))),
    start?.commands && row('Built and started by', commands(start.commands)),
    env.length > 0 && row('Environment', h('ul', { className: 'impl-env' }, ...env.map(([name, value]) => h('li', {}, h('code', {}, `${name}=${value}`))))),
    row('Checks reach it at', h('code', {}, baseUrlOf(implementation))),
    row('Ready when', ready
      ? [h('code', {}, ready.path), ` answers ${ready.status ?? 200}, waiting up to ${readyTimeout(implementation)} s`]
      : source.kind === 'running' ? 'It’s already running' : `Its port answers, waiting up to ${readyTimeout(implementation)} s`),
    stop && row('Tidied up by', commands(stop.commands)),
    credentials?.length > 0 && row('Logins it needs', credentials.map((label, index) => [index ? ', ' : '', h('code', {}, label)]), h('span', { className: 'muted' }, ' (kept on this Mac, never in the schematic)')));
}

export { sourceLine };
