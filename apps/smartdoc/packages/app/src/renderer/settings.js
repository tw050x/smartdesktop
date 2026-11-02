// Settings: a modal in the window, opened from the top bar's gear. Closes with its close button,
// Escape, or a click outside it. Holds the app's Appearance: as the system is, light or dark,
// applied at once (main.js keeps it); and its Updates (updates.js), which download by themselves.
// Once one has downloaded, a button in the top bar offers to restart into it.

export function createSettings({ button, dialog, api }) {
  const appearance = dialog.querySelector('#appearance');
  const choices = [...appearance.querySelectorAll('[data-appearance]')];
  const show = (value) => choices.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.appearance === value)));
  for (const choice of choices) {
    choice.addEventListener('click', () => {
      show(choice.dataset.appearance);
      api.setAppearance(choice.dataset.appearance);
    });
  }

  // Updates: the version, what's happening, and a button to check now or restart into a new one.
  const version = dialog.querySelector('#update-version');
  const state = dialog.querySelector('#update-state');
  const action = dialog.querySelector('#update-action');
  const restart = document.getElementById('update-button');
  function showUpdates(u) {
    version.textContent = `SmartDoc ${u.version}`;
    state.textContent = {
      unavailable: 'Development build',
      idle: 'Updates are checked for automatically',
      checking: 'Checking for updates…',
      current: 'Up to date',
      downloading: `Downloading ${u.next ?? 'an update'}… ${u.percent ?? 0}%`,
      ready: `${u.next} is ready to install`,
      error: 'Couldn’t check for updates',
    }[u.state];
    action.textContent = u.state === 'ready' ? 'Restart to Update' : 'Check for Updates';
    action.disabled = ['unavailable', 'checking', 'downloading'].includes(u.state);
    restart.hidden = u.state !== 'ready';
    restart.title = u.state === 'ready' ? `Restart SmartDoc to update to ${u.next}` : '';
  }
  let updates = { state: 'idle', version: '' };
  action.addEventListener('click', () => (updates.state === 'ready' ? api.installUpdate() : api.checkForUpdates()));
  restart.addEventListener('click', () => api.installUpdate());
  api.onUpdates((u) => showUpdates((updates = u)));
  api.getUpdates().then((u) => showUpdates((updates = u)));

  // The dialog takes focus itself, not its close button, so nothing shows a focus ring on opening.
  button.addEventListener('click', () => {
    api.getAppearance().then(show); // as it is now, wherever it was last set
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
