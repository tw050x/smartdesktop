// node:crypto for the website demo (see vite.demo.config.js): the browser's own random ids.
export const randomUUID = () => crypto.randomUUID();
export default { randomUUID };
