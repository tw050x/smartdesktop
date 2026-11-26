// Glyph outlines from font programs, for drawing text: TrueType's glyf table (quadratic curves,
// composite glyphs), CFF's Type 2 charstrings and Type 1 charstrings (cubic curves, subroutines,
// flex, and accented characters made of two glyphs, seac). Each outline is a list of commands in
// em units (1 is the font size): ['M', x, y], ['L', x, y], ['Q', x1, y1, x, y],
// ['C', x1, y1, x2, y2, x, y], ['Z'].

import { ENCODINGS } from './data.js';

const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const i16 = (b, p) => ((b[p] << 24) >> 16) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

// A transform [a b c d e f] of each point in a list of commands.
function transformCommands(cmds, m) {
  const [a, b, c, d, e, f] = m;
  return cmds.map(([op, ...v]) => {
    const out = [op];
    for (let i = 0; i < v.length; i += 2) out.push(a * v[i] + c * v[i + 1] + e, b * v[i] + d * v[i + 1] + f);
    return out;
  });
}

// --- TrueType -------------------------------------------------------------------------------

export class TrueTypeOutlines {
  constructor(tables) {
    this.glyf = tables.glyf?.data ?? new Uint8Array(0);
    this.loca = tables.loca?.data ?? new Uint8Array(0);
    const head = tables.head?.data;
    this.unitsPerEm = head && u16(head, 18) >= 16 ? u16(head, 18) : 1000;
    this.longLoca = head ? i16(head, 50) === 1 : false;
    this.numGlyphs = tables.maxp ? u16(tables.maxp.data, 4) : 0;
    const locaCount = this.longLoca ? this.loca.length / 4 : this.loca.length / 2;
    // A wrong indexToLocFormat is put right by the table's length, as pdf.js does.
    if (this.numGlyphs && !this.longLoca && this.loca.length === (this.numGlyphs + 1) * 4) this.longLoca = true;
    else if (this.numGlyphs && this.longLoca && this.loca.length === (this.numGlyphs + 1) * 2) this.longLoca = false;
    if (!this.numGlyphs) this.numGlyphs = Math.max(0, Math.floor(locaCount) - 1);
    this.cache = new Map();
  }

  offset(gid) {
    return this.longLoca ? u32(this.loca, gid * 4) : u16(this.loca, gid * 2) * 2;
  }

  has(gid) {
    return gid >= 0 && gid < this.numGlyphs;
  }

  outline(gid) {
    let cmds = this.cache.get(gid);
    if (!cmds) {
      try {
        cmds = transformCommands(this.raw(gid, 0), [1 / this.unitsPerEm, 0, 0, 1 / this.unitsPerEm, 0, 0]);
      } catch {
        cmds = [];
      }
      this.cache.set(gid, cmds);
    }
    return cmds;
  }

  // In font units.
  raw(gid, depth) {
    if (!this.has(gid) || depth > 10) return [];
    const start = this.offset(gid);
    const end = this.offset(gid + 1);
    if (!(end > start) || start + 10 > this.glyf.length) return [];
    const g = this.glyf.subarray(start, Math.min(end, this.glyf.length));
    const contours = i16(g, 0);
    if (contours < 0) return this.composite(g, depth);
    const ends = [];
    let p = 10;
    for (let i = 0; i < contours; i++, p += 2) ends.push(u16(g, p));
    const count = contours ? ends[contours - 1] + 1 : 0;
    p += 2 + u16(g, p);
    const flags = [];
    while (flags.length < count && p < g.length) {
      const f = g[p++];
      flags.push(f);
      if (f & 8) {
        let r = g[p++];
        while (r-- > 0 && flags.length < count) flags.push(f);
      }
    }
    const xs = new Array(count);
    const ys = new Array(count);
    let v = 0;
    for (let i = 0; i < count; i++) {
      const f = flags[i];
      if (f & 2) {
        const d = g[p++];
        v += f & 16 ? d : -d;
      } else if (!(f & 16)) {
        v += i16(g, p);
        p += 2;
      }
      xs[i] = v;
    }
    v = 0;
    for (let i = 0; i < count; i++) {
      const f = flags[i];
      if (f & 4) {
        const d = g[p++];
        v += f & 32 ? d : -d;
      } else if (!(f & 32)) {
        v += i16(g, p);
        p += 2;
      }
      ys[i] = v;
    }
    const cmds = [];
    let first = 0;
    for (const last of ends) {
      if (last < first) continue;
      contour(cmds, xs, ys, flags, first, last);
      first = last + 1;
    }
    return cmds;
  }

  composite(g, depth) {
    const cmds = [];
    let p = 10;
    for (;;) {
      const flags = u16(g, p);
      const gid = u16(g, p + 2);
      p += 4;
      let dx;
      let dy;
      if (flags & 1) {
        dx = i16(g, p);
        dy = i16(g, p + 2);
        p += 4;
      } else {
        dx = (g[p] << 24) >> 24;
        dy = (g[p + 1] << 24) >> 24;
        p += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2dot14 = (q) => i16(g, q) / 16384;
      if (flags & 8) {
        a = d = f2dot14(p);
        p += 2;
      } else if (flags & 0x40) {
        a = f2dot14(p);
        d = f2dot14(p + 2);
        p += 4;
      } else if (flags & 0x80) {
        a = f2dot14(p);
        b = f2dot14(p + 2);
        c = f2dot14(p + 4);
        d = f2dot14(p + 6);
        p += 8;
      }
      // Points matched rather than offsets (ARGS_ARE_XY_VALUES clear) are rare: taken as offsets of 0.
      if (!(flags & 2)) dx = dy = 0;
      cmds.push(...transformCommands(this.raw(gid, depth + 1), [a, b, c, d, dx, dy]));
      if (!(flags & 0x20) || p >= g.length) break;
    }
    return cmds;
  }
}

function contour(cmds, xs, ys, flags, first, last) {
  const on = (i) => flags[i] & 1;
  const n = last - first + 1;
  const at = (k) => first + (((k % n) + n) % n);
  // Start at an on-curve point, or midway between two off-curve ones.
  let start = -1;
  for (let k = 0; k < n; k++) if (on(first + k)) {
    start = k;
    break;
  }
  let sx;
  let sy;
  if (start < 0) {
    sx = (xs[first] + xs[at(1)]) / 2;
    sy = (ys[first] + ys[at(1)]) / 2;
    start = 0;
  } else {
    sx = xs[first + start];
    sy = ys[first + start];
  }
  cmds.push(['M', sx, sy]);
  let cx = null;
  let cy = null;
  const begin = on(first + start) ? start + 1 : start;
  for (let k = begin; k <= start + n; k++) {
    const i = at(k);
    const x = k === start + n ? sx : xs[i];
    const y = k === start + n ? sy : ys[i];
    if (k === start + n || on(i)) {
      if (cx === null) cmds.push(['L', x, y]);
      else cmds.push(['Q', cx, cy, x, y]);
      cx = cy = null;
    } else if (cx === null) {
      cx = x;
      cy = y;
    } else {
      const mx = (cx + x) / 2;
      const my = (cy + y) / 2;
      cmds.push(['Q', cx, cy, mx, my]);
      cx = x;
      cy = y;
    }
  }
  cmds.push(['Z']);
}

// --- CFF (Type 2 charstrings) ------------------------------------------------------------------

const bias = (subrs) => (!subrs ? 0 : subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768);

export class CFFOutlines {
  // `cff` as parseCFF gives it.
  constructor(cff) {
    this.cff = cff;
    this.cache = new Map();
    if (cff.isCID) {
      this.cidToGid = new Map();
      cff.charset.forEach((cid, gid) => this.cidToGid.set(cid, gid));
    }
  }

  has(gid) {
    return gid >= 0 && gid < this.cff.charStrings.length;
  }

  // The glyph index of a glyph name (a non-CID font) or CID.
  gidOfName(name) {
    return this.cff.charset.indexOf(name);
  }

  outline(gid) {
    let cmds = this.cache.get(gid);
    if (!cmds) {
      try {
        const { cmds: raw, matrix } = this.run(gid, 0);
        cmds = transformCommands(raw, matrix);
      } catch {
        cmds = [];
      }
      this.cache.set(gid, cmds);
    }
    return cmds;
  }

  run(gid, depth) {
    const cff = this.cff;
    let priv = cff.privateDict;
    let matrix = cff.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
    if (cff.isCID && cff.fdSelect) {
      const fd = cff.fdArray[cff.fdSelect[gid]];
      if (fd) {
        priv = fd.privateDict;
        // A font dict's own matrix applies, combined with the top dict's if that has one of its
        // own (as FreeType takes it).
        if (fd.has('FontMatrix')) {
          const m = fd.get('FontMatrix');
          if (cff.topDict.has('FontMatrix')) {
            const t = cff.fontMatrix;
            matrix = [m[0] * t[0] + m[1] * t[2], m[0] * t[1] + m[1] * t[3], m[2] * t[0] + m[3] * t[2], m[2] * t[1] + m[3] * t[3], m[4] * t[0] + m[5] * t[2] + t[4], m[4] * t[1] + m[5] * t[3] + t[5]];
          } else matrix = m;
        }
      }
    }
    const local = priv?.subrs ?? null;
    const global = cff.globalSubrs;
    const cmds = [];
    const st = { x: 0, y: 0, stack: [], stems: 0, open: false, width: null, done: false };
    const close = () => {
      if (st.open) cmds.push(['Z']);
      st.open = false;
    };
    const moveTo = (x, y) => {
      close();
      st.x = x;
      st.y = y;
      cmds.push(['M', x, y]);
      st.open = true;
    };
    const lineTo = (x, y) => {
      st.x = x;
      st.y = y;
      cmds.push(['L', x, y]);
    };
    const curveTo = (x1, y1, x2, y2, x, y) => {
      st.x = x;
      st.y = y;
      cmds.push(['C', x1, y1, x2, y2, x, y]);
    };
    const seac = (adx, ady, bchar, achar) => {
      const base = this.gidOfName(ENCODINGS.StandardEncoding[bchar]);
      const accent = this.gidOfName(ENCODINGS.StandardEncoding[achar]);
      if (depth > 2) return;
      if (base >= 0) cmds.push(...this.run(base, depth + 1).cmds);
      if (accent >= 0) cmds.push(...transformCommands(this.run(accent, depth + 1).cmds, [1, 0, 0, 1, adx, ady]));
    };
    const exec = (code, level) => {
      if (level > 10) throw new Error('subroutines nested too deep');
      const s = st.stack;
      for (let i = 0; i < code.length && !st.done; ) {
        const v = code[i++];
        if (v >= 32 || v === 28) {
          if (v === 28) {
            s.push(((code[i] << 24) >> 16) | code[i + 1]);
            i += 2;
          } else if (v <= 246) s.push(v - 139);
          else if (v <= 250) s.push((v - 247) * 256 + code[i++] + 108);
          else if (v <= 254) s.push(-(v - 251) * 256 - code[i++] - 108);
          else {
            s.push(((code[i] << 24) | (code[i + 1] << 16) | (code[i + 2] << 8) | code[i + 3]) / 65536);
            i += 4;
          }
          continue;
        }
        const takeWidth = (even) => {
          if (st.width === null) {
            st.width = (s.length % 2 === 1) === even ? s.shift() : 0;
          }
        };
        switch (v) {
          case 1: // hstem
          case 3: // vstem
          case 18: // hstemhm
          case 23: // vstemhm
            takeWidth(true);
            st.stems += s.length >> 1;
            s.length = 0;
            break;
          case 19: // hintmask
          case 20: // cntrmask
            takeWidth(true);
            st.stems += s.length >> 1;
            s.length = 0;
            i += (st.stems + 7) >> 3;
            break;
          case 21: // rmoveto
            takeWidth(true);
            moveTo(st.x + (s[0] ?? 0), st.y + (s[1] ?? 0));
            s.length = 0;
            break;
          case 22: // hmoveto
            takeWidth(false);
            moveTo(st.x + (s[0] ?? 0), st.y);
            s.length = 0;
            break;
          case 4: // vmoveto
            takeWidth(false);
            moveTo(st.x, st.y + (s[0] ?? 0));
            s.length = 0;
            break;
          case 5: // rlineto
            for (let k = 0; k + 1 < s.length; k += 2) lineTo(st.x + s[k], st.y + s[k + 1]);
            s.length = 0;
            break;
          case 6: // hlineto
          case 7: // vlineto
            for (let k = 0, h = v === 6; k < s.length; k++, h = !h) {
              if (h) lineTo(st.x + s[k], st.y);
              else lineTo(st.x, st.y + s[k]);
            }
            s.length = 0;
            break;
          case 8: // rrcurveto
            for (let k = 0; k + 5 < s.length; k += 6) {
              const x1 = st.x + s[k];
              const y1 = st.y + s[k + 1];
              const x2 = x1 + s[k + 2];
              const y2 = y1 + s[k + 3];
              curveTo(x1, y1, x2, y2, x2 + s[k + 4], y2 + s[k + 5]);
            }
            s.length = 0;
            break;
          case 24: {
            // rcurveline
            let k = 0;
            for (; k + 7 < s.length; k += 6) {
              const x1 = st.x + s[k];
              const y1 = st.y + s[k + 1];
              const x2 = x1 + s[k + 2];
              const y2 = y1 + s[k + 3];
              curveTo(x1, y1, x2, y2, x2 + s[k + 4], y2 + s[k + 5]);
            }
            lineTo(st.x + (s[k] ?? 0), st.y + (s[k + 1] ?? 0));
            s.length = 0;
            break;
          }
          case 25: {
            // rlinecurve
            let k = 0;
            for (; k + 7 < s.length; k += 2) lineTo(st.x + s[k], st.y + s[k + 1]);
            const x1 = st.x + s[k];
            const y1 = st.y + s[k + 1];
            const x2 = x1 + s[k + 2];
            const y2 = y1 + s[k + 3];
            curveTo(x1, y1, x2, y2, x2 + s[k + 4], y2 + s[k + 5]);
            s.length = 0;
            break;
          }
          case 26: {
            // vvcurveto
            let k = 0;
            let dx1 = 0;
            if (s.length % 2) dx1 = s[k++];
            for (; k + 3 < s.length; k += 4) {
              const x1 = st.x + dx1;
              const y1 = st.y + s[k];
              const x2 = x1 + s[k + 1];
              const y2 = y1 + s[k + 2];
              curveTo(x1, y1, x2, y2, x2, y2 + s[k + 3]);
              dx1 = 0;
            }
            s.length = 0;
            break;
          }
          case 27: {
            // hhcurveto
            let k = 0;
            let dy1 = 0;
            if (s.length % 2) dy1 = s[k++];
            for (; k + 3 < s.length; k += 4) {
              const x1 = st.x + s[k];
              const y1 = st.y + dy1;
              const x2 = x1 + s[k + 1];
              const y2 = y1 + s[k + 2];
              curveTo(x1, y1, x2, y2, x2 + s[k + 3], y2);
              dy1 = 0;
            }
            s.length = 0;
            break;
          }
          case 30: // vhcurveto
          case 31: {
            // hvcurveto
            let horizontal = v === 31;
            for (let k = 0; k + 3 < s.length; k += 4) {
              const last = k + 8 > s.length;
              if (horizontal) {
                const x1 = st.x + s[k];
                const y1 = st.y;
                const x2 = x1 + s[k + 1];
                const y2 = y1 + s[k + 2];
                const y = y2 + s[k + 3];
                const x = x2 + (last && s.length - k === 5 ? s[k + 4] : 0);
                curveTo(x1, y1, x2, y2, x, y);
              } else {
                const x1 = st.x;
                const y1 = st.y + s[k];
                const x2 = x1 + s[k + 1];
                const y2 = y1 + s[k + 2];
                const x = x2 + s[k + 3];
                const y = y2 + (last && s.length - k === 5 ? s[k + 4] : 0);
                curveTo(x1, y1, x2, y2, x, y);
              }
              horizontal = !horizontal;
            }
            s.length = 0;
            break;
          }
          case 10: // callsubr
          case 29: {
            // callgsubr
            const subrs = v === 10 ? local : global;
            const n = s.pop() + bias(subrs);
            const sub = subrs?.[n];
            if (sub) exec(sub, level + 1);
            break;
          }
          case 11: // return
            return;
          case 14: // endchar
            takeWidth(true);
            if (s.length >= 4) {
              const [adx, ady, bchar, achar] = s.slice(-4);
              close();
              seac(adx, ady, bchar, achar);
            }
            close();
            st.done = true;
            return;
          case 12: {
            const op = code[i++];
            switch (op) {
              case 35: {
                // flex
                const p = [];
                let x = st.x;
                let y = st.y;
                for (let k = 0; k < 12; k += 2) {
                  x += s[k] ?? 0;
                  y += s[k + 1] ?? 0;
                  p.push(x, y);
                }
                curveTo(p[0], p[1], p[2], p[3], p[4], p[5]);
                curveTo(p[6], p[7], p[8], p[9], p[10], p[11]);
                break;
              }
              case 34: {
                // hflex
                const [dx1, dx2, dy2, dx3, dx4, dx5, dx6] = s;
                const y0 = st.y;
                const x1 = st.x + dx1;
                const x2 = x1 + dx2;
                const y2 = y0 + dy2;
                const x3 = x2 + dx3;
                curveTo(x1, y0, x2, y2, x3, y2);
                const x4 = x3 + dx4;
                const x5 = x4 + dx5;
                curveTo(x4, y2, x5, y0, x5 + dx6, y0);
                break;
              }
              case 36: {
                // hflex1
                const [dx1, dy1, dx2, dy2, dx3, dx4, dx5, dy5, dx6] = s;
                const y0 = st.y;
                const x1 = st.x + dx1;
                const y1 = y0 + dy1;
                const x2 = x1 + dx2;
                const y2 = y1 + dy2;
                const x3 = x2 + dx3;
                curveTo(x1, y1, x2, y2, x3, y2);
                const x4 = x3 + dx4;
                const x5 = x4 + dx5;
                const y5 = y2 + dy5;
                curveTo(x4, y2, x5, y5, x5 + dx6, y0);
                break;
              }
              case 37: {
                // flex1
                const p = [];
                let x = st.x;
                let y = st.y;
                for (let k = 0; k < 10; k += 2) {
                  x += s[k] ?? 0;
                  y += s[k + 1] ?? 0;
                  p.push(x, y);
                }
                const dx = x - st.x;
                const dy = y - st.y;
                const d6 = s[10] ?? 0;
                const end = Math.abs(dx) > Math.abs(dy) ? [x + d6, st.y] : [st.x, y + d6];
                curveTo(p[0], p[1], p[2], p[3], p[4], p[5]);
                curveTo(p[6], p[7], p[8], p[9], end[0], end[1]);
                break;
              }
              default:
                // Arithmetic and storage operators are rare in fonts embedded in PDFs.
                arithmetic(op, s);
                continue;
            }
            s.length = 0;
            break;
          }
          default:
            s.length = 0;
        }
      }
    };
    const code = cff.charStrings[gid];
    if (code) exec(code, 0);
    close();
    return { cmds, matrix };
  }
}

function arithmetic(op, s) {
  const b = s.pop();
  switch (op) {
    case 3: // and
      s.push(s.pop() && b ? 1 : 0);
      break;
    case 4: // or
      s.push(s.pop() || b ? 1 : 0);
      break;
    case 5: // not
      s.push(b ? 0 : 1);
      break;
    case 9: // abs
      s.push(Math.abs(b));
      break;
    case 10: // add
      s.push(s.pop() + b);
      break;
    case 11: // sub
      s.push(s.pop() - b);
      break;
    case 12: // div
      s.push(s.pop() / b);
      break;
    case 14: // neg
      s.push(-b);
      break;
    case 15: // eq
      s.push(s.pop() === b ? 1 : 0);
      break;
    case 18: // drop
      break;
    case 23: // random
      s.push(b, Math.random());
      break;
    case 24: // mul
      s.push(s.pop() * b);
      break;
    case 26: // sqrt
      s.push(Math.sqrt(b));
      break;
    case 27: // dup
      s.push(b, b);
      break;
    case 28: {
      // exch
      const a = s.pop();
      s.push(b, a);
      break;
    }
    default:
      s.length = 0;
  }
}

// --- Type 1 charstrings -----------------------------------------------------------------------

export class Type1Outlines {
  // `font` as parseType1 gives it.
  constructor(font) {
    this.font = font;
    this.byName = new Map(font.charstrings.map((c) => [c.name, c.encoded]));
    this.matrix = font.fontMatrix?.length === 6 ? font.fontMatrix : [0.001, 0, 0, 0.001, 0, 0];
    this.cache = new Map();
  }

  has(name) {
    return this.byName.has(name);
  }

  outline(name) {
    let cmds = this.cache.get(name);
    if (!cmds) {
      try {
        cmds = transformCommands(this.run(name, 0), this.matrix);
      } catch {
        cmds = [];
      }
      this.cache.set(name, cmds);
    }
    return cmds;
  }

  run(name, depth) {
    const code = this.byName.get(name);
    if (!code || depth > 2) return [];
    const subrs = this.font.subrs;
    const cmds = [];
    const st = { x: 0, y: 0, sbx: 0, stack: [], ps: [], flex: null, open: false, done: false };
    const close = () => {
      if (st.open) cmds.push(['Z']);
      st.open = false;
    };
    const moveTo = (x, y) => {
      st.x = x;
      st.y = y;
      if (st.flex) {
        st.flex.push(x, y);
        return;
      }
      close();
      cmds.push(['M', x, y]);
      st.open = true;
    };
    const lineTo = (x, y) => {
      st.x = x;
      st.y = y;
      cmds.push(['L', x, y]);
    };
    const curveTo = (x1, y1, x2, y2, x, y) => {
      st.x = x;
      st.y = y;
      cmds.push(['C', x1, y1, x2, y2, x, y]);
    };
    const exec = (data, level) => {
      if (level > 10) throw new Error('subroutines nested too deep');
      const s = st.stack;
      for (let i = 0; i < data.length && !st.done; ) {
        let v = data[i++];
        if (v >= 32) {
          if (v <= 246) s.push(v - 139);
          else if (v <= 250) s.push((v - 247) * 256 + data[i++] + 108);
          else if (v <= 254) s.push(-(v - 251) * 256 - data[i++] - 108);
          else {
            s.push((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]);
            i += 4;
          }
          continue;
        }
        if (v === 12) v = 1200 + data[i++];
        switch (v) {
          case 13: // hsbw
            st.sbx = s[0] ?? 0;
            st.x = st.sbx;
            st.y = 0;
            s.length = 0;
            break;
          case 1207: // sbw
            st.sbx = s[0] ?? 0;
            st.x = st.sbx;
            st.y = s[1] ?? 0;
            s.length = 0;
            break;
          case 21: // rmoveto
            moveTo(st.x + (s[0] ?? 0), st.y + (s[1] ?? 0));
            s.length = 0;
            break;
          case 22: // hmoveto
            moveTo(st.x + (s[0] ?? 0), st.y);
            s.length = 0;
            break;
          case 4: // vmoveto
            moveTo(st.x, st.y + (s[0] ?? 0));
            s.length = 0;
            break;
          case 5: // rlineto
            lineTo(st.x + (s[0] ?? 0), st.y + (s[1] ?? 0));
            s.length = 0;
            break;
          case 6: // hlineto
            lineTo(st.x + (s[0] ?? 0), st.y);
            s.length = 0;
            break;
          case 7: // vlineto
            lineTo(st.x, st.y + (s[0] ?? 0));
            s.length = 0;
            break;
          case 8: {
            // rrcurveto
            const x1 = st.x + s[0];
            const y1 = st.y + s[1];
            const x2 = x1 + s[2];
            const y2 = y1 + s[3];
            curveTo(x1, y1, x2, y2, x2 + s[4], y2 + s[5]);
            s.length = 0;
            break;
          }
          case 30: {
            // vhcurveto
            const x1 = st.x;
            const y1 = st.y + s[0];
            const x2 = x1 + s[1];
            const y2 = y1 + s[2];
            curveTo(x1, y1, x2, y2, x2 + s[3], y2);
            s.length = 0;
            break;
          }
          case 31: {
            // hvcurveto
            const x1 = st.x + s[0];
            const y1 = st.y;
            const x2 = x1 + s[1];
            const y2 = y1 + s[2];
            curveTo(x1, y1, x2, y2, x2, y2 + s[3]);
            s.length = 0;
            break;
          }
          case 9: // closepath
            close();
            s.length = 0;
            break;
          case 10: {
            // callsubr
            const n = s.pop();
            if (subrs[n]) exec(subrs[n], level + 1);
            break;
          }
          case 11: // return
            return;
          case 14: // endchar
            close();
            st.done = true;
            return;
          case 1206: {
            // seac
            const [asb, adx, ady, bchar, achar] = s;
            close();
            const base = ENCODINGS.StandardEncoding[bchar];
            const accent = ENCODINGS.StandardEncoding[achar];
            cmds.push(...this.run(base, depth + 1));
            cmds.push(...transformCommands(this.run(accent, depth + 1), [1, 0, 0, 1, adx + st.sbx - asb, ady]));
            st.done = true;
            return;
          }
          case 1212: {
            // div
            const b = s.pop();
            s.push(s.pop() / b);
            break;
          }
          case 1216: {
            // callothersubr
            const n = s.pop();
            const count = s.pop();
            const args = s.splice(s.length - count, count);
            if (n === 1) st.flex = [];
            else if (n === 0 && st.flex) {
              // The flex's points: a reference point, then the two curves' six.
              const p = st.flex;
              st.flex = null;
              if (p.length >= 14) {
                curveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
                curveTo(p[8], p[9], p[10], p[11], p[12], p[13]);
              }
              // Its end point, for "pop pop setcurrentpoint".
              st.ps.push(args[2] ?? st.y, args[1] ?? st.x);
            } else if (n !== 2) st.ps.push(...args.reverse());
            break;
          }
          case 1217: // pop
            s.push(st.ps.length ? st.ps.pop() : 0);
            break;
          case 1233: // setcurrentpoint
            st.x = s[0] ?? st.x;
            st.y = s[1] ?? st.y;
            s.length = 0;
            break;
          default:
            // hstem, vstem, dotsection, hstem3, vstem3: hints only.
            s.length = 0;
        }
      }
    };
    exec(code, 0);
    close();
    return cmds;
  }
}
