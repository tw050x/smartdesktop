// node:path for the website demo (see vite.demo.config.js): the little of it the store uses.
export function join(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}
export function dirname(file) {
  const at = file.lastIndexOf('/');
  return at > 0 ? file.slice(0, at) : '/';
}
export function basename(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}
export default { join, dirname, basename };
