// Settings: a modal in the window, opened from the top bar's gear. Closes with its close button,
// Escape, or a click outside it. Holds the app's Appearance: as the system is, light or dark,
// applied at once (main.js keeps it).

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
