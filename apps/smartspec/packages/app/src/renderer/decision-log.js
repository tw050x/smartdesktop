// A schematic's decision log (see store.decisions), in a panel sliding in over the right of the
// window as the status panel does: every decision on it, newest first, grouped by day. Kept for
// auditing (the user's choice): who proposed what and why, what the user approved, accepted (and
// what they were warned of) or discarded, and when it came to show a new draft of something it
// embeds. Only to read: nothing in it is changed from here.

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key === 'className' ? 'class' : key, value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

const CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const list = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
const quoted = (things) => list(things.map((one) => `“${one.title}”`));
const draftName = (number) => (number ? `draft ${number}` : 'a draft since removed');

// A use's change, in words.
function useLine(use) {
  const name = `“${use.name ?? use.use}”`;
  switch (use.change) {
    case 'added': return use.pin ? `Embeds ${name}, pinned to ${draftName(use.pinNumber)}` : `Embeds ${name}, following its latest draft`;
    case 'removed': return `No longer embeds ${name}`;
    case 'replaced': return `${use.use} now embeds ${name}`;
    case 'pinned': return `Pinned ${name} to ${draftName(use.pinNumber)}`;
    case 'repinned': return `Pinned ${name} to ${draftName(use.pinNumber)} (was ${draftName(use.wasNumber)})`;
    case 'unpinned': return `${name} follows its latest draft again${use.wasNumber ? ` (was pinned to draft ${use.wasNumber})` : ''}`;
    default: return `Changed what it sets or relies on in ${name}`;
  }
}

// What a proposal changes, as lines.
function changeLines(changes = {}) {
  return [
    changes.first && 'The schematic’s first draft',
    changes.renamed && `Renamed it “${changes.renamed.to}” (was “${changes.renamed.from}”)`,
    changes.summary && 'Changed the summary',
    changes.parameters && 'Changed the parameters a use can set',
    changes.added && `Added ${quoted(changes.added)}`,
    changes.changed && `Changed ${quoted(changes.changed)}`,
    changes.removed && `Removed ${quoted(changes.removed)}`,
    changes.contract && 'Changed the contract',
    changes.implementation && 'Changed the implementation',
    ...(changes.uses ?? []).map(useLine),
  ].filter(Boolean);
}

// What a reason is about: an item by its title where the change names it.
function reasonTitle(key, changes = {}) {
  if (key === 'contract') return 'The contract';
  if (key === '@implementation') return 'The implementation';
  return [...(changes.added ?? []), ...(changes.changed ?? []), ...(changes.removed ?? [])].find((one) => one.id === key)?.title ?? key;
}

const section = (label, ...rows) => (rows.flat().filter(Boolean).length ? h('div', { className: 'log-section' }, h('span', { className: 'log-label' }, label), ...rows) : null);
const lines = (texts, kind = '') => texts.map((text) => h('p', { className: `log-line ${kind}` }, text));

// The heading of an entry, and what it says.
function describe(entry, { onDraft }) {
  const who = entry.by === 'user' ? 'You' : entry.by;
  switch (entry.type) {
    case 'proposed':
      return {
        title: `${entry.revises ? 'Proposal revised' : 'Proposed'}${entry.by ? ` by ${entry.by}` : ''}`,
        body: [
          entry.note && h('p', { className: 'log-note' }, entry.note),
          entry.goal && section('Goal', lines([entry.goal])),
          section('Changes', lines(changeLines(entry.changes))),
        ],
      };
    case 'approved':
    case 'unapproved':
      return { title: entry.type === 'approved' ? `You approved ${entry.title === 'The contract' || entry.title === 'The implementation' ? entry.title.toLowerCase() : `“${entry.title}”`}` : `You took back your approval of ${entry.title === 'The contract' || entry.title === 'The implementation' ? entry.title.toLowerCase() : `“${entry.title}”`}`, quiet: true };
    case 'accepted':
      return {
        title: `${who} accepted it as draft ${entry.number}`,
        go: () => onDraft(entry.draft),
        body: [
          entry.note && h('p', { className: 'log-note' }, entry.note),
          entry.proposedBy && h('p', { className: 'log-line muted' }, `Proposed by ${entry.proposedBy}`),
          entry.goal && section('Goal', lines([entry.goal])),
          section('Changes', lines(changeLines(entry.changes))),
          entry.reasons && section('Why', Object.entries(entry.reasons).map(([key, why]) => h('p', { className: 'log-line' }, h('strong', {}, `${reasonTitle(key, entry.changes)}: `), why))),
          entry.notApproved?.length && section('Not approved', lines([`${quoted(entry.notApproved)}, accepted as proposed`])),
          (entry.warning || entry.unanswered) && section('Accepted anyway',
            entry.unanswered && lines([`${entry.unanswered === 1 ? '1 comment' : `${entry.unanswered} comments`} the AI hadn’t answered`], 'warn'),
            entry.warning && lines([entry.warning], 'warn')),
          entry.followers?.length && section('Changed with it', entry.followers.map((one) => h('p', { className: `log-line${one.breaks || one.undeclared ? ' warn' : ''}` },
            `“${one.name}” now shows this draft${one.breaks ? `, which changes or removes ${list(one.breaks.map((broken) => `“${broken.part}”`))} it links to` : ''}${one.undeclared ? `, and sets ${list(one.undeclared.map((name) => `“${name}”`))}, no longer declared` : ''}`))),
        ],
      };
    case 'discarded':
      return {
        title: `${who} discarded a proposal`,
        body: [
          entry.note && h('p', { className: 'log-note' }, entry.note),
          entry.proposedBy && h('p', { className: 'log-line muted' }, `Proposed by ${entry.proposedBy}`),
          section('It would have', lines(changeLines(entry.changes))),
          entry.comments && lines([`${entry.comments === 1 ? '1 comment' : `${entry.comments} comments`} on it, kept with it`], 'muted'),
        ],
      };
    case 'follows':
      return {
        title: `Now shows “${entry.name}” draft ${entry.to.number}`,
        body: [
          h('p', { className: 'log-line muted' }, `${entry.from ? `It showed draft ${entry.from.number}. ` : ''}${entry.uses.length > 1 ? `Its uses ${list(entry.uses)} follow` : 'This follows'} its latest draft, so ${entry.uses.length > 1 ? 'they' : 'it'} moved when you accepted the new one.`),
          entry.breaks && lines([`It changes or removes ${list(entry.breaks.map((broken) => `“${broken.part}”`))}, which this links to.`], 'warn'),
          entry.undeclared && lines([`This sets ${list(entry.undeclared.map((name) => `“${name}”`))}, which it no longer declares.`], 'warn'),
        ],
      };
    default:
      return { title: entry.type };
  }
}

const dayOf = (at) => {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};
const timeOf = (at) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

let panel = null;
let mask = null;
let lastFocus = null;
const isOpen = () => document.body.classList.contains('log-open');

export function closeDecisionLog() {
  if (!panel || !isOpen()) return;
  document.body.classList.remove('log-open');
  panel.inert = true;
  lastFocus?.focus?.();
}

function build() {
  mask = h('div', { className: 'log-mask' });
  mask.addEventListener('click', closeDecisionLog);
  const close = h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: closeDecisionLog });
  close.innerHTML = CLOSE;
  panel = h('aside', { className: 'log-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'log-title' },
    h('div', { className: 'log-bar' }, h('h2', { id: 'log-title', className: 'log-title' }, 'Decision log'), close),
    h('div', { className: 'log-body' }));
  panel.inert = true;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.stopPropagation();
      closeDecisionLog();
    }
  }, true);
  document.body.append(mask, panel);
}

// Opens the log of schematic `schemaId` (named `name`); `onDraft(draftId)` shows a draft.
export async function openDecisionLog({ schemaId, name, api, onDraft }) {
  if (!panel) build();
  lastFocus = document.activeElement;
  const body = panel.querySelector('.log-body');
  panel.querySelector('.log-title').textContent = `Decision log of ${name}`;
  body.replaceChildren(h('p', { className: 'log-empty' }, 'Loading…'));
  panel.inert = false;
  document.body.classList.add('log-open');
  panel.querySelector('button').focus();
  let log;
  try {
    log = await api.decisionLog(schemaId);
  } catch (error) {
    body.replaceChildren(h('p', { className: 'log-empty' }, `Couldn’t read it: ${error.message}`));
    return;
  }
  if (!log.entries.length) {
    body.replaceChildren(h('p', { className: 'log-empty' }, 'Nothing decided yet. Decisions are logged from this version of SmartSpec on: what’s proposed, approved, accepted and discarded, and when what this embeds moves to a new draft.'));
    return;
  }
  const go = (draftId) => {
    closeDecisionLog();
    onDraft(draftId);
  };
  const groups = [];
  for (const entry of log.entries) {
    const day = dayOf(entry.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, entries: [] });
    groups.at(-1).entries.push(entry);
  }
  body.replaceChildren(
    h('p', { className: 'log-intro' }, 'Every decision on this schematic, newest first, kept for auditing. Nothing here can be changed or removed.'),
    ...groups.map(({ day, entries }) => h('section', { className: 'log-day' },
      h('h3', {}, day),
      ...entries.map((entry) => {
        const { title, body: rows = [], quiet, go: show } = describe(entry, { onDraft: go });
        return h('article', { className: `log-entry ${entry.type}${quiet ? ' quiet' : ''}` },
          h('div', { className: 'log-head' },
            h('span', { className: 'log-dot', 'aria-hidden': 'true' }),
            h('strong', {}, title),
            h('time', { datetime: entry.at, title: new Date(entry.at).toLocaleString() }, timeOf(entry.at))),
          ...rows.flat().filter(Boolean),
          show && h('button', { className: 'link-button log-show', type: 'button', onclick: show }, `Show draft ${entry.number}`));
      }))),
  );
}
