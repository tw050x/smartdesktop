// node:events for the website demo (see vite.demo.config.js): the little of EventEmitter the store
// and the demo's stand-in API use.
export class EventEmitter {
  #listeners = new Map();
  on(name, listener) {
    if (!this.#listeners.has(name)) this.#listeners.set(name, []);
    this.#listeners.get(name).push(listener);
    return this;
  }
  off(name, listener) {
    this.#listeners.set(name, (this.#listeners.get(name) ?? []).filter((one) => one !== listener));
    return this;
  }
  emit(name, ...args) {
    for (const listener of this.#listeners.get(name) ?? []) listener(...args);
    return Boolean(this.#listeners.get(name)?.length);
  }
}
export default { EventEmitter };
