// Excel's number formats: a cell's value as Excel shows it, by its format code ("#,##0.00",
// "[Red](0.0%)", "d mmm yyyy", "General" …).
//
// format(value, code, options) → { parts, color, align? }
//   parts: [{ text, hidden?, fill? }]: what to draw, left to right. `hidden` takes the room of its
//          text without showing it (a format's `_x` and `?`), `fill` repeats its text to fill the
//          cell (a format's `*x`).
//   color: a colour the format sets ([Red]), or null.
// options: { date1904, locale ('en-US' or another: the short date's order), fits(text) → whether
//          text fits the cell, for General, which drops decimals to fit }.

const BUILTIN = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)', 7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'SHORT_DATE', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'SHORT_DATE h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

// A built-in format's code. As in Excel, the short date (ids 14 and 22) and the currency formats
// (5–8, 42 and 44) follow the locale: its date order and its currency's symbol.
export function builtinFormat(id, { locale = defaultLocale() } = {}) {
  const code = BUILTIN[id];
  if (!code) return null;
  return code.replace('SHORT_DATE', /^en-US|^en-PH|-US$/i.test(locale) ? 'm/d/yyyy' : 'dd/mm/yyyy').replace(/"\$"/g, `"${currencySymbol(locale)}"`);
}

const EURO = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
const SYMBOLS = { GB: '£', JP: '¥', CN: '¥', IN: '₹', KR: '₩', CH: 'CHF', SE: 'kr', NO: 'kr', DK: 'kr', PL: 'zł', BR: 'R$', ZA: 'R', RU: '₽', TR: '₺', IL: '₪' };
function currencySymbol(locale) {
  const region = (locale.split(/[-_]/)[1] ?? '').toUpperCase();
  if (EURO.includes(region)) return '€';
  return SYMBOLS[region] ?? '$';
}

export function defaultLocale() {
  const env = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG;
  if (env && /^[a-z]{2}_[A-Z]{2}/.test(env)) return env.slice(0, 5).replace('_', '-');
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en-US';
  }
}

const COLORS = { black: '#000000', blue: '#0000ff', cyan: '#00ffff', green: '#00ff00', magenta: '#ff00ff', red: '#ff0000', white: '#ffffff', yellow: '#ffff00' };
const INDEXED = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// --- Parsing -------------------------------------------------------------------------------------

const cache = new Map();
function parse(code) {
  if (cache.has(code)) return cache.get(code);
  const sections = [];
  let tokens = [];
  let section = { tokens, color: null, condition: null };
  let i = 0;
  const literal = (text) => tokens.push({ type: 'lit', text });
  while (i < code.length) {
    const c = code[i];
    const rest = code.slice(i);
    if (c === ';') {
      sections.push(section);
      tokens = [];
      section = { tokens, color: null, condition: null };
      i++;
    } else if (c === '"') {
      const end = code.indexOf('"', i + 1);
      literal(code.slice(i + 1, end < 0 ? code.length : end));
      i = end < 0 ? code.length : end + 1;
    } else if (c === '\\' || c === '!') {
      literal(code[i + 1] ?? '');
      i += 2;
    } else if (c === '_') {
      tokens.push({ type: 'pad', text: code[i + 1] ?? ' ' });
      i += 2;
    } else if (c === '*') {
      tokens.push({ type: 'fill', text: code[i + 1] ?? ' ' });
      i += 2;
    } else if (c === '[') {
      const end = code.indexOf(']', i);
      const inner = code.slice(i + 1, end < 0 ? code.length : end);
      i = end < 0 ? code.length : end + 1;
      const lower = inner.toLowerCase();
      if (COLORS[lower]) section.color = COLORS[lower];
      else if (/^color\s*\d+$/.test(lower)) section.color = INDEXED[(Number(lower.replace(/\D/g, '')) - 1) % 8] ?? null;
      else if (/^(<=|>=|<>|<|>|=)\s*-?[\d.]+$/.test(inner)) {
        const [, op, n] = inner.match(/^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/);
        section.condition = { op, n: Number(n) };
      } else if (/^(h+|m+|s+)$/i.test(inner)) tokens.push({ type: 'elapsed', unit: lower[0], width: inner.length });
      else if (inner.startsWith('$')) {
        // A currency or locale: [$€-809] shows €; [$-409] shows nothing.
        const sym = inner.slice(1).split('-')[0];
        if (sym) literal(sym);
      }
      // Anything else ([DBNum1], calendars) is left out.
    } else if (/^(am\/pm|a\/p)/i.test(rest)) {
      const m = rest.match(/^(am\/pm|a\/p)/i)[0];
      tokens.push({ type: 'ampm', text: m });
      i += m.length;
    } else if (/^[yYdDhHsS]/.test(c) || c === 'm' || c === 'M') {
      const m = rest.match(/^([yY]+|[dD]+|[hH]+|[mM]+|[sS]+)/)[0];
      tokens.push({ type: 'date', unit: m[0].toLowerCase(), width: m.length });
      i += m.length;
    } else if (/^General/i.test(rest)) {
      tokens.push({ type: 'general' });
      i += 7;
    } else if (/^[Ee][+-]/.test(rest)) {
      tokens.push({ type: 'exp', sign: rest[1] });
      i += 2;
    } else if (c === '0' || c === '#' || c === '?') {
      tokens.push({ type: 'digit', ch: c });
      i++;
    } else if (/[1-9]/.test(c) && tokens.some((t) => t.type === 'slash')) {
      // A fixed denominator (# ?/8).
      const m = rest.match(/^\d+/)[0];
      tokens.push({ type: 'denom', n: Number(m) });
      i += m.length;
    } else if (c === '.') {
      tokens.push({ type: 'point' });
      i++;
    } else if (c === ',') {
      tokens.push({ type: 'comma' });
      i++;
    } else if (c === '%') {
      tokens.push({ type: 'percent' });
      i++;
    } else if (c === '/' && tokens.some((t) => t.type === 'digit') && !tokens.some((t) => t.type === 'date')) {
      tokens.push({ type: 'slash' });
      i++;
    } else if (c === '@') {
      tokens.push({ type: 'text' });
      i++;
    } else {
      literal(c);
      i++;
    }
  }
  sections.push(section);
  // Minutes or months: m after an hour or before a second is minutes.
  for (const s of sections) {
    const dates = s.tokens.filter((t) => t.type === 'date' || t.type === 'elapsed');
    dates.forEach((t, k) => {
      if (t.type !== 'date' || t.unit !== 'm' || t.width > 2) return;
      const before = dates[k - 1];
      const after = dates[k + 1];
      if ((before && (before.unit === 'h')) || (after && after.unit === 's')) t.unit = 'M';
    });
    s.isDate = s.tokens.some((t) => t.type === 'date' || t.type === 'elapsed' || t.type === 'ampm');
    s.isText = s.tokens.some((t) => t.type === 'text');
  }
  const parsed = { sections };
  cache.set(code, parsed);
  return parsed;
}

// --- Formatting ----------------------------------------------------------------------------------

export function format(value, code, options = {}) {
  if (code == null || /^general$/i.test(code.trim())) return finish(general(value, options), null);
  const { sections } = parse(code);
  if (typeof value === 'boolean') return finish([{ text: value ? 'TRUE' : 'FALSE' }], null);
  if (typeof value === 'string') {
    // Text uses the text section (the fourth, or one with @), else shows as it is.
    const s = sections[3] ?? sections.find((x) => x.isText);
    if (!s) return finish([{ text: value }], null);
    return finish(render(s, value, { text: value, ...options }), s.color);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return finish([{ text: String(value ?? '') }], null);
  const { section, negativeSign } = pick(sections, value);
  if (!section) return finish([{ text: '#'.repeat(1) }], null);
  const v = negativeSign ? value : Math.abs(value);
  return finish(render(section, v, options), section.color);
}

function finish(parts, color) {
  return { parts: parts.filter((p) => p.text !== '' || p.fill), color };
}

// Which section a number uses, and whether it shows its own minus sign.
function pick(sections, value) {
  const conditional = sections.some((s) => s.condition);
  if (conditional) {
    const test = (c, v) => ({ '<': v < c.n, '>': v > c.n, '=': v === c.n, '<=': v <= c.n, '>=': v >= c.n, '<>': v !== c.n })[c.op];
    for (const s of sections) if (s.condition && test(s.condition, value)) return { section: s, negativeSign: s !== sections[0] ? false : value < 0 };
    const rest = sections.filter((s) => !s.condition && !s.isText);
    return { section: rest[0] ?? sections[sections.length - 1], negativeSign: value < 0 && sections.indexOf(rest[0]) <= 1 && sections.filter((s) => s.condition).length < 2 };
  }
  const numeric = sections.filter((s, i) => i < 3);
  if (value > 0 || numeric.length === 1 || (value === 0 && numeric.length === 2)) return { section: numeric[0], negativeSign: value < 0 };
  if (value < 0) return { section: numeric[1], negativeSign: false };
  return { section: numeric[2], negativeSign: false };
}

function render(section, value, options) {
  if (typeof value === 'string') {
    return section.tokens.map((t) => (t.type === 'text' ? { text: value } : t.type === 'lit' ? { text: t.text } : t.type === 'pad' ? { text: t.text, hidden: true } : t.type === 'fill' ? { text: t.text, fill: true } : { text: '' }));
  }
  if (section.isDate) return renderDate(section, value, options);
  if (section.tokens.some((t) => t.type === 'general')) {
    const out = [];
    for (const t of section.tokens) {
      if (t.type === 'general') out.push(...general(value, options));
      else out.push(simple(t));
    }
    return out;
  }
  return renderNumber(section, value);
}

const simple = (t) => (t.type === 'lit' ? { text: t.text } : t.type === 'pad' ? { text: t.text, hidden: true } : t.type === 'fill' ? { text: t.text, fill: true } : { text: '' });

// --- Numbers -------------------------------------------------------------------------------------

function renderNumber(section, value) {
  const tokens = section.tokens;
  const percent = tokens.filter((t) => t.type === 'percent').length;
  let v = value * 100 ** percent;
  const expAt = tokens.findIndex((t) => t.type === 'exp');
  const slashAt = tokens.findIndex((t) => t.type === 'slash');
  if (slashAt >= 0) return renderFraction(section, v);
  const pointAt = tokens.findIndex((t) => t.type === 'point');
  const mantissaEnd = expAt >= 0 ? expAt : tokens.length;
  const intEnd = pointAt >= 0 && pointAt < mantissaEnd ? pointAt : mantissaEnd;
  // Thousands: a comma between digit placeholders groups; commas right after the last integer
  // placeholder (before the point or the end) scale by a thousand each.
  const digitIdx = tokens.map((t, k) => (t.type === 'digit' && k < intEnd ? k : -1)).filter((k) => k >= 0);
  const lastInt = digitIdx[digitIdx.length - 1] ?? -1;
  const firstInt = digitIdx[0] ?? -1;
  let grouping = false;
  let scale = 0;
  tokens.forEach((t, k) => {
    if (t.type !== 'comma' || k >= mantissaEnd) return;
    if (k > firstInt && k < lastInt && firstInt >= 0) grouping = true;
    else if (k > lastInt && k < intEnd + (pointAt >= 0 ? 0 : 1) && lastInt >= 0) scale++;
    else if (k > lastInt && pointAt < 0) scale++;
  });
  v /= 1000 ** scale;
  const fracTokens = pointAt >= 0 && pointAt < mantissaEnd ? tokens.slice(pointAt + 1, mantissaEnd).filter((t) => t.type === 'digit') : [];
  const decimals = fracTokens.length;

  let exponent = 0;
  if (expAt >= 0) {
    const intDigits = Math.max(1, digitIdx.length);
    if (v !== 0) {
      exponent = Math.floor(Math.log10(Math.abs(v)));
      // Engineering-style formats (##0.0E+0): the exponent a multiple of the integer placeholders.
      if (digitIdx.length > 1 && tokens.slice(0, intEnd).some((t) => t.type === 'digit' && t.ch === '#')) exponent = Math.floor(exponent / intDigits) * intDigits;
      else exponent -= intDigits - 1;
      v /= 10 ** exponent;
      if (Number(Math.abs(v).toFixed(decimals)) >= 10 ** intDigits) {
        v /= 10;
        exponent += 1;
      }
    }
  }

  const negative = v < 0;
  const abs = Math.abs(v);
  const fixed = roundFixed(abs, decimals);
  let [intStr, fracStr = ''] = fixed.split('.');
  if (intStr === '0') intStr = '';
  const out = [];
  if (negative && Number(fixed) !== 0) out.push({ text: '-' });

  // Integer placeholders, right to left: each takes a digit; the leftmost takes the rest.
  const intTokens = tokens.slice(0, intEnd);
  const intPlaceholders = intTokens.filter((t) => t.type === 'digit');
  const digits = intStr.split('');
  const assigned = new Map();
  let d = digits.length - 1;
  for (let k = intPlaceholders.length - 1; k >= 0; k--) {
    const t = intPlaceholders[k];
    if (k === 0) {
      assigned.set(t, digits.slice(0, d + 1).join(''));
      d = -1;
    } else assigned.set(t, d >= 0 ? digits[d--] : '');
  }
  let intText = [];
  for (const t of intTokens) {
    if (t.type === 'digit') {
      const got = assigned.get(t) ?? '';
      if (got) intText.push({ text: got, digits: true });
      else if (t.ch === '0') intText.push({ text: '0', digits: true });
      else if (t.ch === '?') intText.push({ text: '0', hidden: true });
    } else if (t.type === 'comma' || t.type === 'percent') {
      if (t.type === 'percent') intText.push({ text: '%' });
    } else intText.push(simple(t));
  }
  if (grouping) {
    // Group the digits written (they're consecutive parts), from the right.
    const all = intText.filter((p) => p.digits).map((p) => p.text).join('');
    const grouped = all.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    let placed = false;
    intText = intText.flatMap((p) => {
      if (!p.digits) return [p];
      if (placed) return [];
      placed = true;
      return [{ text: grouped }];
    });
  }
  out.push(...intText);

  if (pointAt >= 0 && pointAt < mantissaEnd) {
    const after = tokens.slice(pointAt + 1, mantissaEnd);
    // Trailing zeros: shown for 0, dropped for #, blank for ?.
    const fd = fracStr.padEnd(decimals, '0').split('');
    let keep = decimals;
    while (keep > 0 && fd[keep - 1] === '0' && fracTokens[keep - 1].ch !== '0') keep--;
    const showPoint = true;
    if (showPoint) out.push({ text: '.' });
    let n = 0;
    for (const t of after) {
      if (t.type === 'digit') {
        if (n < keep) out.push({ text: fd[n] });
        else if (t.ch === '?') out.push({ text: '0', hidden: true });
        n++;
      } else if (t.type === 'percent') out.push({ text: '%' });
      else if (t.type !== 'comma') out.push(simple(t));
    }
  }
  if (expAt >= 0) {
    const expTokens = tokens.slice(expAt + 1);
    const expDigits = expTokens.filter((t) => t.type === 'digit').length;
    const sign = exponent < 0 ? '-' : tokens[expAt].sign === '+' ? '+' : '';
    out.push({ text: `E${sign}${String(Math.abs(exponent)).padStart(expDigits, '0')}` });
    for (const t of expTokens) if (t.type !== 'digit') out.push(t.type === 'percent' ? { text: '%' } : simple(t));
  }
  return out;
}

// x to `decimals` places, rounding halves away from zero (as Excel does), without exponents.
function roundFixed(x, decimals) {
  const factor = 10 ** decimals;
  const r = Math.round((x * factor) * (1 + Number.EPSILON)) / factor;
  if (r >= 1e21) return r.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
  return r.toFixed(decimals);
}

function renderFraction(section, value) {
  const tokens = section.tokens;
  const slashAt = tokens.findIndex((t) => t.type === 'slash');
  const denomToken = tokens.slice(slashAt + 1).find((t) => t.type === 'denom');
  const denomDigits = tokens.slice(slashAt + 1).filter((t) => t.type === 'digit').length;
  // The numerator's placeholders are the digits just before the slash (after a space or literal);
  // any before those are the whole number's.
  let k = slashAt - 1;
  while (k >= 0 && tokens[k].type === 'digit') k--;
  const numTokens = tokens.slice(k + 1, slashAt);
  const wholeTokens = tokens.slice(0, k + 1).filter((t) => t.type === 'digit');
  const negative = value < 0;
  let abs = Math.abs(value);
  let whole = 0;
  if (wholeTokens.length) {
    whole = Math.floor(abs);
    abs -= whole;
  }
  let num;
  let den;
  if (denomToken) {
    den = denomToken.n;
    num = Math.round(abs * den);
  } else {
    [num, den] = bestFraction(abs, 10 ** Math.max(1, denomDigits) - 1);
  }
  if (wholeTokens.length && num === den) {
    whole += 1;
    num = 0;
  }
  const out = [];
  if (negative) out.push({ text: '-' });
  const prefix = tokens.slice(0, k + 1);
  if (wholeTokens.length) {
    let wrote = false;
    for (const t of prefix) {
      if (t.type === 'digit') {
        if (!wrote) out.push({ text: whole || num === 0 ? String(whole) : '', hidden: !whole && num !== 0 });
        wrote = true;
      } else out.push(simple(t));
    }
  } else out.push(...prefix.map(simple));
  if (num === 0 && wholeTokens.length) {
    // A whole number: the fraction's room is left blank.
    out.push({ text: `${'0'.repeat(numTokens.length)}/${denomToken ? den : '0'.repeat(denomDigits)}`, hidden: true });
  } else {
    out.push({ text: String(num).padStart(numTokens.filter((t) => t.ch !== '#').length, ' ') });
    out.push({ text: '/' });
    out.push({ text: String(den).padEnd(denomToken ? 0 : denomDigits, ' ') });
  }
  for (const t of tokens.slice(slashAt + 1)) if (t.type !== 'digit' && t.type !== 'denom') out.push(simple(t));
  return out;
}

// The nearest fraction with a denominator no more than `max` (continued fractions).
function bestFraction(x, max) {
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let v = x;
  for (let n = 0; n < 64; n++) {
    const a = Math.floor(v);
    const [h2, k2] = [a * h1 + h0, a * k1 + k0];
    if (k2 > max) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(v - a) < 1e-12) break;
    v = 1 / (v - a);
  }
  // Check the semiconvergent bound too.
  let best = [h1, k1];
  for (let den = 1; den <= max && max <= 999; den++) {
    const num = Math.round(x * den);
    if (Math.abs(x - num / den) < Math.abs(x - best[0] / best[1]) - 1e-15) best = [num, den];
  }
  return best;
}

// --- General -------------------------------------------------------------------------------------

// Excel's General: integers as they are, others to as many decimals as fit in 11 characters
// (beside a minus sign), else in scientific notation; in a narrow cell, fewer decimals until it
// fits (`fits`).
function general(value, { fits = null } = {}) {
  if (typeof value === 'boolean') return [{ text: value ? 'TRUE' : 'FALSE' }];
  if (typeof value === 'string') return [{ text: value }];
  if (typeof value !== 'number' || !Number.isFinite(value)) return [{ text: String(value ?? '') }];
  const candidates = generalCandidates(value);
  if (fits) for (const c of candidates) if (fits(c)) return [{ text: c }];
  return [{ text: candidates[0] }];
}

function generalCandidates(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const out = [];
  const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  const sci = (digits) => {
    let [m, e] = abs.toExponential(digits).split('e');
    m = trim(m);
    const n = Number(e);
    return `${sign}${m}E${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
  };
  if (abs === 0) return ['0'];
  const intDigits = Math.floor(Math.log10(abs)) + 1;
  if (abs >= 1e11 || (abs < 1e-9)) {
    for (let d = 5; d >= 0; d--) out.push(sci(d));
    return [...new Set(out)];
  }
  // Fixed: as many decimals as fit in 11 characters.
  const room = 11 - Math.max(1, intDigits) - 1;
  for (let d = Math.max(0, room); d >= 0; d--) {
    const s = trim(abs.toFixed(d));
    if (Number(s) === 0 && abs !== 0) continue;
    out.push(sign + s);
  }
  if (abs < 1e-4 || !out.length) for (let d = 5; d >= 0; d--) out.push(sci(d));
  else for (let d = 5; d >= 0; d--) out.push(sci(d));
  return [...new Set(out)];
}

// --- Dates and times ------------------------------------------------------------------------------

// A serial date as its parts (Excel's 1900 system, with its 29 February 1900; or 1904).
export function serialToDate(serial, { date1904 = false } = {}) {
  let days = Math.floor(serial);
  let fraction = serial - days;
  let y;
  let mo;
  let d;
  let weekday;
  if (!date1904 && days === 60) {
    [y, mo, d] = [1900, 2, 29];
    weekday = 3;
  } else {
    if (!date1904 && days < 60) days += 1;
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const date = new Date(base + days * 86400000);
    [y, mo, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    weekday = date.getUTCDay();
    if (!date1904 && serial < 1) [y, mo, d] = [1900, 1, 0];
  }
  return { y, mo, d, weekday, fraction };
}

function renderDate(section, value, { date1904 = false } = {}) {
  const tokens = section.tokens;
  const subsecond = tokens.findIndex((t) => t.type === 'point');
  const decimals = subsecond >= 0 ? tokens.slice(subsecond + 1).findIndex((t) => t.type !== 'digit') : 0;
  const places = subsecond >= 0 ? (decimals < 0 ? tokens.length - subsecond - 1 : decimals) : 0;
  // Round to the shown second (or fraction of one) first, carrying into the day.
  const unit = 86400 * 10 ** places;
  const rounded = Math.round(value * unit) / unit;
  const { y, mo, d, weekday } = serialToDate(rounded, { date1904 });
  const totalSeconds = Math.round((rounded - Math.floor(rounded)) * 86400 * 10 ** places) / 10 ** places;
  const h = Math.floor(totalSeconds / 3600);
  const mi = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const sub = totalSeconds - Math.floor(totalSeconds);
  const ampm = tokens.some((t) => t.type === 'ampm');
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'date') {
      const w = t.width;
      if (t.unit === 'y') out.push({ text: w <= 2 ? String(y % 100).padStart(2, '0') : String(y) });
      else if (t.unit === 'm') out.push({ text: w === 1 ? String(mo) : w === 2 ? String(mo).padStart(2, '0') : w === 3 ? MONTHS[mo - 1].slice(0, 3) : w === 5 ? MONTHS[mo - 1][0] : MONTHS[mo - 1] });
      else if (t.unit === 'd') out.push({ text: w === 1 ? String(d) : w === 2 ? String(d).padStart(2, '0') : w === 3 ? DAYS[weekday].slice(0, 3) : DAYS[weekday] });
      else if (t.unit === 'h') {
        let hh = h;
        if (ampm) hh = h % 12 || 12;
        out.push({ text: w >= 2 ? String(hh).padStart(2, '0') : String(hh) });
      } else if (t.unit === 'M') out.push({ text: w >= 2 ? String(mi).padStart(2, '0') : String(mi) });
      else if (t.unit === 's') out.push({ text: w >= 2 ? String(s).padStart(2, '0') : String(s) });
    } else if (t.type === 'elapsed') {
      const n = t.unit === 'h' ? Math.floor(Math.round(value * 86400) / 3600) : t.unit === 'm' ? Math.floor(Math.round(value * 86400) / 60) : Math.round(value * 86400);
      out.push({ text: String(n).padStart(t.width, '0') });
    } else if (t.type === 'ampm') out.push({ text: t.text.length > 3 ? (h < 12 ? 'AM' : 'PM') : h < 12 ? 'A' : 'P' });
    else if (t.type === 'point' && places) {
      out.push({ text: `.${sub.toFixed(places).slice(2)}` });
      k += places;
    } else if (t.type === 'digit') out.push({ text: t.ch === '0' ? '0' : '' });
    else out.push(simple(t));
  }
  return out;
}

// What a format shows a value as, as plain text (for tests and measuring).
export function formatText(value, code, options) {
  return format(value, code, options).parts.map((p) => (p.hidden ? ' ' : p.fill ? '' : p.text)).join('');
}
