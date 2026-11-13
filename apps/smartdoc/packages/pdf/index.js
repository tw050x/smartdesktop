// @smartdoc/pdf: turns a document into a PDF, with no other program and no dependencies. PDFs pass
// straight through; pictures, text and Markdown are set by this package; Word, Excel and
// PowerPoint files are laid out by its own engines (formats/). Experimental: what it can't yet show
// as Office would is listed in the report, never passed off as faithful.
//
//   const { pdf, kind, report } = await convert(bytes, { name: 'CV.docx' });
//
// `report` is { kind, engine, pages, substituted: [{ font, by }], missing: [what], notes: [text] }.
import { imageToPdf } from './formats/image.js';
import { markdownToPdf, textToPdf } from './formats/text.js';
import { METRIC_COMPATIBLE } from './lib/fonts.js';

// What a file is, from its first bytes (and its name, for text, which has no signature).
export function detect(bytes, name = '') {
  const head = bytes.subarray(0, 8);
  const ext = name.toLowerCase().split('.').pop();
  if (head.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (head.readUInt32BE(0) === 0x89504e47) return 'png';
  if (head.readUInt32BE(0) === 0xd0cf11e0) return { doc: 'doc', xls: 'xls', ppt: 'ppt' }[ext] ?? 'ole';
  if (head.readUInt32BE(0) === 0x504b0304) {
    const text = bytes.toString('latin1', 0, Math.min(bytes.length, 4096));
    if (text.includes('word/')) return 'docx';
    if (text.includes('xl/')) return 'xlsx';
    if (text.includes('ppt/')) return 'pptx';
    if (text.includes('mimetypeapplication/vnd.oasis.opendocument')) return 'odf';
    return { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' }[ext] ?? 'zip';
  }
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return 'markdown';
  if (['txt', 'text', 'csv', 'log', ''].includes(ext) || looksLikeText(bytes)) return 'text';
  return 'unknown';
}

function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 4096);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

// What can be converted, by kind, and how it's named to a person.
export const KINDS = {
  pdf: 'PDF',
  jpeg: 'JPEG picture',
  png: 'PNG picture',
  text: 'text file',
  markdown: 'Markdown file',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'PowerPoint presentation',
};

export const REFUSED = {
  doc: 'This is an older Word document (.doc), which can’t be converted. Open it in Word or Pages, save it as a .docx file, and add that instead.',
  xls: 'This is an older Excel workbook (.xls), which can’t be converted. Open it in Excel or Numbers, save it as an .xlsx file, and add that instead.',
  ppt: 'This is an older PowerPoint presentation (.ppt), which can’t be converted. Open it in PowerPoint or Keynote, save it as a .pptx file, and add that instead.',
  ole: 'This is an older Office file, which can’t be converted. Open it in its app, save it in the newer format (.docx, .xlsx or .pptx), and add that instead.',
  odf: 'OpenDocument files (.odt, .ods, .odp) can’t be converted yet.',
};

export function createReport(kind) {
  const substituted = new Map();
  const missing = new Set();
  const notes = new Set();
  return {
    kind,
    substitute: (font, by) => substituted.set(font, by),
    missingGlyph: (char, font) => missing.add(`${font}: ${char}`),
    note: (text) => notes.add(text),
    toJSON: () => ({ kind, substituted: [...substituted].map(([font, by]) => ({ font, by })), missing: [...missing], notes: [...notes] }),
  };
}

export async function convert(bytes, { name = '' } = {}) {
  const kind = detect(bytes, name);
  if (REFUSED[kind]) throw Object.assign(new Error(REFUSED[kind]), { code: 'unsupported', kind });
  const report = createReport(kind);
  const title = name.replace(/\.[^.]+$/, '') || null;
  let result;
  if (kind === 'pdf') result = { pdf: bytes, pages: null };
  else if (kind === 'jpeg' || kind === 'png') result = imageToPdf(bytes);
  else if (kind === 'text') result = textToPdf(bytes.toString('utf8'), { report, title });
  else if (kind === 'markdown') result = markdownToPdf(bytes.toString('utf8'), { report, title });
  else if (kind === 'docx') result = (await import('./formats/docx.js')).docxToPdf(bytes, { report, title });
  else if (kind === 'xlsx') result = (await import('./formats/xlsx.js')).xlsxToPdf(bytes, { report, title });
  else if (kind === 'pptx') result = (await import('./formats/pptx.js')).pptxToPdf(bytes, { report, title });
  else throw Object.assign(new Error('This kind of file can’t be converted to a PDF.'), { code: 'unsupported', kind });
  return { pdf: result.pdf, kind, report: { ...report.toJSON(), pages: result.pages } };
}

// A conversion's report for the user, a sentence a line, or null when everything showed as it is:
// fonts replaced by ones of other widths (a stand-in with the same widths changes nothing), characters
// with no font, and what isn't drawn yet.
export function describeReport(report) {
  if (!report) return null;
  const lines = [];
  const fonts = report.substituted.filter((s) => METRIC_COMPATIBLE[s.font.toLowerCase()] !== s.by);
  if (fonts.length) lines.push(`${fonts.map((s) => `${s.font} is shown in ${s.by}`).join(', ')}, as ${fonts.length === 1 ? 'it isn’t' : 'they aren’t'} on this Mac, so some lines may break differently.`);
  if (report.missing.length) lines.push('Some characters have no font on this Mac, and show as boxes.');
  lines.push(...report.notes);
  return lines.length ? lines : null;
}
