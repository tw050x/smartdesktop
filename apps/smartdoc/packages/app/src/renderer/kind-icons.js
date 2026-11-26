// An icon for each kind of thing in a review, shared by the cards beside the pages and the chat's
// list of findings: wording, content, question, structure, design and flag findings, notes, the
// user's comments (and earlier ones) and highlights.

const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  change: svg('<path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="m14 8 2 2"/>'),
  options: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.2 9a3 3 0 0 1 5.7 1c0 2-3 2.6-3 4.5"/><path d="M12 17.5h.01"/>'),
  move: svg('<path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4"/>'),
  design: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.5h17M9.5 9.5v11"/>'),
  flag: svg('<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>'),
  note: svg('<path d="M5 4h14v10l-6 6H5Z"/><path d="M13 20v-6h6"/>'),
  comment: svg('<path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z"/>'),
  earlier: svg('<path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z" stroke-dasharray="3 3"/>'),
  highlight: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9Z"/>'),
};

// The icon for an item as the review lists it: a finding's kind, else what it is.
export const kindIcon = (item) => ICONS[item.type === 'finding' ? item.item.kind : item.type] ?? ICONS.flag;
