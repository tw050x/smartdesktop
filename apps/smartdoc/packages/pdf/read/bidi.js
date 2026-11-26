// Putting right-to-left text (Hebrew, Arabic) in reading order, the way pdf.js does for each text
// item: a simplified Unicode bidirectional algorithm (rules W1 to W7, N1 and N2, I1 and I2, L2),
// with < and > dropped from text that's been reordered. Text with no right-to-left characters is
// left as it is.

import { BIDI_ARABIC, BIDI_BASE } from './data.js';

const isOdd = (i) => (i & 1) !== 0;

function findUnequal(arr, start, value) {
  let j = start;
  while (j < arr.length && arr[j] === value) j++;
  return j;
}

function reverse(arr, start, end) {
  for (let i = start, j = end - 1; i < j; ++i, --j) [arr[i], arr[j]] = [arr[j], arr[i]];
}

const result = (str, ltr, vertical = false) => ({ str, dir: vertical ? 'ttb' : ltr ? 'ltr' : 'rtl' });

export function bidi(str, startLevel = -1, vertical = false) {
  const n = str.length;
  if (n === 0 || vertical) return result(str, true, vertical);
  const chars = new Array(n);
  const types = new Array(n);
  let numBidi = 0;
  for (let i = 0; i < n; ++i) {
    chars[i] = str.charAt(i);
    const c = str.charCodeAt(i);
    let t = 'L';
    if (c <= 0xff) t = BIDI_BASE[c];
    else if (c >= 0x0590 && c <= 0x05f4) t = 'R';
    else if (c >= 0x0600 && c <= 0x06ff) t = BIDI_ARABIC[c & 0xff];
    else if ((c >= 0x0700 && c <= 0x08ac) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) t = 'AL';
    if (t === 'R' || t === 'AL' || t === 'AN') numBidi++;
    types[i] = t;
  }
  if (numBidi === 0) return result(str, true);

  let ltr;
  if (startLevel === -1) {
    if (numBidi / n < 0.3 && n > 4) {
      ltr = true;
      startLevel = 0;
    } else {
      ltr = false;
      startLevel = 1;
    }
  }
  const levels = new Array(n).fill(startLevel);
  const e = isOdd(startLevel) ? 'R' : 'L';
  const sor = e;
  const eor = sor;

  // W1: non-spacing marks take the type before them.
  let last = sor;
  for (let i = 0; i < n; ++i) {
    if (types[i] === 'NSM') types[i] = last;
    else last = types[i];
  }
  // W2: European numbers after Arabic letters are Arabic numbers.
  last = sor;
  for (let i = 0; i < n; ++i) {
    const t = types[i];
    if (t === 'EN') types[i] = last === 'AL' ? 'AN' : 'EN';
    else if (t === 'R' || t === 'L' || t === 'AL') last = t;
  }
  // W3
  for (let i = 0; i < n; ++i) if (types[i] === 'AL') types[i] = 'R';
  // W4: a single separator between two numbers of the same kind joins them.
  for (let i = 1; i < n - 1; ++i) {
    if (types[i] === 'ES' && types[i - 1] === 'EN' && types[i + 1] === 'EN') types[i] = 'EN';
    if (types[i] === 'CS' && (types[i - 1] === 'EN' || types[i - 1] === 'AN') && types[i + 1] === types[i - 1]) types[i] = types[i - 1];
  }
  // W5: terminators next to European numbers are European numbers.
  for (let i = 0; i < n; ++i) {
    if (types[i] !== 'EN') continue;
    for (let j = i - 1; j >= 0 && types[j] === 'ET'; --j) types[j] = 'EN';
    for (let j = i + 1; j < n && types[j] === 'ET'; ++j) types[j] = 'EN';
  }
  // W6
  for (let i = 0; i < n; ++i) {
    const t = types[i];
    if (t === 'WS' || t === 'ES' || t === 'ET' || t === 'CS') types[i] = 'ON';
  }
  // W7
  last = sor;
  for (let i = 0; i < n; ++i) {
    const t = types[i];
    if (t === 'EN') types[i] = last === 'L' ? 'L' : 'EN';
    else if (t === 'R' || t === 'L') last = t;
  }
  // N1: neutrals between two strong types of the same direction take it.
  for (let i = 0; i < n; ++i) {
    if (types[i] !== 'ON') continue;
    const end = findUnequal(types, i + 1, 'ON');
    let before = sor;
    for (let j = i - 1; j >= 0; j--) {
      const tt = types[j];
      if (tt === 'L') {
        before = 'L';
        break;
      }
      if (tt === 'R' || tt === 'EN' || tt === 'AN') {
        before = 'R';
        break;
      }
    }
    let after = eor;
    for (let j = end; j < n; j++) {
      const tt = types[j];
      if (tt === 'L') {
        after = 'L';
        break;
      }
      if (tt === 'R' || tt === 'EN' || tt === 'AN') {
        after = 'R';
        break;
      }
    }
    if (before === after) types.fill(before, i, end);
    i = end - 1;
  }
  // N2
  for (let i = 0; i < n; ++i) if (types[i] === 'ON') types[i] = e;
  // I1, I2
  for (let i = 0; i < n; ++i) {
    const t = types[i];
    if (!isOdd(levels[i])) {
      if (t === 'R') levels[i] += 1;
      else if (t === 'AN' || t === 'EN') levels[i] += 2;
    } else if (t === 'L' || t === 'AN' || t === 'EN') levels[i] += 1;
  }
  // L2: reverse each run at or above each level, from the highest down to the lowest odd one.
  let highest = -1;
  let lowestOdd = 99;
  for (const level of levels) {
    if (highest < level) highest = level;
    if (lowestOdd > level && isOdd(level)) lowestOdd = level;
  }
  for (let level = highest; level >= lowestOdd; --level) {
    let start = -1;
    for (let i = 0; i < n; ++i) {
      if (levels[i] < level) {
        if (start >= 0) {
          reverse(chars, start, i);
          start = -1;
        }
      } else if (start < 0) start = i;
    }
    if (start >= 0) reverse(chars, start, n);
  }
  for (let i = 0; i < n; ++i) if (chars[i] === '<' || chars[i] === '>') chars[i] = '';
  return result(chars.join(''), ltr);
}
