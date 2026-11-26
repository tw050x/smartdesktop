// PDF's objects as read: numbers, booleans and null as themselves; strings as binary strings (one
// character per byte, decoded to text only where text is wanted, see text.js); names as Name, one
// object per name so they compare with ===; arrays; dictionaries as Dict; references as Ref; and
// streams as Stream, its dictionary and its encoded bytes.

export class Name {
  static #all = new Map();
  constructor(name) {
    this.name = name;
  }
  static of(name) {
    let n = Name.#all.get(name);
    if (!n) Name.#all.set(name, (n = new Name(name)));
    return n;
  }
  toString() {
    return `/${this.name}`;
  }
}

export class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
  get key() {
    return `${this.num}R${this.gen}`;
  }
  toString() {
    return `${this.num} ${this.gen} R`;
  }
}

// A dictionary: its entries by key (without the slash). get() follows references through the
// document it belongs to; raw() doesn't.
export class Dict {
  constructor(doc = null) {
    this.doc = doc;
    this.map = new Map();
  }
  set(key, value) {
    this.map.set(key, value);
  }
  has(key) {
    return this.map.has(key);
  }
  raw(key) {
    return this.map.get(key);
  }
  get(key, ...more) {
    let value = this.map.get(key);
    for (let i = 0; value === undefined && i < more.length; i++) value = this.map.get(more[i]);
    return this.doc && value instanceof Ref ? this.doc.fetch(value) : value;
  }
  // The entry as an array, each element followed through references.
  array(key) {
    const value = this.get(key);
    if (!Array.isArray(value)) return null;
    return this.doc ? value.map((v) => (v instanceof Ref ? this.doc.fetch(v) : v)) : value;
  }
  number(key, fallback = null) {
    const value = this.get(key);
    return typeof value === 'number' ? value : fallback;
  }
  name(key) {
    const value = this.get(key);
    return value instanceof Name ? value.name : null;
  }
  dict(key) {
    const value = this.get(key);
    if (value instanceof Dict) return value;
    if (value instanceof Stream) return value.dict;
    return null;
  }
  keys() {
    return [...this.map.keys()];
  }
}

export class Stream {
  constructor(dict, bytes) {
    this.dict = dict;
    this.bytes = bytes; // as stored, possibly encrypted and encoded (see document.js, filters.js)
    this.decoded = null;
  }
}

export const isName = (value, name) => value instanceof Name && (name === undefined || value.name === name);

// Follows a value through references in `doc`.
export const resolve = (doc, value) => (value instanceof Ref ? doc.fetch(value) : value);

// A dictionary's or a stream's dictionary.
export const dictOf = (value) => (value instanceof Stream ? value.dict : value instanceof Dict ? value : null);
