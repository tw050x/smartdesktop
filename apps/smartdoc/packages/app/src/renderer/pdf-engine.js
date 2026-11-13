// Which reader opens and draws PDFs: pdf.js, or SmartDoc's own (packages/pdf/read, experimental,
// switched on and off from the top bar; the user's choice, until it can replace pdf.js). Both are
// used through pdf.js's API, which ours imitates (read/viewer.js); each page is laid out with the
// text layer of the reader that made it, so positions in its text work the same either way.
import { TextLayer, getDocument as pdfjsGetDocument } from 'pdfjs-dist';
import { getDocument as ourGetDocument, renderTextLayer } from '../../../pdf/read/viewer.js';

let ours = false;
let fontSource = null;
const fonts = new Map();

// `api.readerFont(file)` gives a bundled font's bytes (from packages/pdf/fonts), for fonts that
// aren't embedded; none (the website's demo), and ours draws them with installed fonts only.
export function useOwnReader(on, api = null) {
  ours = Boolean(on);
  if (api?.readerFont) fontSource = api.readerFont;
}
export const usingOwnReader = () => ours;

const fontBytes = (file) => {
  if (!fontSource) return null;
  if (!fonts.has(file)) fonts.set(file, fontSource(file).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null));
  return fonts.get(file);
};

// A loading task ({ promise, destroy }) for the PDF in `data`, by the reader chosen.
export function getDocument({ data }) {
  return ours ? ourGetDocument({ data, fonts: fontBytes }) : pdfjsGetDocument({ data });
}

// Lays a page's text over it (in `container`), by the reader that made the page; gives the spans,
// one for each text item with text.
export async function layOutText(page, textContent, container, viewport) {
  if (page.reader === 'smartdoc') return renderTextLayer({ textContent, container, viewport });
  const layer = new TextLayer({ textContentSource: textContent, container, viewport });
  await layer.render();
  return layer.textDivs;
}
