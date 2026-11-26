// SmartStudio's Settings: the dialog every app has (@smartdesktop/ui's settings.js: appearance and
// version), with the generation server's address in it, checked as it's saved.
import { createSettings as createDialog } from '@smartdesktop/ui/renderer/settings.js';

export function createSettings({ dialog, api }) {
  // The generation server's address, saved and checked at once, and what it says back.
  const field = dialog.querySelector('#server-url-input');
  const check = dialog.querySelector('#server-check');
  const showCheck = (state) => {
    if (!state) return;
    if (state.checking && !state.reachable) check.textContent = 'Checking…';
    else if (!state.reachable) check.textContent = state.error ?? 'It doesn’t answer.';
    else {
      const kinds = Object.entries(state.kinds ?? {}).map(([kind, { ready, missing }]) => `${kind === 'music' ? 'Music' : 'Video'}: ${ready ? 'ready' : `needs ${missing.length === 1 ? 'a model' : `${missing.length} models`}`}`).join(' · ');
      check.textContent = `Connected${state.device ? ` to ${state.device}` : ''}${state.version ? `, ComfyUI ${state.version}` : ''}. ${kinds}`;
    }
    check.classList.toggle('problem', !state.reachable || Object.values(state.kinds ?? {}).some((kind) => !kind.ready));
  };
  api.onServerCheck?.(showCheck);
  const save = async () => {
    check.textContent = 'Checking…';
    try {
      showCheck(await api.setServer(field.value));
    } catch (error) {
      check.textContent = String(error.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      check.classList.add('problem');
    }
  };
  dialog.querySelector('#server-save').addEventListener('click', save);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
  });

  // Each time it opens, the address as it is now and how the server last answered.
  createDialog({ dialog, api, name: 'SmartStudio', onOpen: () => api.getServer?.().then(({ url, state }) => {
    field.value = url;
    showCheck(state);
  }) });
}
