// Settings: a modal in the window, opened from the app menu's Settings… (⌘,), the same in every app
// with tabs (SmartDesktop's settings are a window of its own). Closes with its close button, Escape,
// or a click outside it. Holds the app's Appearance: as the system is, light or dark, applied at
// once (main.js keeps it); and the app's version (`name` and its version). Its updates show in the
// update toast (update-toast.js), and the app menu's Check for Updates… looks for one now. An app
// with settings of its own (SmartDoc's experiments, SmartSpec's shared secrets, SmartStudio's
// generation server) sets them up itself, beside this, and is told each time it opens (`onOpen`).

export function createSettings({ dialog, api, name, onOpen = () => {} }) {
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
  const showVersion = (u) => u?.version && (version.textContent = `${name} ${u.version}`);
  api.onUpdates(showVersion);
  api.getUpdates().then(showVersion);

  // The dialog takes focus itself, not its close button, so nothing shows a focus ring on opening.
  api.onShowSettings(() => {
    if (dialog.open) return;
    api.getAppearance().then(show); // as it is now, wherever it was last set
    onOpen();
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
