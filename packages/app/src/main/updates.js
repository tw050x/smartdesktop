import { app } from 'electron';
import updater from 'electron-updater';

// Keeps the app up to date from the project's GitHub releases (electron-updater reads the newest
// release's latest-mac.yml): it checks soon after starting and every few hours, downloads a new
// version in the background, and installs it when the app quits, or straight away if the user
// chooses to restart. The app's MCP launcher is inside the app, so it updates with it.
// `report(status)` hears each change: { state, version, next?, percent?, message? }, where state
// is 'unavailable' (a development build), 'idle', 'checking', 'current', 'downloading', 'ready' or
// 'error'.

const { autoUpdater } = updater;
const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export function createUpdates({ report }) {
  const version = app.getVersion();
  let status = { state: app.isPackaged ? 'idle' : 'unavailable', version };
  const set = (next) => {
    status = { version, ...next };
    report(status);
  };

  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => {
      if (status.state !== 'downloading' && status.state !== 'ready') set({ state: 'checking' });
    });
    autoUpdater.on('update-not-available', () => set({ state: 'current' }));
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', next: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => set({ state: 'downloading', next: status.next, percent: Math.floor(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', next: info.version }));
    autoUpdater.on('error', (error) => {
      if (status.state !== 'ready') set({ state: 'error', message: error?.message ?? String(error) });
    });
  }

  const check = () => {
    if (!app.isPackaged || status.state === 'downloading' || status.state === 'ready') return;
    autoUpdater.checkForUpdates().catch(() => {}); // reported through the 'error' event
  };

  return {
    get status() {
      return status;
    },
    start() {
      if (!app.isPackaged) return;
      setTimeout(check, FIRST_CHECK_MS);
      setInterval(check, CHECK_EVERY_MS);
    },
    check,
    // Quits, installs the downloaded version and opens it again.
    install() {
      if (status.state === 'ready') autoUpdater.quitAndInstall();
    },
  };
}
