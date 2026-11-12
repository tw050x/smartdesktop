// The settings window (see main.js), from the menu bar icon's Settings…: the appearance, applied at
// once (main.js keeps it); the AI setup; and updates (updates.js), which download by themselves and
// install when SmartDesktop quits, or now, with Restart to Update.
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

const version = document.getElementById('update-version');
const state = document.getElementById('update-state');
const action = document.getElementById('update-action');
let updates = { state: 'idle', version: '' };
function showUpdates(u) {
  updates = u;
  version.textContent = `SmartDesktop ${u.version}`;
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
}
action.addEventListener('click', () => (updates.state === 'ready' ? api.installUpdate() : api.checkForUpdates()));
api.onUpdates(showUpdates);
api.getUpdates().then(showUpdates);
