// Settings: a modal in the window, opened from the top bar's gear. Closes with its close button,
// Escape, or a click outside it.

export function createSettings({ button, dialog }) {
  // The dialog takes focus itself, not its close button, so nothing shows a focus ring on opening.
  button.addEventListener('click', () => {
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
