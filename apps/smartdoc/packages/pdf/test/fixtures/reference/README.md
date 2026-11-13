# Reference PDFs

The fixtures in `../docx`, `../xlsx` and `../pptx` as Office and LibreOffice turn them into PDFs, which this package's
are measured against (`test/pdf.test.js` checks every line against Word's, Excel's and PowerPoint's; `tools/compare.mjs`
measures pages, lines and ink against Word's, and LibreOffice's beside them):

- `word/`: Microsoft Word 16.115 for Mac, File › Save As…, File Format PDF ("Best for electronic
  distribution and accessibility"), with Office's own fonts.
- `excel/`: Microsoft Excel 16.115 for Mac, `save workbook as … file format PDF file format`
  (AppleScript), every sheet, on a Mac set to British English (the built-in currency formats show
  £). Excel for Mac prints on a grid of 72 to the inch, so its PDFs differ from Windows Excel's;
  this package follows the Mac's (see `formats/xlsx.js`).
- `powerpoint/`: Microsoft PowerPoint 16.115 for Mac, `save … as save as PDF` (AppleScript), after
  the user had exported once by hand (File › Export…) so PowerPoint could write to the folder.
- `libreoffice/`: LibreOffice 26.8.3.1, `soffice --headless --convert-to pdf`.

The bar this package is held to: for each document, ours at least as close to Word's as
LibreOffice's is.

    node tools/compare.mjs test/fixtures/docx test/fixtures/reference/word --other test/fixtures/reference/libreoffice
    node tools/compare.mjs test/fixtures/xlsx test/fixtures/reference/excel --other test/fixtures/reference/libreoffice
    node tools/compare.mjs test/fixtures/pptx test/fixtures/reference/powerpoint --other test/fixtures/reference/libreoffice

(`SMARTDOC_PDF_BUNDLED_FONTS=1` lays out with the bundled fonts alone, as on a machine without
Office.) Make the references again whenever a fixture changes.
