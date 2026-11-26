// Excel workbooks (.xlsx) as Excel prints them: each sheet's print area (or the cells in use) on
// pages of its paper size, margins and scale (or fitted to so many pages), split across and down in
// its page order, with its print titles, headers and footers; each cell's value as its number
// format shows it, in its font, fill, borders and alignment; text running over empty neighbours,
// numbers too wide shown as ###.
import { createPdf } from '../lib/pdf.js';
import { EXCEL_THEME, excelTint, openPackage, readTheme } from '../lib/office.js';
import { builtinFormat, format } from '../lib/numfmt.js';
import { fontFor, lineMetrics, shape } from '../lib/text.js';
import { child, children, textOf } from '../lib/xml.js';


export function xlsxToPdf(bytes, { report, title } = {}) {
  const book = readXlsx(bytes, { report });
  return printWorkbook(book, { report, title });
}

// --- Reading -------------------------------------------------------------------------------------

export function readXlsx(bytes, { report }) {
  const pkg = openPackage(bytes);
  const mainName = pkg.main('xl/workbook.xml');
  const wb = pkg.part(mainName);
  if (!wb) throw new Error('The Excel workbook is damaged: it has no workbook part.');
  const rels = pkg.rels(mainName);
  const relOf = (type) => [...rels.values()].find((r) => r.type === type)?.target;
  const theme = readTheme(pkg.part(relOf('theme')));
  const date1904 = ['1', 'true'].includes(child(wb, 'workbookPr')?.attrs.date1904);
  const styles = readStyles(pkg.part(relOf('styles')), theme);
  const strings = readStrings(pkg.part(relOf('sharedStrings')), styles, theme);

  const sheets = [];
  const entries = children(child(wb, 'sheets'), 'sheet');
  const names = children(child(wb, 'definedNames'), 'definedName');
  entries.forEach((entry, index) => {
    const name = entry.attrs.name;
    if (entry.attrs.state === 'hidden' || entry.attrs.state === 'veryHidden') return;
    const rel = rels.get(entry.attrs['r:id']);
    if (!rel || rel.type !== 'worksheet') {
      if (rel?.type === 'chartsheet') report?.note('Chart sheets aren’t shown yet.');
      return;
    }
    const ws = pkg.part(rel.target);
    if (!ws) return;
    const defined = (n) => names.find((d) => d.attrs.name === n && Number(d.attrs.localSheetId) === index);
    sheets.push(readSheet(ws, { name, styles, strings, theme, report, pkg, part: rel.target, printArea: textOf(defined('_xlnm.Print_Area')), printTitles: textOf(defined('_xlnm.Print_Titles')) }));
  });
  return { sheets, styles, theme, date1904 };
}

// A colour element (rgb, theme with tint, indexed, auto) as #rrggbb, or null.
function colorOf(el, theme, fallback = null) {
  if (!el) return fallback;
  const a = el.attrs;
  let hex = null;
  if (a.rgb) hex = `#${a.rgb.slice(-6)}`;
  else if (a.theme != null) hex = theme.colors[EXCEL_THEME[Number(a.theme)]] ?? null;
  else if (a.indexed != null) hex = INDEXED[Number(a.indexed)] ?? null;
  else if (a.auto) hex = fallback;
  if (hex && a.tint) hex = excelTint(hex, Number(a.tint));
  return hex ?? fallback;
}

// Excel's legacy palette (indexed colours 0–63; 64 is the system foreground, 65 its background).
const INDEXED = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#c0c0c0', '#808080', '#9999ff', '#993366', '#ffffcc', '#ccffff', '#660066', '#ff8080', '#0066cc', '#ccccff', '#000080', '#ff00ff', '#ffff00', '#00ffff', '#800080', '#800000', '#008080', '#0000ff', '#00ccff', '#ccffff', '#ccffcc', '#ffff99', '#99ccff', '#ff99cc', '#cc99ff', '#ffcc99', '#3366ff', '#33cccc', '#99cc00', '#ffcc00', '#ff9900', '#ff6600', '#666699', '#969696', '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333', '#000000', '#ffffff'];

function readFont(el, theme) {
  const v = (name) => child(el, name)?.attrs.val;
  const flag = (name) => {
    const f = child(el, name);
    return Boolean(f) && f.attrs.val !== '0' && f.attrs.val !== 'false';
  };
  let family = v('name') ?? theme.minor;
  const scheme = v('scheme');
  if (scheme === 'minor') family = theme.minor;
  else if (scheme === 'major') family = theme.major;
  return {
    family,
    size: Number(v('sz') ?? 11),
    bold: flag('b'),
    italic: flag('i'),
    strike: flag('strike'),
    underline: child(el, 'u') ? child(el, 'u').attrs.val ?? 'single' : null,
    vertAlign: v('vertAlign') === 'superscript' || v('vertAlign') === 'subscript' ? v('vertAlign') : null,
    color: colorOf(child(el, 'color'), theme, '#000000'),
  };
}

function readStyles(root, theme) {
  const formats = new Map();
  for (const f of children(child(root, 'numFmts'), 'numFmt')) formats.set(Number(f.attrs.numFmtId), f.attrs.formatCode);
  const fonts = children(child(root, 'fonts'), 'font').map((f) => readFont(f, theme));
  if (!fonts.length) fonts.push({ family: theme.minor, size: 11, color: '#000000' });
  const fills = children(child(root, 'fills'), 'fill').map((f) => {
    const p = child(f, 'patternFill');
    const type = p?.attrs.patternType ?? (p ? 'solid' : 'none');
    if (!p || type === 'none') {
      if (child(f, 'gradientFill')) {
        const stops = children(child(f, 'gradientFill'), 'stop').map((s) => colorOf(child(s, 'color'), theme));
        return stops[0] ? { color: stops[0], gradient: true } : null;
      }
      return null;
    }
    const fg = colorOf(child(p, 'fgColor'), theme, '#000000');
    const bg = colorOf(child(p, 'bgColor'), theme, '#ffffff');
    if (type === 'solid') return { color: fg };
    // Patterns, drawn as the mix of colours they look like from a distance.
    const share = { gray125: 0.125, gray0625: 0.0625, lightGray: 0.25, mediumGray: 0.5, darkGray: 0.75 }[type] ?? 0.5;
    return { color: mix(fg, bg, share), pattern: type };
  });
  const borders = children(child(root, 'borders'), 'border').map((b) => {
    const side = (name) => {
      const s = child(b, name);
      const style = s?.attrs.style;
      if (!style || style === 'none') return null;
      return { style, color: colorOf(child(s, 'color'), theme, '#000000') };
    };
    return {
      left: side('left') ?? side('start'),
      right: side('right') ?? side('end'),
      top: side('top'),
      bottom: side('bottom'),
      diagonal: b.attrs.diagonalUp === '1' || b.attrs.diagonalDown === '1' ? { ...side('diagonal'), up: b.attrs.diagonalUp === '1', down: b.attrs.diagonalDown === '1' } : null,
    };
  });
  const xfs = children(child(root, 'cellXfs'), 'xf').map((xf) => {
    const a = child(xf, 'alignment')?.attrs ?? {};
    const id = Number(xf.attrs.numFmtId ?? 0);
    return {
      format: formats.get(id) ?? builtinFormat(id) ?? 'General',
      font: fonts[Number(xf.attrs.fontId ?? 0)] ?? fonts[0],
      fill: fills[Number(xf.attrs.fillId ?? 0)] ?? null,
      border: borders[Number(xf.attrs.borderId ?? 0)] ?? null,
      horizontal: a.horizontal ?? 'general',
      vertical: a.vertical ?? 'bottom',
      wrap: a.wrapText === '1' || a.wrapText === 'true',
      shrink: a.shrinkToFit === '1' || a.shrinkToFit === 'true',
      indent: Number(a.indent ?? 0),
      rotation: Number(a.textRotation ?? 0),
    };
  });
  if (!xfs.length) xfs.push({ format: 'General', font: fonts[0], fill: null, border: null, horizontal: 'general', vertical: 'bottom', wrap: false, indent: 0, rotation: 0 });
  // The Normal style's font sets the column widths' unit (the first cell style, as Excel keeps it).
  const normalXf = children(child(root, 'cellStyleXfs'), 'xf')[0];
  const normalFont = fonts[Number(normalXf?.attrs.fontId ?? 0)] ?? fonts[0];
  return { xfs, fonts, normalFont, dxfCount: children(child(root, 'dxfs'), 'dxf').length };
}

function mix(a, b, share) {
  const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(c(a, i) * share + c(b, i) * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}

// Shared strings: [{ text, runs? }], runs as [{ text, font }] for rich text.
function readStrings(root, styles, theme) {
  return children(root, 'si').map((si) => {
    const runs = children(si, 'r');
    if (!runs.length) return { text: plainText(si) };
    const parts = runs.map((r) => ({ text: plainText(r), font: child(r, 'rPr') ? readFont(renameRunProps(child(r, 'rPr')), theme) : null }));
    return { text: parts.map((p) => p.text).join(''), runs: parts };
  });
}

// A run's properties name their font `rFont` (a cell font's `name`).
function renameRunProps(rPr) {
  return { ...rPr, children: rPr.children.map((c) => (c.name === 'rFont' ? { ...c, name: 'name' } : c)) };
}

// A string item's text: its t elements (not its phonetic guides).
function plainText(el) {
  let out = '';
  for (const c of el.children ?? []) {
    if (c.name === 't') out += textOf(c);
    else if (c.name === 'r') out += plainText(c);
  }
  return out.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// "AB12" → { c: 28, r: 12 } (both from 1).
export function cellRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref ?? '');
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { c, r: Number(m[2]) };
}

// A range "A1:D20" (or a whole column "A:B", or a whole row "1:3") as { r1, c1, r2, c2 }.
function rangeOf(text) {
  const t = text.replace(/\$/g, '').split('!').pop().trim();
  const [a, b = a] = t.split(':');
  const colOnly = /^[A-Z]+$/i;
  const rowOnly = /^\d+$/;
  if (colOnly.test(a) && colOnly.test(b)) return { r1: 1, c1: cellRef(`${a}1`).c, r2: Infinity, c2: cellRef(`${b}1`).c };
  if (rowOnly.test(a) && rowOnly.test(b)) return { r1: Number(a), c1: 1, r2: Number(b), c2: Infinity };
  const p = cellRef(a);
  const q = cellRef(b);
  if (!p || !q) return null;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}

function readSheet(ws, { name, styles, strings, theme, report, pkg, part, printArea, printTitles }) {
  const fmt = child(ws, 'sheetFormatPr')?.attrs ?? {};
  const cols = children(child(ws, 'cols'), 'col').map((c) => ({
    min: Number(c.attrs.min),
    max: Number(c.attrs.max),
    width: c.attrs.width != null ? Number(c.attrs.width) : null,
    hidden: c.attrs.hidden === '1' || c.attrs.hidden === 'true',
    style: c.attrs.style != null ? Number(c.attrs.style) : null,
  }));
  const rows = new Map();
  const cells = new Map();
  let maxR = 0;
  let maxC = 0;
  for (const row of children(child(ws, 'sheetData'), 'row')) {
    const r = Number(row.attrs.r ?? maxR + 1);
    rows.set(r, {
      height: row.attrs.ht != null ? Number(row.attrs.ht) : null,
      custom: row.attrs.customHeight === '1' || row.attrs.customHeight === 'true',
      hidden: row.attrs.hidden === '1' || row.attrs.hidden === 'true',
      style: row.attrs.customFormat === '1' && row.attrs.s != null ? Number(row.attrs.s) : null,
    });
    maxR = Math.max(maxR, r);
    let col = 0;
    for (const c of children(row, 'c')) {
      const ref = c.attrs.r ? cellRef(c.attrs.r) : { r, c: col + 1 };
      col = ref.c;
      const type = c.attrs.t ?? 'n';
      const raw = textOf(child(c, 'v'));
      const s = Number(c.attrs.s ?? 0);
      let value = null;
      let runs = null;
      if (type === 's') {
        const item = strings[Number(raw)];
        value = item?.text ?? '';
        runs = item?.runs ?? null;
      } else if (type === 'inlineStr') {
        const is = child(c, 'is');
        value = is ? plainText(is) : '';
      } else if (type === 'str') value = raw ?? '';
      else if (type === 'b') value = raw === '1' || raw === 'true';
      else if (type === 'e') value = { error: raw ?? '#N/A' };
      else if (type === 'd') value = raw ? isoToSerial(raw) : null;
      else if (raw != null && raw !== '') value = Number(raw);
      if (child(c, 'f') && raw == null) report?.note('Some formulas had no saved result, so their cells are empty.');
      cells.set(`${ref.r},${ref.c}`, { r: ref.r, c: ref.c, value, runs, style: s });
      maxC = Math.max(maxC, ref.c);
      maxR = Math.max(maxR, ref.r);
    }
  }
  const merges = children(child(ws, 'mergeCells'), 'mergeCell').map((m) => rangeOf(m.attrs.ref)).filter(Boolean);
  const margins = child(ws, 'pageMargins')?.attrs ?? {};
  const setup = child(ws, 'pageSetup')?.attrs ?? {};
  const options = child(ws, 'printOptions')?.attrs ?? {};
  const fit = child(child(ws, 'sheetPr'), 'pageSetUpPr')?.attrs.fitToPage;
  const hf = child(ws, 'headerFooter');
  const breaks = (el) => children(el, 'brk').map((b) => Number(b.attrs.id)).filter((n) => n > 0);
  const titles = { rows: null, cols: null };
  for (const part of (printTitles ?? '').split(',')) {
    const r = part && rangeOf(part);
    if (!r) continue;
    if (r.c2 === Infinity) titles.rows = [r.r1, r.r2];
    else if (r.r2 === Infinity) titles.cols = [r.c1, r.c2];
  }
  const hyperlinks = [];
  const sheetRels = pkg.rels(part);
  for (const h of children(child(ws, 'hyperlinks'), 'hyperlink')) {
    const target = h.attrs['r:id'] ? sheetRels.get(h.attrs['r:id']) : null;
    const range = rangeOf(h.attrs.ref ?? '');
    if (target?.external && range) hyperlinks.push({ ...range, url: target.target });
  }
  if (child(ws, 'drawing')) report?.note('Charts, pictures and shapes on sheets aren’t shown yet.');
  if (children(ws, 'conditionalFormatting').length) report?.note('Conditional formatting isn’t shown yet: cells show their own formatting.');
  const flag = (v, d = false) => (v == null ? d : v === '1' || v === 'true');
  return {
    name,
    defaultColWidth: fmt.defaultColWidth != null ? Number(fmt.defaultColWidth) : null,
    baseColWidth: fmt.baseColWidth != null ? Number(fmt.baseColWidth) : 8,
    defaultRowHeight: fmt.defaultRowHeight != null ? Number(fmt.defaultRowHeight) : null,
    customHeight: flag(fmt.customHeight),
    cols,
    rows,
    cells,
    merges,
    hyperlinks,
    extent: { r: maxR, c: maxC },
    printArea: printArea ? printArea.split(',').map(rangeOf).filter(Boolean)[0] ?? null : null,
    titles,
    page: {
      paper: Number(setup.paperSize ?? 1),
      width: setup.paperWidth,
      height: setup.paperHeight,
      landscape: setup.orientation === 'landscape',
      scale: Number(setup.scale ?? 100),
      fit: flag(fit),
      fitWidth: Number(setup.fitToWidth ?? 1),
      fitHeight: Number(setup.fitToHeight ?? 1),
      overThenDown: setup.pageOrder === 'overThenDown',
      firstPage: flag(setup.useFirstPageNumber) ? Number(setup.firstPageNumber ?? 1) : null,
      margins: {
        left: Number(margins.left ?? 0.7) * 72,
        right: Number(margins.right ?? 0.7) * 72,
        top: Number(margins.top ?? 0.75) * 72,
        bottom: Number(margins.bottom ?? 0.75) * 72,
        header: Number(margins.header ?? 0.3) * 72,
        footer: Number(margins.footer ?? 0.3) * 72,
      },
      gridLines: flag(options.gridLines),
      headings: flag(options.headings),
      centerH: flag(options.horizontalCentered),
      centerV: flag(options.verticalCentered),
      rowBreaks: breaks(child(ws, 'rowBreaks')),
      colBreaks: breaks(child(ws, 'colBreaks')),
    },
    headerFooter: hf
      ? {
          differentFirst: flag(hf.attrs.differentFirst),
          differentOddEven: flag(hf.attrs.differentOddEven),
          scaleWithDoc: flag(hf.attrs.scaleWithDoc, true),
          alignWithMargins: flag(hf.attrs.alignWithMargins, true),
          oddHeader: textOf(child(hf, 'oddHeader')),
          oddFooter: textOf(child(hf, 'oddFooter')),
          evenHeader: textOf(child(hf, 'evenHeader')),
          evenFooter: textOf(child(hf, 'evenFooter')),
          firstHeader: textOf(child(hf, 'firstHeader')),
          firstFooter: textOf(child(hf, 'firstFooter')),
        }
      : null,
    styles,
    theme,
  };
}

// An ISO date (a cell of type d) as a serial number.
function isoToSerial(iso) {
  const t = Date.parse(iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(t)) return null;
  return (t - Date.UTC(1899, 11, 30)) / 86400000;
}

// --- Measuring -----------------------------------------------------------------------------------

// Paper sizes (points) by Excel's numbers.
const PAPER = {
  1: [612, 792], 2: [612, 792], 3: [792, 1224], 4: [1224, 792], 5: [612, 1008], 6: [396, 612], 7: [522, 756],
  8: [841.89, 1190.55], 9: [595.28, 841.89], 10: [595.28, 841.89], 11: [419.53, 595.28], 12: [728.5, 1031.81], 13: [515.91, 728.5],
  14: [612, 936], 15: [609.45, 779.53], 17: [792, 1224], 18: [612, 792], 19: [279, 639], 20: [297, 684], 34: [498.9, 708.66],
  25: [1224, 1584], 26: [1584, 2448], 66: [1190.55, 1683.78], 70: [297.64, 419.53],
};

function sizeOf(page) {
  let [w, h] = PAPER[page.paper] ?? PAPER[1];
  const parse = (v) => {
    const m = /^([\d.]+)(mm|cm|in|pt|pc|pi)?$/.exec(v ?? '');
    if (!m) return null;
    return Number(m[1]) * ({ mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 }[m[2] ?? 'mm']);
  };
  if (page.width && page.height) [w, h] = [parse(page.width) ?? w, parse(page.height) ?? h];
  return page.landscape ? { width: Math.max(w, h), height: Math.min(w, h) } : { width: Math.min(w, h), height: Math.max(w, h) };
}

// Excel for Mac lays a sheet out on a grid of 72 to the inch, so its pixel is a point (Windows
// Excel's is three quarters of one): column widths from the widest digit at that size, each glyph's
// advance a whole pixel, every position rounded to one. (Measured from Excel for Mac's own PDFs.)

// The widest digit of a font at its size, in whole pixels: Excel's unit for column widths.
function maxDigitWidth(font) {
  const found = fontFor({ family: font.family, bold: font.bold, italic: font.italic });
  if (!found) return 6;
  let widest = 0;
  for (let d = 0; d <= 9; d++) widest = Math.max(widest, found.font.advance(found.font.glyph(48 + d)));
  return Math.round((widest / found.font.unitsPerEm) * font.size);
}

// A font's line (its ascent and descent) at its size, at `dpi`.
function fontLine(font, dpi = 72) {
  const found = fontFor({ family: font.family, bold: font.bold, italic: font.italic });
  if (!found) return (font.size * 1.22 * dpi) / 72;
  const m = lineMetrics(found.font, (font.size * dpi) / 72);
  return m.ascent + m.descent;
}

// The height Windows Excel gives a row for a font (points): its line in whole pixels, plus two.
const windowsRowHeight = (font) => (Math.round(fontLine(font, 96)) + 2) * 0.75;
// A line of text on Excel for Mac's grid: the font's line, in whole pixels.
const macLine = (font) => Math.ceil(fontLine(font) - 1e-9);

function measureSheet(sheet) {
  const normal = sheet.styles.normalFont;
  const mdw = maxDigitWidth(normal);
  const colPx = (w) => Math.trunc(((256 * w + Math.trunc(128 / mdw)) / 256) * mdw);
  const defaultPx = sheet.defaultColWidth != null ? colPx(sheet.defaultColWidth) : sheet.baseColWidth * mdw + 5;
  const colInfo = (c) => sheet.cols.find((x) => c >= x.min && c <= x.max);
  const widths = new Map();
  const colWidth = (c) => {
    if (!widths.has(c)) {
      const info = colInfo(c);
      widths.set(c, info?.hidden ? 0 : info?.width != null ? colPx(info.width) : defaultPx);
    }
    return widths.get(c);
  };
  // Row heights are kept in points as Windows Excel sizes them; Excel for Mac scales them by its
  // own default row against Windows' (14 to 15 for Calibri 11), to whole pixels.
  const ratio = macLine(normal) / windowsRowHeight(normal);
  const toGrid = (pt) => Math.floor(pt * ratio + 1e-6);
  const defaultRow = sheet.defaultRowHeight != null ? toGrid(sheet.defaultRowHeight) : macLine(normal);
  const heights = new Map();
  const rowHeight = (r) => {
    if (heights.has(r)) return heights.get(r);
    const row = sheet.rows.get(r);
    let h;
    if (row?.hidden) h = 0;
    else if (row?.height != null) h = toGrid(row.height);
    else {
      // A row Excel didn't size: as tall as its tallest font (scaled as above), and its wrapped
      // text.
      h = defaultRow;
      if (!sheet.customHeight) {
        for (const cell of cellsInRow(sheet, r)) {
          const xf = sheet.styles.xfs[cell.style] ?? sheet.styles.xfs[0];
          if (cell.value == null || cell.value === '') continue;
          const fonts = cell.runs ? cell.runs.map((x) => x.font ?? xf.font) : [xf.font];
          let need = Math.max(...fonts.map((f) => toGrid(windowsRowHeight(f))));
          if (xf.wrap && typeof cell.value === 'string') {
            const lines = wrapText(cell, xf, colWidth(cell.c) - PAD_LEFT - PAD_RIGHT);
            need = Math.max(need, lines.length * macLine(xf.font) + 1);
          }
          h = Math.max(h, need);
        }
      }
    }
    heights.set(r, h);
    return h;
  };
  return { mdw, colWidth, rowHeight, colInfo };
}

const rowIndex = new WeakMap();
function cellsInRow(sheet, r) {
  if (!rowIndex.has(sheet)) {
    const map = new Map();
    for (const cell of sheet.cells.values()) {
      if (!map.has(cell.r)) map.set(cell.r, []);
      map.get(cell.r).push(cell);
    }
    for (const list of map.values()) list.sort((a, b) => a.c - b.c);
    rowIndex.set(sheet, map);
  }
  return rowIndex.get(sheet).get(r) ?? [];
}

// The room Excel for Mac leaves between a cell's edges and its text.
const PAD_LEFT = 3;
const PAD_RIGHT = 2;
// Positions on the grid: halves round up.
const snap = (v) => Math.floor(v + 0.5 + 1e-9);
// A run's glyphs with whole-pixel advances, as Excel for Mac sets them.
const shapeGrid = (text, style, opts) => shape(text, style, opts).map((g) => ({ ...g, advance: Math.round(g.advance) }));

// --- Printing ------------------------------------------------------------------------------------

function printWorkbook(book, { report, title }) {
  const pdf = createPdf({ title });
  let pages = 0;
  for (const sheet of book.sheets) {
    const printed = printSheet(pdf, sheet, book, { report });
    pages += printed;
  }
  if (!pages) {
    pdf.addPage({ width: 612, height: 792 });
    report?.note('The workbook has nothing to print.');
    pages = 1;
  }
  return { pdf: pdf.finish(), pages };
}

// What a sheet prints: its print area, or the cells with something to show (values, fills,
// borders), from the first to the last.
function printRange(sheet) {
  if (sheet.printArea) {
    const a = sheet.printArea;
    return { r1: a.r1, c1: a.c1, r2: Math.min(a.r2, sheet.extent.r || 1), c2: Math.min(a.c2, sheet.extent.c || 1) };
  }
  let r1 = Infinity;
  let c1 = Infinity;
  let r2 = 0;
  let c2 = 0;
  for (const cell of sheet.cells.values()) {
    const xf = sheet.styles.xfs[cell.style] ?? sheet.styles.xfs[0];
    const shows = (cell.value != null && cell.value !== '') || xf.fill || (xf.border && (xf.border.left || xf.border.right || xf.border.top || xf.border.bottom));
    if (!shows) continue;
    r1 = Math.min(r1, cell.r);
    c1 = Math.min(c1, cell.c);
    r2 = Math.max(r2, cell.r);
    c2 = Math.max(c2, cell.c);
  }
  for (const m of sheet.merges) {
    if (!sheet.cells.has(`${m.r1},${m.c1}`)) continue;
    r2 = Math.max(r2, m.r2);
    c2 = Math.max(c2, m.c2);
  }
  if (!r2) return null;
  // Excel prints from the sheet's first row and column (A1) to the last used.
  return { r1: 1, c1: 1, r2, c2 };
}

function printSheet(pdf, sheet, book, { report }) {
  const range = printRange(sheet);
  if (!range) return 0;
  const m = measureSheet(sheet);
  const { page } = sheet;
  const paper = sizeOf(page);
  const area = { width: paper.width - page.margins.left - page.margins.right, height: paper.height - page.margins.top - page.margins.bottom };
  const rows = [];
  for (let r = range.r1; r <= range.r2; r++) if (m.rowHeight(r) > 0) rows.push(r);
  const cols = [];
  for (let c = range.c1; c <= range.c2; c++) if (m.colWidth(c) > 0) cols.push(c);
  if (!rows.length || !cols.length) return 0;
  const titleRows = sheet.titles.rows ? rows.filter((r) => r >= sheet.titles.rows[0] && r <= sheet.titles.rows[1]) : [];
  const titleCols = sheet.titles.cols ? cols.filter((c) => c >= sheet.titles.cols[0] && c <= sheet.titles.cols[1]) : [];
  const headingW = page.headings ? headingWidth(range.r2, sheet) : 0;
  const headingH = page.headings ? macLine(sheet.styles.normalFont) : 0;
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

  // The scale: as set, or the largest that fits the sheet on so many pages across and down.
  let scale = Math.max(0.1, Math.min(4, page.scale / 100));
  if (page.fit) {
    const totalW = sum(cols, m.colWidth) + headingW;
    const totalH = sum(rows, m.rowHeight) + headingH;
    let s = 1;
    if (page.fitWidth > 0) s = Math.min(s, (area.width * page.fitWidth) / totalW);
    if (page.fitHeight > 0) s = Math.min(s, (area.height * page.fitHeight) / totalH);
    scale = Math.max(0.1, Math.floor(s * 100 + 1e-9) / 100);
    // Fitted across several pages, a page may not hold its share exactly: shrink until it does.
    for (let tries = 0; tries < 90; tries++) {
      const across = bands(cols, m.colWidth, area.width / scale - headingW - sum(titleCols, m.colWidth), [], sum(titleCols, m.colWidth)).length;
      const down = bands(rows, m.rowHeight, area.height / scale - headingH - sum(titleRows, m.rowHeight), [], sum(titleRows, m.rowHeight)).length;
      if ((page.fitWidth <= 0 || across <= page.fitWidth) && (page.fitHeight <= 0 || down <= page.fitHeight)) break;
      scale = Math.max(0.1, scale - 0.01);
    }
  }
  const usableW = area.width / scale - headingW;
  const usableH = area.height / scale - headingH;
  const colBands = bands(cols, m.colWidth, usableW - sum(titleCols, m.colWidth), page.fit ? [] : page.colBreaks, sum(titleCols, m.colWidth));
  const rowBands = bands(rows, m.rowHeight, usableH - sum(titleRows, m.rowHeight), page.fit ? [] : page.rowBreaks, sum(titleRows, m.rowHeight));
  const order = [];
  if (page.overThenDown) for (const rb of rowBands) for (const cb of colBands) order.push([rb, cb]);
  else for (const cb of colBands) for (const rb of rowBands) order.push([rb, cb]);

  const total = order.length;
  const first = page.firstPage ?? 1;
  order.forEach(([rb, cb], i) => {
    const out = pdf.addPage(paper);
    if (i === 0) pdf.bookmark(sheet.name, out, 0);
    const bandRows = [...titleRows.filter((r) => !rb.includes(r) && r < rb[0]), ...rb];
    const bandCols = [...titleCols.filter((c) => !cb.includes(c) && c < cb[0]), ...cb];
    const w = sum(bandCols, m.colWidth) + headingW;
    const h = sum(bandRows, m.rowHeight) + headingH;
    // Everything is laid out at the sheet's own size, from the page's top left, and scaled into
    // place; the grid starts at the margins rounded down.
    let x0 = page.margins.left / scale;
    let y0 = page.margins.top / scale;
    if (page.centerH) x0 += (area.width / scale - w) / 2;
    if (page.centerV) y0 += (area.height / scale - h) / 2;
    x0 = Math.floor(x0 + 1e-6);
    y0 = Math.floor(y0 + 1e-6);
    out.raw(`q ${n(scale)} 0 0 ${n(scale)} 0 ${n(paper.height - scale * paper.height)} cm`);
    drawCells(out, sheet, m, bandRows, bandCols, { x0, y0, headingW, headingH, book, report, links: { scale }, pageEdge: { left: x0, right: x0 + usableW + headingW } });
    out.raw('Q');
    drawHeaderFooter(out, sheet, paper, { number: first + i, total: first + total - 1, index: i, scale, book, report });
  });
  return total;
}

const n = (v) => (Math.round(v * 1000) / 1000).toString();

// Splits rows (or columns) into pages: as many as fit in `room`, breaking early at a manual
// break (after the row or column it names), at least one a page.
function bands(items, size, room, breaks, firstExtra = 0) {
  const out = [];
  let current = [];
  let used = 0;
  for (const it of items) {
    const s = size(it);
    // The first page's print titles are among its own rows, so it has their room as well.
    if (current.length && used + s > room + (out.length ? 0 : firstExtra) + 0.01) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(it);
    used += s;
    if (breaks.includes(it)) {
      out.push(current);
      current = [];
      used = 0;
    }
  }
  if (current.length) out.push(current);
  return out;
}

function headingWidth(lastRow, sheet) {
  const digits = String(lastRow).length;
  return Math.max(3, digits) * maxDigitWidth(sheet.styles.normalFont) + 8;
}

// --- Cells ---------------------------------------------------------------------------------------

function drawCells(out, sheet, m, bandRows, bandCols, { x0, y0, headingW, headingH, book, report, links, pageEdge }) {
  const xs = new Map();
  const ys = new Map();
  let x = x0 + headingW;
  for (const c of bandCols) {
    xs.set(c, x);
    x += m.colWidth(c);
  }
  const right = x;
  let y = y0 + headingH;
  for (const r of bandRows) {
    ys.set(r, y);
    y += m.rowHeight(r);
  }
  const bottom = y;
  const colAt = (c) => xs.get(c);
  const rowAt = (r) => ys.get(r);
  const xfOf = (cell) => sheet.styles.xfs[cell?.style ?? 0] ?? sheet.styles.xfs[0];
  const styleAt = (r, c) => {
    const cell = sheet.cells.get(`${r},${c}`);
    if (cell) return xfOf(cell);
    const row = sheet.rows.get(r);
    if (row?.style != null) return sheet.styles.xfs[row.style];
    const col = m.colInfo(c);
    if (col?.style != null) return sheet.styles.xfs[col.style];
    return null;
  };
  const mergeOf = (r, c) => sheet.merges.find((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2);
  // A merged area's box on this page (its parts that are here).
  const boxOf = (g) => {
    const rs = bandRows.filter((r) => r >= g.r1 && r <= g.r2);
    const cs = bandCols.filter((c) => c >= g.c1 && c <= g.c2);
    if (!rs.length || !cs.length) return null;
    return { x: colAt(cs[0]), y: rowAt(rs[0]), w: cs.reduce((s, c) => s + m.colWidth(c), 0), h: rs.reduce((s, r) => s + m.rowHeight(r), 0) };
  };

  // Fills.
  for (const r of bandRows) {
    for (const c of bandCols) {
      const xf = styleAt(r, c);
      if (!xf?.fill) continue;
      out.rect(colAt(c), rowAt(r), m.colWidth(c), m.rowHeight(r), { fill: xf.fill.color });
    }
  }
  // Gridlines (when the sheet prints them), not inside merged areas.
  if (sheet.page.gridLines) {
    // A pixel's line after each edge (below it, or to its right), as Excel for Mac draws them.
    for (const r of [...bandRows, null]) {
      const yy = r == null ? bottom : rowAt(r);
      out.rect(x0 + headingW, yy, right + 1 - x0 - headingW, 1, { fill: '#000000' });
    }
    for (const c of [...bandCols, null]) {
      const xx = c == null ? right : colAt(c);
      out.rect(xx, y0 + headingH, 1, bottom + 1 - y0 - headingH, { fill: '#000000' });
    }
  }
  if (sheet.page.headings) drawHeadings(out, sheet, m, bandRows, bandCols, { x0, y0, colAt, rowAt, headingW, headingH, right, bottom });

  // Text: each cell's value, running over empty neighbours (in its row, on this page) when it
  // doesn't fit and isn't wrapped.
  // The largest descent of the row's bottom-aligned, single-line text (the baseline they share).
  const rowDescents = new Map();
  const rowDescentOf = (r) => {
    if (!rowDescents.has(r)) {
      let d = 0;
      for (const cell of cellsInRow(sheet, r)) {
        if (cell.value == null || cell.value === '' || mergeOf(r, cell.c)) continue;
        const xf = xfOf(cell);
        if (xf.vertical !== 'bottom' || (xf.wrap && typeof cell.value === 'string')) continue;
        const fonts = cell.runs ? cell.runs.map((x) => x.font ?? xf.font) : [xf.font];
        for (const f of fonts) d = Math.max(d, descentOf(f));
      }
      rowDescents.set(r, d);
    }
    return rowDescents.get(r);
  };
  const isEmpty = (r, c) => {
    const cell = sheet.cells.get(`${r},${c}`);
    return (!cell || cell.value == null || cell.value === '') && !mergeOf(r, c);
  };
  for (const r of bandRows) {
    for (const c of bandCols) {
      const cell = sheet.cells.get(`${r},${c}`);
      const merge = mergeOf(r, c);
      if (merge && (merge.r1 !== r || merge.c1 !== c)) {
        // The merged area's text is drawn by its first cell, or here if that's on another page.
        const firstHere = bandRows.includes(merge.r1) && bandCols.includes(merge.c1);
        if (firstHere || r !== bandRows.find((rr) => rr >= merge.r1) || c !== bandCols.find((cc) => cc >= merge.c1)) continue;
      }
      const source = merge ? sheet.cells.get(`${merge.r1},${merge.c1}`) : cell;
      if (!source || source.value == null || source.value === '') continue;
      const xf = xfOf(source);
      const box = merge ? boxOf(merge) : { x: colAt(c), y: rowAt(r), w: m.colWidth(c), h: m.rowHeight(r) };
      if (!box) continue;
      // Room to run over: empty cells beside it on this page.
      let spillLeft = box.x;
      let spillRight = box.x + box.w;
      if (!merge && !xf.wrap && typeof source.value === 'string') {
        const at = bandCols.indexOf(c);
        let k = at + 1;
        for (; k < bandCols.length && isEmpty(r, bandCols[k]); k++) spillRight = colAt(bandCols[k]) + m.colWidth(bandCols[k]);
        // Past the last column printed (when the cells beyond are empty), on to the page's edge.
        if (k === bandCols.length && (bandCols[k - 1] ?? c) >= Math.max(...bandCols)) {
          let more = true;
          for (let cc = bandCols[bandCols.length - 1] + 1; cc <= sheet.extent.c; cc++) if (!isEmpty(r, cc)) more = false;
          if (more) spillRight = Math.max(spillRight, pageEdge.right);
        }
        k = at - 1;
        for (; k >= 0 && isEmpty(r, bandCols[k]); k--) spillLeft = colAt(bandCols[k]);
      }
      drawValue(out, source, xf, box, { spillLeft, spillRight, book, report, sheet, rowDescent: merge ? 0 : rowDescentOf(r) });
      const link = sheet.hyperlinks.find((h) => source.r >= h.r1 && source.r <= h.r2 && source.c >= h.c1 && source.c <= h.c2);
      if (link) out.link(links.scale * box.x, links.scale * box.y, links.scale * box.w, links.scale * box.h, link.url);
    }
  }

  // Borders, over everything: each cell's own, and its neighbours' facing ones.
  const edges = new Map();
  const edge = (key, line) => {
    const prev = edges.get(key);
    if (!prev || weight(line.border) >= weight(prev.border)) edges.set(key, line);
  };
  for (const r of bandRows) {
    for (const c of bandCols) {
      const xf = styleAt(r, c);
      const b = xf?.border;
      if (!b) continue;
      const g = mergeOf(r, c);
      const x1 = colAt(c);
      const y1 = rowAt(r);
      const x2 = x1 + m.colWidth(c);
      const y2 = y1 + m.rowHeight(r);
      // Inside a merged area, only its outer edges.
      if (b.top && (!g || r === g.r1)) edge(`h${r},${c}`, { border: b.top, x1, y1, x2, y2: y1 });
      if (b.bottom && (!g || r === g.r2)) edge(`h${r + 1},${c}`, { border: b.bottom, x1, y1: y2, x2, y2 });
      if (b.left && (!g || c === g.c1)) edge(`v${r},${c}`, { border: b.left, x1, y1, x2: x1, y2 });
      if (b.right && (!g || c === g.c2)) edge(`v${r},${c + 1}`, { border: b.right, x1: x2, y1, x2, y2 });
      if (b.diagonal?.style) {
        if (b.diagonal.down) drawBorder(out, b.diagonal, x1, y1, x2, y2);
        if (b.diagonal.up) drawBorder(out, b.diagonal, x1, y2, x2, y1);
      }
    }
  }
  for (const e of edges.values()) drawBorder(out, e.border, e.x1, e.y1, e.x2, e.y2);
}

const WEIGHT = { hair: 1, dotted: 2, dashDotDot: 3, dashDot: 4, dashed: 5, thin: 6, mediumDashDotDot: 7, slantDashDot: 8, mediumDashDot: 9, mediumDashed: 10, medium: 11, thick: 12, double: 13 };
const weight = (b) => WEIGHT[b.style] ?? 6;

// A border along a cell's edge, in Excel for Mac's whole pixels (each a point), as it draws them:
// thin, the pixel after the edge (below it, or to its right); medium two, and thick three, spread
// either side of it; double, the pixels before and after it; dashes and dots as runs of pixels.
function drawBorder(out, border, x1, y1, x2, y2) {
  const s = border.style;
  const color = border.color ?? '#000000';
  const horizontal = y1 === y2;
  const offsets = { medium: [-1, 0], mediumDashed: [-1, 0], mediumDashDot: [-1, 0], mediumDashDotDot: [-1, 0], slantDashDot: [-1, 0], thick: [-1, 0, 1], double: [-1, 1] }[s] ?? [0];
  const dash = { hair: [1, 1], dotted: [1, 1], dashed: [3, 1], dashDot: [8, 3, 3, 3], dashDotDot: [8, 3, 3, 3, 3, 3], mediumDashed: [9, 3], mediumDashDot: [9, 3, 3, 3], mediumDashDotDot: [9, 3, 3, 3, 3, 3], slantDashDot: [10, 2, 4, 2] }[s] ?? null;
  // Diagonals are lines.
  if (x1 !== x2 && y1 !== y2) {
    out.line(x1, y1, x2, y2, { stroke: color, lineWidth: offsets.length, dash });
    return;
  }
  const length = horizontal ? x2 - x1 + 1 : y2 - y1 + 1;
  for (const k of offsets) {
    const segments = [];
    if (!dash) segments.push([0, length]);
    else {
      let at = 0;
      for (let i = 0; at < length; i++) {
        const run = dash[i % dash.length];
        if (i % 2 === 0) segments.push([at, Math.min(run, length - at)]);
        at += run;
      }
    }
    for (const [from, len] of segments) {
      if (horizontal) out.rect(x1 + from, y1 + k, len, 1, { fill: color });
      else out.rect(x1 + k, y1 + from, 1, len, { fill: color });
    }
  }
}

function drawHeadings(out, sheet, m, bandRows, bandCols, { x0, y0, colAt, rowAt, headingW, headingH, right, bottom }) {
  const font = sheet.styles.normalFont;
  const style = { family: font.family, size: font.size };
  const line = { stroke: '#000000', lineWidth: 0.25 };
  for (const c of bandCols) {
    const label = columnName(c);
    drawText(out, shapeGrid(label, style), snap(colAt(c) + (m.colWidth(c) - widthOf(shapeGrid(label, style))) / 2), y0 + headingH - 3, '#000000');
    out.line(colAt(c), y0, colAt(c), y0 + headingH, line);
  }
  for (const r of bandRows) {
    const label = String(r);
    const glyphs = shapeGrid(label, style);
    drawText(out, glyphs, snap(x0 + (headingW - widthOf(glyphs)) / 2), rowAt(r) + m.rowHeight(r) - 3, '#000000');
    out.line(x0, rowAt(r), x0 + headingW, rowAt(r), line);
  }
  out.line(x0, y0 + headingH, right, y0 + headingH, line);
  out.line(x0 + headingW, y0, x0 + headingW, bottom, line);
  out.rect(x0, y0, right - x0, bottom - y0, { stroke: '#000000', lineWidth: 0.25 });
}

export function columnName(c) {
  let s = '';
  for (let k = c; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

const widthOf = (glyphs) => glyphs.reduce((s, g) => s + g.advance, 0);
const runStyle = (font) => ({ family: font.family, bold: font.bold, italic: font.italic, size: font.vertAlign ? font.size * 0.65 : font.size });
const lineHeightOf = (font) => macLine(font);

// A cell's text as runs of glyphs: rich text by its runs' fonts, else the cell's font.
function glyphsOf(text, cell, xf, { report, runs = null } = {}) {
  if (runs) {
    const out = [];
    for (const run of runs) {
      const font = run.font ?? xf.font;
      for (const g of shapeGrid(run.text, runStyle(font), { report })) out.push({ ...g, color: font.color, font0: font });
    }
    return out;
  }
  return shapeGrid(text, runStyle(xf.font), { report }).map((g) => ({ ...g, color: xf.font.color, font0: xf.font }));
}

// A wrapped cell's lines: its text broken at spaces (and at its own line breaks) to `width`.
function wrapText(cell, xf, width) {
  const lines = [];
  for (const para of String(cell.value).split(/\r?\n/)) {
    const glyphs = shapeGrid(para, runStyle(xf.font));
    let line = [];
    let used = 0;
    let lastSpace = -1;
    for (const g of glyphs) {
      line.push(g);
      used += g.advance;
      if (g.space) lastSpace = line.length - 1;
      if (used > width && line.length > 1 && !g.space) {
        const cut = lastSpace >= 0 ? lastSpace + 1 : line.length - 1;
        const carried = line.splice(cut);
        lines.push(line);
        line = carried;
        used = widthOf(line);
        lastSpace = line.findIndex((x) => x.space);
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawValue(out, cell, xf, box, { spillLeft, spillRight, book, report, sheet, rowDescent = 0 }) {
  const value = cell.value;
  const isNumber = typeof value === 'number';
  const isError = value && typeof value === 'object' && value.error;
  let horizontal = xf.horizontal;
  if (horizontal === 'general') horizontal = isNumber ? 'right' : typeof value === 'boolean' || isError ? 'center' : 'left';
  if (horizontal === 'fill' || horizontal === 'justify' || horizontal === 'distributed' || horizontal === 'centerContinuous') horizontal = horizontal === 'centerContinuous' ? 'center' : 'left';
  const inner = box.w - PAD_LEFT - PAD_RIGHT;
  const indent = xf.indent ? xf.indent * maxDigitWidth(sheet.styles.normalFont) : 0;
  if (xf.rotation) report?.note('Rotated text in cells is shown level.');

  // The text, by the number format.
  let parts;
  let color = xf.font.color;
  if (isError) parts = [{ text: value.error }];
  else {
    const fits = (text) => widthOf(shapeGrid(text, runStyle(xf.font))) <= inner - indent + 0.01;
    const shown = format(value, xf.format, { date1904: book.date1904, fits: isNumber ? fits : null });
    parts = shown.parts;
    if (shown.color) color = shown.color;
  }

  if (xf.wrap && !isNumber) {
    const lines = wrapText({ value: parts.map((p) => p.text).join('') }, xf, inner - indent);
    const lh = lineHeightOf(xf.font);
    const blockH = lines.length * lh;
    let top = box.y + box.h - blockH;
    if (xf.vertical === 'top') top = box.y;
    else if (xf.vertical === 'center' || xf.vertical === 'distributed' || xf.vertical === 'justify') top = box.y + (box.h - blockH) / 2;
    const ascent = ascentOf(xf.font);
    out.clipped(box.x, box.y, box.w, box.h, () => {
      lines.forEach((line, i) => {
        while (line.length && line[line.length - 1].space) line.pop();
        const w = widthOf(line);
        let lx = box.x + PAD_LEFT + (horizontal === 'left' ? indent : 0);
        // Wrapped lines keep a pixel more clear on the right than a single line does.
        if (horizontal === 'right') lx = box.x + box.w - PAD_RIGHT - 1 - indent - w;
        else if (horizontal === 'center') lx = (box.x + PAD_LEFT + box.x + box.w - PAD_RIGHT - 1 - w) / 2;
        drawText(out, line, snap(lx), snap(top + i * lh + 1 + ascent), color, xf.font);
      });
    });
    return;
  }

  // One line: hidden parts take room, a fill repeats to fill the cell.
  const pieces = [];
  for (const p of parts) {
    if (p.fill) {
      pieces.push({ fill: true, glyphs: shapeGrid(p.text, runStyle(xf.font)) });
      continue;
    }
    const glyphs = cell.runs && parts.length === 1 ? glyphsOf(p.text, cell, xf, { report, runs: cell.runs }) : glyphsOf(p.text, cell, xf, { report });
    pieces.push({ glyphs, hidden: p.hidden });
  }
  const textWidth = pieces.reduce((s, p) => s + (p.fill ? 0 : widthOf(p.glyphs)), 0);
  const fillPiece = pieces.find((p) => p.fill);
  if (isNumber && textWidth > inner - indent + 0.01 && xf.format && !/^general$/i.test(xf.format.trim())) {
    // A number too wide for its cell: #s across it.
    const hash = shapeGrid('#', runStyle(xf.font))[0];
    const count = Math.max(1, Math.floor(inner / (hash?.advance || 5)));
    pieces.length = 0;
    pieces.push({ glyphs: Array.from({ length: count }, () => ({ ...hash, color, font0: xf.font })) });
  }
  if (fillPiece) {
    const unit = widthOf(fillPiece.glyphs) || 1;
    const room = Math.max(0, inner - indent - textWidth);
    const times = Math.floor(room / unit);
    fillPiece.glyphs = Array.from({ length: times }, () => fillPiece.glyphs).flat();
  }
  const total = pieces.reduce((s, p) => s + widthOf(p.glyphs), 0);
  let x = box.x + PAD_LEFT + indent;
  if (horizontal === 'right') x = box.x + box.w - PAD_RIGHT - indent - total;
  else if (horizontal === 'center') x = (box.x + PAD_LEFT + box.x + box.w - PAD_RIGHT - total) / 2;
  x = snap(x);
  // Bottom-aligned text in a row shares one baseline: the row's largest descent above its foot.
  const descent = Math.max(descentOf(xf.font, pieces), rowDescent ?? 0);
  let baseline = box.y + box.h - descent;
  const ascent = ascentOf(xf.font);
  if (xf.vertical === 'top') baseline = box.y + 1 + ascent;
  else if (xf.vertical === 'center' || xf.vertical === 'distributed' || xf.vertical === 'justify') baseline = box.y + (box.h + ascent - descent) / 2;
  baseline = snap(baseline);
  // Text that doesn't fit runs over empty neighbours, and is cut off at the first that isn't.
  const clip = { x: Math.min(box.x, spillLeft), w: Math.max(box.x + box.w, spillRight) - Math.min(box.x, spillLeft) };
  out.clipped(clip.x, box.y, clip.w, box.h, () => {
    let px = x;
    for (const p of pieces) {
      if (!p.hidden) drawText(out, p.glyphs, px, baseline, color, xf.font);
      px += widthOf(p.glyphs);
    }
  });
}

function ascentOf(font) {
  const found = fontFor(runStyle(font));
  return found ? lineMetrics(found.font, font.size).ascent : font.size * 0.8;
}
// How far text stands above a cell's foot: its font's descent, in whole pixels.
function descentOf(font, pieces = []) {
  let d = 0;
  const found = fontFor(runStyle(font));
  if (found) d = lineMetrics(found.font, font.size).descent;
  for (const p of pieces) for (const g of p.glyphs) if (g.font0 && g.font0 !== font) {
    const f = fontFor(runStyle(g.font0));
    if (f) d = Math.max(d, lineMetrics(f.font, g.font0.size).descent);
  }
  return Math.round(d);
}

// Glyphs on a baseline, in runs of the same font and colour, with the font's underline and
// strikethrough.
function drawText(out, glyphs, x, baseline, color, font = null) {
  let start = 0;
  let px = x;
  const flush = (end) => {
    if (end <= start) return;
    const run = glyphs.slice(start, end);
    const g0 = run[0];
    const f = g0.font0 ?? font;
    const rise = f?.vertAlign === 'superscript' ? f.size * 0.33 : f?.vertAlign === 'subscript' ? -f.size * 0.14 : 0;
    const width = widthOf(run);
    out.glyphs(g0.font, g0.size, px, baseline - rise, run.map((g) => ({ gid: g.gid, text: g.text, advance: g.advance })), { color: g0.color ?? color });
    if (f?.underline && f.underline !== 'none') {
      const t = Math.max(0.5, f.size / 18);
      out.line(px, baseline + f.size * 0.12, px + width, baseline + f.size * 0.12, { stroke: g0.color ?? color, lineWidth: t });
      if (f.underline === 'double' || f.underline === 'doubleAccounting') out.line(px, baseline + f.size * 0.12 + 2 * t, px + width, baseline + f.size * 0.12 + 2 * t, { stroke: g0.color ?? color, lineWidth: t });
    }
    if (f?.strike) out.line(px, baseline - f.size * 0.28, px + width, baseline - f.size * 0.28, { stroke: g0.color ?? color, lineWidth: Math.max(0.5, f.size / 18) });
    px += width;
    start = end;
  };
  for (let i = 1; i <= glyphs.length; i++) {
    const a = glyphs[i - 1];
    const b = glyphs[i];
    if (!b || b.font !== a.font || b.size !== a.size || b.color !== a.color || b.font0 !== a.font0) flush(i);
  }
}

// --- Headers and footers --------------------------------------------------------------------------

// &L, &C and &R sections, with &P (page), &N (pages), &D, &T, &F, &A (sheet), &"font,style",
// &nn (size), &B, &I, &U, &S, &&.
function drawHeaderFooter(out, sheet, paper, { number, total, index, scale, book, report }) {
  const hf = sheet.headerFooter;
  if (!hf) return;
  const firstPage = index === 0 && hf.differentFirst;
  const even = hf.differentOddEven && number % 2 === 0;
  const header = firstPage ? hf.firstHeader : even ? hf.evenHeader : hf.oddHeader;
  const footer = firstPage ? hf.firstFooter : even ? hf.evenFooter : hf.oddFooter;
  const k = hf.scaleWithDoc ? scale : 1;
  const left = hf.alignWithMargins ? sheet.page.margins.left : 0.7 * 72;
  const right = paper.width - (hf.alignWithMargins ? sheet.page.margins.right : 0.7 * 72);
  const base = sheet.styles.normalFont;
  const fields = { P: String(number), N: String(total), A: sheet.name, F: '', Z: '', D: today(), T: now() };
  for (const [text, place] of [[header, 'header'], [footer, 'footer']]) {
    if (!text) continue;
    for (const [align, runs] of Object.entries(hfSections(text, base, fields))) {
      const lines = splitLines(runs);
      // Each line as tall as its biggest font's line on the grid; a header from its margin down, a
      // footer from its margin up.
      const heights = lines.map((line) => Math.max(...line.map((r) => macLine({ ...r, size: (r.size || base.size) * k }))));
      const blockH = heights.reduce((a, b) => a + b, 0);
      let top = place === 'header' ? sheet.page.margins.header : paper.height - sheet.page.margins.footer - blockH;
      lines.forEach((line, li) => {
        const glyphs = line.flatMap((r) => shapeGrid(r.text, { family: r.family, bold: r.bold, italic: r.italic, size: r.size * k }, { report }).map((g) => ({ ...g, color: r.color, font0: { ...r, size: r.size * k } })));
        const w = widthOf(glyphs);
        const x = align === 'L' ? Math.ceil(left) : align === 'R' ? snap(right - w) : Math.floor((left + right - w) / 2);
        const ascent = Math.max(...line.map((r) => ascentOf({ ...r, size: r.size * k })), 0);
        drawText(out, glyphs, x, snap(top + heights[li] - 1 - (heights[li] - ascent) + (place === 'header' ? 1 : 0)), '#000000');
        top += heights[li];
      });
    }
  }
}

function today() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function now() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hfSections(text, base, fields) {
  const sections = { L: [], C: [], R: [] };
  let where = 'C';
  let font = { family: base.family, size: base.size, bold: false, italic: false, underline: null, strike: false, color: '#000000' };
  let i = 0;
  const push = (t) => {
    if (!t) return;
    sections[where].push({ ...font, text: t });
  };
  while (i < text.length) {
    const c = text[i];
    if (c !== '&') {
      let j = i;
      while (j < text.length && text[j] !== '&') j++;
      push(text.slice(i, j));
      i = j;
      continue;
    }
    const next = text[i + 1];
    if (next === '&') {
      push('&');
      i += 2;
    } else if (next === 'L' || next === 'C' || next === 'R') {
      where = next;
      i += 2;
    } else if (next === '"') {
      const end = text.indexOf('"', i + 2);
      const [family, style = ''] = text.slice(i + 2, end).split(',');
      if (family && family !== '-') font = { ...font, family };
      font = { ...font, bold: /bold/i.test(style), italic: /italic|oblique/i.test(style) };
      i = end + 1;
    } else if (/\d/.test(next)) {
      const m = /^\d+/.exec(text.slice(i + 1))[0];
      font = { ...font, size: Number(m) };
      i += 1 + m.length;
    } else if (next === 'K') {
      font = { ...font, color: `#${text.slice(i + 2, i + 8)}` };
      i += 8;
    } else {
      if (next === 'B') font = { ...font, bold: !font.bold };
      else if (next === 'I') font = { ...font, italic: !font.italic };
      else if (next === 'U' || next === 'E') font = { ...font, underline: font.underline ? null : 'single' };
      else if (next === 'S') font = { ...font, strike: !font.strike };
      else if (fields[next] != null) push(fields[next]);
      i += 2;
    }
  }
  for (const k of Object.keys(sections)) if (!sections[k].length) delete sections[k];
  return sections;
}

function splitLines(runs) {
  const lines = [[]];
  for (const r of runs) {
    const parts = r.text.split(/\r?\n/);
    parts.forEach((p, k) => {
      if (k > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ ...r, text: p });
    });
  }
  return lines.map((l) => (l.length ? l : [{ text: '', size: 0 }]));
}
