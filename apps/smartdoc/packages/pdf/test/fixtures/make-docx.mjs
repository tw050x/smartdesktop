// Writes the Word test documents (test/fixtures/docx/*.docx), each as Word itself writes one: the
// package's parts, Word's document defaults (Calibri 11 pt, 8 pt after each paragraph, 1.08 line
// spacing, the Office theme), its built-in styles, and the feature the document tests. Run it with
// node; the documents are kept in the repo so the comparison PDFs made from them stay valid.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { writeZip } from '../../lib/zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'docx');
mkdirSync(out, { recursive: true });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>
<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

// Word's built-in styles as a new document from Word has them.
const STYLES = (extra = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading1Char"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4513"/><w:tab w:val="right" w:pos="9026"/></w:tabs><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4513"/><w:tab w:val="right" w:pos="9026"/></w:tabs><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
${extra}
</w:styles>`;

const SETTINGS = (extra = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>${extra}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const A4 = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/>';

// A paragraph: text runs as [text, rPr] pairs or plain strings, with optional pPr.
const p = (runs, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${[].concat(runs).map((r) => (typeof r === 'string' && !r.startsWith('<w:') ? run(r) : r)).join('')}</w:p>`;
const run = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const tab = (rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:tab/></w:r>`;
const field = (instr, shown) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${shown}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;

function docx(name, { body, styles = '', numbering = null, headers = {}, footnotes = null, media = {}, rels = [], settings = '' }) {
  const relList = [
    ['rId1', 'styles', 'styles.xml'],
    ['rId2', 'settings', 'settings.xml'],
    ['rId3', 'theme', 'theme/theme1.xml'],
    ...(numbering ? [['rId4', 'numbering', 'numbering.xml']] : []),
    ...(footnotes ? [['rId5', 'footnotes', 'footnotes.xml']] : []),
    ...Object.keys(headers).map((part, i) => [`rIdH${i}`, part.startsWith('header') ? 'header' : 'footer', `${part}.xml`]),
    ...Object.keys(media).map((m) => [`rIdM_${m.replace(/\W/g, '')}`, 'image', `media/${m}`]),
    ...rels,
  ];
  const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${numbering ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : ''}${footnotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ''}${Object.keys(headers).map((h) => `<Override PartName="/word/${h}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${h.startsWith('header') ? 'header' : 'footer'}+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relList.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${T}/${type}" Target="${esc(target)}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': STYLES(styles),
    'word/settings.xml': SETTINGS(settings),
    'word/theme/theme1.xml': THEME,
  };
  if (numbering) files['word/numbering.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>${numbering}</w:numbering>`;
  if (footnotes) files['word/footnotes.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${footnotes}</w:footnotes>`;
  for (const [part, xml] of Object.entries(headers)) files[`word/${part}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${part.startsWith('header') ? 'hdr' : 'ftr'} ${W}>${xml}</w:${part.startsWith('header') ? 'hdr' : 'ftr'}>`;
  for (const [m, data] of Object.entries(media)) files[`word/media/${m}`] = data;
  writeFileSync(path.join(out, `${name}.docx`), writeZip(files));
}

const LOREM = 'Good documents are read quickly. A reader skims the first lines of each paragraph, looks for the numbers that matter, and decides within seconds whether to read on. Every sentence should earn its place, and every heading should tell the reader what follows, so the structure of the document carries its meaning even before the words do.';
const LOREM2 = 'Long paragraphs are harder to read on screen than on paper, so this one runs on deliberately: it gives the layout engine several lines to break, to justify and to carry across a page boundary, which is where widow and orphan control decides whether a single line may be left behind on its own.';

// 1. A letter: alignment, emphasis, spacing, a justified paragraph.
docx('letter', {
  body: [
    p('Alex Example', '<w:jc w:val="right"/>'),
    p('12 High Street, London', '<w:jc w:val="right"/>'),
    p('12 November 2026', '<w:jc w:val="right"/>'),
    p('Dear Ms Taylor,'),
    p([run('I am writing to apply for the role of '), run('Engineering Lead', '<w:b/>'), run(' advertised on your website. '), run('In short:', '<w:i/>'), run(' I have spent twelve years building the tools that let product teams ship faster and more safely.')]),
    p(LOREM, '<w:jc w:val="both"/>'),
    p(LOREM2, '<w:jc w:val="both"/>'),
    p([run('A centred line, in red.', '<w:color w:val="C00000"/>')], '<w:jc w:val="center"/>'),
    p([run('Underlined', '<w:u w:val="single"/>'), run(', '), run('struck', '<w:strike/>'), run(', '), run('highlighted', '<w:highlight w:val="yellow"/>'), run(', and '), run('small caps', '<w:smallCaps/>'), run(' with H'), run('2', '<w:vertAlign w:val="subscript"/>'), run('O and x'), run('2', '<w:vertAlign w:val="superscript"/>'), run('.')]),
    p('Yours sincerely,'),
    p(''),
    p('Alex Example'),
    `<w:sectPr>${A4}</w:sectPr>`,
  ].join(''),
});

// 2. Lists: bullets and numbers, three levels.
const ABSTRACT = (id, formats) => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${formats.map(([fmt, text, font], l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>` : ''}</w:lvl>`).join('')}</w:abstractNum>`;
docx('lists', {
  numbering: [
    ABSTRACT(0, [['bullet', '', 'Symbol'], ['bullet', 'o', 'Courier New'], ['bullet', '', 'Wingdings']]),
    ABSTRACT(1, [['decimal', '%1.'], ['lowerLetter', '%2.'], ['lowerRoman', '%3.']]),
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
  ].join(''),
  body: [
    p('Things to bring:'),
    ...[[0, 'A notebook'], [0, 'Two pens'], [1, 'one blue'], [1, 'one black'], [2, 'spare refills'], [0, 'Your badge']].map(([l, t]) => p(t, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${l}"/><w:numId w:val="1"/></w:numPr>`)),
    p('Steps:'),
    ...[[0, 'Arrive at nine'], [0, 'Sign in at reception'], [1, 'Show your badge'], [1, 'Collect a visitor pass'], [2, 'Keep it visible'], [0, 'Go to the third floor'], [0, 'Wait in the meeting room, where coffee and water are provided, and the session will start shortly after everyone has arrived.']].map(([l, t]) => p(t, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${l}"/><w:numId w:val="2"/></w:numPr>`)),
    `<w:sectPr>${A4}</w:sectPr>`,
  ].join(''),
});

// 3. A table: borders, a shaded header row, a merged cell, set column widths.
const cell = (text, w, extra = '', pPr = '') => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${extra}</w:tcPr>${p(text, pPr)}</w:tc>`;
docx('table', {
  body: [
    p('Quarterly results', '<w:pStyle w:val="Heading1"/>'),
    p('The table below shows revenue by region.'),
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="3005"/><w:gridCol w:w="3005"/><w:gridCol w:w="3006"/></w:tblGrid>
<w:tr><w:trPr><w:tblHeader/></w:trPr>${['Region', 'Q1', 'Q2'].map((t, i) => cell([run(t, '<w:b/>')], i === 2 ? 3006 : 3005, '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>')).join('')}</w:tr>
<w:tr>${cell('North', 3005)}${cell('£1,200', 3005, '', '<w:jc w:val="right"/>')}${cell('£1,450', 3006, '', '<w:jc w:val="right"/>')}</w:tr>
<w:tr>${cell('South, including the islands and the coastal towns', 3005)}${cell('£980', 3005, '', '<w:jc w:val="right"/>')}${cell('£1,020', 3006, '', '<w:jc w:val="right"/>')}</w:tr>
<w:tr>${cell('Total', 3005)}${cell([run('£4,650 across both quarters', '<w:b/>')], 6011, '<w:gridSpan w:val="2"/>', '<w:jc w:val="center"/>')}</w:tr>
</w:tbl>`,
    p(''),
    p('Figures are unaudited.'),
    `<w:sectPr>${A4}</w:sectPr>`,
  ].join(''),
});

// 4. Several pages with a header and a footer giving the page number, a different first page.
const paras = [];
for (let i = 1; i <= 14; i++) {
  paras.push(p(`Section ${i}`, '<w:pStyle w:val="Heading2"/>'));
  paras.push(p(i % 2 ? LOREM : LOREM2, '<w:jc w:val="both"/>'));
  paras.push(p(LOREM));
}
docx('headers', {
  headers: {
    header1: p([run('Annual report'), tab(), tab(), run('Confidential', '<w:i/>')], '<w:pStyle w:val="Header"/>'),
    footer1: p([tab(), run('Page '), field('PAGE', '2'), run(' of '), field('NUMPAGES', '4')], '<w:pStyle w:val="Footer"/>'),
    header2: p([run('First page header', '<w:b/>')], '<w:pStyle w:val="Header"/>'),
  },
  body: [p('Annual report', '<w:pStyle w:val="Title"/>'), ...paras, `<w:sectPr><w:headerReference w:type="default" r:id="rIdH0"/><w:footerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="first" r:id="rIdH2"/>${A4}<w:titlePg/></w:sectPr>`].join(''),
});

// 5. Sections: portrait, then landscape in two columns.
docx('sections', {
  body: [
    p('Portrait section', '<w:pStyle w:val="Heading1"/>'),
    p(LOREM),
    p('', `<w:sectPr>${A4}</w:sectPr>`),
    p('Landscape, two columns', '<w:pStyle w:val="Heading1"/>'),
    p(LOREM, '<w:jc w:val="both"/>'),
    p(LOREM2, '<w:jc w:val="both"/>'),
    p(LOREM, '<w:jc w:val="both"/>'),
    `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:num="2" w:space="708"/></w:sectPr>`,
  ].join(''),
});

// 6. A picture in the text: a PNG 2 inches wide.
const png = makePng(240, 120);
const picture = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1828800" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="chart.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdM_chartpng"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
docx('image', {
  media: { 'chart.png': png },
  body: [p('A picture follows.'), `<w:p>${picture}</w:p>`, p('And text after it.'), `<w:sectPr>${A4}</w:sectPr>`].join(''),
});

// 7. Footnotes.
docx('footnotes', {
  footnotes: `<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> The first source.</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> The second, a longer note that runs on to show how footnote text wraps across the width of the page.</w:t></w:r></w:p></w:footnote>`,
  body: [p([run('A claim that needs a source.'), '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>', run(' Another one.'), '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="2"/></w:r>']), p(LOREM), `<w:sectPr>${A4}</w:sectPr>`].join(''),
});

// 8. Headings, a hyperlink and a contents-style line with a dotted right tab.
docx('styles', {
  rels: [['rIdL1', 'hyperlink', 'https://smartdoc.tw050x.net/', 'External']],
  body: [
    p('Contents', '<w:pStyle w:val="Heading1"/>'),
    ...[['Introduction', '1'], ['Method', '3'], ['Results and discussion', '12']].map(([t, n]) => p([run(t), tab(), run(n)], '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9016"/></w:tabs>')),
    p('Introduction', '<w:pStyle w:val="Heading1"/>'),
    p([run('See '), `<w:hyperlink r:id="rIdL1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the SmartDoc website</w:t></w:r></w:hyperlink>`, run(' for more.')]),
    p('Method', '<w:pStyle w:val="Heading2"/>'),
    p([run('Name:'), tab(), run('Alex Example')], '<w:tabs><w:tab w:val="left" w:pos="2160"/></w:tabs>'),
    p([run('Amount:'), tab(), run('1,234.56')], '<w:tabs><w:tab w:val="decimal" w:pos="4320"/></w:tabs>'),
    p([run('Centred:'), tab(), run('middle')], '<w:tabs><w:tab w:val="center" w:pos="4513"/></w:tabs>'),
    `<w:sectPr>${A4}</w:sectPr>`,
  ].join(''),
});

console.log('Wrote', out);

// A small PNG: a blue bar chart on white, drawn pixel by pixel.
function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const bars = [0.4, 0.75, 0.55, 0.9];
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const bar = Math.floor((x / width) * bars.length);
      const inBar = (x % (width / bars.length)) > 10 && (x % (width / bars.length)) < width / bars.length - 10 && y > height * (1 - bars[bar]);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = inBar ? 0x44 : 0xff;
      raw[o + 1] = inBar ? 0x72 : 0xff;
      raw[o + 2] = inBar ? 0xc4 : 0xff;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(data) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
