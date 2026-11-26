// Settings: a modal in the window, opened from the SmartStudio menu's Settings… (⌘,). Closes with its close button,
// Escape, or a click outside it. Holds the app's Appearance: as the system is, light or dark,
// applied at once (main.js keeps it); the generation server's address, checked as it's saved; and
// the app's version. Its updates show in the update toast
// (update-toast.js), and the app menu's Check for Updates… looks for one now.

export function createSettings({ dialog, api }) {
  const appearance = dialog.querySelector('#appearance');
  const choices = [...appearance.querySelectorAll('[data-appearance]')];
  const show = (value) => choices.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.appearance === value)));
  for (const choice of choices) {
    choice.addEventListener('click', () => {
      show(choice.dataset.appearance);
      api.setAppearance(choice.dataset.appearance);
    });
  }

  // The version (updates show in the update toast, update-toast.js).
  const version = dialog.querySelector('#update-version');
  const showVersion = (u) => u?.version && (version.textContent = `SmartStudio ${u.version}`);
  api.onUpdates(showVersion);
  api.getUpdates().then(showVersion);

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

  // The dialog takes focus itself, not its close button, so nothing shows a focus ring on opening.
  api.onShowSettings(() => {
    if (dialog.open) return;
    api.getAppearance().then(show); // as it is now, wherever it was last set
    api.getServer?.().then(({ url, state }) => {
      field.value = url;
      showCheck(state);
    });
    dialog.showModal();
    dialog.focus();
  });
  dialog.querySelector('#settings-close').addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog itself, outside its box.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
}
