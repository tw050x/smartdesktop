// SmartSpec's Settings: the dialog every app has (@smartdesktop/ui's settings.js: appearance and
// version), with SmartSpec's shared secrets in it, shown afresh each time it opens.
import { createSettings as createDialog } from '@smartdesktop/ui/renderer/settings.js';

export function createSettings({ dialog, api }) {
  const shared = sharedSecrets(dialog, api);
  createDialog({ dialog, api, name: 'SmartSpec', onOpen: () => shared?.refresh() });
}

// Shared secrets (the user's choice, 2026-11-25): named values, each kept once on this Mac and used by
// any number of schematics' secrets (main/secrets.js). Made, given a new value, renamed and deleted
// here; a schematic's secret picks one in Test mode. Values go in, never come back out.
function sharedSecrets(dialog, api) {
  const section = dialog.querySelector('#shared-secrets-setting');
  if (!section || !api.sharedSecrets) return null;
  section.hidden = false;
  const list = section.querySelector('#shared-secret-list');
  const adding = section.querySelector('#shared-secret-new');
  const trouble = section.querySelector('#shared-secrets-trouble');
  let editing = null; // { id, what: 'value' | 'name' } or { id: 'new' }
  let all = [];

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  };
  const button = (label, onclick, title = '') => el('button', { type: 'button', className: 'side-by-side', textContent: label, title, onclick });
  const when = (at) => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const fail = (error) => {
    trouble.textContent = error.message;
    trouble.hidden = false;
  };
  const act = (promise) => promise.then(() => { trouble.hidden = true; editing = null; return refresh(); }, fail);
  // A field and Save (with Return), Escape or Cancel to stop; `extra` buttons beside them.
  const entry = ({ type, placeholder, value = '', save, extra = [] }) => {
    const field = el('input', { type, className: 'secret-field', placeholder, value, autocomplete: 'off', spellcheck: false });
    field.setAttribute('aria-label', placeholder);
    const saveButton = button('Save', () => field.value.trim() && save(field.value));
    saveButton.disabled = !field.value;
    field.addEventListener('input', () => { saveButton.disabled = !field.value.trim(); });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && field.value.trim()) save(field.value);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing = null; draw(); }
    });
    requestAnimationFrame(() => field.focus());
    return { field, row: el('div', { className: 'secret-entry' }, field, saveButton, ...extra, button('Cancel', () => { editing = null; draw(); })) };
  };

  function rowOf(one) {
    const used = one.usedBy.length
      ? `Used by ${one.usedBy.map((use) => `${use.schematic} (${use.name})`).join(', ')}`
      : 'Not used by any schematic yet';
    const mine = editing?.id === one.id;
    const actions = !mine && el('div', { className: 'secret-actions' },
      button('Replace…', () => { editing = { id: one.id, what: 'value' }; draw(); }, `A new value, for every schematic using it`),
      button('New Random Value', () => act(api.generateSharedSecret(one.id)), 'Replace its value with a random one (64 hex characters), for every schematic using it'),
      button('Rename…', () => { editing = { id: one.id, what: 'name' }; draw(); }),
      button('Delete', () => act(api.deleteSharedSecret(one.id))));
    const form = mine && (editing.what === 'name'
      ? entry({ type: 'text', placeholder: 'Its name', value: one.name, save: (name) => act(api.renameSharedSecret(one.id, name)) }).row
      : entry({ type: 'password', placeholder: `${one.name}’s new value`, save: (value) => act(api.setSharedSecret(one.id, value)) }).row);
    return el('li', { className: 'secret set shared-secret' },
      el('div', { className: 'secret-head' },
        el('strong', { className: 'shared-secret-name', textContent: one.name }),
        el('span', { className: 'secret-state set', textContent: one.by === 'random' ? `Made at random, ${when(one.at)}` : `Set ${when(one.at)}` })),
      el('p', { className: 'secret-how muted', textContent: used }),
      actions, form);
  }

  function draw() {
    list.replaceChildren(...all.map(rowOf));
    list.hidden = !all.length;
    if (editing?.id === 'new') {
      // Its name, then its value: entered, or made at random.
      const name = el('input', { type: 'text', className: 'secret-field', placeholder: 'Name, such as Staging database password', autocomplete: 'off', spellcheck: false });
      name.setAttribute('aria-label', 'The shared secret’s name');
      const create = (request) => {
        if (!name.value.trim()) { name.focus(); return; }
        act(api.createSharedSecret({ name: name.value, ...request }));
      };
      const value = entry({ type: 'password', placeholder: 'Its value', save: (entered) => create({ value: entered }), extra: [button('Make Random', () => create({ random: true }), 'A random value (64 hex characters) in place of one entered')] });
      requestAnimationFrame(() => name.focus());
      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') value.field.focus();
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing = null; draw(); }
      });
      adding.replaceChildren(el('div', { className: 'secret shared-secret-adding' }, el('div', { className: 'secret-entry' }, name), value.row));
    } else adding.replaceChildren(el('div', { className: 'shared-secret-actions' }, button('New Shared Secret…', () => { editing = { id: 'new' }; draw(); })));
  }

  async function refresh() {
    all = (await api.sharedSecrets().catch(() => null)) ?? [];
    if (editing && editing.id !== 'new' && !all.some((one) => one.id === editing.id)) editing = null;
    draw();
  }
  api.onSharedSecretsChanged?.(() => dialog.open && refresh());
  return { refresh };
}
