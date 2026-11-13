// A PDF file opened for reading: its cross-reference data (tables, streams, hybrid files, updates
// chained by /Prev), rebuilt by scanning the file when it's missing or damaged; its objects,
// fetched as they're needed (from object streams too) and decrypted; its pages, with the
// attributes they inherit; its metadata and outline.

import { decodeStream, streamBytes } from './filters.js';
import { Dict, Name, Ref, Stream } from './objects.js';
import { Cmd, EOF, Lexer, Parser, bytesOf, indexOf, lastIndexOf, latin1 } from './parser.js';
import { PasswordError, createSecurity } from './security.js';

const OBJ = Cmd.of('obj');

export class PdfDocument {
  // `data` is the file's bytes (a Uint8Array or Buffer); `password` opens an encrypted one.
  constructor(data, { password = '' } = {}) {
    this.bytes = data instanceof Uint8Array ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    this.entries = new Map(); // object number → { type: 1, offset, gen } | { type: 2, stream, index }
    this.cache = new Map();
    this.fetching = new Set();
    this.trailer = null;
    this.repaired = false;
    this.headerOffset = Math.max(0, indexOf(this.bytes, bytesOf('%PDF-'), 0, Math.min(this.bytes.length, 1024)));
    try {
      this.readXrefChain();
    } catch {
      this.trailer = null;
    }
    // Decryption is set up before the catalog is looked for, as it may be in an encrypted object
    // stream.
    if (this.trailer) {
      try {
        this.setUpSecurity(password);
      } catch (e) {
        if (e instanceof PasswordError) throw e;
        this.trailer = null;
      }
    }
    if (!this.trailer || !this.trailer.has('Root') || !this.rootOk()) {
      this.decryptString = this.decryptStream = this.decryptStreamWith = undefined;
      this.cache.clear();
      this.rebuild();
      this.setUpSecurity(password);
    }
    this.catalog = this.trailer.dict('Root');
    if (!this.catalog) throw new Error('This file has no document in it: it may not be a PDF, or it may be damaged.');
    this.pages = this.collectPages();
  }

  setUpSecurity(password) {
    const encrypt = this.trailer.get('Encrypt');
    if (!(encrypt instanceof Dict)) return;
    const ids = this.trailer.get('ID');
    const security = createSecurity(encrypt, Array.isArray(ids) ? ids[0] : '', password);
    this.decryptString = security.decryptString;
    this.decryptStream = security.decryptStream;
    this.decryptStreamWith = security.decryptStreamWith;
    // What was read before (the encryption dictionary itself) stays as it was.
    for (const [key, value] of this.cache) if (value !== encrypt) this.cache.delete(key);
  }

  // The trailer's Root is a document catalog with a page tree.
  rootOk() {
    try {
      const root = this.trailer.get('Root');
      return root instanceof Dict && root.get('Pages') instanceof Dict;
    } catch {
      return false;
    }
  }

  // --- Cross-reference data -----------------------------------------------------------------

  // A linearized file (PDF 32000-1 Annex F): its first object's dictionary, checked as pdf.js
  // checks it, or null.
  linearization() {
    try {
      const parser = new Parser(new Lexer(this.bytes, this.headerOffset), { doc: null });
      const num = parser.object();
      const gen = parser.object();
      const obj = parser.token();
      const dict = parser.object();
      if (!Number.isInteger(num) || !Number.isInteger(gen) || obj !== OBJ || !(dict instanceof Dict)) return null;
      const lin = dict.get('Linearized');
      if (typeof lin !== 'number' || lin <= 0) return null;
      const int = (name, zero = false) => {
        const v = dict.get(name);
        if (Number.isInteger(v) && (zero ? v >= 0 : v > 0)) return v;
        throw new Error(`linearization ${name}`);
      };
      if (int('L') !== this.bytes.length - this.headerOffset) return null;
      const hints = dict.get('H');
      if (!Array.isArray(hints) || (hints.length !== 2 && hints.length !== 4) || !hints.every((h) => Number.isInteger(h) && h > 0)) return null;
      return { numPages: int('N'), first: int('O'), endFirst: int('E'), mainXref: int('T') };
    } catch {
      return null;
    }
  }

  readXrefChain() {
    let offset;
    if (this.linearization()) {
      // A linearized file's first section follows its first object, and leads to the rest.
      const at = indexOf(this.bytes, bytesOf('endobj'), this.headerOffset, Math.min(this.bytes.length, this.headerOffset + 1024));
      if (at < 0) throw new Error('no endobj');
      let p = at + 6;
      while (p < this.bytes.length && (this.bytes[p] === 0x20 || this.bytes[p] === 0x0a || this.bytes[p] === 0x0d || this.bytes[p] === 0x09)) p++;
      offset = p - this.headerOffset;
    } else {
      const tail = Math.max(0, this.bytes.length - 2048);
      const at = lastIndexOf(this.bytes, bytesOf('startxref'), this.bytes.length, tail);
      if (at < 0) throw new Error('no startxref');
      const lexer = new Lexer(this.bytes, at + 9);
      offset = lexer.next();
    }
    if (typeof offset !== 'number') throw new Error('no xref offset');
    const seen = new Set();
    let first = true;
    while (typeof offset === 'number' && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.readXrefAt(offset);
      if (first) {
        this.trailer = trailer;
        first = false;
      }
      // A hybrid file's table points at a stream holding the objects in object streams.
      const stm = trailer.raw('XRefStm');
      if (typeof stm === 'number' && !seen.has(stm)) {
        seen.add(stm);
        try {
          this.readXrefAt(stm);
        } catch {
          // a damaged one is skipped
        }
      }
      offset = trailer.raw('Prev');
    }
  }

  // Reads a table or stream at `offset` (allowing for junk before the header), adding entries not
  // already known (newer sections are read first), and returns its trailer.
  readXrefAt(offset) {
    for (const at of new Set([offset, offset + this.headerOffset])) {
      const lexer = new Lexer(this.bytes, at);
      const t = lexer.next();
      if (t === Cmd.of('xref')) return this.readTable(lexer);
      if (typeof t === 'number') {
        const parser = new Parser(new Lexer(this.bytes, at), { doc: this });
        const num = parser.object();
        parser.object();
        if (parser.token() !== OBJ) continue;
        const stream = parser.object();
        if (stream instanceof Stream && stream.dict.name('Type') === 'XRef') return this.readXrefStream(stream, num);
      }
    }
    throw new Error('no xref at offset');
  }

  readTable(lexer) {
    const b = this.bytes;
    for (;;) {
      const save = lexer.pos;
      const first = lexer.next();
      if (first === Cmd.of('trailer')) break;
      if (typeof first !== 'number') {
        lexer.pos = save;
        break;
      }
      const count = lexer.next();
      if (typeof count !== 'number') break;
      for (let i = 0; i < count; i++) {
        lexer.skipSpace();
        // Each entry is "oooooooooo ggggg n" (20 bytes), but some writers vary it: read tokens.
        const offset = lexer.next();
        const gen = lexer.next();
        const kind = lexer.next();
        if (typeof offset !== 'number' || typeof gen !== 'number' || !(kind instanceof Cmd)) break;
        let num = first + i;
        // A section numbered from 1 whose first entry is the free head of the list is really from 0.
        if (first === 1 && i === 0 && kind.cmd === 'f' && offset === 0 && gen === 65535) num = 0;
        if (kind.cmd === 'n' && !this.entries.has(num) && offset > 0) this.entries.set(num, { type: 1, offset, gen });
      }
      void b;
    }
    const trailer = new Parser(lexer, { doc: this }).object();
    if (!(trailer instanceof Dict)) throw new Error('no trailer');
    return trailer;
  }

  readXrefStream(stream, selfNum) {
    const dict = stream.dict;
    const widths = dict.get('W');
    const size = dict.number('Size', 0);
    const index = dict.get('Index') ?? [0, size];
    const data = streamBytes(stream);
    const [w0, w1, w2] = widths;
    const rowLength = w0 + w1 + w2;
    let pos = 0;
    const field = (width, fallback) => {
      if (!width) return fallback;
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + data[pos++];
      return v;
    };
    for (let i = 0; i + 1 < index.length; i += 2) {
      const start = index[i];
      const count = index[i + 1];
      for (let n = 0; n < count && pos + rowLength <= data.length; n++) {
        const type = field(w0, 1);
        const a = field(w1, 0);
        const c = field(w2, 0);
        const num = start + n;
        if (this.entries.has(num)) continue;
        if (type === 1) this.entries.set(num, { type: 1, offset: a, gen: c });
        else if (type === 2) this.entries.set(num, { type: 2, stream: a, index: c });
      }
    }
    void selfNum;
    return dict;
  }

  // Scans the whole file for "n g obj" and trailers: for files whose cross-reference data is
  // missing or wrong.
  rebuild() {
    this.repaired = true;
    this.entries.clear();
    this.cache.clear();
    const b = this.bytes;
    const trailers = [];
    const objStreams = [];
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      // "trailer"
      if (c === 0x74 && b[i + 1] === 0x72 && latin1(b, i, i + 7) === 'trailer') {
        try {
          const t = new Parser(new Lexer(b, i + 7), { doc: this }).object();
          if (t instanceof Dict) trailers.push(t);
        } catch {
          // skip it
        }
        continue;
      }
      // "obj" preceded by "num gen "
      if (c === 0x6f && b[i + 1] === 0x62 && b[i + 2] === 0x6a && (i + 3 >= b.length || !isRegular(b[i + 3]))) {
        let j = i - 1;
        while (j >= 0 && isSpace(b[j])) j--;
        let genEnd = j + 1;
        while (j >= 0 && isDigit(b[j])) j--;
        const gen = Number(latin1(b, j + 1, genEnd));
        if (genEnd === j + 1) continue;
        while (j >= 0 && isSpace(b[j])) j--;
        const numEnd = j + 1;
        while (j >= 0 && isDigit(b[j])) j--;
        if (numEnd === j + 1) continue;
        const num = Number(latin1(b, j + 1, numEnd));
        // The last definition in the file wins, as later updates replace earlier ones.
        this.entries.set(num, { type: 1, offset: j + 1, gen });
        genEnd = 0;
      }
    }
    // Objects in object streams, and XRef streams' dictionaries as trailers.
    for (const [num, entry] of [...this.entries]) {
      try {
        const obj = this.fetch(new Ref(num, entry.gen));
        if (obj instanceof Stream) {
          const type = obj.dict.name('Type');
          if (type === 'ObjStm') objStreams.push(num);
          if (type === 'XRef') trailers.push(obj.dict);
        }
      } catch {
        // a damaged object
      }
    }
    for (const streamNum of objStreams) {
      try {
        const { offsets } = this.objectStream(streamNum);
        offsets.forEach(([num], index) => {
          if (!this.entries.has(num)) this.entries.set(num, { type: 2, stream: streamNum, index });
        });
      } catch {
        // skip it
      }
    }
    this.cache.clear();
    // The trailer: the last with a Root that's a catalog, or failing that, a catalog found.
    let trailer = null;
    for (const t of trailers.reverse()) {
      try {
        if (t.get('Root') instanceof Dict && t.get('Root').get('Pages') instanceof Dict) {
          trailer = t;
          break;
        }
      } catch {
        // try the next
      }
    }
    if (!trailer) {
      const kept = this.trailer;
      trailer = new Dict(this);
      if (kept?.has('Root')) trailer.set('Root', kept.raw('Root'));
      for (const [num, entry] of this.entries) {
        try {
          const obj = this.fetch(new Ref(num, entry.gen ?? 0));
          if (obj instanceof Dict && obj.name('Type') === 'Catalog' && obj.get('Pages') instanceof Dict) {
            trailer.set('Root', new Ref(num, entry.gen ?? 0));
            break;
          }
        } catch {
          // keep looking
        }
      }
      for (const t of trailers) {
        if (t.has('Encrypt')) trailer.set('Encrypt', t.raw('Encrypt'));
        if (t.has('ID')) trailer.set('ID', t.raw('ID'));
        if (t.has('Info')) trailer.set('Info', t.raw('Info'));
      }
    }
    this.trailer = trailer;
  }

  // --- Objects ------------------------------------------------------------------------------

  fetchIfRef(value) {
    return value instanceof Ref ? this.fetch(value) : value;
  }

  fetch(ref) {
    const key = ref.num;
    if (this.cache.has(key)) return this.cache.get(key);
    const entry = this.entries.get(ref.num);
    if (!entry) return null;
    if (this.fetching.has(key)) return null; // a loop (an object whose /Length is itself, say)
    this.fetching.add(key);
    try {
      let value = null;
      if (entry.type === 1) value = this.readObjectAt(entry.offset, ref);
      else if (entry.type === 2) {
        const { parse } = this.objectStream(entry.stream);
        value = parse(entry.index);
      }
      this.cache.set(key, value);
      return value;
    } finally {
      this.fetching.delete(key);
    }
  }

  readObjectAt(offset, ref) {
    for (const at of new Set([offset, offset + this.headerOffset])) {
      if (at >= this.bytes.length) continue;
      const parser = new Parser(new Lexer(this.bytes, at), { doc: this });
      const num = parser.token();
      const gen = parser.token();
      if (num !== ref.num || typeof gen !== 'number' || parser.token() !== OBJ) continue;
      return parser.object(new Ref(num, gen));
    }
    // The offset is wrong: find the object by scanning, once.
    if (!this.repaired) {
      this.rebuildKeepingTrailer();
      const entry = this.entries.get(ref.num);
      if (entry?.type === 1 && entry.offset !== offset) return this.readObjectAt(entry.offset, ref);
    }
    return null;
  }

  rebuildKeepingTrailer() {
    const trailer = this.trailer;
    const decrypt = [this.decryptString, this.decryptStream, this.decryptStreamWith];
    this.rebuild();
    if (trailer?.has('Root')) this.trailer = trailer;
    [this.decryptString, this.decryptStream, this.decryptStreamWith] = decrypt;
  }

  // An object stream's objects: its offsets, and parse(index) for one of them.
  objectStream(num) {
    const cacheKey = `objstm ${num}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const stream = this.fetch(new Ref(num, 0));
    if (!(stream instanceof Stream)) throw new Error('not an object stream');
    const data = decodeStream(stream).data;
    const n = stream.dict.number('N', 0);
    const first = stream.dict.number('First', 0);
    const lexer = new Lexer(data, 0);
    const offsets = [];
    for (let i = 0; i < n; i++) {
      const objNum = lexer.next();
      const off = lexer.next();
      if (typeof objNum !== 'number' || typeof off !== 'number') break;
      offsets.push([objNum, off]);
    }
    const result = {
      offsets,
      parse: (index) => {
        const entry = offsets[index];
        if (!entry) return null;
        // Objects in an object stream aren't encrypted on their own: the stream was.
        return new Parser(new Lexer(data, first + entry[1]), { doc: this, allowStreams: false }).object();
      },
    };
    this.cache.set(cacheKey, result);
    return result;
  }

  // --- Pages --------------------------------------------------------------------------------

  collectPages() {
    const pages = [];
    // The nodes above the one being walked, so a loop in the tree stops; a page listed twice shows
    // twice, as other readers show it.
    const above = new Set();
    let visited = 0;
    const walk = (node, inherited) => {
      if (!(node instanceof Dict) || above.has(node) || ++visited > 100000) return;
      const own = {
        Resources: node.get('Resources') ?? inherited.Resources,
        MediaBox: node.get('MediaBox') ?? inherited.MediaBox,
        CropBox: node.get('CropBox') ?? inherited.CropBox,
        Rotate: node.get('Rotate') ?? inherited.Rotate,
      };
      const kids = node.array('Kids');
      const type = node.name('Type');
      if (kids && type !== 'Page') {
        above.add(node);
        for (const kid of kids) walk(kid, own);
        above.delete(node);
      } else if (type === 'Page' || (!kids && (node.has('Contents') || node.has('MediaBox')))) {
        pages.push(new PdfPage(this, node, own, pages.length));
      }
    };
    walk(this.catalog.get('Pages'), {});
    if (!pages.length) {
      // No page tree to be found: every page object in the file, in the order they appear.
      const found = [];
      for (const [num, entry] of this.entries) {
        try {
          const obj = this.fetch(new Ref(num, entry.gen ?? 0));
          if (obj instanceof Dict && obj.name('Type') === 'Page') found.push([entry.type === 1 ? entry.offset : Infinity, num, obj]);
        } catch {
          // skip it
        }
      }
      found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (const [, , dict] of found) {
        const parent = dict.get('Parent');
        walk(dict, parent instanceof Dict ? { Resources: parent.get('Resources'), MediaBox: parent.get('MediaBox') } : {});
      }
    }
    return pages;
  }

  get numPages() {
    return this.pages.length;
  }

  // --- Metadata and outline -----------------------------------------------------------------

  info() {
    const info = this.trailer.get('Info');
    const out = {};
    if (!(info instanceof Dict)) return out;
    for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
      const v = info.get(key);
      if (typeof v === 'string') out[key] = textString(v);
    }
    return out;
  }

  // The outline (bookmarks): [{ title, page (0-based, or null), items }].
  outline() {
    const root = this.catalog.dict('Outlines');
    const seen = new Set();
    const list = (first) => {
      const out = [];
      for (let item = first; item instanceof Dict && !seen.has(item) && out.length < 10000; item = item.get('Next')) {
        seen.add(item);
        const title = textString(item.get('Title') ?? '');
        let dest = item.get('Dest');
        const action = item.dict('A');
        if (dest == null && action?.name('S') === 'GoTo') dest = action.get('D');
        out.push({ title, page: this.destinationPage(dest), items: list(item.get('First')) });
      }
      return out;
    };
    return root ? list(root.get('First')) : [];
  }

  // The 0-based page a destination goes to, or null.
  destinationPage(dest) {
    if (typeof dest === 'string' || dest instanceof Name) dest = this.namedDestination(dest instanceof Name ? dest.name : dest);
    if (dest instanceof Dict) dest = dest.get('D');
    if (!Array.isArray(dest) || !dest.length) return null;
    const target = dest[0];
    if (typeof target === 'number') return target >= 0 && target < this.pages.length ? target : null;
    const page = target instanceof Ref ? this.fetch(target) : target;
    const index = this.pages.findIndex((p) => p.dict === page);
    return index >= 0 ? index : null;
  }

  namedDestination(name) {
    const old = this.catalog.dict('Dests');
    if (old?.has(name)) return old.get(name);
    const tree = this.catalog.dict('Names')?.dict('Dests');
    return tree ? lookupNameTree(tree, name) : null;
  }
}

function lookupNameTree(node, key, depth = 0) {
  if (!(node instanceof Dict) || depth > 32) return null;
  const names = node.array('Names');
  if (names) {
    for (let i = 0; i + 1 < names.length; i += 2) if (names[i] === key) return node.doc.fetchIfRef(names[i + 1]);
    return null;
  }
  for (const kid of node.array('Kids') ?? []) {
    const limits = kid instanceof Dict ? kid.array('Limits') : null;
    if (limits && (key < limits[0] || key > limits[1])) continue;
    const found = lookupNameTree(kid, key, depth + 1);
    if (found != null) return found;
  }
  return null;
}

export class PdfPage {
  constructor(doc, dict, inherited, index) {
    this.doc = doc;
    this.dict = dict;
    this.index = index;
    this.resources = inherited.Resources instanceof Dict ? inherited.Resources : new Dict(doc);
    const box = (value, fallback) => {
      const v = Array.isArray(value) ? value.map((x) => doc.fetchIfRef(x)) : null;
      if (!v || v.length !== 4 || v.some((x) => typeof x !== 'number')) return fallback;
      const r = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
      // An empty box counts as none.
      return r[2] - r[0] > 0 && r[3] - r[1] > 0 ? r : fallback;
    };
    this.mediaBox = box(inherited.MediaBox, [0, 0, 612, 792]);
    const crop = box(inherited.CropBox, this.mediaBox);
    // What shows is where the crop box and media box overlap.
    const view = [Math.max(crop[0], this.mediaBox[0]), Math.max(crop[1], this.mediaBox[1]), Math.min(crop[2], this.mediaBox[2]), Math.min(crop[3], this.mediaBox[3])];
    this.view = view[2] > view[0] && view[3] > view[1] ? view : this.mediaBox;
    // A rotation that isn't a multiple of 90 degrees counts as none, as in pdf.js.
    const rotate = typeof inherited.Rotate === 'number' ? inherited.Rotate : 0;
    this.rotate = rotate % 90 !== 0 ? 0 : ((rotate % 360) + 360) % 360;
    this.userUnit = dict.number('UserUnit', 1);
  }

  // The page's content: its streams' data joined, a line break between each.
  contents() {
    const contents = this.dict.get('Contents');
    const streams = Array.isArray(contents) ? contents.map((c) => this.doc.fetchIfRef(c)) : [contents];
    const parts = streams.filter((s) => s instanceof Stream).map((s) => {
      try {
        return streamBytes(s);
      } catch {
        return new Uint8Array(0);
      }
    });
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
      out[at++] = 0x0a;
    }
    return out;
  }

  // Width and height in points as shown (rotated).
  get size() {
    const w = (this.view[2] - this.view[0]) * this.userUnit;
    const h = (this.view[3] - this.view[1]) * this.userUnit;
    return this.rotate % 180 ? { width: h, height: w } : { width: w, height: h };
  }
}

const isSpace = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isRegular = (c) => !isSpace(c) && !'()<>[]{}/%'.includes(String.fromCharCode(c));

// PDF text strings: UTF-16BE (with its byte order mark), UTF-8 (with its mark, PDF 2.0), or
// PDFDocEncoding.
const PDFDOC_HIGH = '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž�€';
const PDFDOC_LOW = '˘ˇˆ˙˝˛˚˜';
export function textString(s) {
  if (typeof s !== 'string') return '';
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  if (s.charCodeAt(0) === 0xef && s.charCodeAt(1) === 0xbb && s.charCodeAt(2) === 0xbf) {
    try {
      return new TextDecoder('utf-8').decode(bytesOf(s.slice(3)));
    } catch {
      // fall through
    }
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x18 && c <= 0x1f) out += PDFDOC_LOW[c - 0x18];
    else if (c >= 0x80 && c <= 0xa0) out += PDFDOC_HIGH[c - 0x80];
    else out += s[i];
  }
  return out;
}

export { EOF };
