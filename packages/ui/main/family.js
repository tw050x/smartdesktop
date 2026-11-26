// Where the family's apps find each other (for guest tabs, see guests.js), with or without
// SmartDesktop: a folder in the user's Application Support, "SmartDesktop Shared" ("SmartDesktop
// Shared Dev" for development builds, which find only each other; SMARTDESKTOP_SHARED moves it, for
// test copies), holding apps/<id>.json for each app running: { app, name, url, pid }, `url` its
// guest server's, `hosting` if it shows others' tabs, `serving` if it serves its own. Written as the app's server starts, removed as it quits; one whose process has
// gone (a crash) counts for nothing.
import fs from 'node:fs';
import path from 'node:path';

export function familyFolder(app) {
  if (process.env.SMARTDESKTOP_SHARED) return path.resolve(process.env.SMARTDESKTOP_SHARED);
  return path.join(app.getPath('appData'), app.isPackaged ? 'SmartDesktop Shared' : 'SmartDesktop Shared Dev');
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export function createFamily(folder) {
  const apps = path.join(folder, 'apps');
  const fileOf = (id) => path.join(apps, `${id}.json`);
  return {
    // This app is running, served at `url`.
    announce({ app, name, url, hosting = false, serving = false }) {
      fs.mkdirSync(apps, { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileOf(app), JSON.stringify({ app, name, url, hosting, serving, pid: process.pid }), { mode: 0o600 });
    },
    // It's quitting (only its own entry: another copy may have taken the name since).
    withdraw(id) {
      try {
        const entry = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
        if (entry.pid === process.pid) fs.rmSync(fileOf(id), { force: true });
      } catch {
        // Nothing there.
      }
    },
    // The other apps running, by id.
    others(self) {
      let names = [];
      try {
        names = fs.readdirSync(apps).filter((name) => name.endsWith('.json'));
      } catch {
        return [];
      }
      return names.flatMap((name) => {
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(apps, name), 'utf8'));
          return entry.app !== self && entry.url && alive(entry.pid) ? [entry] : [];
        } catch {
          return [];
        }
      });
    },
    get(id) {
      return this.others(null).find((entry) => entry.app === id) ?? null;
    },
  };
}
