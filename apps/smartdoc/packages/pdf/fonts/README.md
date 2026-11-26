# Bundled fonts

Stand-ins for Office's commonest fonts, with the same character widths and line heights, so a
document set in one of those fonts breaks its lines and pages the same on a Mac without it (see
`lib/fonts.js`, `SUBSTITUTES`). Checked against the originals: every printable ASCII character's
width, the ascent and the descent.

| Font | Stands in for | Source | Licence |
| --- | --- | --- | --- |
| Carlito | Calibri | Google Fonts (`ofl/carlito`) | SIL Open Font License 1.1 (`LICENSE-Carlito.txt`) |
| Caladea | Cambria | ChromeOS extra fonts, `crosextrafonts-20130214` (Google Fonts' Caladea has different widths) | Apache License 2.0 (`LICENSE-Caladea.txt`) |
| Liberation Sans, Serif, Mono 2.1.5 | Arial, Times New Roman, Courier New | liberationfonts/liberation-fonts | SIL Open Font License 1.1 (`LICENSE-Liberation.txt`) |
