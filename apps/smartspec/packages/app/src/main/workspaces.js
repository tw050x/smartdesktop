// Each schematic's workspace: a clone of its code's git repository (or the one holding its Compose
// file) on this Mac, in ~/.smartspec/workspaces/<name>-<id> (the user's choice: a folder of the
// app's own in their home folder, so they, and their AI, can work on the files there). The runner
// clones it there on the first run, at the schematic's ref, then tests it as it is, uncommitted
// changes and all, never resetting it. Its place is fixed once chosen (kept in workspaces.json in the
// app's data), so renaming the schematic doesn't move it. Never part of the schematic.
// SMARTSPEC_HOME moves ~/.smartspec (tests, a development build that wants its own).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export { WORKSPACE_KINDS } from './implementation.js';

export const smartspecHome = (env = process.env) => env.SMARTSPEC_HOME || path.join(os.homedir(), '.smartspec');

// A folder as the user would write it: ~/.smartspec/workspaces/orders-mwt7abpm.
const shortened = (dir) => (dir === os.homedir() || dir.startsWith(`${os.homedir()}${path.sep}`) ? `~${dir.slice(os.homedir().length)}` : dir);
const slug = (name) => (name ?? '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'schematic';

const git = (dir, args) => new Promise((resolve) => {
  execFile('git', args, { cwd: dir, timeout: 5000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout.trim()));
});

export function createWorkspaces(userData, { home = smartspecHome() } = {}) {
  const file = path.join(userData, 'workspaces.json');
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  return {
    // Where a schematic's workspace is, or will be: chosen (and kept) the first time it's asked for.
    pathFor(schemaId, name) {
      if (!all[schemaId]) {
        all[schemaId] = path.join(home, 'workspaces', `${slug(name)}-${schemaId.split('-')[0]}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(all, null, 2));
      }
      return all[schemaId];
    },
    // What's there: { dir, label, cloned, branch, commit, changes } (changes: files with
    // uncommitted changes); cloned false before its first run.
    async info(schemaId, name) {
      const dir = this.pathFor(schemaId, name);
      const cloned = fs.existsSync(path.join(dir, '.git'));
      if (!cloned) return { dir, label: shortened(dir), cloned: false };
      const [branch, commit, status] = await Promise.all([
        git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(dir, ['log', '-1', '--format=%h %s']),
        git(dir, ['status', '--porcelain']),
      ]);
      return { dir, label: shortened(dir), cloned: true, branch: branch === 'HEAD' ? null : branch, commit, changes: status ? status.split('\n').length : 0 };
    },
  };
}
