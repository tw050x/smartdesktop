// Plain text and Markdown as documents, laid out by the flow engine (lib/flow.js).
//
// Plain text is set as LibreOffice opens it: every line as it is, in a fixed-width font (Liberation
// Mono, 10 points), on the paper size usual where the Mac is (Letter in the US and Canada, A4
// elsewhere), with 2 cm margins.
//
// Markdown (CommonMark's common parts and GitHub's tables): headings, paragraphs, emphasis, code,
// links, lists, quotes, rules and tables, set in a plain document style.
import { renderFlow } from '../lib/flow.js';

const CM = 72 / 2.54;
export function paper() {
  const region = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] ?? '').toUpperCase();
  return ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE'].includes(region) ? { width: 612, height: 792 } : { width: 595.3, height: 841.9 };
}

const section = (blocks) => ({ page: paper(), margin: { top: 2 * CM, right: 2 * CM, bottom: 2 * CM, left: 2 * CM, header: 1.25 * CM, footer: 1.25 * CM }, columns: { count: 1 }, blocks, headers: {}, footers: {} });

export function textToPdf(text, { report, title } = {}) {
  const style = { family: 'Liberation Mono', size: 10 };
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const blocks = lines.map((line) => ({
    type: 'paragraph',
    props: { spacing: { before: 0, after: 0, line: 1, rule: 'auto' }, tabs: [] },
    content: line ? [...splitTabs(line, style)] : [],
    mark: style,
  }));
  return renderFlow({ sections: [section(blocks)], defaultTab: 7.2 * 6.0, title }, { report });
}

function* splitTabs(line, style) {
  const parts = line.split('\t');
  for (let i = 0; i < parts.length; i++) {
    if (i) yield { type: 'tab', style };
    if (parts[i]) yield { type: 'text', text: parts[i], style };
  }
}

// --- Markdown ------------------------------------------------------------------------------------

const BODY = { family: 'Liberation Sans', size: 11, color: '#1d1d1f' };
const CODE = { family: 'Liberation Mono', size: 9.5, color: '#1d1d1f' };
const HEADINGS = [24, 18, 15, 13, 11.5, 11];

export function markdownToPdf(source, { report, title } = {}) {
  const blocks = markdownBlocks(source.replace(/\r\n?/g, '\n'));
  return renderFlow({ sections: [section(blocks)], defaultTab: 36, title }, { report });
}

const para = (content, props = {}, mark = BODY) => ({ type: 'paragraph', props: { spacing: { before: 0, after: 8, line: 1.2, rule: 'auto' }, ...props }, content, mark });

function markdownBlocks(text, depth = 0) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  const isBlank = (l) => !l || !l.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    // Fenced code.
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      body.forEach((l, k) => blocks.push(para(l ? [{ type: 'text', text: l, style: CODE }] : [], { spacing: { before: k === 0 ? 4 : 0, after: k === body.length - 1 ? 10 : 0, line: 1.15, rule: 'auto' }, shading: '#f3f3f6', indent: { left: 6, right: 6 } }, CODE)));
      continue;
    }
    // Headings.
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const style = { ...BODY, size: HEADINGS[level - 1], bold: true };
      blocks.push(para(inline(heading[2], style), { spacing: { before: level <= 2 ? 16 : 12, after: 6, line: 1.15, rule: 'auto' }, keepNext: true, outline: level }, style));
      i++;
      continue;
    }
    // A rule.
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(para([], { borders: { bottom: { width: 0.75, color: '#c4c4cb' } }, spacing: { before: 6, after: 12, line: 1, rule: 'auto' } }, { ...BODY, size: 4 }));
      i++;
      continue;
    }
    // A table: a header row, then a row of dashes.
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = cellsOf(line);
      const aligns = cellsOf(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      const body = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) body.push(cellsOf(lines[i++]));
      const width = paper().width - 4 * CM;
      const cols = header.length;
      const border = { width: 0.5, color: '#c4c4cb' };
      const row = (cells, head) => ({
        header: head,
        cells: Array.from({ length: cols }, (_, c) => ({
          shading: head ? '#f3f3f6' : null,
          margin: { top: 3, bottom: 3, left: 5, right: 5 },
          blocks: [para(inline(cells[c] ?? '', head ? { ...BODY, bold: true } : BODY), { align: aligns[c], spacing: { before: 0, after: 0, line: 1.15, rule: 'auto' } })],
        })),
      });
      blocks.push({ type: 'table', props: { borders: { top: border, bottom: border, left: border, right: border, insideH: border, insideV: border }, spaceAfter: 10 }, grid: Array(cols).fill(width / cols), rows: [row(header, true), ...body.map((r) => row(r, false))] });
      continue;
    }
    // A quote.
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      for (const b of markdownBlocks(body.join('\n'), depth + 1)) {
        if (b.type === 'paragraph') {
          b.props = { ...b.props, indent: { ...(b.props.indent ?? {}), left: (b.props.indent?.left ?? 0) + 14 }, borders: { left: { width: 3, color: '#d1d1d6', space: 8 } } };
          for (const c of b.content) if (c.style) c.style = { ...c.style, color: '#6e6e73' };
        }
        blocks.push(b);
      }
      continue;
    }
    // Lists: bullets or numbers, items continuing on indented lines, nested lists inside.
    const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const [, indentText] = line.match(listItem);
      const base = indentText.length;
      let number = Number(line.match(/^\s*(\d+)/)?.[1] ?? 1);
      while (i < lines.length) {
        const m = lines[i].match(listItem);
        if (!m || m[1].length !== base) break;
        const ordered = /\d/.test(m[2]);
        const body = [m[3]];
        i++;
        while (i < lines.length && !isBlank(lines[i]) && !(listItem.test(lines[i]) && lines[i].match(listItem)[1].length <= base)) body.push(lines[i++].replace(new RegExp(`^\\s{0,${base + 4}}`), ''));
        const level = depth;
        const left = 18 * (level + 1);
        const marker = ordered ? `${number++}.` : ['•', '◦', '▪'][level % 3];
        const inner = markdownBlocks(body.join('\n'), level + 1);
        inner.forEach((b, k) => {
          if (b.type !== 'paragraph') return blocks.push(b);
          const isNested = b.props?._list;
          if (!isNested) {
            b.props = { ...b.props, indent: { left, firstLine: k === 0 ? -14 : 0 }, spacing: { before: 0, after: 3, line: 1.2, rule: 'auto' }, tabs: [{ pos: left, align: 'left' }], _list: true };
            if (k === 0) b.label = [{ type: 'text', text: marker, style: BODY }, { type: 'tab', style: BODY }];
          }
          blocks.push(b);
        });
        while (i < lines.length && isBlank(lines[i]) && listItem.test(lines[i + 1] ?? '') && lines[i + 1].match(listItem)[1].length === base) i++;
      }
      const lastList = blocks[blocks.length - 1];
      if (lastList?.type === 'paragraph' && depth === 0) lastList.props.spacing = { ...lastList.props.spacing, after: 8 };
      continue;
    }
    // A paragraph: lines until a blank one or another block starts.
    const body = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !/^\s{0,3}(#{1,6}\s|>|```|~~~|([-*_])(\s*\2){2,}\s*$)/.test(lines[i]) && !listItem.test(lines[i])) body.push(lines[i++]);
    blocks.push(para(inline(body.join('\n'), BODY)));
  }
  return blocks;
}

// Emphasis, strong, code, links and line breaks in a paragraph's text.
function inline(text, base) {
  const out = [];
  const push = (t, style) => t && out.push({ type: 'text', text: t, style });
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|( {2,}|\\)\n|\n/g;
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    push(text.slice(at, m.index), base);
    if (m[2]) out.push(...inline(m[2], { ...base, bold: true }));
    else if (m[4]) out.push(...inline(m[4], { ...base, italic: true }));
    else if (m[5]) push(m[5], { ...CODE, size: base.size * 0.9, shading: '#f3f3f6' });
    else if (m[6]) out.push(...inline(m[6], { ...base, color: '#2f6fde', underline: 'single', link: m[7] }));
    else if (m[8]) out.push({ type: 'break', kind: 'line' });
    else push(' ', base);
    at = m.index + m[0].length;
  }
  push(text.slice(at), base);
  return out;
}
