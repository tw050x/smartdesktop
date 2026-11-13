// Word documents (.docx, Office Open XML) into the flow engine's model (lib/flow.js), as Word lays
// them out: styles with their inheritance and the document's defaults, the theme's fonts and
// colours, paragraph and character formatting, numbered and bulleted lists, sections (page size,
// margins, columns, headers and footers), tables (from the column grid Word saves), pictures inline
// and floating, hyperlinks, fields (page numbers), footnotes. Tracked changes are shown accepted;
// comments aren't drawn. What isn't shown is reported.
//
// Units: Word keeps lengths in twentieths of a point (twips), font sizes in half points, border
// widths in eighths of a point, and drawings in EMUs (12700 to a point).
import { renderFlow } from '../lib/flow.js';
import { openPackage, readTheme, themeColor } from '../lib/office.js';
import { child, children, descendants, num, textOf } from '../lib/xml.js';

const TW = 1 / 20; // twips → points
const EMU = 1 / 12700; // EMUs → points

export function docxToPdf(bytes, { report, title } = {}) {
  const model = readDocx(bytes, { report });
  model.title = model.title ?? title;
  return renderFlow(model, { report });
}

export function readDocx(bytes, { report }) {
  const { zip, part, rels, main } = openPackage(bytes);
  const mainName = main('word/document.xml');
  const document = part(mainName);
  if (!document) throw new Error('The Word document is damaged: it has no main part.');
  const docRels = rels(mainName);
  const relTarget = (type) => [...docRels.values()].find((r) => r.type === type)?.target;
  const theme = readTheme(part(relTarget('theme') ?? 'word/theme/theme1.xml'));
  const settings = part(relTarget('settings') ?? 'word/settings.xml');
  const styles = readStyles(part(relTarget('styles') ?? 'word/styles.xml'), theme);
  const numbering = readNumbering(part(relTarget('numbering') ?? 'word/numbering.xml'), styles, theme);
  const defaultTab = (num(child(settings, 'w:defaultTabStop'), 'w:val', 720)) * TW;
  const evenAndOdd = Boolean(child(settings, 'w:evenAndOddHeaders'));
  const lang = styles.defaults.lang;
  // Word 2013 and later (compatibility mode 15) squeeze a justified line's spaces to fit a word more.
  const compat = [...descendants(settings ?? { children: [] }, 'w:compatSetting')].find((c) => c.attrs['w:name'] === 'compatibilityMode');
  const shrinkSpaces = Number(compat?.attrs['w:val'] ?? 0) >= 15;

  const ctx = { zip, part, rels, styles, numbering, theme, report, shrinkSpaces, counters: new Map(), state: { trackedChanges: false, footnoteOrder: new Map() } };

  // Footnotes: id → blocks.
  const footnotes = {};
  const footnotesName = relTarget('footnotes');
  if (footnotesName && zip.has(footnotesName)) {
    const fnRels = rels(footnotesName);
    for (const note of children(part(footnotesName), 'w:footnote')) {
      const type = note.attrs['w:type'];
      if (type === 'separator' || type === 'continuationSeparator') continue;
      footnotes[note.attrs['w:id']] = readBlocks(note, { ...ctx, partRels: fnRels, footnoteId: note.attrs['w:id'] });
    }
  }
  if (relTarget('comments') && zip.has(relTarget('comments')) && children(part(relTarget('comments')), 'w:comment').length) {
    report.note('The document’s comments aren’t shown in the PDF.');
  }

  // The body: blocks, with each section ending at a paragraph that carries its sectPr, the last
  // section's at the body's end.
  const body = child(document, 'w:body');
  const sections = [];
  let blocks = [];
  let previousHeaders = { headers: {}, footers: {} };
  const bodyCtx = { ...ctx, partRels: docRels };
  const endSection = (sectPr) => {
    const section = readSection(sectPr, { ...bodyCtx, previous: previousHeaders });
    section.blocks = blocks;
    previousHeaders = { headers: section.headers, footers: section.footers };
    sections.push(section);
    blocks = [];
  };
  for (const node of children(body)) {
    if (node.name === 'w:sectPr') continue;
    const read = readBlock(node, bodyCtx);
    blocks.push(...read);
    const sectPr = node.name === 'w:p' ? child(child(node, 'w:pPr'), 'w:sectPr') : null;
    if (sectPr) endSection(sectPr);
  }
  endSection(child(body, 'w:sectPr'));
  if (ctx.state.trackedChanges) report.note('The document has tracked changes: the PDF shows them accepted.');
  return { sections, footnotes, defaultTab, evenAndOdd, lang };
}

// The main document part, from the package's relationships (word/document.xml, usually).
// --- Styles --------------------------------------------------------------------------------------

function readStyles(root, theme) {
  const byId = new Map();
  const defaults = { run: {}, para: {}, lang: null };
  const docDefaults = child(root, 'w:docDefaults');
  defaults.runEl = child(child(docDefaults, 'w:rPrDefault'), 'w:rPr');
  defaults.paraEl = child(child(docDefaults, 'w:pPrDefault'), 'w:pPr');
  defaults.lang = child(defaults.runEl, 'w:lang')?.attrs['w:val'] ?? null;
  let defaultPara = null;
  let defaultChar = null;
  let defaultTable = null;
  for (const s of children(root, 'w:style')) {
    const id = s.attrs['w:styleId'];
    const style = {
      id,
      type: s.attrs['w:type'],
      basedOn: child(s, 'w:basedOn')?.attrs['w:val'] ?? null,
      name: child(s, 'w:name')?.attrs['w:val'] ?? id,
      pPr: child(s, 'w:pPr'),
      rPr: child(s, 'w:rPr'),
      tblPr: child(s, 'w:tblPr'),
      tcPr: child(s, 'w:tcPr'),
      trPr: child(s, 'w:trPr'),
      conditional: Object.fromEntries(children(s, 'w:tblStylePr').map((c) => [c.attrs['w:type'], { pPr: child(c, 'w:pPr'), rPr: child(c, 'w:rPr'), tcPr: child(c, 'w:tcPr'), tblPr: child(c, 'w:tblPr') }])),
      link: child(s, 'w:link')?.attrs['w:val'] ?? null,
    };
    byId.set(id, style);
    if (s.attrs['w:default'] === '1' || s.attrs['w:default'] === 'true') {
      if (style.type === 'paragraph') defaultPara = id;
      if (style.type === 'character') defaultChar = id;
      if (style.type === 'table') defaultTable = id;
    }
  }
  // A style and every style it's based on, base first.
  const chain = (id) => {
    const out = [];
    const seen = new Set();
    let at = byId.get(id);
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      out.unshift(at);
      at = at.basedOn ? byId.get(at.basedOn) : null;
    }
    return out;
  };
  return { byId, chain, defaults, defaultPara, defaultChar, defaultTable, theme };
}

// Run properties: the rPr elements in order of precedence (lowest first) merged into a look.
function runProps(elements, theme, base = {}) {
  const style = { ...base };
  for (const rPr of elements) {
    if (!rPr) continue;
    for (const p of children(rPr)) {
      const val = p.attrs['w:val'];
      const on = val === undefined || !['0', 'false', 'off', 'none'].includes(val);
      switch (p.name) {
        case 'w:rFonts': {
          const themed = p.attrs['w:asciiTheme'] ?? p.attrs['w:hAnsiTheme'];
          if (themed) style.family = themed.startsWith('major') ? theme.major : theme.minor;
          else if (p.attrs['w:ascii'] || p.attrs['w:hAnsi']) style.family = p.attrs['w:ascii'] ?? p.attrs['w:hAnsi'];
          if (p.attrs['w:eastAsia']) style.eastAsia = p.attrs['w:eastAsia'];
          break;
        }
        case 'w:b': style.bold = on; break;
        case 'w:i': style.italic = on; break;
        case 'w:caps': style.caps = on; break;
        case 'w:smallCaps': style.smallCaps = on; break;
        case 'w:strike': style.strike = on; break;
        case 'w:dstrike': style.dstrike = on; break;
        case 'w:vanish': style.hidden = on; break;
        case 'w:webHidden': break;
        case 'w:sz': style.size = Number(val) / 2; break;
        case 'w:color': {
          const themed = p.attrs['w:themeColor'] && themeColor(theme, p.attrs['w:themeColor'], p.attrs['w:themeTint'], p.attrs['w:themeShade']);
          style.color = themed ?? (val && val !== 'auto' ? `#${val}` : null);
          break;
        }
        case 'w:u': style.underline = val ?? 'single'; style.underlineColor = p.attrs['w:color'] && p.attrs['w:color'] !== 'auto' ? `#${p.attrs['w:color']}` : null; break;
        case 'w:highlight': style.highlight = HIGHLIGHTS[val] ?? null; break;
        case 'w:shd': style.shading = shading(p, theme); break;
        case 'w:vertAlign': style.vertAlign = val === 'baseline' ? null : val; break;
        case 'w:spacing': style.spacing = Number(val) * TW; break;
        case 'w:w': style.scale = Number(val) / 100; break;
        case 'w:kern': style.kernFrom = Number(val) / 2; break;
        case 'w:position': style.position = Number(val) / 2; break;
        case 'w:lang': break;
        default: break;
      }
    }
  }
  // Kerning applies at sizes from w:kern up (0 or missing: none), as Word does.
  style.kern = style.kernFrom != null && style.kernFrom > 0 && (style.size ?? 11) >= style.kernFrom;
  return style;
}

const HIGHLIGHTS = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' };

function shading(el, theme) {
  if (!el) return null;
  const fill = el.attrs['w:fill'];
  const themed = el.attrs['w:themeFill'] && themeColor(theme, el.attrs['w:themeFill'], el.attrs['w:themeFillTint'], el.attrs['w:themeFillShade']);
  if (themed) return themed;
  if (fill && fill !== 'auto') return `#${fill}`;
  return null;
}

function border(el, theme) {
  if (!el) return undefined;
  const style = el.attrs['w:val'];
  if (!style || style === 'nil' || style === 'none') return null;
  const color = el.attrs['w:themeColor'] ? themeColor(theme, el.attrs['w:themeColor'], el.attrs['w:themeTint'], el.attrs['w:themeShade']) : el.attrs['w:color'] && el.attrs['w:color'] !== 'auto' ? `#${el.attrs['w:color']}` : '#000000';
  return { style: style === 'single' ? 'solid' : style, width: num(el, 'w:sz', 4) / 8, color, space: num(el, 'w:space', 0) };
}

// Paragraph properties merged in precedence order (lowest first).
function paraProps(elements, theme) {
  const p = { indent: {}, spacing: {}, tabs: [], borders: null, numPr: null };
  for (const pPr of elements) {
    if (!pPr) continue;
    for (const e of children(pPr)) {
      const val = e.attrs['w:val'];
      const on = val === undefined || !['0', 'false', 'off'].includes(val);
      switch (e.name) {
        case 'w:jc': p.align = { start: 'left', end: 'right', left: 'left', right: 'right', center: 'center', both: 'both', distribute: 'distribute', lowKashida: 'both', mediumKashida: 'both', highKashida: 'both', thaiDistribute: 'distribute' }[val] ?? 'left'; break;
        case 'w:ind': {
          const leftVal = e.attrs['w:left'] ?? e.attrs['w:start'];
          const rightVal = e.attrs['w:right'] ?? e.attrs['w:end'];
          if (leftVal != null) p.indent.left = Number(leftVal) * TW;
          if (rightVal != null) p.indent.right = Number(rightVal) * TW;
          if (e.attrs['w:hanging'] != null) p.indent.firstLine = -Number(e.attrs['w:hanging']) * TW;
          else if (e.attrs['w:firstLine'] != null) p.indent.firstLine = Number(e.attrs['w:firstLine']) * TW;
          break;
        }
        case 'w:spacing': {
          if (e.attrs['w:before'] != null) p.spacing.before = Number(e.attrs['w:before']) * TW;
          if (e.attrs['w:after'] != null) p.spacing.after = Number(e.attrs['w:after']) * TW;
          if (e.attrs['w:beforeAutospacing'] === '1') p.spacing.before = 14;
          if (e.attrs['w:afterAutospacing'] === '1') p.spacing.after = 14;
          if (e.attrs['w:line'] != null) {
            const rule = e.attrs['w:lineRule'] ?? 'auto';
            p.spacing.rule = rule;
            p.spacing.line = rule === 'auto' ? Number(e.attrs['w:line']) / 240 : Number(e.attrs['w:line']) * TW;
          }
          break;
        }
        case 'w:keepNext': p.keepNext = on; break;
        case 'w:keepLines': p.keepLines = on; break;
        case 'w:widowControl': p.widowControl = on; break;
        case 'w:pageBreakBefore': p.pageBreakBefore = on; break;
        case 'w:contextualSpacing': p.spacing.contextual = on; break;
        case 'w:outlineLvl': p.outline = Number(val) + 1; break;
        case 'w:numPr': {
          const ilvl = child(e, 'w:ilvl')?.attrs['w:val'];
          const numId = child(e, 'w:numId')?.attrs['w:val'];
          p.numPr = { ...(p.numPr ?? {}), ...(ilvl != null && { ilvl: Number(ilvl) }), ...(numId != null && { numId }) };
          break;
        }
        case 'w:tabs': {
          for (const t of children(e, 'w:tab')) {
            const pos = Number(t.attrs['w:pos']) * TW;
            const align = { start: 'left', end: 'right', left: 'left', right: 'right', center: 'center', decimal: 'decimal', bar: 'bar', num: 'left', clear: 'clear' }[t.attrs['w:val']] ?? 'left';
            p.tabs = p.tabs.filter((x) => Math.abs(x.pos - pos) > 0.5);
            if (align !== 'clear') p.tabs.push({ pos, align, leader: t.attrs['w:leader'] ?? 'none' });
          }
          break;
        }
        case 'w:pBdr': {
          p.borders = { ...(p.borders ?? {}) };
          for (const side of ['top', 'bottom', 'left', 'right', 'between']) {
            const b = border(child(e, `w:${side}`), theme);
            if (b !== undefined) p.borders[side] = b;
          }
          break;
        }
        case 'w:shd': p.shading = shading(e, theme); break;
        default: break;
      }
    }
  }
  return p;
}

// --- Numbering -----------------------------------------------------------------------------------

function readNumbering(root, styles, theme) {
  const abstracts = new Map();
  for (const a of children(root, 'w:abstractNum')) {
    const levels = new Map();
    for (const l of children(a, 'w:lvl')) {
      levels.set(Number(l.attrs['w:ilvl']), {
        start: num(child(l, 'w:start'), 'w:val', 1),
        format: child(l, 'w:numFmt')?.attrs['w:val'] ?? 'decimal',
        text: child(l, 'w:lvlText')?.attrs['w:val'] ?? '',
        suffix: child(l, 'w:suff')?.attrs['w:val'] ?? 'tab',
        align: child(l, 'w:lvlJc')?.attrs['w:val'] ?? 'left',
        restart: num(child(l, 'w:lvlRestart'), 'w:val', null),
        legal: Boolean(child(l, 'w:isLgl')),
        pPr: child(l, 'w:pPr'),
        rPr: child(l, 'w:rPr'),
      });
    }
    abstracts.set(a.attrs['w:abstractNumId'], { levels, styleLink: child(a, 'w:numStyleLink')?.attrs['w:val'] });
  }
  const nums = new Map();
  for (const n of children(root, 'w:num')) {
    const overrides = new Map();
    for (const o of children(n, 'w:lvlOverride')) {
      overrides.set(Number(o.attrs['w:ilvl']), { start: num(child(o, 'w:startOverride'), 'w:val', null), lvl: child(o, 'w:lvl') });
    }
    nums.set(n.attrs['w:numId'], { abstract: child(n, 'w:abstractNumId')?.attrs['w:val'], overrides });
  }
  return { abstracts, nums, theme, styles };
}

function levelOf(numbering, numId, ilvl) {
  const n = numbering.nums.get(numId);
  if (!n) return null;
  let abstract = numbering.abstracts.get(n.abstract);
  if (abstract?.styleLink) {
    // A list style: its own numbering is in the style's numPr.
    const style = numbering.styles.byId.get(abstract.styleLink);
    const linked = child(child(style?.pPr, 'w:numPr'), 'w:numId')?.attrs['w:val'];
    const ln = linked && numbering.nums.get(linked);
    if (ln) abstract = numbering.abstracts.get(ln.abstract) ?? abstract;
  }
  const level = abstract?.levels.get(ilvl);
  const override = n.overrides.get(ilvl);
  if (!level) return null;
  return { ...level, start: override?.start ?? level.start, overridden: override?.start != null };
}

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
function formatNumber(n, format) {
  switch (format) {
    case 'decimal': return String(n);
    case 'decimalZero': return n < 10 ? `0${n}` : String(n);
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'ordinal': return `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) ? 0 : Math.min(n % 10, 4) % 4] ?? 'th'}`;
    case 'none': return '';
    default: return String(n);
  }
}
const letters = (n) => {
  const ch = String.fromCharCode(97 + ((n - 1) % 26));
  return ch.repeat(Math.floor((n - 1) / 26) + 1);
};
const roman = (n) => {
  let out = '';
  for (const [v, s] of ROMAN) while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
};

// The label for a numbered paragraph, its counters advanced: "2.", "a)", "•".
function numberLabel(ctx, numId, ilvl) {
  const level = levelOf(ctx.numbering, numId, ilvl);
  if (!level) return null;
  const abstract = ctx.numbering.nums.get(numId)?.abstract;
  const key = abstract ?? numId;
  if (!ctx.counters.has(key)) ctx.counters.set(key, { values: [], numId, started: new Set() });
  const counter = ctx.counters.get(key);
  // A different num instance with a start override restarts the list.
  if (counter.numId !== numId) {
    counter.numId = numId;
    if (level.overridden) counter.values = [];
  }
  if (counter.values[ilvl] == null) counter.values[ilvl] = level.start - 1;
  counter.values[ilvl] += 1;
  // Deeper levels start again.
  for (let d = ilvl + 1; d < 9; d++) counter.values[d] = null;
  for (let d = 0; d < ilvl; d++) if (counter.values[d] == null) {
    const l = levelOf(ctx.numbering, numId, d);
    counter.values[d] = l?.start ?? 1;
  }
  let text = level.text;
  if (level.format === 'bullet') text = level.text;
  else {
    text = text.replace(/%(\d)/g, (_, d) => {
      const lv = Number(d) - 1;
      const l = levelOf(ctx.numbering, numId, lv) ?? level;
      return formatNumber(counter.values[lv] ?? l.start, level.legal && lv !== ilvl ? 'decimal' : l.format);
    });
  }
  return { text, level };
}

// --- Sections ------------------------------------------------------------------------------------

function readSection(sectPr, ctx) {
  const pgSz = child(sectPr, 'w:pgSz');
  const pgMar = child(sectPr, 'w:pgMar');
  const cols = child(sectPr, 'w:cols');
  const width = num(pgSz, 'w:w', 11906) * TW;
  const height = num(pgSz, 'w:h', 16838) * TW;
  const section = {
    page: { width, height },
    margin: {
      top: Math.abs(num(pgMar, 'w:top', 1440)) * TW,
      right: num(pgMar, 'w:right', 1440) * TW,
      bottom: Math.abs(num(pgMar, 'w:bottom', 1440)) * TW,
      left: num(pgMar, 'w:left', 1440) * TW + num(pgMar, 'w:gutter', 0) * TW,
      header: num(pgMar, 'w:header', 708) * TW,
      footer: num(pgMar, 'w:footer', 708) * TW,
    },
    columns: { count: num(cols, 'w:num', 1), space: num(cols, 'w:space', 720) * TW, separator: cols?.attrs['w:sep'] === '1' || cols?.attrs['w:sep'] === 'true' },
    type: child(sectPr, 'w:type')?.attrs['w:val'] ?? 'nextPage',
    titlePage: Boolean(child(sectPr, 'w:titlePg')) && child(sectPr, 'w:titlePg').attrs['w:val'] !== '0',
    pageStart: num(child(sectPr, 'w:pgNumType'), 'w:start', null),
    headers: { ...ctx.previous.headers },
    footers: { ...ctx.previous.footers },
  };
  for (const [tag, which] of [['w:headerReference', 'headers'], ['w:footerReference', 'footers']]) {
    for (const ref of children(sectPr, tag)) {
      const target = ctx.partRels.get(ref.attrs['r:id'])?.target;
      if (!target || !ctx.zip.has(target)) continue;
      const root = ctx.part(target);
      section[which][ref.attrs['w:type'] ?? 'default'] = readBlocks(root, { ...ctx, partRels: ctx.rels(target), inHeader: true });
    }
  }
  return section;
}

// --- Blocks --------------------------------------------------------------------------------------

function readBlocks(container, ctx) {
  const out = [];
  for (const node of children(container)) out.push(...readBlock(node, ctx));
  return out;
}

function readBlock(node, ctx) {
  if (node.name === 'w:p') return [readParagraph(node, ctx)];
  if (node.name === 'w:tbl') return [readTable(node, ctx)];
  if (node.name === 'w:sdt') return readBlocks(child(node, 'w:sdtContent'), ctx);
  if (node.name === 'w:customXml' || node.name === 'w:ins' || node.name === 'w:moveTo') return readBlocks(node, ctx);
  if (node.name === 'w:del' || node.name === 'w:moveFrom') {
    ctx.state.trackedChanges = true;
    return [];
  }
  if (node.name === 'mc:AlternateContent') return readBlocks(child(node, 'mc:Choice') ?? child(node, 'mc:Fallback'), ctx);
  return [];
}

function readParagraph(p, ctx) {
  const { styles, theme } = ctx;
  const pPr = child(p, 'w:pPr');
  const styleId = child(pPr, 'w:pStyle')?.attrs['w:val'] ?? styles.defaultPara;
  const chain = styles.chain(styleId);
  // The paragraph's look: defaults, its table's style (in a table), its style chain, direct.
  const pElements = [styles.defaults.paraEl, ...(ctx.tablePara ?? []), ...chain.map((s) => s.pPr), pPr];
  let props = paraProps(pElements, theme);
  const runBase = runProps([styles.defaults.runEl, ...(ctx.tableRun ?? []), ...chain.map((s) => s.rPr)], theme, { family: theme.minor, size: 10 });

  // Numbering: from the paragraph or its style; its level's indent goes under the paragraph's own.
  let label = null;
  const numPr = props.numPr;
  if (numPr?.numId && numPr.numId !== '0') {
    const ilvl = numPr.ilvl ?? 0;
    const numbered = numberLabel(ctx, numPr.numId, ilvl);
    if (numbered) {
      const levelProps = paraProps([numbered.level.pPr], theme);
      // The level's indent and tabs, then the paragraph's style's and its own over them.
      props = paraProps([styles.defaults.paraEl, ...(ctx.tablePara ?? []), ...chain.map((s) => s.pPr).filter(Boolean), numbered.level.pPr, pPr].filter(Boolean), theme);
      if (levelProps.indent.left != null && !hasInd(pPr) && !chain.some((s) => hasInd(s.pPr))) props.indent = { ...props.indent, ...levelProps.indent };
      const markRun = runProps([styles.defaults.runEl, ...chain.map((s) => s.rPr), child(pPr, 'w:rPr'), numbered.level.rPr], theme, { family: theme.minor, size: 10 });
      markRun.underline = null;
      label = [{ type: 'text', text: numbered.text, style: markRun }];
      if (numbered.level.suffix === 'tab') label.push({ type: 'tab', style: markRun, label: true });
      else if (numbered.level.suffix === 'space') label.push({ type: 'text', text: ' ', style: markRun });
    }
  }

  // Laid out as Word does (see `word` in flow.js), and squeezed as Word 2013 and later do.
  props.word = true;
  if (ctx.shrinkSpaces) props.shrinkSpaces = true;
  const content = [];
  readRuns(p, { ...ctx, runBase, chain }, content);
  const mark = runProps([styles.defaults.runEl, ...(ctx.tableRun ?? []), ...chain.map((s) => s.rPr), child(pPr, 'w:rPr')], theme, { family: theme.minor, size: 10 });
  return { type: 'paragraph', props: { ...props, styleId }, content, mark, label };
}

const hasInd = (pPr) => Boolean(child(pPr, 'w:ind'));

// A paragraph's runs, hyperlinks, fields and the like, into inline items.
function readRuns(container, ctx, out, extra = {}) {
  for (const node of children(container)) {
    switch (node.name) {
      case 'w:r':
        readRun(node, ctx, out, extra);
        break;
      case 'w:hyperlink': {
        const rel = node.attrs['r:id'] && ctx.partRels?.get(node.attrs['r:id']);
        const link = rel?.external ? rel.target : null;
        readRuns(node, ctx, out, { ...extra, link });
        break;
      }
      case 'w:fldSimple': {
        const instr = (node.attrs['w:instr'] ?? '').trim().split(/\s+/)[0].toUpperCase();
        if (instr === 'PAGE' || instr === 'NUMPAGES') {
          const style = runStyleOf(child(node, 'w:r'), ctx, extra);
          out.push({ type: 'field', field: instr, style });
        } else readRuns(node, ctx, out, extra);
        break;
      }
      case 'w:ins':
      case 'w:moveTo':
      case 'w:smartTag':
      case 'w:customXml':
        readRuns(node, ctx, out, extra);
        break;
      case 'w:sdt':
        readRuns(child(node, 'w:sdtContent'), ctx, out, extra);
        break;
      case 'w:del':
      case 'w:moveFrom':
        ctx.state.trackedChanges = true;
        break;
      case 'mc:AlternateContent':
        readRuns(child(node, 'mc:Choice') ?? child(node, 'mc:Fallback'), ctx, out, extra);
        break;
      default:
        break;
    }
  }
}

function runStyleOf(r, ctx, extra) {
  const rPr = child(r, 'w:rPr');
  const charStyle = child(rPr, 'w:rStyle')?.attrs['w:val'];
  const charChain = charStyle ? ctx.styles.chain(charStyle).map((s) => s.rPr) : [];
  const style = runProps([...charChain, rPr], ctx.theme, ctx.runBase);
  if (extra.link) style.link = extra.link;
  return style;
}

function readRun(r, ctx, out, extra) {
  const style = runStyleOf(r, ctx, extra);
  // Complex fields: fldChar begin / instrText / separate / result / end. PAGE and NUMPAGES become
  // live fields; any other shows its last result.
  for (const node of children(r)) {
    if (ctx.field) {
      if (node.name === 'w:instrText') {
        ctx.field.instr += textOf(node);
        continue;
      }
      if (node.name === 'w:fldChar') {
        const type = node.attrs['w:fldCharType'];
        if (type === 'separate') {
          ctx.field.separated = true;
          const kind = ctx.field.instr.trim().split(/\s+/)[0].toUpperCase();
          if (kind === 'PAGE' || kind === 'NUMPAGES') {
            out.push({ type: 'field', field: kind, style });
            ctx.field.live = true;
          }
        } else if (type === 'end') {
          const kind = ctx.field.instr.trim().split(/\s+/)[0].toUpperCase();
          if (!ctx.field.separated && (kind === 'PAGE' || kind === 'NUMPAGES')) out.push({ type: 'field', field: kind, style });
          ctx.field = ctx.field.parent;
        } else if (type === 'begin') ctx.field = { instr: '', parent: ctx.field };
        continue;
      }
      if (!ctx.field.separated || ctx.field.live) continue;
    }
    switch (node.name) {
      case 'w:t':
        out.push({ type: 'text', text: textOf(node), style });
        break;
      case 'w:tab':
        out.push({ type: 'tab', style });
        break;
      case 'w:br': {
        const type = node.attrs['w:type'];
        out.push({ type: 'break', kind: type === 'page' ? 'page' : type === 'column' ? 'column' : 'line' });
        break;
      }
      case 'w:cr':
        out.push({ type: 'break', kind: 'line' });
        break;
      case 'w:noBreakHyphen':
        out.push({ type: 'text', text: '‑', style });
        break;
      case 'w:softHyphen':
        out.push({ type: 'text', text: '­', style });
        break;
      case 'w:sym': {
        const code = parseInt(node.attrs['w:char'], 16);
        out.push({ type: 'text', text: String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code), style: { ...style, family: node.attrs['w:font'] ?? style.family } });
        break;
      }
      case 'w:fldChar':
        if (node.attrs['w:fldCharType'] === 'begin') ctx.field = { instr: '', parent: ctx.field ?? null };
        break;
      case 'w:footnoteReference': {
        const id = node.attrs['w:id'];
        out.push({ type: 'footnote', id, text: String(footnoteIndex(ctx, id)), style: { ...style, vertAlign: 'superscript' } });
        break;
      }
      case 'w:footnoteRef':
        out.push({ type: 'text', text: String(footnoteIndex(ctx, ctx.footnoteId)), style: { ...style, vertAlign: 'superscript' } });
        break;
      case 'w:drawing':
        readDrawing(node, ctx, out, style);
        break;
      case 'w:pict':
      case 'w:object':
        readVml(node, ctx, out, style);
        break;
      case 'mc:AlternateContent': {
        const choice = child(node, 'mc:Choice');
        const fallback = child(node, 'mc:Fallback');
        const sub = [];
        readRun({ name: 'w:r', attrs: {}, children: [...children(choice ?? fallback)] }, ctx, sub, extra);
        if (!sub.length && fallback && choice) readRun({ name: 'w:r', attrs: {}, children: [...children(fallback)] }, ctx, sub, extra);
        out.push(...sub);
        break;
      }
      default:
        break;
    }
  }
}

// Footnotes are numbered in the order they're referenced.
function footnoteIndex(ctx, id) {
  const order = ctx.state.footnoteOrder;
  if (!order.has(id)) order.set(id, order.size + 1);
  return order.get(id);
}

// --- Pictures ------------------------------------------------------------------------------------

function blipData(ctx, container) {
  const blip = findDeep(container, 'a:blip');
  const id = blip?.attrs['r:embed'] ?? blip?.attrs['r:link'];
  const target = id && ctx.partRels?.get(id)?.target;
  if (!target || !ctx.zip.has(target)) return null;
  return ctx.zip.read(target);
}

function findDeep(el, name) {
  for (const c of children(el)) {
    if (c.name === name) return c;
    const found = findDeep(c, name);
    if (found) return found;
  }
  return null;
}

function readDrawing(drawing, ctx, out, style) {
  const inline = child(drawing, 'wp:inline');
  const anchor = child(drawing, 'wp:anchor');
  const frame = inline ?? anchor;
  if (!frame) return;
  const extent = child(frame, 'wp:extent');
  const width = num(extent, 'cx', 0) * EMU;
  const height = num(extent, 'cy', 0) * EMU;
  const data = blipData(ctx, frame);
  const isText = findDeep(frame, 'wps:txbx') || findDeep(frame, 'wps:wsp');
  if (!data) {
    if (findDeep(frame, 'c:chart')) ctx.report.note('A chart isn’t shown.');
    else if (findDeep(frame, 'dgm:relIds')) ctx.report.note('A SmartArt graphic isn’t shown.');
    else if (isText) ctx.report.note('A text box or shape isn’t shown.');
    return;
  }
  if (!isPicture(data)) {
    ctx.report.note('A picture in a format that can’t be converted yet isn’t shown.');
    return;
  }
  if (inline) {
    out.push({ type: 'image', image: data, width, height, style });
    return;
  }
  // A floating picture: shown where it's anchored, in its paragraph's place, for now inline (its
  // exact place and the text wrapping round it come with floats).
  ctx.report.note('A floating picture is shown in line with its paragraph’s text.');
  out.push({ type: 'image', image: data, width, height, style, floating: true });
}

function readVml(node, ctx, out, style) {
  const image = findDeep(node, 'v:imagedata');
  const shape = findDeep(node, 'v:shape');
  const id = image?.attrs['r:id'];
  const target = id && ctx.partRels?.get(id)?.target;
  if (!target || !ctx.zip.has(target)) return;
  const data = ctx.zip.read(target);
  if (!isPicture(data)) {
    ctx.report.note('An embedded object isn’t shown.');
    return;
  }
  const css = Object.fromEntries((shape?.attrs.style ?? '').split(';').map((kv) => kv.split(':').map((s) => s.trim())).filter((kv) => kv.length === 2));
  const toPt = (v) => (v?.endsWith('pt') ? parseFloat(v) : v?.endsWith('in') ? parseFloat(v) * 72 : v?.endsWith('cm') ? (parseFloat(v) * 72) / 2.54 : v?.endsWith('px') ? parseFloat(v) * 0.75 : parseFloat(v) || 0);
  out.push({ type: 'image', image: data, width: toPt(css.width), height: toPt(css.height), style });
}

const isPicture = (data) => data && ((data[0] === 0xff && data[1] === 0xd8) || data.readUInt32BE(0) === 0x89504e47);

// --- Tables --------------------------------------------------------------------------------------

function readTable(tbl, ctx) {
  const { styles, theme } = ctx;
  const tblPr = child(tbl, 'w:tblPr');
  const styleId = child(tblPr, 'w:tblStyle')?.attrs['w:val'] ?? styles.defaultTable;
  const chain = styleId ? styles.chain(styleId) : [];
  const allTblPr = [...chain.map((s) => s.tblPr), tblPr].filter(Boolean);
  const pick = (name) => [...allTblPr].reverse().map((e) => child(e, name)).find(Boolean) ?? null;
  const borders = {};
  for (const e of allTblPr) {
    const b = child(e, 'w:tblBorders');
    if (!b) continue;
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV', 'start', 'end']) {
      const v = border(child(b, `w:${side}`), theme);
      if (v !== undefined) borders[side === 'start' ? 'left' : side === 'end' ? 'right' : side] = v;
    }
  }
  const cellMargin = {};
  for (const e of allTblPr) {
    const m = child(e, 'w:tblCellMar');
    for (const side of ['top', 'left', 'bottom', 'right', 'start', 'end']) {
      const v = child(m, `w:${side}`);
      if (v) cellMargin[side === 'start' ? 'left' : side === 'end' ? 'right' : side] = num(v, 'w:w', 0) * TW;
    }
  }
  const indentEl = pick('w:tblInd');
  const look = child(tblPr, 'w:tblLook');
  const lookOn = (attr, bit) => (look?.attrs[attr] != null ? look.attrs[attr] === '1' : look?.attrs['w:val'] ? (parseInt(look.attrs['w:val'], 16) & bit) !== 0 : attr === 'w:firstRow' || attr === 'w:firstColumn' || attr === 'w:noVBand');
  const flags = { firstRow: lookOn('w:firstRow', 0x20), lastRow: lookOn('w:lastRow', 0x40), firstColumn: lookOn('w:firstColumn', 0x80), lastColumn: lookOn('w:lastColumn', 0x100), hBand: !lookOn('w:noHBand', 0x200), vBand: !lookOn('w:noVBand', 0x400) };
  const grid = children(child(tbl, 'w:tblGrid'), 'w:gridCol').map((g) => num(g, 'w:w', 0) * TW);
  const align = pick('w:jc')?.attrs['w:val'];

  // The table style's paragraph and run properties apply to every cell's paragraphs.
  const tablePara = chain.map((s) => s.pPr).filter(Boolean);
  const tableRun = chain.map((s) => s.rPr).filter(Boolean);
  const rowsEl = children(tbl, 'w:tr');
  const rows = [];
  rowsEl.forEach((tr, r) => {
    const trPr = child(tr, 'w:trPr');
    const height = child(trPr, 'w:trHeight');
    const row = {
      height: height ? num(height, 'w:val', 0) * TW : 0,
      rule: height?.attrs['w:hRule'] ?? 'atLeast',
      header: Boolean(child(trPr, 'w:tblHeader')),
      cantSplit: Boolean(child(trPr, 'w:cantSplit')),
      cells: [],
    };
    const tcs = children(tr).filter((c) => c.name === 'w:tc' || c.name === 'w:sdt');
    let col = num(child(trPr, 'w:gridBefore'), 'w:val', 0);
    if (col) row.cells.push({ span: col, blocks: [], borders: { top: null, bottom: null, left: null, right: null }, ghost: true });
    tcs.forEach((tcNode, c) => {
      const tc = tcNode.name === 'w:sdt' ? child(child(tcNode, 'w:sdtContent'), 'w:tc') : tcNode;
      if (!tc) return;
      const tcPr = child(tc, 'w:tcPr');
      const span = num(child(tcPr, 'w:gridSpan'), 'w:val', 1);
      const vMerge = child(tcPr, 'w:vMerge');
      // Conditional formatting from the table style: header row, first column, banding.
      const conditions = [];
      if (flags.hBand && !(flags.firstRow && r === 0)) conditions.push((r - (flags.firstRow ? 1 : 0)) % 2 === 0 ? 'band1Horz' : 'band2Horz');
      if (flags.vBand) conditions.push(c % 2 === 0 ? 'band1Vert' : 'band2Vert');
      if (flags.firstColumn && col === 0) conditions.push('firstCol');
      if (flags.lastColumn && col + span >= grid.length) conditions.push('lastCol');
      if (flags.firstRow && r === 0) conditions.push('firstRow');
      if (flags.lastRow && r === rowsEl.length - 1) conditions.push('lastRow');
      const cond = chain.flatMap((s) => conditions.map((k) => s.conditional[k]).filter(Boolean));
      const condTcPr = cond.map((x) => x.tcPr).filter(Boolean);
      const cellBorders = {};
      for (const e of [...condTcPr, tcPr]) {
        const b = child(e, 'w:tcBorders');
        if (!b) continue;
        for (const side of ['top', 'left', 'bottom', 'right', 'start', 'end']) {
          const v = border(child(b, `w:${side}`), theme);
          if (v !== undefined) cellBorders[side === 'start' ? 'left' : side === 'end' ? 'right' : side] = v;
        }
      }
      const margin = {};
      const mar = child(tcPr, 'w:tcMar');
      for (const side of ['top', 'left', 'bottom', 'right', 'start', 'end']) {
        const v = child(mar, `w:${side}`);
        if (v) margin[side === 'start' ? 'left' : side === 'end' ? 'right' : side] = num(v, 'w:w', 0) * TW;
      }
      const shd = [...condTcPr, tcPr].map((e) => shading(child(e, 'w:shd'), theme)).filter(Boolean).pop() ?? null;
      const cellCtx = { ...ctx, tablePara: [...tablePara, ...cond.map((x) => x.pPr).filter(Boolean)], tableRun: [...tableRun, ...cond.map((x) => x.rPr).filter(Boolean)] };
      row.cells.push({
        span,
        vmerge: vMerge ? (vMerge.attrs['w:val'] === 'restart' ? 'restart' : 'continue') : null,
        borders: cellBorders,
        shading: shd,
        margin,
        valign: child(tcPr, 'w:vAlign')?.attrs['w:val'] ?? 'top',
        blocks: readBlocks(tc, cellCtx).filter((b) => b),
      });
      col += span;
    });
    rows.push(row);
  });
  // Vertically merged cells: the first holds the content; the height it needs spreads over the rows.
  return {
    type: 'table',
    props: { indent: indentEl ? num(indentEl, 'w:w', 0) * TW : 0, align: align === 'center' ? 'center' : align === 'right' || align === 'end' ? 'right' : 'left', borders, cellMargin, word: true },
    grid,
    rows,
  };
}
