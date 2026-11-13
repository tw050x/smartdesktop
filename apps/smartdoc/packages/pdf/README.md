# @smartdoc/pdf

Turns documents into PDFs with no other program and no dependencies: Word (.docx), Excel (.xlsx)
and PowerPoint (.pptx) files laid out by its own engines, Markdown, plain text and pictures (PNG,
JPEG). PDFs pass straight through. It's what SmartDoc uses to open these files (an experimental
feature there, turned on in Settings › Experimental).

```js
import { convert, describeReport } from '@smartdoc/pdf';

const { pdf, kind, report } = await convert(bytes, { name: 'Report.docx' });
// pdf: the PDF's bytes; kind: 'docx', 'xlsx', 'pptx', 'markdown', 'text', 'png', 'jpeg' or 'pdf'
// report: { substituted: [{ font, by }], missing: [...], notes: [...] }
describeReport(report); // what didn't come out as it is, a sentence a line, or null
```

Older Office files (.doc, .xls, .ppt) are refused with a plain message saying to save them in the
newer format.

## How close it is to Office

Each test document's PDF is measured against Office's own (Word, Excel and PowerPoint 16 for
Mac), and must be at least as close as LibreOffice's: the same pages, each line broken in the same
place and within a point of where Office puts it, and the pages' ink. See
`test/fixtures/reference/README.md` and `tools/compare.mjs`. Excel's layout follows Excel for
Mac's, which lays sheets out on a grid of 72 to the inch.

Fonts are found by the names documents use, on the Mac (Office's own included, when it's
installed) or bundled: Carlito, Caladea and the Liberation fonts, with the same measurements as
Calibri, Cambria, Arial, Times New Roman and Courier New, so text breaks the same where those
aren't installed (see `fonts/README.md` for their licences).

Not drawn yet (and said so in the report): charts, gradients (shown as one colour), conditional
formatting, text boxes and floating pictures in Word documents (shown in line), rotated text in
cells.

## Licence

MIT. The bundled fonts keep their own licences (SIL Open Font License 1.1, Apache 2.0).
