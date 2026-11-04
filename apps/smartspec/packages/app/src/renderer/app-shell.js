import { APP_MARKUP } from './app-markup.js';
import { createServerStatus } from './server-status.js';
import { createSettings } from './settings.js';

// The window's interface, given the API it works through (window.smartspec, from the preload
// script, talking to the main process). It fills the empty body with the window's markup first.
export function startApp(api) {
  document.body.innerHTML = APP_MARKUP;
  document.body.classList.add(`platform-${api.platform}`);
  const serverStatus = createServerStatus({ api });
  api.onAiControl((name) => serverStatus.setAiControl(name));
  createSettings({ button: document.getElementById('settings-button'), dialog: document.getElementById('settings-dialog'), api });
  document.getElementById('home-connect').addEventListener('click', () => serverStatus.open());
}
