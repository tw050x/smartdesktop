// The settings window (see main.js), from the menu bar icon's Settings…: the appearance, applied at
// once (main.js keeps it); the AI setup; and the version. Updates show in the update toast in the
// chat's window (update-toast.js).
const api = window.smartdesktop;
document.body.classList.add(`platform-${api.platform}`);

const choices = [...document.querySelectorAll('[data-appearance]')];
const showAppearance = (value) => choices.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.appearance === value)));
for (const choice of choices) {
  choice.addEventListener('click', () => {
    showAppearance(choice.dataset.appearance);
    api.setAppearance(choice.dataset.appearance);
  });
}
api.getAppearance().then(showAppearance);

document.getElementById('open-setup').addEventListener('click', () => api.openSetup());

// The version (updates show in the update toast in the chat's window, update-toast.js).
const version = document.getElementById('update-version');
const showVersion = (u) => u?.version && (version.textContent = `SmartDesktop ${u.version}`);
api.onUpdates(showVersion);
api.getUpdates().then(showVersion);
