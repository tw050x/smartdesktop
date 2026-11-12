// The update toast, centred at the bottom of the window: where updates show (the user's choice: not
// in Settings). A check the user asked for (the app menu's Check for Updates…, `asked` from
// updates.js) shows a spinner while it looks, then what it found: up to date, or why it couldn't
// check, put away after a moment. A new version downloading shows how much has arrived, asked for or
// not, and once it's downloaded, Restart to Update and Later: Later puts it away until the next
// version, or until the user checks again. The same in SmartDoc, SmartSpec and SmartDesktop apart
// from the app's name.

const SETTLE_MS = 4000; // how long "up to date" and the like stay

export function createUpdateToast({ api, name }) {
  const toast = document.createElement('div');
  toast.className = 'update-toast';
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  const spinner = Object.assign(document.createElement('span'), { className: 'update-toast-spinner' });
  spinner.setAttribute('aria-hidden', 'true');
  const text = Object.assign(document.createElement('span'), { className: 'update-toast-text' });
  const percent = Object.assign(document.createElement('span'), { className: 'update-toast-percent' });
  const restart = Object.assign(document.createElement('button'), { type: 'button', className: 'primary-button', textContent: 'Restart to Update' });
  const later = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary-button', textContent: 'Later' });
  toast.append(spinner, text, percent, restart, later);
  document.body.append(toast);

  let putOff = null; // the version the user chose Later for
  let settling = null;
  let shown = { state: 'idle' };
  restart.addEventListener('click', () => api.installUpdate());
  later.addEventListener('click', () => {
    putOff = shown.next;
    toast.hidden = true;
  });

  function show(u) {
    shown = u;
    clearTimeout(settling);
    // Asked for again: whatever it finds shows, even a version put off before.
    if (u.asked) putOff = null;
    const parts = {
      checking: u.asked && { spin: true, text: 'Checking for updates…' },
      downloading: u.next !== putOff && { text: `Downloading ${name} ${u.next ?? ''}`.trim(), percent: `${u.percent ?? 0}%` },
      ready: u.next !== putOff && { text: `${name} ${u.next} is ready to install.`, buttons: true },
      current: u.asked && { text: `${name} is up to date.`, settle: true },
      error: u.asked && { text: 'Couldn’t check for updates. Check your connection and try again.', settle: true },
      unavailable: u.asked && { text: 'A development build doesn’t update itself.', settle: true },
    }[u.state];
    toast.hidden = !parts;
    if (!parts) return;
    spinner.hidden = !parts.spin;
    text.textContent = parts.text;
    percent.hidden = !parts.percent;
    percent.textContent = parts.percent ?? '';
    restart.hidden = !parts.buttons;
    later.hidden = !parts.buttons;
    if (parts.settle) settling = setTimeout(() => (toast.hidden = true), SETTLE_MS);
  }

  api.onUpdates(show);
  api.getUpdates().then((u) => {
    // What it was before this window opened: only a version downloading or ready shows.
    if (u) show({ ...u, asked: false });
  });
}
