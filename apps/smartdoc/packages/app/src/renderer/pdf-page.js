import { TextLayer } from 'pdfjs-dist';

// Pages are drawn once at this scale, then shrunk with CSS to fit the space available, so
// resizing the window never needs a redraw.
export const RENDER_SCALE = 1.5;

// Draws a PDF page with its text layer. `place` puts the page's element in the view (and fits it)
// before the drawing starts, so it shows up straight away. Gives back what anchors.js needs.
export async function drawPage(page, place) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const ratio = window.devicePixelRatio || 1;

  // .page takes the fitted size in the layout; .page-content holds the page at its drawn
  // size and is scaled down to match, keeping the canvas and text layer aligned.
  const pageEl = document.createElement('div');
  pageEl.className = 'page';
  pageEl.dataset.width = String(viewport.width);
  pageEl.dataset.height = String(viewport.height);

  const contentEl = document.createElement('div');
  contentEl.className = 'page-content';
  contentEl.style.width = `${viewport.width}px`;
  contentEl.style.height = `${viewport.height}px`;
  contentEl.style.setProperty('--total-scale-factor', String(RENDER_SCALE));

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);

  const textLayerEl = document.createElement('div');
  textLayerEl.className = 'textLayer';

  contentEl.append(canvas, textLayerEl);
  pageEl.append(contentEl);
  place(pageEl);

  await page.render({ canvas, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
  const textContent = await page.getTextContent();
  const textLayer = new TextLayer({ textContentSource: textContent, container: textLayerEl, viewport });
  await textLayer.render();
  return { items: textContent.items, textDivs: textLayer.textDivs, contentEl, textLayerEl };
}

// Sizes a drawn page to fit a width, never enlarging it.
export function fitPageTo(pageEl, available) {
  const k = Math.max(0, Math.min(1, available / Number(pageEl.dataset.width)));
  pageEl.style.width = `${Number(pageEl.dataset.width) * k}px`;
  pageEl.style.height = `${Number(pageEl.dataset.height) * k}px`;
  pageEl.firstElementChild.style.transform = `scale(${k})`;
}
