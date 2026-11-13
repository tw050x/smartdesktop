// A picture as a PDF: one page the picture's own size (at 96 pixels to the inch, as Office and
// LibreOffice place a picture with no size of its own), the picture filling it.
import { createPdf } from '../lib/pdf.js';
import { imageInfo } from '../lib/image.js';

export function imageToPdf(data) {
  const info = imageInfo(data);
  const width = (info.width * 72) / 96;
  const height = (info.height * 72) / 96;
  const pdf = createPdf();
  const page = pdf.addPage({ width, height });
  const image = pdf.addImage(data);
  page.image(image, 0, 0, width, height);
  return { pdf: pdf.finish(), pages: 1 };
}
