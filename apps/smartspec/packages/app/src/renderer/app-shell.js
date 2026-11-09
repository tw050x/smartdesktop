import { APP_MARKUP } from './app-markup.js';
import { watchArrowKeys } from './arrow-nav.js';
import { createSchemas } from './schemas.js';
import { createServerStatus } from './server-status.js';
import { createSettings } from './settings.js';
import './selection.js';

// The window's interface, given the API it works through (window.smartspec, from the preload
// script, talking to the main process). It fills the empty body with the window's markup first.
export function startApp(api) {
  document.body.innerHTML = APP_MARKUP;
  document.body.classList.add(`platform-${api.platform}`);
  api.onFullScreenChange((isFullScreen) => document.body.classList.toggle('full-screen', isFullScreen));
  const serverStatus = createServerStatus({ api });
  api.onAiControl((name) => serverStatus.setAiControl(name));
  createSettings({ dialog: document.getElementById('settings-dialog'), api });
  createSchemas({ el: document.getElementById('content'), bottomBar: document.getElementById('review-bar'), crumbs: document.getElementById('breadcrumb'), draftNav: document.getElementById('draft-nav'), modeCard: document.getElementById('mode-card'), focusMenu: document.getElementById('focus-menu'), viewSwitch: document.getElementById('view-switch'), api });
  watchArrowKeys();
}
