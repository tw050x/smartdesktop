import { spawn } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { APP_NAME, VERSION } from './platform.js';

// The first-time download of the app, for the user and the AI. When the AI first uses SmartDoc and
// the app isn't on this computer yet, a window (download-window, built from
// helper/download-window.swift; macOS only) asks the user whether to download it, then shows a
// progress bar with a Cancel button. The AI gets describe(), which the bridge answers its tool
// calls with meanwhile, so it can tell the user what's happening.

const HELPER = fileURLToPath(new URL('./download-window', import.meta.url));
const ICON = fileURLToPath(new URL('../icon.png', import.meta.url));
const WINDOW_EVERY_MS = 100;

export class DownloadDeclined extends Error {
  constructor() {
    super(`The user chose not to download ${APP_NAME} now. If they want to use it after all, ask them to, then use any ${APP_NAME} tool and they'll be asked again.`);
  }
}

export class DownloadCancelled extends Error {
  constructor() {
    super(`The user cancelled downloading ${APP_NAME}. If they want to use it after all, ask them to, then use any ${APP_NAME} tool and they'll be asked again.`);
  }
}

export const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

// "about 20 seconds", "about 2 minutes".
function roughly(seconds) {
  if (seconds < 10) return 'a few seconds';
  if (seconds < 60) return `about ${Math.ceil(seconds / 5) * 5} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// The download's progress in words, and how far it's got (0 to 1, or -1 if the size isn't known).
export function progressText({ received, total, elapsedMs }) {
  if (!total) return { fraction: -1, percent: null, detail: received ? megabytes(received) : 'Starting…', left: null };
  const fraction = Math.min(received / total, 1);
  const rate = elapsedMs > 1000 && received ? received / elapsedMs : null;
  const left = rate ? roughly((total - received) / rate / 1000) : null;
  return {
    fraction,
    percent: Math.floor(fraction * 100),
    detail: `${Math.round(received / 1e6)} of ${megabytes(total)}${left ? ` · ${left} left` : ''}`,
    left,
  };
}

// The window, asking whether to download: `answer(true or false)` hears the user's choice (false
// too if the window goes away first), and `cancel()` the user cancelling the download after.
// Null if this launcher has no window.
function openWindow({ helper, size, answer, cancel }) {
  if (process.platform !== 'darwin' || !existsSync(helper)) return null;
  try {
    chmodSync(helper, 0o755); // in case unpacking lost it
  } catch {}
  let child;
  try {
    child = spawn(helper, ['--icon', ICON, ...(size ? ['--size', size] : [])], { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  let answered = false;
  const reply = (yes) => {
    if (answered) return;
    answered = true;
    answer(yes);
  };
  child.on('error', () => reply(false));
  child.on('exit', () => reply(false));
  child.stdin.on('error', () => {});
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const word = line.trim();
    if (word === 'download') reply(true);
    else if (word === 'decline') reply(false);
    else if (word === 'cancel') cancel();
  });
  // The launcher can exit with the window still up (showing an error): it closes with our stdin.
  child.unref();
  child.stdout.unref?.();
  const send = (line) => child.stdin.writable && child.stdin.write(`${line.replace(/\s+/g, ' ')}\n`);
  return {
    show: (fraction, detail) => send(`progress ${fraction} ${detail}`),
    fail: (message) => send(`error ${message}`),
    close: () => {
      send('close');
      child.stdin.end();
    },
  };
}

// One attempt at a time: begin() (its signal cancels the download), ask() whether to download,
// progress() as bytes arrive, then installed() and finish() once the app is open, or
// failed(error) if it went wrong, was declined or cancelled.
export function createDownload({ helper = HELPER, now = Date.now } = {}) {
  let controller = null;
  let window = null;
  // While an attempt runs: { asking, size } until the user answers, then { received, total,
  // startedAt, opening }.
  let state = null;
  let notice = null; // the user declined or cancelled: the AI hears it once
  let shown = false; // whether this attempt has a window
  let shownAt = 0;

  const closeWindow = () => {
    window?.close();
    window = null;
  };

  const download = {
    begin() {
      controller = new AbortController();
      state = null;
      notice = null;
      return controller.signal;
    },
    // Asks the user whether to download the app (`bytes` big, if known). Resolves to their answer;
    // true straight away if there's no window to ask in.
    ask(bytes) {
      const size = bytes ? megabytes(bytes) : null;
      return new Promise((resolve) => {
        state = { asking: true, size };
        closeWindow();
        window = openWindow({
          helper,
          size,
          answer: (yes) => {
            if (yes) state = { received: 0, total: bytes ?? null, startedAt: now(), opening: false };
            resolve(yes);
          },
          cancel: () => download.cancel(),
        });
        shown = Boolean(window);
        if (!window) {
          state = { received: 0, total: bytes ?? null, startedAt: now(), opening: false };
          resolve(true);
        }
      });
    },
    progress(received, total) {
      if (!state || state.asking) state = { received: 0, total: null, startedAt: now(), opening: false };
      state.received = received;
      state.total = total ?? state.total;
      if (now() - shownAt < WINDOW_EVERY_MS && received !== total) return;
      shownAt = now();
      const { fraction, detail } = progressText({ received, total: state.total, elapsedMs: now() - state.startedAt });
      window?.show(fraction, detail);
    },
    // The user cancelled the download (the window's Cancel button).
    cancel() {
      if (state && !state.asking && !state.opening) controller?.abort(new DownloadCancelled());
    },
    // Downloaded and unpacked: the app is opening.
    installed() {
      if (!state) return;
      state.opening = true;
      window?.show(-1, `Opening ${APP_NAME}…`);
    },
    finish() {
      state = null;
      controller = null;
      closeWindow();
    },
    // The error to report: the user's declining or cancelling, or what went wrong (which the
    // window shows until the user closes it).
    failed(error) {
      const cancelled = controller?.signal.aborted && controller.signal.reason instanceof DownloadCancelled;
      const reported = cancelled ? controller.signal.reason : error;
      if (reported instanceof DownloadCancelled || reported instanceof DownloadDeclined) {
        notice = reported.message;
        closeWindow();
      } else {
        window?.fail(reported.message);
      }
      window = null;
      state = null;
      controller = null;
      return reported;
    },
    // For the AI: what's happening while an attempt runs, or that the user declined or cancelled
    // (once); null otherwise.
    describe() {
      if (notice) {
        const told = notice;
        notice = null;
        return told;
      }
      if (!state) return null;
      if (state.asking) {
        return `${APP_NAME} isn't on this computer yet. A window on the user's screen is asking them whether to download it${state.size ? ` (${state.size})` : ''}. `
          + 'Tell the user to answer it there, then try again once they have.';
      }
      if (state.opening) return `${APP_NAME} has finished downloading and is opening. Try again in a few seconds.`;
      const { percent, left } = progressText({ received: state.received, total: state.total, elapsedMs: now() - state.startedAt });
      const sofar = [percent !== null && `${percent}% done`, left && `${left} left`].filter(Boolean).join(', ');
      return `${APP_NAME} ${VERSION} is being downloaded for the first time${sofar ? ` (${sofar})` : ''}. `
        + `${shown ? "A window on the user's screen shows its progress, and " : ''}${APP_NAME} opens by itself when it's done. `
        + 'Tell the user, then try again in a moment.';
    },
  };
  return download;
}
