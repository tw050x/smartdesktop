// Reading a content stream (PDF 32000-1 7.8.2): its operators, each with the operands before it.
// Inline images (BI ... ID data EI) come back as one operator holding their dictionary and data.
// Operands are matched to operators as pdf.js matches them, so damaged streams read the same:
// words that aren't operators are passed over, keeping the operands before them; an operator
// given too many keeps the last ones it takes and puts the rest aside, and one given too few takes
// back what was put aside, or is skipped. More than 33 operands in a row, or more than 10 path
// operators in a row without theirs, and the stream can't be read further (ContentError).

import { Dict, Name } from './objects.js';
import { Cmd, EOF, Lexer, Parser } from './parser.js';

// How many operands each operator takes, and which take up to that many.
export const OPERAND_COUNT = {
  w: 1, J: 1, j: 1, M: 1, d: 2, ri: 1, i: 1, gs: 1, q: 0, Q: 0, cm: 6,
  m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4,
  S: 0, s: 0, f: 0, F: 0, 'f*': 0, B: 0, 'B*': 0, b: 0, 'b*': 0, n: 0, W: 0, 'W*': 0,
  BT: 0, ET: 0, Tc: 1, Tw: 1, Tz: 1, TL: 1, Tf: 2, Tr: 1, Ts: 1, Td: 2, TD: 2, Tm: 6, 'T*': 0,
  Tj: 1, TJ: 1, "'": 1, '"': 3, d0: 2, d1: 6,
  CS: 1, cs: 1, SC: 4, SCN: 33, sc: 4, scn: 33, G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4,
  sh: 1, BI: 1, ID: 0, EI: 1, Do: 1, MP: 1, DP: 2, BMC: 1, BDC: 2, EMC: 0, BX: 0, EX: 0,
};
// What the lexer takes as a whole word: the operators, and words that start them or the keywords.
const LEXER_WORDS = { ...OPERAND_COUNT, BM: null, BD: null, true: null, fa: null, fal: null, fals: null, false: null, nu: null, nul: null, null: null };
const VARIABLE = new Set(['SC', 'SCN', 'sc', 'scn']);
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);

export class ContentError extends Error {}

const ARRAY_START = Cmd.of('[');
const DICT_START = Cmd.of('<<');
const BI = Cmd.of('BI');

// Calls `fn(op, operands)` for each operator in `bytes`; `fn` returning false stops, as does a
// stream that can't be read further (what came before it counts, as in pdf.js).
export function readOperators(bytes, fn, doc = null) {
  try {
    operators(bytes, fn, doc);
  } catch (e) {
    if (!(e instanceof ContentError)) throw e;
  }
}

function operators(bytes, fn, doc) {
  const lexer = new Lexer(bytes);
  lexer.knownCommands = LEXER_WORDS;
  lexer.TooLong = ContentError;
  const parser = new Parser(lexer, { doc, allowStreams: false });
  let args = null;
  const aside = [];
  let isPathOp = false;
  let invalidPathOps = 0;
  const push = (obj) => {
    if (obj === null) return;
    args ??= [];
    args.push(obj);
    if (args.length > 33) throw new ContentError('Too many arguments');
  };
  for (;;) {
    const t = parser.peek();
    if (t === EOF) break;
    if (t === ARRAY_START || t === DICT_START) {
      push(parser.object());
      continue;
    }
    parser.token();
    if (!(t instanceof Cmd)) {
      push(t);
      continue;
    }
    const op = t.cmd;
    if (t === BI) push(inlineImage(parser, lexer, doc));
    const count = OPERAND_COUNT[op];
    if (count === undefined) continue;
    let length = args ? args.length : 0;
    if (!isPathOp) invalidPathOps = 0;
    isPathOp = PATH_OPS.has(op);
    if (!VARIABLE.has(op)) {
      if (length !== count) {
        while (length > count) {
          aside.push(args.shift());
          length--;
        }
        while (length < count && aside.length) {
          args ??= [];
          args.unshift(aside.pop());
          length++;
        }
      }
      if (length < count) {
        if (isPathOp && ++invalidPathOps > 10) throw new ContentError(`Invalid command ${op}`);
        if (args) args.length = 0;
        continue;
      }
    }
    const operands = args ?? [];
    args = null;
    if (fn(op, operands) === false) return;
  }
}

// BI <key value ...> ID <data> EI: the data's end is the EI after it that stands on its own.
function inlineImage(parser, lexer, doc) {
  const dict = new Dict(doc);
  for (;;) {
    const k = parser.token();
    if (k === EOF || (k instanceof Cmd && k.cmd === 'ID')) break;
    if (k instanceof Name) dict.set(k.name, parser.object());
  }
  parser.ahead = [];
  const b = lexer.bytes;
  let start = lexer.pos;
  if (b[start] === 0x0d && b[start + 1] === 0x0a) start += 2;
  else if (isWhite(b[start])) start++;
  let end = b.length;
  for (let i = start; i < b.length - 1; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === start || isWhite(b[i - 1])) && (i + 2 >= b.length || isWhite(b[i + 2]) || isDelimiter(b[i + 2]))) {
      // Make sure what follows looks like content again, not more image data.
      if (looksLikeContent(b, i + 2)) {
        end = i;
        break;
      }
    }
  }
  lexer.pos = Math.min(b.length, end + 2);
  let dataEnd = end;
  if (dataEnd > start && isWhite(b[dataEnd - 1])) dataEnd--;
  return { dict, data: b.subarray(start, dataEnd) };
}

const isWhite = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelimiter = (c) => c === 0x25 || c === 0x2f || c === 0x5b || c === 0x3c || c === 0x28;

// The next few bytes after a candidate EI are printable and form a word or two of operators.
function looksLikeContent(b, from) {
  let printable = 0;
  for (let i = from; i < Math.min(b.length, from + 32); i++) {
    const c = b[i];
    if (c > 0x7e || (c < 0x20 && !isWhite(c))) return false;
    printable++;
  }
  return printable > 0 || from >= b.length;
}
