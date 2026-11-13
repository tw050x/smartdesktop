// A small XML reader for Office's parts: elements with their attributes and children, text kept
// exactly (spaces matter in a document's runs). Names keep their prefixes ("w:p"), as Office's
// prefixes are fixed in practice; `local(name)` drops one when a part uses another.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) => text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, code) => {
  if (code[0] === '#') {
    const value = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
  }
  return ENTITIES[code] ?? whole;
});

// The document's root element: { name, attrs, children: [element | string] }.
export function parseXml(source) {
  const text = typeof source === 'string' ? source : source.toString('utf8');
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let at = 0;
  const push = (node) => stack[stack.length - 1].children.push(node);
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open < 0) {
      if (at < text.length) push(decode(text.slice(at)));
      break;
    }
    if (open > at) push(decode(text.slice(at, open)));
    if (text.startsWith('<?', open)) {
      at = text.indexOf('?>', open) + 2;
    } else if (text.startsWith('<!--', open)) {
      at = text.indexOf('-->', open) + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open);
      push(text.slice(open + 9, close));
      at = close + 3;
    } else if (text.startsWith('<!', open)) {
      at = text.indexOf('>', open) + 1;
    } else if (text[open + 1] === '/') {
      const close = text.indexOf('>', open);
      if (stack.length > 1) stack.pop();
      at = close + 1;
    } else {
      // A start tag: its name, then attributes up to `>` or `/>`, quotes respected.
      let i = open + 1;
      while (i < text.length && !/[\s/>]/.test(text[i])) i++;
      const element = { name: text.slice(open + 1, i), attrs: {}, children: [] };
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(text[i])) i++;
        if (text[i] === '>') {
          i++;
          break;
        }
        if (text[i] === '/' && text[i + 1] === '>') {
          selfClosing = true;
          i += 2;
          break;
        }
        const nameStart = i;
        while (i < text.length && !/[\s=/>]/.test(text[i])) i++;
        const attr = text.slice(nameStart, i);
        while (/\s/.test(text[i])) i++;
        if (text[i] === '=') {
          i++;
          while (/\s/.test(text[i])) i++;
          const quote = text[i];
          const end = text.indexOf(quote, i + 1);
          element.attrs[attr] = decode(text.slice(i + 1, end));
          i = end + 1;
        } else if (attr) element.attrs[attr] = '';
        if (i >= text.length) break;
      }
      push(element);
      if (!selfClosing) stack.push(element);
      at = i;
    }
  }
  return root.children.find((c) => typeof c === 'object') ?? null;
}

export const local = (name) => name.slice(name.indexOf(':') + 1);

// The first child element named `name`, and all of them.
export const child = (el, name) => el?.children.find((c) => typeof c === 'object' && c.name === name) ?? null;
export const children = (el, name) => (el?.children ?? []).filter((c) => typeof c === 'object' && (!name || c.name === name));
// A path of names down from `el`: child(child(el, a), b)…
export const path = (el, ...names) => names.reduce((at, name) => child(at, name), el);
// Every element named `name` anywhere under `el`, in document order.
export function descendants(el, name, out = []) {
  for (const c of el?.children ?? []) {
    if (typeof c !== 'object') continue;
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
// The text of an element and everything in it.
export const textOf = (el) => (el?.children ?? []).map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
// An attribute as a number, or a fallback.
export const num = (el, attr, fallback = null) => {
  const value = el?.attrs[attr];
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
