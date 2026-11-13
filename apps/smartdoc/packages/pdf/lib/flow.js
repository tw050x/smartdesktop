// The page layout engine for flowing documents (Word, Markdown, text): a document model of sections,
// paragraphs, tables and pictures, laid out the way Word does it and drawn into a PDF.
//
// The model (everything in points):
//   { sections: [section], footnotes: { id: [block] }, defaultTab, evenAndOdd, title, lang }
//   section: { page: { width, height }, margin: { top, right, bottom, left, header, footer },
//              columns: { count, space, separator }, type: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage',
//              titlePage, pageStart, headers: { default, first, even }, footers: { … }, blocks }
//   block: paragraph | table
//   paragraph: { type: 'paragraph', props, content: [inline], mark: style, label?: [inline] }
//     props: { align, indent: { left, right, firstLine }, spacing: { before, after, line, rule, contextual },
//              keepNext, keepLines, widowControl, pageBreakBefore, tabs: [{ pos, align, leader }],
//              borders: { top, bottom, left, right, between }, shading, styleId, outline (heading level) }
//   inline: { type: 'text', text, style } | { type: 'tab', style } | { type: 'break', kind: 'line' | 'page' | 'column' }
//           | { type: 'image', image, width, height } | { type: 'field', field: 'PAGE' | 'NUMPAGES', style }
//           | { type: 'footnote', id, text, style } | { type: 'float', … (see floats) }
//   style: { family, size, bold, italic, color, underline, strike, dstrike, highlight, shading, caps,
//            smallCaps, vertAlign, spacing, scale, kern, hidden, link }
//   table: { type: 'table', props: { indent, align, borders, cellMargin }, grid: [widths],
//            rows: [{ height, rule, header, cantSplit, cells: [{ span, vmerge, borders, shading, margin, valign, blocks }] }] }
import { createPdf } from './pdf.js';
import { isSpace, joinRuns, lineMetrics, shape } from './text.js';

const EPS = 0.01;
// How much of its spaces' width a justified line may give up to fit (Word 2013 and later).
export const SHRINK = 0.2;

export function renderFlow(model, { report }) {
  const pdf = createPdf({ title: model.title, lang: model.lang });
  const images = new Map(); // image data → pdf image
  const imageFor = (data) => {
    if (!images.has(data)) images.set(data, pdf.addImage(data));
    return images.get(data);
  };
  const pages = paginate(model, { report });
  const total = pages.length;
  pages.forEach((page, index) => drawPage(pdf, page, { number: page.number, total, index, imageFor, report, model }));
  return { pdf: pdf.finish(), pages: total };
}

// --- Paragraphs into lines ----------------------------------------------------------------------

// The paragraph's inline content as positioned pieces, broken into lines `width` wide (its own
// indents inside that). `fields` gives the text of PAGE and NUMPAGES fields (in headers, known when
// drawn).
export function layoutParagraph(para, width, { report, fields = { PAGE: '1', NUMPAGES: '1' }, defaultTab = 36, exclusions = null } = {}) {
  const props = para.props ?? {};
  const indent = props.indent ?? {};
  const left = indent.left ?? 0;
  const right = indent.right ?? 0;
  const firstLine = indent.firstLine ?? 0;

  // Items: each glyph (with its run's look), tabs, breaks, pictures.
  const runs = [];
  const content = [...(para.label ?? []), ...(para.content ?? [])];
  for (const item of content) {
    if (item.type === 'text' || item.type === 'field' || item.type === 'footnote') {
      if (item.style?.hidden) continue;
      const text = item.type === 'field' ? fields[item.field] ?? '' : item.text;
      const style = runStyle(item.style);
      const glyphs = shape(text, style, { report }).map((g) => ({ ...g, style: item.style, footnote: item.type === 'footnote' ? item.id : undefined, link: item.style?.link }));
      runs.push(glyphs);
    } else if (item.type === 'tab') {
      runs.push([{ tab: true, style: item.style, advance: 0, breakAfter: false, cp: 9, label: item.label }]);
    } else if (item.type === 'break') {
      runs.push([{ hardBreak: item.kind, advance: 0, cp: 10 }]);
    } else if (item.type === 'image') {
      runs.push([{ object: item, advance: item.width, breakAfter: true, cp: 0xfffc, height: item.height, style: item.style }]);
    }
  }
  const items = joinRuns(runs);
  for (const item of items) if (item.object || item.tab) item.breakAfter = item.breakAfter || item.object;

  const markStyle = runStyle(para.mark ?? para.content?.find((c) => c.style)?.style ?? {});
  const tabs = [...(props.tabs ?? [])].filter((t) => t.align !== 'clear').sort((a, b) => a.pos - b.pos);

  const lines = [];
  let line = null;
  // A justified line's spaces may squeeze (Word 2013 and later): those between its words, after its
  // last tab, all before the item being tried.
  const squeeze = props.shrinkSpaces && (props.align === 'both' || props.align === 'distribute');
  const spacesOf = (l) => {
    let width = 0;
    for (const it of l.items) {
      if (it.tab) width = 0;
      else if (it.space) width += it.advance;
    }
    return width;
  };
  const startLine = (first) => {
    const lineLeft = left + (first ? firstLine : 0);
    let avail = width - lineLeft - right;
    let offset = 0;
    if (exclusions) {
      // A float beside this line narrows it (see floats); measured at the line's top.
      const cut = exclusions(lines.length);
      if (cut) {
        offset = cut.left;
        avail -= cut.left + cut.right;
      }
    }
    line = { items: [], x: lineLeft + offset, width: Math.max(0, avail), used: 0, first, tabStart: null, lastBreak: -1 };
  };
  startLine(true);

  // The next tab stop past x (from the paragraph's left edge, as Word measures them): a set stop,
  // the hanging indent (an implicit stop), or the next default stop.
  const nextTab = (x) => {
    for (const t of tabs) if (t.pos > x + EPS) return t;
    if (line.first && firstLine < 0 && left > x + EPS) return { pos: left, align: 'left' };
    const stop = Math.floor(x / defaultTab + 1 + EPS) * defaultTab;
    return { pos: stop, align: 'left', implicit: true };
  };

  // A right, centre or decimal tab places what follows it: the tab's width shrinks as the text after
  // it grows (it grows leftwards into the tab's space), until the next tab or the line's end.
  const placeTab = () => {
    const t = line.tabStart;
    if (!t) return;
    const segment = line.items.slice(t.index + 1);
    let segWidth = segment.reduce((w, it) => w + it.advance, 0);
    if (t.stop.align === 'decimal') {
      const dot = segment.findIndex((it) => it.text === '.' || it.text === ',');
      if (dot >= 0) segWidth = segment.slice(0, dot).reduce((w, it) => w + it.advance, 0);
    }
    const tabItem = line.items[t.index];
    const at = t.x;
    const stop = t.stop.pos - line.x;
    let advance = 0;
    if (t.stop.align === 'right' || t.stop.align === 'decimal') advance = Math.max(0, stop - at - segWidth);
    else if (t.stop.align === 'center') advance = Math.max(0, stop - at - segWidth / 2);
    tabItem.advance = advance;
    line.used = at + advance + segment.reduce((w, it) => w + it.advance, 0);
  };
  const finishTab = () => {
    placeTab();
    line.tabStart = null;
  };

  const endLine = (reason) => {
    finishTab();
    line.end = reason;
    lines.push(line);
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.hardBreak) {
      line.items.push({ ...item, advance: 0 });
      endLine(item.hardBreak);
      startLine(false);
      continue;
    }
    if (item.tab) {
      finishTab();
      const stop = nextTab(line.x + line.used);
      const tabItem = { ...item, advance: 0, stop };
      line.items.push(tabItem);
      if (stop.align === 'left' || stop.implicit) {
        tabItem.advance = Math.max(0, stop.pos - line.x - line.used);
        line.used += tabItem.advance;
      } else line.tabStart = { index: line.items.length - 1, x: line.used, stop };
      // A tab past the line's end wraps (Word moves the text after it to the next line).
      if (line.used > line.width + EPS && line.items.length > 1) {
        line.items.pop();
        endLine('wrap');
        startLine(false);
        i--;
      }
      continue;
    }
    // Try it on the line: it fits if the line's still within its width (spaces always fit: they hang
    // past the margin; so does a soft hyphen, which takes no room unless the line breaks there).
    line.items.push(item);
    if (line.tabStart) placeTab();
    else line.used += item.advance;
    const fits = item.space || item.softHyphen || line.used <= line.width + EPS || (squeeze && line.used <= line.width + SHRINK * spacesOf(line) + EPS);
    if (fits || line.items.length === 1) {
      if (item.breakAfter) line.lastBreak = line.items.length - 1;
      continue;
    }
    line.items.pop();
    if (line.tabStart) placeTab();
    else line.used -= item.advance;
    // It doesn't fit: break at the last opportunity, or before this item if there was none.
    let breakAt = line.lastBreak;
    if (breakAt < 0) breakAt = line.items.length - 1;
    const carried = line.items.splice(breakAt + 1);
    if (line.tabStart && line.tabStart.index > breakAt) line.tabStart = null;
    if (line.tabStart) placeTab();
    else line.used = line.items.reduce((w, it) => w + it.advance, 0);
    const last = line.items[line.items.length - 1];
    if (last?.softHyphen) {
      last.advance = last.hyphenWidth;
      last.text = '-';
      last.showHyphen = true;
    }
    endLine('wrap');
    startLine(false);
    for (const c of carried) {
      line.items.push(c);
      line.used += c.advance;
      if (c.breakAfter) line.lastBreak = line.items.length - 1;
    }
    i--;
  }
  endLine('end');

  // Each line's height, baseline and alignment.
  const spacing = props.spacing ?? {};
  for (const l of lines) {
    let ascent = 0;
    let descent = 0;
    let objectHeight = 0;
    let fontSingle = 0; // the text's own single line, which a Word multiple is measured from
    const consider = (font, size) => {
      const m = lineMetrics(font, size);
      ascent = Math.max(ascent, m.ascent);
      descent = Math.max(descent, m.descent);
      fontSingle = Math.max(fontSingle, m.ascent + m.descent);
    };
    for (const it of l.items) {
      if (it.font && !it.zeroWidth) consider(it.metricsFont ?? it.font, runStyle(it.style).size);
      if (it.object) objectHeight = Math.max(objectHeight, it.object.height);
    }
    if (!ascent) {
      const mark = markFont(markStyle, report);
      if (mark) {
        consider(mark.font, markStyle.size);
        // A line of pictures only: Word gives it no descent (the picture stands on the line's foot).
        if (objectHeight && props.word) {
          ascent = 0;
          descent = 0;
        }
      }
    }
    // A picture sits on the baseline, its height all above it.
    ascent = Math.max(ascent, objectHeight);
    const single = ascent + descent;
    let height = single;
    let baseline = ascent;
    const rule = spacing.rule ?? 'auto';
    const value = spacing.line ?? 1;
    if (rule === 'auto' && props.powerpoint) {
      // PowerPoint: a line is 1.2 times its largest font size (times its spacing), its descent
      // below the baseline.
      const sizes = l.items.filter((it) => it.font && !it.zeroWidth).map((it) => runStyle(it.style).size);
      const largest = sizes.length ? Math.max(...sizes) : markStyle.size;
      height = Math.max(objectHeight, 1.2 * largest * value);
      baseline = height - descent;
    } else if (rule === 'auto') {
      // Word adds a multiple's extra as the text's (a picture's height isn't multiplied).
      height = props.word ? single + fontSingle * (value - 1) : single * value;
      // Word puts a multiple's extra room below the text (the baseline stays at the ascent); a
      // multiple under one takes it from the top.
      baseline = props.word && value >= 1 ? ascent : height - descent;
    } else if (rule === 'exact') {
      height = value;
      baseline = Math.min(height, ascent * (height / Math.max(single, EPS)) + (height > single ? height - single : 0));
      baseline = height - descent * Math.min(1, height / Math.max(single, EPS));
    } else if (rule === 'atLeast') {
      height = Math.max(single, value);
      baseline = height - descent;
    }
    l.height = height;
    l.baseline = baseline;
    l.ascent = ascent;
    l.descent = descent;

    // Trailing spaces hang past the margin; they don't count for alignment.
    let end = l.items.length;
    while (end > 0 && (l.items[end - 1].space || l.items[end - 1].hardBreak)) end--;
    const content = l.items.slice(0, end).reduce((w, it) => w + it.advance, 0);
    const extra = l.width - content;
    const align = props.align ?? 'left';
    l.offset = 0;
    if (align === 'center') l.offset = extra / 2;
    else if (align === 'right') l.offset = extra;
    else if ((align === 'both' || align === 'distribute') && ((extra > 0 && (l.end === 'wrap' || l.end === 'line' || align === 'distribute')) || extra < -EPS)) {
      // Justified: the extra spread over the spaces after the last tab (or, for a line that fitted
      // by squeezing, taken from them, on any line).
      let lastTab = -1;
      l.items.forEach((it, i) => i < end && it.tab && (lastTab = i));
      const spaces = l.items.filter((it, i) => i > lastTab && i < end && it.space);
      if (spaces.length) for (const s of spaces) s.advance += extra / spaces.length;
      else if (align === 'distribute') {
        const glyphs = l.items.filter((it, i) => i > lastTab && i < end - 1);
        for (const g of glyphs) g.advance += extra / Math.max(1, glyphs.length);
      }
    }
  }
  return { lines, left, right, markStyle };
}

function runStyle(style = {}) {
  let size = style.size ?? 11;
  if (style.vertAlign === 'superscript' || style.vertAlign === 'subscript') size *= 0.65;
  return { family: style.family ?? 'Calibri', bold: style.bold, italic: style.italic, size, spacing: style.spacing ?? 0, kern: style.kern ?? false, scale: style.scale ?? 1, caps: style.caps, smallCaps: style.smallCaps };
}

const markFonts = new Map();
function markFont(style, report) {
  const key = `${style.family}|${style.bold}|${style.italic}`;
  if (!markFonts.has(key)) markFonts.set(key, shape(' ', style, { report })[0] ?? null);
  return markFonts.get(key);
}

// --- Pages ---------------------------------------------------------------------------------------

// Lays every section's blocks out on pages: [{ section, number, items: [placed], header, footer }].
function paginate(model, { report }) {
  const pages = [];
  let page = null;
  let pageNumber = 0;
  const footnoteText = model.footnotes ?? {};
  // The space after the last paragraph placed, which the next one's space before is measured
  // against (Word: see `word`), carried from one section to the next.
  let previousAfter = 0;

  const newPage = (section, { blank = false } = {}) => {
    pageNumber = section._restart != null ? section._restart : pageNumber + 1;
    section._restart = null;
    const firstOfSection = !pages.some((p) => p.section === section);
    page = { section, number: pageNumber, items: [], footnotes: [], blank, firstOfSection };
    pages.push(page);
    const area = bodyArea(section, page, report, model);
    page.area = area;
    page.column = 0;
    page.y = area.top;
    page.columnTop = area.top;
    return page;
  };

  for (const [si, section] of model.sections.entries()) {
    if (section.pageStart != null) section._restart = section.pageStart;
    const continuous = section.type === 'continuous' && page && si > 0;
    if (!continuous) {
      newPage(section);
      // Starting on an odd or even page adds a blank one when needed.
      if ((section.type === 'oddPage' && page.number % 2 === 0) || (section.type === 'evenPage' && page.number % 2 === 1)) {
        page.blank = true;
        newPage(section);
      }
      // A new section's page keeps its first paragraph's space before, as a page break does.
      if (section.blocks?.[0]) section.blocks[0]._afterBreak = true;
    } else {
      // A continuous section starts below the last one, with its own columns.
      page.section = section;
      const area = bodyArea(section, page, report, model);
      page.area = { ...area, top: page.y };
      page.columnTop = page.y;
      page.column = 0;
    }
    flowBlocks(section.blocks, section);
  }
  if (!pages.length) newPage(model.sections[0] ?? defaultSection());
  return pages;

  function columnBox() {
    const { area } = page;
    const cols = page.section.columns ?? { count: 1, space: 0 };
    const count = Math.max(1, cols.count ?? 1);
    const space = cols.space ?? 36;
    const width = (area.width - space * (count - 1)) / count;
    return { x: area.left + page.column * (width + space), width, bottom: area.bottom - footnoteHeight(page) };
  }

  function nextColumn(section) {
    const count = Math.max(1, section.columns?.count ?? 1);
    if (page.column < count - 1) {
      page.column += 1;
      page.y = page.columnTop;
    } else newPage(section);
  }

  // Blocks into the current page and column: paragraphs line by line (keeping lines together, and
  // with the next paragraph, as asked; no widowed or orphaned single line), tables row by row.
  function flowBlocks(blocks, section) {
    let previous = null;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      if (block.type === 'table') {
        flowTable(block, section);
        previous = block;
        previousAfter = 0;
        continue;
      }
      if (block.type === 'sectionBreak') continue;
      const props = block.props ?? {};
      if (props.pageBreakBefore && page.items.length) newPage(section);
      const box = columnBox();
      const laid = layoutParagraph(block, box.width, { report, defaultTab: model.defaultTab ?? 36 });
      const spacing = props.spacing ?? {};
      // Contextual spacing: none between paragraphs of the same style that ask for it.
      const sameStyle = previous?.type === 'paragraph' && previous.props?.styleId === props.styleId;
      let before = spacing.contextual && sameStyle ? 0 : spacing.before ?? 0;
      // Word leaves the larger of the space after the paragraph above and this one's space before,
      // not both: this one adds only what it asks for beyond what's there (even at the top of a new
      // section's page, the paragraph before having had its space after on the page before).
      if (props.word) before = Math.max(0, before - previousAfter);
      const after = spacing.after ?? 0;
      // …and none after one followed by a paragraph of the same style, when it asks.
      const next = blocks[b + 1];
      const afterUsed = spacing.contextual && next?.type === 'paragraph' && next.props?.styleId === props.styleId ? 0 : after;
      // Space before is dropped at the top of a page the paragraph flowed onto (not the first page).
      if (page.y <= page.columnTop + EPS && pages.length > 1 && !block._afterBreak) before = 0;
      const borders = props.borders ?? {};
      const borderTop = borders.top ? (borders.top.width ?? 0.5) + (borders.top.space ?? 0) : 0;
      const borderBottom = borders.bottom ? (borders.bottom.width ?? 0.5) + (borders.bottom.space ?? 0) : 0;

      // How many lines from `from` fit in the column below y.
      const lines = laid.lines;
      const totalHeight = lines.reduce((h, l) => h + l.height, 0);
      // Keep with next: this paragraph and the first lines of the next must share a page.
      const keepWithNext = props.keepNext && b < blocks.length - 1;
      let nextFirst = 0;
      if (keepWithNext) {
        const next = blocks[b + 1];
        if (next.type === 'paragraph') {
          const nl = layoutParagraph(next, box.width, { report, defaultTab: model.defaultTab ?? 36 });
          nextFirst = (next.props?.spacing?.before ?? 0) + nl.lines.slice(0, 2).reduce((h, l) => h + l.height, 0);
        }
      }
      const needWhole = props.keepLines || keepWithNext;
      const fullHeight = before + borderTop + totalHeight + borderBottom + afterUsed;
      if (needWhole && page.y + fullHeight + (keepWithNext ? nextFirst : 0) > box.bottom + EPS && page.y > page.columnTop + EPS) {
        nextColumn(section);
        before = 0;
      }
      let at = page.y + before;
      let first = true;
      let index = 0;
      const widow = props.widowControl !== false;
      while (index < lines.length) {
        const current = columnBox();
        const top = at + (first ? borderTop : 0);
        // Lines that fit here.
        let fit = 0;
        let y = top;
        while (index + fit < lines.length && y + lines[index + fit].height <= current.bottom + EPS) {
          y += lines[index + fit].height;
          fit++;
        }
        // A footnote referenced in a line needs its note on the same page.
        if (fit === 0 && page.y <= page.columnTop + EPS) fit = 1; // a line taller than the page still goes somewhere
        if (widow && fit < lines.length - index && lines.length >= 2) {
          const remaining = lines.length - index - fit;
          // Orphan: only the first line here; widow: only the last line on the next page.
          if (index === 0 && fit === 1 && page.y > page.columnTop + EPS) fit = 0;
          else if (remaining === 1 && fit >= 2) fit -= 1;
        }
        if (fit === 0) {
          nextColumn(section);
          at = page.y;
          first = false;
          continue;
        }
        let ly = top;
        for (let k = 0; k < fit; k++) {
          const line = lines[index + k];
          place({ type: 'line', x: current.x, top: ly, line, para: block, laid, width: current.width });
          for (const g of line.items) if (g.footnote) addFootnote(g.footnote);
          ly += line.height;
        }
        // Paragraph decorations: shading and borders around this page's part of it.
        decorate(block, laid, current, first ? at : top, ly, first, index + fit >= lines.length);
        index += fit;
        page.y = ly;
        first = false;
        if (index < lines.length) {
          nextColumn(section);
          at = page.y;
        }
        // A page or column break inside the paragraph.
        const broke = lines[index - 1]?.end;
        if (broke === 'page' && index <= lines.length) {
          newPage(section);
          at = page.y;
          if (blocks[b + 1]) blocks[b + 1]._afterBreak = true;
        } else if (broke === 'column') {
          nextColumn(section);
          at = page.y;
        }
      }
      page.y += borderBottom + afterUsed;
      previous = block;
      previousAfter = afterUsed;
    }
  }

  function place(item) {
    page.items.push({ ...item, column: page.column });
  }

  function decorate(block, laid, box, top, bottom, first, last) {
    const props = block.props ?? {};
    if (!props.shading && !props.borders) return;
    const left = box.x + (props.indent?.left ?? 0) - (props.borders?.left?.space ?? 0);
    const right = box.x + box.width - (props.indent?.right ?? 0) + (props.borders?.right?.space ?? 0);
    page.items.push({ type: 'paraBox', x: left, top, width: right - left, height: bottom - top, shading: props.shading, borders: props.borders, first, last, under: true });
  }

  function addFootnote(id) {
    if (page.footnotes.includes(id)) return;
    page.footnotes.push(id);
  }

  function footnoteHeight(p) {
    if (!p.footnotes.length) return 0;
    let h = 12; // the separator and its space
    for (const id of p.footnotes) {
      for (const block of footnoteText[id] ?? []) {
        if (block.type !== 'paragraph') continue;
        const laid = layoutParagraph(block, p.area.width, { report });
        h += laid.lines.reduce((s, l) => s + l.height, 0) + (block.props?.spacing?.after ?? 0);
      }
    }
    return h;
  }

  // Tables: rows placed one after another, each row as tall as its tallest cell; a row that doesn't
  // fit goes to the next page (split across pages unless it mustn't be), header rows repeating.
  function flowTable(table, section) {
    const box = columnBox();
    const grid = table.grid ?? [];
    const gridTotal = grid.reduce((a, b) => a + b, 0);
    const indent = table.props?.indent ?? 0;
    let x0 = box.x + indent + wordShift(table);
    if (table.props?.align === 'center') x0 = box.x + (box.width - gridTotal) / 2;
    else if (table.props?.align === 'right') x0 = box.x + box.width - gridTotal;
    const rows = table.rows.map((row, r) => measureRow(table, row, grid, x0, r));
    // Vertically merged cells: their height spans the rows they cover (drawn once, at the first).
    const headerRows = [];
    for (const row of rows) {
      if (!row.source.header) break;
      headerRows.push(row);
    }
    let first = true;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const current = columnBox();
      if (page.y + row.height > current.bottom + EPS && page.y > page.columnTop + EPS) {
        nextColumn(section);
        if (!first && headerRows.length && r >= headerRows.length) for (const h of headerRows) placeRow(table, h);
      }
      placeRow(table, row);
      first = false;
    }
    page.y += table.props?.spaceAfter ?? 0;
  }

  function measureRow(table, row, grid, x0, r) {
    let col = 0;
    const cells = [];
    for (const cell of row.cells) {
      const span = cell.span ?? 1;
      const x = x0 + grid.slice(0, col).reduce((a, b) => a + b, 0);
      const width = grid.slice(col, col + span).reduce((a, b) => a + b, 0);
      const margin = { top: 0, bottom: 0, left: 5.4, right: 5.4, ...(table.props?.cellMargin ?? {}), ...(cell.margin ?? {}) };
      const inner = Math.max(1, width - margin.left - margin.right);
      const content = layoutBlocks(cell.blocks ?? [], inner, { report, defaultTab: model.defaultTab ?? 36 });
      cells.push({ cell, x, width, col, span, margin, content, height: content.height + margin.top + margin.bottom });
      col += span;
    }
    let height = Math.max(0, ...cells.filter((c) => c.cell.vmerge !== 'continue' && c.cell.vmerge !== 'restart').map((c) => c.height));
    const borders = rowBorders(table, cells, r);
    if (row.rule === 'exact') height = row.height;
    else {
      height += borders.top + borders.bottom;
      if (row.height) height = Math.max(height, row.height);
    }
    return { source: row, cells, height, index: r, borderTop: borders.top };
  }

  function placeRow(table, row) {
    page.items.push({ type: 'row', table, row, top: page.y });
    page.y += row.height;
  }
}

// Blocks laid out in a box `width` wide, not paginated (a table cell's content, a header): each
// paragraph's lines, and nested tables measured. Returns { height, items } with items relative to
// the box's top left.
export function layoutBlocks(blocks, width, opts) {
  const items = [];
  let y = 0;
  let previous = null;
  let previousAfter = 0;
  for (const [bi, block] of blocks.entries()) {
    if (block.type === 'paragraph') {
      const props = block.props ?? {};
      const spacing = props.spacing ?? {};
      const same = previous?.type === 'paragraph' && previous.props?.styleId === props.styleId;
      const before = spacing.contextual && same ? 0 : spacing.before ?? 0;
      y += props.word ? Math.max(0, before - previousAfter) : before;
      const laid = layoutParagraph(block, width, opts);
      const top = y;
      for (const line of laid.lines) {
        items.push({ type: 'line', x: 0, top: y, line, para: block, laid, width });
        y += line.height;
      }
      if (props.shading || props.borders) items.unshift({ type: 'paraBox', x: props.indent?.left ?? 0, top, width: width - (props.indent?.left ?? 0) - (props.indent?.right ?? 0), height: y - top, shading: props.shading, borders: props.borders, first: true, last: true, under: true });
      const next = blocks[bi + 1];
      previousAfter = spacing.contextual && next?.type === 'paragraph' && next.props?.styleId === props.styleId ? 0 : spacing.after ?? 0;
      y += previousAfter;
    } else if (block.type === 'table') {
      const grid = block.grid ?? [];
      for (const row of block.rows) {
        let col = 0;
        const cells = [];
        for (const cell of row.cells) {
          const span = cell.span ?? 1;
          const x = grid.slice(0, col).reduce((a, b) => a + b, 0) + (block.props?.indent ?? 0) + wordShift(block);
          const w = grid.slice(col, col + span).reduce((a, b) => a + b, 0);
          const margin = { top: 0, bottom: 0, left: 5.4, right: 5.4, ...(block.props?.cellMargin ?? {}), ...(cell.margin ?? {}) };
          const content = layoutBlocks(cell.blocks ?? [], Math.max(1, w - margin.left - margin.right), opts);
          cells.push({ cell, x, width: w, col, span, margin, content, height: content.height + margin.top + margin.bottom });
          col += span;
        }
        const r = block.rows.indexOf(row);
        let height = Math.max(0, ...cells.map((c) => c.height));
        const borders = rowBorders(block, cells, r);
        if (row.rule === 'exact') height = row.height;
        else {
          height += borders.top + borders.bottom;
          if (row.height) height = Math.max(height, row.height);
        }
        items.push({ type: 'row', table: block, row: { source: row, cells, height, index: r, borderTop: borders.top }, top: y, relative: true });
        y += height;
      }
      previousAfter = 0;
    }
    previous = block;
  }
  return { height: y, items };
}

// The body's box on a page of `section`: inside the margins, pushed down by a header taller than
// the space above the margin (and up by a tall footer), as Word does.
function bodyArea(section, page, report, model) {
  const { width: pw, height: ph } = section.page;
  const m = section.margin;
  let top = m.top;
  let bottom = ph - m.bottom;
  const header = headerFor(section, page, 'headers', model);
  const footer = headerFor(section, page, 'footers', model);
  const inner = pw - m.left - m.right;
  if (header?.length) {
    const h = layoutBlocks(header, inner, { report, fields: { PAGE: String(page.number), NUMPAGES: '99' }, defaultTab: model.defaultTab ?? 36 }).height;
    top = Math.max(top, m.header + h);
  }
  if (footer?.length) {
    const h = layoutBlocks(footer, inner, { report, fields: { PAGE: String(page.number), NUMPAGES: '99' }, defaultTab: model.defaultTab ?? 36 }).height;
    bottom = Math.min(bottom, ph - m.footer - h);
  }
  return { left: m.left, top, width: inner, bottom };
}

// Which header (or footer) a page shows: the first page's on the section's first page if it has a
// different first page, the even one on even pages when the document has them, else the default.
function headerFor(section, page, which, model) {
  const set = section[which] ?? {};
  if (section.titlePage && page.firstOfSection) return set.first ?? [];
  if (model.evenAndOdd && page.number % 2 === 0) return set.even ?? set.default ?? [];
  return set.default ?? [];
}

function defaultSection() {
  return { page: { width: 595.3, height: 841.9 }, margin: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36 }, blocks: [], headers: {}, footers: {} };
}

// --- Drawing -------------------------------------------------------------------------------------

function drawPage(pdf, page, ctx) {
  const { section } = page;
  const out = pdf.addPage(section.page);
  const { report, model } = ctx;
  const fields = { PAGE: String(page.number), NUMPAGES: String(ctx.total) };
  const m = section.margin;
  const inner = section.page.width - m.left - m.right;

  // Header and footer, with this page's number.
  const header = headerFor(section, page, 'headers', model);
  if (header?.length) {
    const laid = layoutBlocks(header, inner, { report, fields, defaultTab: model.defaultTab ?? 36 });
    drawItems(out, laid.items, m.left, m.header, ctx);
  }
  const footer = headerFor(section, page, 'footers', model);
  if (footer?.length) {
    const laid = layoutBlocks(footer, inner, { report, fields, defaultTab: model.defaultTab ?? 36 });
    drawItems(out, laid.items, m.left, section.page.height - m.footer - laid.height, ctx);
  }
  if (page.blank) return;

  // Underneath first: paragraph shading and borders, table rows' backgrounds.
  drawItems(out, page.items.filter((it) => it.under), 0, 0, ctx);
  drawItems(out, page.items.filter((it) => !it.under), 0, 0, ctx, fields);

  // Column separators.
  const cols = section.columns;
  if (cols?.separator && cols.count > 1) {
    const area = page.area;
    const width = (area.width - cols.space * (cols.count - 1)) / cols.count;
    for (let c = 1; c < cols.count; c++) {
      const x = area.left + c * (width + cols.space) - cols.space / 2;
      out.line(x, area.top, x, page.y, { stroke: '#000000', lineWidth: 0.5 });
    }
  }

  // Footnotes, under a short rule at the bottom of the body.
  if (page.footnotes.length) {
    const area = page.area;
    let height = 0;
    const laidNotes = [];
    for (const id of page.footnotes) {
      const blocks = model.footnotes?.[id] ?? [];
      const laid = layoutBlocks(blocks, area.width, { report, fields, defaultTab: model.defaultTab ?? 36 });
      laidNotes.push(laid);
      height += laid.height;
    }
    let y = area.bottom - height;
    out.line(area.left, y - 6, area.left + 144, y - 6, { stroke: '#000000', lineWidth: 0.5 });
    for (const laid of laidNotes) {
      drawItems(out, laid.items, area.left, y, ctx, fields);
      y += laid.height;
    }
  }
}

export function drawItems(out, items, dx, dy, ctx, fields) {
  for (const item of items) {
    if (item.type === 'line') drawLine(out, item, dx, dy, ctx);
    else if (item.type === 'paraBox') drawParaBox(out, item, dx, dy);
    else if (item.type === 'row') drawRow(out, item, dx, dy, ctx, fields);
  }
}

function drawLine(out, item, dx, dy, ctx) {
  const { line } = item;
  const top = item.top + dy;
  let x = item.x + dx + line.x + line.offset;
  const baseline = top + line.baseline;
  // Consecutive glyphs of one look draw as one run; decorations (underline, strike, highlight) per run.
  let run = null;
  const flush = () => {
    if (!run || !run.glyphs.length) return (run = null);
    const s = run.style ?? {};
    const shift = s.vertAlign === 'superscript' ? -(s.size ?? 11) * 0.33 : s.vertAlign === 'subscript' ? (s.size ?? 11) * 0.14 : 0;
    const width = run.glyphs.reduce((w, g) => w + g.advance, 0);
    if (s.highlight || s.shading) out.rect(run.x, top, width, line.height, { fill: s.highlight ?? s.shading });
    const bold = run.glyphs[0].syntheticBold;
    out.glyphs(run.font, run.size, run.x, baseline + shift, run.glyphs.map((g) => ({ gid: g.gid, text: g.text, advance: g.advance })), {
      color: s.color ?? '#000000',
      render: bold ? 2 : 0,
      outline: bold ? run.size * 0.03 : 0,
    });
    const visible = run.glyphs;
    const decoWidth = visible.reduce((w, g) => w + g.advance, 0) - (run.trailingSpace ?? 0);
    if (s.underline && s.underline !== 'none') {
      const thickness = Math.max(0.5, run.size * 0.05);
      const y = baseline + shift + run.size * 0.12;
      const color = s.underlineColor ?? s.color ?? '#000000';
      out.line(run.x, y, run.x + decoWidth, y, { stroke: color, lineWidth: s.underline === 'thick' ? thickness * 2 : thickness, dash: s.underline === 'dotted' ? [thickness, thickness * 2] : s.underline === 'dash' ? [thickness * 4, thickness * 2] : null });
      if (s.underline === 'double') out.line(run.x, y + thickness * 2, run.x + decoWidth, y + thickness * 2, { stroke: color, lineWidth: thickness });
    }
    if (s.strike || s.dstrike) {
      const y = baseline + shift - run.size * 0.27;
      out.line(run.x, y, run.x + decoWidth, y, { stroke: s.color ?? '#000000', lineWidth: Math.max(0.5, run.size * 0.05) });
      if (s.dstrike) out.line(run.x, y - run.size * 0.08, run.x + decoWidth, y - run.size * 0.08, { stroke: s.color ?? '#000000', lineWidth: Math.max(0.5, run.size * 0.05) });
    }
    if (s.link) out.link(run.x, top, width, line.height, s.link);
    run = null;
  };
  for (const g of line.items) {
    if (g.hardBreak) continue;
    if (g.tab) {
      flush();
      // A tab's leader (dots, dashes or a line) across the space it takes.
      const leader = g.stop?.leader;
      if (leader && leader !== 'none' && g.advance > 2) {
        const s = g.style ?? {};
        const size = runStyle(s).size;
        if (leader === 'underscore' || leader === 'heavy') out.line(x, baseline + 1, x + g.advance, baseline + 1, { stroke: s.color ?? '#000000', lineWidth: leader === 'heavy' ? 1.2 : 0.5 });
        else {
          const ch = leader === 'hyphen' ? '-' : leader === 'middleDot' ? '·' : '.';
          const glyph = shape(ch, runStyle(s))[0];
          if (glyph) {
            // As Word draws them: as many as fit, ending just short of what follows the tab (about a
            // quarter of a dot's width, 0.72pt at 11pt), whatever is left over before them.
            const step = glyph.advance;
            const gap = step * 0.26;
            const count = Math.max(0, Math.floor((g.advance - gap) / step));
            const start = x + g.advance - gap - count * step;
            out.glyphs(glyph.font, size, start, baseline, Array.from({ length: count }, () => ({ gid: glyph.gid, text: ch, advance: step })), { color: s.color ?? '#000000' });
          }
        }
      }
      x += g.advance;
      continue;
    }
    if (g.object) {
      flush();
      const image = ctx.imageFor(g.object.image);
      out.image(image, x, baseline - g.object.height, g.object.width, g.object.height);
      x += g.advance;
      continue;
    }
    const size = g.size;
    if (!run || run.font !== g.font || run.size !== size || run.style !== g.style) {
      flush();
      run = { font: g.font, size, style: g.style, x, glyphs: [] };
    }
    if (!g.zeroWidth && !(g.softHyphen && !g.showHyphen)) run.glyphs.push(g);
    x += g.advance;
  }
  flush();
}

function drawParaBox(out, item, dx, dy) {
  const x = item.x + dx;
  const top = item.top + dy;
  if (item.shading) out.rect(x, top, item.width, item.height, { fill: item.shading });
  const b = item.borders ?? {};
  const edge = (border, x1, y1, x2, y2) => border && border.style !== 'none' && out.line(x1, y1, x2, y2, { stroke: border.color ?? '#000000', lineWidth: border.width ?? 0.5, dash: border.style === 'dotted' ? [1, 2] : border.style === 'dashed' ? [3, 2] : null });
  if (item.first) edge(b.top, x, top, x + item.width, top);
  if (item.last) edge(b.bottom, x, top + item.height, x + item.width, top + item.height);
  edge(b.left, x, top, x, top + item.height);
  edge(b.right, x + item.width, top, x + item.width, top + item.height);
}

// A table row: each cell's shading, its content, then its borders (the table's, unless the cell
// has its own).
// Word sets a table half its left border's width to the right of its indent (its lines and text
// alike), so the border's outer edge, not its middle, is on the indent.
function wordShift(table) {
  if (!table.props?.word) return 0;
  const first = table.rows?.[0]?.cells?.[0];
  const border = first?.borders?.left !== undefined ? first.borders.left : table.props.borders?.left;
  return shown(border) ? (border.width ?? 0.5) / 2 : 0;
}

// A cell's border on each side, as Word picks it: the cell's own, else the table's (its outer edges
// on the table's edges, its inside lines between cells).
function cellBorder(table, c, r, side) {
  const own = c.cell.borders ?? {};
  if (own[side] !== undefined) return own[side];
  const tb = table.props?.borders ?? {};
  const rows = table.rows?.length ?? 1;
  const outer = { top: r === 0, bottom: r + (c.cell._rowSpan ?? 1) >= rows, left: c.col === 0, right: c.col + c.span >= (table.grid?.length ?? 1) }[side];
  return outer ? tb[side] : tb[side === 'top' || side === 'bottom' ? 'insideH' : 'insideV'];
}
const shown = (border) => border && border.style !== 'none' && border.style !== 'nil' && (border.width ?? 0.5) > 0;

// The room a row's borders take (Word adds them to its height): the line along its top (the
// table's top border on the first row, the line between rows after), and the table's bottom
// border under the last row.
function rowBorders(table, cells, r) {
  let top = 0;
  let bottom = 0;
  const last = r === (table.rows?.length ?? 1) - 1;
  for (const c of cells) {
    if (c.cell.vmerge === 'continue') continue;
    const t = cellBorder(table, c, r, 'top');
    if (shown(t)) top = Math.max(top, t.width ?? 0.5);
    if (last) {
      const b = cellBorder(table, c, r, 'bottom');
      if (shown(b)) bottom = Math.max(bottom, b.width ?? 0.5);
    }
  }
  return { top, bottom };
}

function drawRow(out, item, dx, dy, ctx, fields) {
  const { row, table } = item;
  const top = item.top + dy;
  const r = row.index ?? table.rows.indexOf(row.source);
  const last = r === table.rows.length - 1;
  for (const c of row.cells) {
    if (c.cell.vmerge === 'continue') continue;
    const x = c.x + dx;
    const height = c.cell._spanHeight ?? row.height;
    if (c.cell.shading) out.rect(x, top, c.width, height, { fill: c.cell.shading });
    let cy = top + (row.borderTop ?? 0) + c.margin.top;
    if (c.cell.valign === 'center') cy = top + (height - c.content.height) / 2;
    else if (c.cell.valign === 'bottom') cy = top + height - c.content.height - c.margin.bottom;
    drawItems(out, c.content.items, x + c.margin.left, cy, ctx, fields);
  }
  for (const c of row.cells) {
    if (c.cell.vmerge === 'continue') continue;
    const x = c.x + dx;
    const height = c.cell._spanHeight ?? row.height;
    const edge = (border, x1, y1, x2, y2) => shown(border) && out.line(x1, y1, x2, y2, { stroke: border.color ?? '#000000', lineWidth: border.width ?? 0.5 });
    // Each line in the middle of the room it takes: a row draws the line along its top, the last
    // row (or a cell reaching the table's foot) the bottom one too; each cell its left, the last
    // its right.
    const tw = row.borderTop ?? 0;
    const bottomBorder = cellBorder(table, c, r, 'bottom');
    const reachesFoot = last || r + (c.cell._rowSpan ?? 1) >= table.rows.length;
    const bw = reachesFoot && shown(bottomBorder) ? bottomBorder.width ?? 0.5 : 0;
    edge(cellBorder(table, c, r, 'top'), x, top + tw / 2, x + c.width, top + tw / 2);
    if (reachesFoot) edge(bottomBorder, x, top + height - bw / 2, x + c.width, top + height - bw / 2);
    else if (c.cell._rowSpan > 1) edge(cellBorder(table, c, r, 'bottom'), x, top + height, x + c.width, top + height);
    edge(cellBorder(table, c, r, 'left'), x, top, x, top + height);
    if (c.col + c.span >= (table.grid?.length ?? 1)) edge(cellBorder(table, c, r, 'right'), x + c.width, top, x + c.width, top + height);
    else if (c.cell.borders?.right !== undefined) edge(c.cell.borders.right, x + c.width, top, x + c.width, top + height);
  }
}
