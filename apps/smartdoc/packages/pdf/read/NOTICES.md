# Notices for the PDF reader

`read/` is SmartDoc's own code, MIT licensed like the rest of this package, but parts of it come
from others' work, under these terms.

## pdf.js

Much of how `read/` handles text, fonts, damaged files and encryption follows Mozilla's pdf.js
closely, so that a page's text comes out exactly as pdf.js gives it (review positions SmartDoc has
stored are offsets into that text): `text.js`, `font.js`, `fontfile.js`, `cff.js`, `type1.js`,
`sfnt.js`, `bidi.js`, `content.js` and parts of `document.js`, `parser.js`, `cmap.js`,
`inflate.js` and `security.js` are ported from it. In drawing, the colour conversions in
`colorspace.js` (CMYK, CalGray, CalRGB, Lab) and the choice of each code's glyph in `drawfont.js`
follow it too. `text-layer.js` follows pdf.js's TextLayer, and the text layer's rules in
SmartDoc's `styles.css` are taken from its `pdf_viewer.css`. The tables in `data.js` (the standard
encodings, glyph names to Unicode, font-name tables, CFF strings and charsets, standard glyph orders
and bidirectional types) are taken as pdf.js transcribes them.

Copyright Mozilla Foundation. Licensed under the Apache License, Version 2.0 (`LICENSE-pdf.js.txt`).
Modified: rewritten for this reader, synchronously, on plain byte arrays.

## Adobe Glyph List

Glyph names to Unicode in `data.js` build on the Adobe Glyph List
(https://github.com/adobe-type-tools/agl-aglfn):

```
Copyright 2002-2019 Adobe (http://www.adobe.com/).

Redistribution and use in source and binary forms, with or
without modification, are permitted provided that the
following conditions are met:

Redistributions of source code must retain the above
copyright notice, this list of conditions and the following
disclaimer.

Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following
disclaimer in the documentation and/or other materials
provided with the distribution.

Neither the name of Adobe nor the names of its contributors
may be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Adobe Core 14 AFM files

The 14 standard fonts' widths in `data.js` are from Adobe's Core 14 AFM files. Only each glyph's
width is kept.

```
Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated. All Rights Reserved.

This file and the 14 PostScript(R) AFM files it accompanies may be used, copied, and distributed
for any purpose and without charge, with or without modification, provided that all copyright
notices are retained; that the AFM files are not distributed without this file; that all
modifications to this file or any of the AFM files are prominently noted in the modified file(s);
and that this paragraph is not removed.
```
