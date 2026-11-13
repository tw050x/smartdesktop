// PDF functions (PDF 32000-1 7.10), which turn tints into colours and positions along a shading into
// colours: type 0 (sampled), 2 (exponential), 3 (stitching) and 4 (a PostScript calculator). Each
// becomes a JavaScript function from an array of inputs to an array of outputs, clipped to its
// Domain and Range. An array of functions (one output each) makes one function.

import { streamBytes } from './filters.js';
import { Dict, Stream } from './objects.js';

const clip = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const numbers = (doc, v) => (Array.isArray(v) ? v.map((x) => doc.fetchIfRef(x)).filter((x) => typeof x === 'number') : null);

// `value` is a function dictionary or stream, or an array of them; returns (inputs) => outputs.
export function makeFunction(doc, value, depth = 0) {
  value = doc.fetchIfRef(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => makeFunction(doc, v, depth + 1));
    return (x) => parts.map((f) => f(x)[0]);
  }
  const dict = value instanceof Stream ? value.dict : value;
  if (!(dict instanceof Dict) || depth > 10) throw new Error('not a function');
  const type = dict.get('FunctionType');
  const domain = numbers(doc, dict.get('Domain')) ?? [0, 1];
  const range = numbers(doc, dict.get('Range'));
  let f;
  if (type === 0) f = sampled(doc, value, dict, domain, range);
  else if (type === 2) f = exponential(doc, dict);
  else if (type === 3) f = stitching(doc, dict, domain, depth);
  else if (type === 4) f = calculator(value, range);
  else throw new Error(`unknown function type ${type}`);
  return (inputs) => {
    const x = [];
    for (let i = 0; i < domain.length / 2; i++) x.push(clip(Number(inputs[i]) || 0, domain[2 * i], domain[2 * i + 1]));
    const y = f(x);
    if (range) for (let i = 0; i < y.length && 2 * i < range.length; i++) y[i] = clip(y[i], range[2 * i], range[2 * i + 1]);
    return y;
  };
}

function sampled(doc, stream, dict, domain, range) {
  if (!(stream instanceof Stream) || !range) throw new Error('sampled function without samples');
  const size = numbers(doc, dict.get('Size'));
  const bps = dict.get('BitsPerSample');
  const m = domain.length / 2;
  const n = range.length / 2;
  const encode = numbers(doc, dict.get('Encode')) ?? size.flatMap((s) => [0, s - 1]);
  const decode = numbers(doc, dict.get('Decode')) ?? range;
  const data = streamBytes(stream);
  const count = size.reduce((a, b) => a * b, 1) * n;
  const samples = new Float64Array(count);
  const max = 2 ** bps - 1;
  let bit = 0;
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let b = 0; b < bps; b++, bit++) v = v * 2 + ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    samples[i] = v / max;
  }
  return (x) => {
    // Multilinear interpolation between the samples round the point.
    const e = [];
    for (let i = 0; i < m; i++) {
      const d0 = domain[2 * i];
      const d1 = domain[2 * i + 1];
      let v = encode[2 * i] + ((x[i] - d0) * (encode[2 * i + 1] - encode[2 * i])) / (d1 - d0 || 1);
      e.push(clip(v, 0, size[i] - 1));
    }
    const out = new Array(n).fill(0);
    const corners = 1 << m;
    for (let c = 0; c < corners; c++) {
      let weight = 1;
      let index = 0;
      let stride = 1;
      for (let i = 0; i < m; i++) {
        const lo = Math.floor(e[i]);
        const t = e[i] - lo;
        const hi = c & (1 << i);
        const pos = hi ? Math.min(lo + 1, size[i] - 1) : lo;
        weight *= hi ? t : 1 - t;
        index += pos * stride;
        stride *= size[i];
      }
      if (weight === 0) continue;
      for (let j = 0; j < n; j++) out[j] += weight * samples[index * n + j];
    }
    return out.map((v, j) => decode[2 * j] + v * (decode[2 * j + 1] - decode[2 * j]));
  };
}

function exponential(doc, dict) {
  const c0 = numbers(doc, dict.get('C0')) ?? [0];
  const c1 = numbers(doc, dict.get('C1')) ?? [1];
  const n = dict.get('N');
  return ([x]) => {
    const p = x ** n;
    return c0.map((a, i) => a + p * ((c1[i] ?? 0) - a));
  };
}

function stitching(doc, dict, domain, depth) {
  const fns = (dict.get('Functions') ?? []).map((f) => makeFunction(doc, f, depth + 1));
  const bounds = numbers(doc, dict.get('Bounds')) ?? [];
  const encode = numbers(doc, dict.get('Encode')) ?? [];
  return ([x]) => {
    let i = 0;
    while (i < bounds.length && x >= bounds[i]) i++;
    const lo = i === 0 ? domain[0] : bounds[i - 1];
    const hi = i === bounds.length ? domain[1] : bounds[i];
    const e0 = encode[2 * i] ?? 0;
    const e1 = encode[2 * i + 1] ?? 1;
    const t = hi === lo ? e0 : e0 + ((x - lo) * (e1 - e0)) / (hi - lo);
    return fns[i] ? fns[i]([t]) : [0];
  };
}

// Type 4: { ... } PostScript with arithmetic, comparison, if and ifelse.
function calculator(stream, range) {
  const src = String.fromCharCode(...streamBytes(stream).subarray(0, 65536));
  const tokens = src.match(/[{}]|[^\s{}]+/g) ?? [];
  let pos = 0;
  const parse = () => {
    const out = [];
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t === '{') out.push(parse());
      else if (t === '}') return out;
      else out.push(/^[-+.\d]/.test(t) ? Number(t) : t === 'true' ? true : t === 'false' ? false : t);
    }
    return out;
  };
  while (pos < tokens.length && tokens[pos] !== '{') pos++;
  pos++;
  const program = parse();
  const OPS = {
    abs: (s) => s.push(Math.abs(s.pop())),
    add: (s) => s.push(s.pop() + s.pop()),
    atan: (s) => {
      const den = s.pop();
      const num = s.pop();
      let a = (Math.atan2(num, den) * 180) / Math.PI;
      if (a < 0) a += 360;
      s.push(a);
    },
    ceiling: (s) => s.push(Math.ceil(s.pop())),
    cos: (s) => s.push(Math.cos((s.pop() * Math.PI) / 180)),
    cvi: (s) => s.push(Math.trunc(s.pop())),
    cvr: () => {},
    div: (s) => {
      const b = s.pop();
      s.push(s.pop() / b);
    },
    exp: (s) => {
      const e = s.pop();
      s.push(s.pop() ** e);
    },
    floor: (s) => s.push(Math.floor(s.pop())),
    idiv: (s) => {
      const b = s.pop();
      s.push(Math.trunc(s.pop() / b));
    },
    ln: (s) => s.push(Math.log(s.pop())),
    log: (s) => s.push(Math.log10(s.pop())),
    mod: (s) => {
      const b = s.pop();
      s.push(s.pop() % b);
    },
    mul: (s) => s.push(s.pop() * s.pop()),
    neg: (s) => s.push(-s.pop()),
    round: (s) => s.push(Math.round(s.pop())),
    sin: (s) => s.push(Math.sin((s.pop() * Math.PI) / 180)),
    sqrt: (s) => s.push(Math.sqrt(s.pop())),
    sub: (s) => {
      const b = s.pop();
      s.push(s.pop() - b);
    },
    truncate: (s) => s.push(Math.trunc(s.pop())),
    and: (s) => {
      const b = s.pop();
      const a = s.pop();
      s.push(typeof a === 'boolean' ? a && b : a & b);
    },
    or: (s) => {
      const b = s.pop();
      const a = s.pop();
      s.push(typeof a === 'boolean' ? a || b : a | b);
    },
    xor: (s) => {
      const b = s.pop();
      const a = s.pop();
      s.push(typeof a === 'boolean' ? a !== b : a ^ b);
    },
    not: (s) => {
      const a = s.pop();
      s.push(typeof a === 'boolean' ? !a : ~a);
    },
    bitshift: (s) => {
      const n = s.pop();
      const a = s.pop();
      s.push(n >= 0 ? a << n : a >> -n);
    },
    eq: (s) => s.push(s.pop() === s.pop()),
    ne: (s) => s.push(s.pop() !== s.pop()),
    gt: (s) => s.push(s.pop() < s.pop()),
    ge: (s) => s.push(s.pop() <= s.pop()),
    lt: (s) => s.push(s.pop() > s.pop()),
    le: (s) => s.push(s.pop() >= s.pop()),
    true: (s) => s.push(true),
    false: (s) => s.push(false),
    copy: (s) => {
      const n = s.pop();
      s.push(...s.slice(s.length - n));
    },
    dup: (s) => s.push(s[s.length - 1]),
    exch: (s) => {
      const b = s.pop();
      const a = s.pop();
      s.push(b, a);
    },
    index: (s) => {
      const n = s.pop();
      s.push(s[s.length - 1 - n]);
    },
    pop: (s) => s.pop(),
    roll: (s) => {
      const j = s.pop();
      const n = s.pop();
      if (n <= 0) return;
      const part = s.splice(s.length - n, n);
      const k = ((j % n) + n) % n;
      s.push(...part.slice(n - k), ...part.slice(0, n - k));
    },
  };
  const exec = (proc, s, budget) => {
    for (let i = 0; i < proc.length; i++) {
      if (--budget.left < 0) throw new Error('calculator function runs too long');
      const t = proc[i];
      if (typeof t === 'number' || typeof t === 'boolean') s.push(t);
      else if (Array.isArray(t)) {
        const next = proc[i + 1];
        if (next === 'if') {
          if (s.pop()) exec(t, s, budget);
          i++;
        } else if (Array.isArray(next) && proc[i + 2] === 'ifelse') {
          exec(s.pop() ? t : next, s, budget);
          i += 2;
        }
      } else if (OPS[t]) OPS[t](s);
    }
  };
  const n = range ? range.length / 2 : 1;
  return (x) => {
    const s = [...x];
    try {
      exec(program, s, { left: 100000 });
    } catch {
      return new Array(n).fill(0);
    }
    const out = s.slice(-n).map((v) => (typeof v === 'number' ? v : v ? 1 : 0));
    while (out.length < n) out.unshift(0);
    return out;
  };
}
