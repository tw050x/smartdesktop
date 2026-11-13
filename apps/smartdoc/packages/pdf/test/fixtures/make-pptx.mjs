// Writes the PowerPoint test presentation (test/fixtures/pptx/deck.pptx) as PowerPoint writes one:
// the Office Theme's master (16:9) and its Title Slide, Title and Content, Title Only and Blank
// layouts, and a slide for each thing tested: a title slide, bullets at three levels, shapes,
// pictures, a table in PowerPoint's default style, text formatting, and a hidden slide. Run it with
// node; the presentation is kept in the repo so the reference PDFs made from it stay valid.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { writeZip } from '../../lib/zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'pptx');
mkdirSync(out, { recursive: true });

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>
<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="67000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="94000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="98000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const level = (n, { marL, indent, sz, before, bullet = true }) => `<a:lvl${n}pPr marL="${marL}" indent="${indent}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${before}"/></a:spcBef>${bullet ? '<a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="•"/>' : '<a:buNone/>'}<a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
const plainLevel = (n) => `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
const plainLevels = () => [1, 2, 3, 4, 5, 6, 7, 8, 9].map(plainLevel).join('');

const ph = (id, name, type, idx, { off, ext, body = '', lst = '', text = null } = {}) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${type ? ` type="${type}"` : ''}${idx != null ? ` idx="${idx}"` : ''}${type === 'dt' || type === 'ftr' || type === 'sldNum' ? ' sz="quarter"' : ''}/></p:nvPr></p:nvSpPr><p:spPr>${off ? `<a:xfrm><a:off x="${off[0]}" y="${off[1]}"/><a:ext cx="${ext[0]}" cy="${ext[1]}"/></a:xfrm>` : ''}${off && !text ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : ''}</p:spPr><p:txBody><a:bodyPr${body}/><a:lstStyle>${lst}</a:lstStyle>${text ?? '<a:p><a:endParaRPr lang="en-GB"/></a:p>'}</p:txBody></p:sp>`;
const tree = (shapes) => `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree>`;

const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${A}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${tree([
  ph(2, 'Title Placeholder 1', 'title', null, { off: [838200, 365125], ext: [10515600, 1325563], body: ' vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"', text: '<a:p><a:r><a:rPr lang="en-GB"/><a:t>Click to edit Master title style</a:t></a:r></a:p>' }),
  ph(3, 'Text Placeholder 2', 'body', 1, { off: [838200, 1825625], ext: [10515600, 4351338], body: ' vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"', text: '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-GB"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>' }),
  ph(4, 'Date Placeholder 3', 'dt', 2, { off: [838200, 6356350], ext: [2743200, 365125], body: ' anchor="ctr"', lst: '<a:lvl1pPr algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>' }),
  ph(5, 'Footer Placeholder 4', 'ftr', 3, { off: [4038600, 6356350], ext: [4114800, 365125], body: ' anchor="ctr"', lst: '<a:lvl1pPr algn="ctr"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>' }),
  ph(6, 'Slide Number Placeholder 5', 'sldNum', 4, { off: [8610600, 6356350], ext: [2743200, 365125], body: ' anchor="ctr"', lst: '<a:lvl1pPr algn="r"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>' }),
])}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${[1, 2, 3, 4].map((n) => `<p:sldLayoutId id="${2147483648 + n}" r:id="rId${n}"/>`).join('')}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${[
  level(1, { marL: 228600, indent: -228600, sz: 2800, before: 1000 }), level(2, { marL: 685800, indent: -228600, sz: 2400, before: 500 }), level(3, { marL: 1143000, indent: -228600, sz: 2000, before: 500 }),
  level(4, { marL: 1600200, indent: -228600, sz: 1800, before: 500 }), level(5, { marL: 2057400, indent: -228600, sz: 1800, before: 500 }), level(6, { marL: 2514600, indent: -228600, sz: 1800, before: 500 }),
  level(7, { marL: 2971800, indent: -228600, sz: 1800, before: 500 }), level(8, { marL: 3429000, indent: -228600, sz: 1800, before: 500 }), level(9, { marL: 3886200, indent: -228600, sz: 1800, before: 500 }),
].join('')}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${plainLevels()}</p:otherStyle></p:txStyles></p:sldMaster>`;

const layout = (name, type, shapes) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${A} type="${type}" preserve="1"><p:cSld name="${name}">${tree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const footers = [ph(4, 'Date Placeholder 3', 'dt', 10), ph(5, 'Footer Placeholder 4', 'ftr', 11), ph(6, 'Slide Number Placeholder 5', 'sldNum', 12)];
const LAYOUTS = [
  layout('Title Slide', 'title', [
    ph(2, 'Title 1', 'ctrTitle', null, { off: [1524000, 1122363], ext: [9144000, 2387600], body: ' anchor="b"', lst: '<a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr>' }),
    ph(3, 'Subtitle 2', 'subTitle', 1, { off: [1524000, 3602038], ext: [9144000, 1655762], lst: '<a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr>' }),
    ...footers,
  ]),
  layout('Title and Content', 'obj', [ph(2, 'Title 1', 'title'), ph(3, 'Content Placeholder 2', null, 1), ...footers]),
  layout('Title Only', 'titleOnly', [ph(2, 'Title 1', 'title'), ...footers]),
  layout('Blank', 'blank', footers),
];

// --- Slides --------------------------------------------------------------------------------------

const run = (text, rPr = '') => `<a:r><a:rPr lang="en-GB" dirty="0"${rPr.startsWith(' ') ? rPr.split('>')[0] : ''}>${rPr.startsWith(' ') ? rPr.slice(rPr.indexOf('>') + 1) : rPr}</a:rPr><a:t>${esc(text)}</a:t></a:r>`;
const para = (runs, pPr = '') => `<a:p>${pPr}${[].concat(runs).map((r) => (r.startsWith('<a:') ? r : run(r))).join('')}</a:p>`;
const slideXml = (shapes, { hidden = false, layoutRel = 'rId1' } = {}) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${A}${hidden ? ' show="0"' : ''}><p:cSld>${tree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
const slidePh = (id, type, idx, paragraphs) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${type ?? 'Content'} ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${type ? ` type="${type}"` : ''}${idx != null ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
const shape = (id, prst, box, { fill = 'accent1', line = 'shade', text = null, rot = 0, flipH = false, noFill = false, outline = null, txBox = false, body = '' } = {}) => {
  // Positions are whole EMUs (PowerPoint repairs a file with fractions).
  const [x, y, w, h] = box.map(Math.round);
  const style = txBox ? '' : `<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="${fill}"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>`;
  const spFill = noFill ? '<a:noFill/>' : txBox ? '<a:noFill/>' : '';
  const ln = outline ? `<a:ln w="${outline.w}"><a:solidFill><a:srgbClr val="${outline.color}"/></a:solidFill>${outline.dash ? `<a:prstDash val="${outline.dash}"/>` : ''}${outline.tail ? '<a:tailEnd type="triangle"/>' : ''}</a:ln>` : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${prst} ${id}"/><p:cNvSpPr${txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${rot ? ` rot="${rot * 60000}"` : ''}${flipH ? ' flipH="1"' : ''}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${spFill}${ln}</p:spPr>${style}${text != null ? `<p:txBody><a:bodyPr${txBox ? ' wrap="square" rtlCol="0"' : ' rtlCol="0" anchor="ctr"'}${body}>${txBox ? '<a:spAutoFit/>' : ''}</a:bodyPr><a:lstStyle/>${[].concat(text).map((t) => (t.startsWith('<a:p>') ? t : para(t, txBox ? '' : '<a:pPr algn="ctr"/>'))).join('')}</p:txBody>` : ''}</p:sp>`;
};
const EMU_IN = 914400;

const slides = [];
// 1. A title slide.
slides.push({ layout: 1, xml: slideXml([slidePh(2, 'ctrTitle', null, [para('Quarterly review')]), slidePh(3, 'subTitle', 1, [para('Prepared for the board · November 2026')])]) });
// 2. Bullets at three levels, one long enough to wrap.
slides.push({ layout: 2, xml: slideXml([slidePh(2, 'title', null, [para('What we found')]), slidePh(3, null, 1, [
  para('Revenue grew in every region'),
  para('North led, with a third of new customers', '<a:pPr lvl="1"/>'),
  para('Most came through partners', '<a:pPr lvl="2"/>'),
  para('Costs held steady while the team grew'),
  para('Support response times fell from a day and a half to under six hours, the biggest change of the year, and customers noticed'),
  para('Next: expand into two new markets'),
])]) });
// 3. Shapes: fills, outlines, a rotated one, an arrow, a line, and a text box with mixed formatting.
slides.push({ layout: 4, xml: slideXml([
  shape(2, 'rect', [0.6 * EMU_IN, 0.6 * EMU_IN, 2.4 * EMU_IN, 1.2 * EMU_IN], { text: 'Rectangle' }),
  shape(3, 'ellipse', [3.4 * EMU_IN, 0.6 * EMU_IN, 2.0 * EMU_IN, 1.2 * EMU_IN], { fill: 'accent2', text: 'Ellipse' }),
  shape(4, 'roundRect', [5.8 * EMU_IN, 0.6 * EMU_IN, 2.4 * EMU_IN, 1.2 * EMU_IN], { noFill: true, outline: { w: 28575, color: '70AD47' }, text: [para([run('Outlined', '<a:solidFill><a:srgbClr val="70AD47"/></a:solidFill>')], '<a:pPr algn="ctr"/>')] }),
  shape(5, 'rightArrow', [8.6 * EMU_IN, 0.7 * EMU_IN, 2.4 * EMU_IN, 1.0 * EMU_IN], { fill: 'accent4' }),
  shape(6, 'rect', [1.0 * EMU_IN, 2.6 * EMU_IN, 2.0 * EMU_IN, 1.0 * EMU_IN], { fill: 'accent5', rot: 30, text: 'Turned' }),
  shape(7, 'triangle', [3.8 * EMU_IN, 2.4 * EMU_IN, 1.6 * EMU_IN, 1.4 * EMU_IN], { fill: 'accent6' }),
  shape(8, 'hexagon', [6.0 * EMU_IN, 2.4 * EMU_IN, 1.8 * EMU_IN, 1.4 * EMU_IN], { fill: 'accent3', text: 'Six' }),
  shape(9, 'line', [8.4 * EMU_IN, 2.6 * EMU_IN, 3.0 * EMU_IN, 1.0 * EMU_IN], { noFill: true, outline: { w: 19050, color: 'C00000', dash: 'dash', tail: true } }),
  shape(10, 'rect', [0.6 * EMU_IN, 4.4 * EMU_IN, 10.8 * EMU_IN, 2.0 * EMU_IN], { txBox: true, text: [
    para([run('A text box with '), run('bold', ' b="1">'), run(', '), run('italic', ' i="1">'), run(', '), run('red', '<a:solidFill><a:srgbClr val="C00000"/></a:solidFill>'), run(' and '), run('larger', ' sz="2800">'), run(' words, long enough to wrap onto a second line inside its box.')]),
    para('A second paragraph, aligned right.', '<a:pPr algn="r"/>'),
  ] }),
]) });
// 4. Pictures: one whole, one cropped.
slides.push({ layout: 3, media: true, xml: slideXml([slidePh(2, 'title', null, [para('Pictures')]),
  `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 2"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(0.9 * EMU_IN)}" y="${2 * EMU_IN}"/><a:ext cx="${4 * EMU_IN}" cy="${2 * EMU_IN}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="25000" r="25000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${6 * EMU_IN}" y="${2 * EMU_IN}"/><a:ext cx="${2 * EMU_IN}" cy="${2 * EMU_IN}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
]) });
// 5. A table in PowerPoint's default style (Medium Style 2, accent 1).
{
  const cell = (t, extra = '') => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(t, extra)}</a:txBody><a:tcPr/></a:tc>`;
  const rows = [['Region', 'Q1', 'Q2'], ['North', '£1,200', '£1,450'], ['South', '£980', '£1,020'], ['East', '£760', '£890']];
  const w = 3200400;
  const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table 2"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="1825625"/><a:ext cx="${3 * w}" cy="1483360"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${`<a:gridCol w="${w}"/>`.repeat(3)}</a:tblGrid>${rows.map((r) => `<a:tr h="370840">${r.map((t, i) => cell(t, i ? '<a:pPr algn="r"/>' : '')).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  slides.push({ layout: 3, xml: slideXml([slidePh(2, 'title', null, [para('Revenue by region')]), table]) });
}
// 6. Text: alignment, sizes, a numbered list.
slides.push({ layout: 3, xml: slideXml([slidePh(2, 'title', null, [para('Text')]),
  shape(3, 'rect', [838200, 1690688, 10515600, 4486275], { txBox: true, text: [
    para('Centred, at 24 points', '<a:pPr algn="ctr"/>').replace('<a:rPr lang="en-GB" dirty="0">', '<a:rPr lang="en-GB" sz="2400" dirty="0">'),
    para('Left, at the default size'),
    para('First numbered step', '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
    para('Second numbered step', '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
    para('Third numbered step', '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
    para('Small grey closing line', '').replace('<a:rPr lang="en-GB" dirty="0">', '<a:rPr lang="en-GB" sz="1200" dirty="0"><a:solidFill><a:srgbClr val="7F7F7F"/></a:solidFill>'),
  ] }),
]) });
// 7. Hidden: left out of the PDF.
slides.push({ layout: 2, hidden: true, xml: slideXml([slidePh(2, 'title', null, [para('Hidden slide')])], { hidden: true }) });

// --- The package ---------------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const band = Math.floor((x / width) * 4);
      const colors = [[0x44, 0x72, 0xc4], [0xed, 0x7d, 0x31], [0xa5, 0xa5, 0xa5], [0x70, 0xad, 0x47]];
      const sky = y < height * 0.5;
      const [r, g, b] = sky ? colors[band] : [0xff, 0xff, 0xff];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
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

const files = {};
const n = slides.length;
files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>${LAYOUTS.map((_, i) => `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`).join('')}${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/></Types>`;
files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
files['ppt/_rels/presentation.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${T}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 2}" Type="${T}/presProps" Target="presProps.xml"/><Relationship Id="rId${n + 3}" Type="${T}/viewProps" Target="viewProps.xml"/><Relationship Id="rId${n + 4}" Type="${T}/theme" Target="theme/theme1.xml"/><Relationship Id="rId${n + 5}" Type="${T}/tableStyles" Target="tableStyles.xml"/></Relationships>`;
files['ppt/presentation.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${A} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${plainLevels()}</p:defaultTextStyle></p:presentation>`;
files['ppt/presProps.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr ${A}/>`;
files['ppt/viewProps.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr ${A}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`;
files['ppt/tableStyles.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;
files['ppt/theme/theme1.xml'] = THEME;
files['ppt/slideMasters/slideMaster1.xml'] = MASTER;
files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${LAYOUTS.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${T}/slideLayout" Target="../slideLayouts/slideLayout${i + 1}.xml"/>`).join('')}<Relationship Id="rId${LAYOUTS.length + 1}" Type="${T}/theme" Target="../theme/theme1.xml"/></Relationships>`;
LAYOUTS.forEach((xml, i) => {
  files[`ppt/slideLayouts/slideLayout${i + 1}.xml`] = xml;
  files[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
});
slides.forEach((s, i) => {
  files[`ppt/slides/slide${i + 1}.xml`] = s.xml;
  files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/slideLayout" Target="../slideLayouts/slideLayout${s.layout}.xml"/>${s.media ? `<Relationship Id="rId2" Type="${T}/image" Target="../media/image1.png"/>` : ''}</Relationships>`;
});
files['ppt/media/image1.png'] = makePng(400, 200);
writeFileSync(path.join(out, 'deck.pptx'), writeZip(files));
