// node:fs/promises for the website demo (see vite.demo.config.js): the files the store keeps,
// held in memory, so the app's own store (main/store.js) runs in the browser. Only what the store
// uses. A file that isn't there fails as Node's does, with code ENOENT. snapshot and restore let
// the demo's director put the store back to any point at once.

const files = new Map(); // path → text

const missing = (file) => Object.assign(new Error(`ENOENT: no such file or directory, '${file}'`), { code: 'ENOENT' });
const clean = (file) => String(file).replace(/\/+$/, '');

export async function readFile(file) {
  const text = files.get(clean(file));
  if (text === undefined) throw missing(file);
  return text;
}
export async function writeFile(file, text) {
  files.set(clean(file), String(text));
}
export async function mkdir() {}
export async function rename(from, to) {
  const text = files.get(clean(from));
  if (text === undefined) throw missing(from);
  files.delete(clean(from));
  files.set(clean(to), text);
}
export async function rm(file, { recursive = false, force = false } = {}) {
  const at = clean(file);
  let found = files.delete(at);
  if (recursive) {
    for (const key of [...files.keys()]) {
      if (key.startsWith(`${at}/`)) found = files.delete(key) || found;
    }
  }
  if (!found && !force) throw missing(file);
}
// The names directly in a folder: its files and the folders that hold any.
export async function readdir(folder) {
  const prefix = `${clean(folder)}/`;
  const names = new Set();
  for (const key of files.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
  if (!names.size) throw missing(folder);
  return [...names];
}

export const snapshot = () => new Map(files);
export function restore(saved) {
  files.clear();
  for (const [key, text] of saved ?? []) files.set(key, text);
}

export default { readFile, writeFile, mkdir, rename, rm, readdir };
