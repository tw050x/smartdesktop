import { app } from 'electron';
import updater from 'electron-updater';

// Keeps the app up to date from the project's GitHub releases (electron-updater reads the newest
// release's latest-mac.yml): it checks soon after starting and every few hours, downloads a new
// version in the background, and installs it when the app quits, or straight away if the user
// chooses to restart. The app's MCP launcher is inside the app, so it updates with it.
// `report(status)` hears each change: { state, version, next?, percent?, message?, asked? }, where
// state is 'unavailable' (a development build), 'idle', 'checking', 'current', 'downloading',
// 'ready' or 'error', and `asked` marks a check the user asked for (the app menu's Check for
// Updates…), whose every step the update toast shows (update-toast.js), even finding nothing.
// The same in SmartDoc, SmartSpec and SmartDesktop.

const { autoUpdater } = updater;
const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export function createUpdates({ report }) {
  const version = app.getVersion();
  let status = { state: app.isPackaged ? 'idle' : 'unavailable', version };
  let asked = false; // the check under way was asked for, until it comes to an end
  const set = (next) => {
    status = { version, ...next, ...(asked && { asked: true }) };
    if (['current', 'ready', 'error'].includes(next.state)) asked = false;
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

  // `byUser`: the user asked (the app menu), so the toast shows how it goes. Asked while a version
  // is downloading or ready, that's what it shows again (even one put off with Later).
  const check = ({ byUser = false } = {}) => {
    if (byUser) {
      if (!app.isPackaged) return report({ ...status, asked: true });
      if (status.state === 'downloading' || status.state === 'ready') return report({ ...status, asked: true });
      asked = true;
      set({ state: 'checking' });
    }
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
