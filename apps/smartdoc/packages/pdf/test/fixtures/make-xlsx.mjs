// Writes the Excel test workbooks (test/fixtures/xlsx/*.xlsx), each as Excel writes one: its parts,
// the Office theme, Excel's default styles (Calibri 11, the Normal style), and the feature the
// workbook tests. Run it with node; the workbooks are kept in the repo so the reference PDFs made
// from them stay valid.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../../lib/zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'xlsx');
mkdirSync(out, { recursive: true });

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>
<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

// Styles, gathered as cells ask for them: a style is { font, fill, border, format, align }, each
// part as Excel writes it.
function styleBook() {
  const fonts = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const formats = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const index = (list, item) => {
    const at = list.indexOf(item);
    if (at >= 0) return at;
    list.push(item);
    return list.length - 1;
  };
  const style = ({ font = {}, fill = null, border = null, format = null, align = null } = {}) => {
    const f = font.name || font.b || font.i || font.sz || font.color || font.u || font.strike
      ? index(fonts, `<font>${font.b ? '<b/>' : ''}${font.i ? '<i/>' : ''}${font.strike ? '<strike/>' : ''}${font.u ? `<u${font.u === 'double' ? ' val="double"' : ''}/>` : ''}<sz val="${font.sz ?? 11}"/>${font.color ? `<color rgb="FF${font.color}"/>` : '<color theme="1"/>'}<name val="${font.name ?? 'Calibri'}"/><family val="2"/>${font.name ? '' : '<scheme val="minor"/>'}</font>`)
      : 0;
    const fi = fill ? index(fills, `<fill><patternFill patternType="solid"><fgColor ${fill.theme != null ? `theme="${fill.theme}"${fill.tint ? ` tint="${fill.tint}"` : ''}` : `rgb="FF${fill}"`}/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (name, s) => (s ? `<${name} style="${s.style ?? s}"><color ${s.color ? `rgb="FF${s.color}"` : 'indexed="64"'}/></${name}>` : `<${name}/>`);
    const b = border ? index(borders, `<border>${side('left', border.left)}${side('right', border.right)}${side('top', border.top)}${side('bottom', border.bottom)}<diagonal/></border>`) : 0;
    let n = 0;
    if (typeof format === 'number') n = format;
    else if (format === 'General') n = 0;
    else if (format) {
      const at = formats.indexOf(format);
      n = 164 + (at >= 0 ? at : formats.push(format) - 1);
    }
    const a = align ? `<alignment${Object.entries(align).map(([k, v]) => ` ${k}="${v}"`).join('')}/>` : '';
    const xf = `<xf numFmtId="${n}" fontId="${f}" fillId="${fi}" borderId="${b}" xfId="0"${n ? ' applyNumberFormat="1"' : ''}${f ? ' applyFont="1"' : ''}${fi ? ' applyFill="1"' : ''}${b ? ' applyBorder="1"' : ''}${a ? ' applyAlignment="1">' + a + '</xf>' : '/>'}`;
    return index(xfs, xf);
  };
  const xml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet ${NS}>${formats.length ? `<numFmts count="${formats.length}">${formats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
  return { style, xml };
}

const colName = (c) => {
  let s = '';
  for (let k = c; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
};

// A workbook: sheets as { name, rows: [[cell…]…] (cell: value, or { v, s, f }), cols: [[min, max,
// width]], heights: { row: pt }, merges: ['A1:D1'], page: {…} }.
function workbook(name, sheets, { names = [] } = {}) {
  const styles = styleBook();
  const strings = [];
  const stringIndex = new Map();
  const sst = (t) => {
    if (!stringIndex.has(t)) {
      stringIndex.set(t, strings.length);
      strings.push(t);
    }
    return stringIndex.get(t);
  };
  const files = {};
  sheets.forEach((sheet, si) => {
    const rowsXml = sheet.rows.map((row, ri) => {
      const r = ri + 1;
      const cells = row.map((cell, ci) => {
        if (cell == null) return '';
        const ref = `${colName(ci + 1)}${r}`;
        const c = typeof cell === 'object' && !Array.isArray(cell) && !(cell instanceof Date) ? cell : { v: cell };
        const s = c.style ? styles.style(c.style) : 0;
        const sAttr = s ? ` s="${s}"` : '';
        const f = c.f ? `<f>${esc(c.f)}</f>` : '';
        if (c.v == null) return `<c r="${ref}"${sAttr}/>`;
        if (c.rich) {
          const runs = c.rich.map(([t, rPr]) => `<r>${rPr ? `<rPr>${rPr}</rPr>` : ''}<t xml:space="preserve">${esc(t)}</t></r>`).join('');
          strings.push({ rich: runs });
          return `<c r="${ref}"${sAttr} t="s"><v>${strings.length - 1}</v></c>`;
        }
        if (typeof c.v === 'string') return `<c r="${ref}"${sAttr} t="${c.f ? 'str' : 's'}">${f}<v>${c.f ? esc(c.v) : sst(c.v)}</v></c>`;
        if (typeof c.v === 'boolean') return `<c r="${ref}"${sAttr} t="b">${f}<v>${c.v ? 1 : 0}</v></c>`;
        return `<c r="${ref}"${sAttr}>${f}<v>${c.v}</v></c>`;
      }).join('');
      const ht = sheet.heights?.[r];
      return `<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells}</row>`;
    }).join('');
    const p = sheet.page ?? {};
    const cols = sheet.cols?.length ? `<cols>${sheet.cols.map(([min, max, width]) => `<col min="${min}" max="${max}" width="${width}" customWidth="1"/>`).join('')}</cols>` : '';
    const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const printOptions = p.gridLines || p.centerH ? `<printOptions${p.centerH ? ' horizontalCentered="1"' : ''}${p.gridLines ? ' gridLines="1"' : ''}/>` : '';
    const setup = `<pageSetup paperSize="${p.paper ?? 9}"${p.scale ? ` scale="${p.scale}"` : ''}${p.fitWidth != null ? ` fitToWidth="${p.fitWidth}" fitToHeight="${p.fitHeight ?? 0}"` : ''} orientation="${p.landscape ? 'landscape' : 'portrait'}"/>`;
    const hf = p.footer || p.header ? `<headerFooter>${p.header ? `<oddHeader>${esc(p.header)}</oddHeader>` : ''}${p.footer ? `<oddFooter>${esc(p.footer)}</oddFooter>` : ''}</headerFooter>` : '';
    const last = `${colName(Math.max(1, ...sheet.rows.map((r) => r.length)))}${sheet.rows.length}`;
    files[`xl/worksheets/sheet${si + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}>${p.fitWidth != null ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ''}<dimension ref="A1:${last}"/><sheetViews><sheetView${si === 0 ? ' tabSelected="1"' : ''} workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"/>${cols}<sheetData>${rowsXml}</sheetData>${merges}${printOptions}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${setup}${hf}</worksheet>`;
  });
  const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const n = sheets.length;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${T}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="${T}/theme" Target="theme/theme1.xml"/><Relationship Id="rId${n + 2}" Type="${T}/styles" Target="styles.xml"/><Relationship Id="rId${n + 3}" Type="${T}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><workbookPr defaultThemeVersion="166925"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${names.length ? `<definedNames>${names.map(([nm, sheet, ref]) => `<definedName name="${nm}" localSheetId="${sheet}">${esc(ref)}</definedName>`).join('')}</definedNames>` : ''}<calcPr calcId="191029"/></workbook>`;
  files['xl/theme/theme1.xml'] = THEME;
  files['xl/styles.xml'] = styles.xml();
  files['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((t) => (typeof t === 'object' ? `<si>${t.rich}</si>` : `<si><t xml:space="preserve">${esc(t)}</t></si>`)).join('')}</sst>`;
  writeFileSync(path.join(out, `${name}.xlsx`), writeZip(files));
}

const bold = { font: { b: true } };
const money = '"£"#,##0.00';

// 1. A budget: a merged title, a header row with a fill and a border, money, percentages, dates,
// a total with a top and double bottom border.
{
  const head = (t) => ({ v: t, style: { font: { b: true }, fill: { theme: 4, tint: '0.79998168889431442' }, border: { bottom: 'thin' } } });
  const items = [['Rent', 1200, 0.32, 45231], ['Salaries', 1850.5, 0.49, 45245], ['Software', 310.25, 0.08, 45260], ['Travel', 420, 0.11, 45275]];
  workbook('budget', [{
    name: 'Budget',
    cols: [[1, 1, 18.7109375], [2, 2, 12.7109375], [3, 3, 10.7109375], [4, 4, 13.7109375]],
    merges: ['A1:D1'],
    heights: { 1: 21 },
    rows: [
      [{ v: 'Quarterly budget', style: { font: { b: true, sz: 16 }, align: { horizontal: 'center' } } }],
      [],
      [head('Item'), head('Amount'), head('Share'), head('Due')],
      ...items.map(([a, b, c, d]) => [a, { v: b, style: { format: money } }, { v: c, style: { format: 9 } }, { v: d, style: { format: 'd mmm yyyy' } }]),
      [{ v: 'Total', style: { font: { b: true }, border: { top: 'thin', bottom: 'double' } } }, { v: 3780.75, f: 'SUM(B4:B7)', style: { font: { b: true }, format: money, border: { top: 'thin', bottom: 'double' } } }, { v: 1, f: 'SUM(C4:C7)', style: { format: 9, border: { top: 'thin', bottom: 'double' } } }, { v: null, style: { border: { top: 'thin', bottom: 'double' } } }],
    ],
  }]);
}

// 2. A long list over several pages: its header row repeated on each, gridlines printed, a footer
// numbering the pages.
{
  const regions = ['North', 'South', 'East', 'West'];
  const rows = [[{ v: 'Order', ...bold, style: bold }, { v: 'Region', style: bold }, { v: 'Customer', style: bold }, { v: 'Units', style: bold }, { v: 'Value', style: bold }]];
  for (let i = 1; i <= 150; i++) rows.push([1000 + i, regions[i % 4], `Customer ${String.fromCharCode(65 + (i % 26))}${i}`, (i * 7) % 40 + 1, { v: Math.round(((i * 37.5) % 900 + 12.25) * 100) / 100, style: { format: '#,##0.00' } }]);
  workbook('long', [{ name: 'Orders', cols: [[1, 1, 9.140625], [2, 2, 10.7109375], [3, 3, 16.7109375], [4, 5, 10.7109375]], rows, page: { gridLines: true, footer: '&CPage &P of &N' } }], { names: [['_xlnm.Print_Titles', 0, 'Orders!$1:$1']] });
}

// 3. A wide sheet: more columns than a landscape page holds, so pages go across; and the same,
// fitted to one page wide.
{
  const make = (name, page) => {
    const rows = [Array.from({ length: 24 }, (_, c) => ({ v: `Month ${c + 1}`, style: bold }))];
    for (let r = 1; r <= 30; r++) rows.push(Array.from({ length: 24 }, (_, c) => ((r * 13 + c * 7) % 97) * 10 + c));
    return { name, rows, page };
  };
  workbook('wide', [make('Across', { landscape: true }), make('Fitted', { landscape: true, fitWidth: 1, fitHeight: 0 })]);
}

// 4. Text: running over empty neighbours, cut off by full ones, wrapped, aligned, indented; a
// number too wide for its column; General's decimals; rich text; sizes and colours; tall rows.
{
  const long = 'This sentence is longer than its column, so it runs over the empty cells beside it.';
  workbook('text', [{
    name: 'Text',
    cols: [[1, 1, 14.7109375], [2, 4, 12.7109375]],
    heights: { 7: 48, 8: 48 },
    rows: [
      [long],
      ['Cut off by the next cell, which is full.', 'Full'],
      [{ v: 'Right', style: { align: { horizontal: 'right' } } }, { v: 'Centred', style: { align: { horizontal: 'center' } } }, { v: 'Indented', style: { align: { indent: 2 } } }],
      [{ v: 123456789, style: { format: '#,##0.00' } }, 1 / 3, 1234567.891, true],
      [{ v: 'Red and big', style: { font: { sz: 16, color: 'C00000' } } }, { v: 'Small italic', style: { font: { sz: 9, i: true } } }, { v: 'Underlined', style: { font: { u: true } } }, { v: 'Struck', style: { font: { strike: true } } }],
      [{ v: 'mixed', rich: [['Bold', '<b/><sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/>'], [' then plain', '<sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/>']] }],
      [{ v: 'Wrapped text in a cell, broken over several lines to fit its column.', style: { align: { wrapText: 1, vertical: 'top' } } }, { v: 'Middle', style: { align: { vertical: 'center' } } }, { v: 'Top', style: { align: { vertical: 'top' } } }, 'Bottom'],
      [{ v: 'Centred and wrapped across the middle of a tall row.', style: { align: { wrapText: 1, horizontal: 'center', vertical: 'center' } } }],
      [{ v: 'Arial 10', style: { font: { name: 'Arial', sz: 10 } } }, { v: 'Times 12', style: { font: { name: 'Times New Roman', sz: 12 } } }],
    ],
  }]);
}

// 5. Number formats, one a row: what the value is and how it shows.
{
  const cases = [
    [1234.5678, 'General'], [-1234.5678, '#,##0.00'], [0.4567, '0.0%'], [1234.5, money], [-1234.5, '"£"#,##0.00;[Red]-"£"#,##0.00'],
    [-42, '#,##0_);(#,##0)'], [0, '0.00;-0.00;"–"'], [12345678, '#,##0,,"M"'], [0.000123, '0.00E+00'], [1.75, '# ?/?'],
    [45242, 'dddd d mmmm yyyy'], [45242.6875, 'yyyy-mm-dd hh:mm'], [0.6875, 'h:mm AM/PM'], [1.25, '[h]:mm'], [5551234567, '000-000-0000'],
    [1234.5, 44], [0, 44], [-1234.5, 44], ['text', '"Note: "@'], [7, '00000'],
  ];
  workbook('formats', [{
    name: 'Formats',
    cols: [[1, 1, 30.7109375], [2, 2, 26.7109375]],
    rows: [[{ v: 'Format', style: bold }, { v: 'Shows', style: bold }], ...cases.map(([v, f]) => [typeof f === 'number' ? `Built-in ${f}` : f, { v, style: { format: f } }])],
  }]);
}
