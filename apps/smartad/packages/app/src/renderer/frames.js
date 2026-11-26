import { normalizeAd } from '../main/ad-model.js';
import { createAdRenderer } from './ad-render.js';

// An ad drawn at its real size (scale 1, no sheet round it), in a window of its own that's never
// shown, for pictures of chosen moments (view_frames; drawFrames in main.js), and later for exports:
// the same drawing as the ad's tab, the time set exactly, so a moment always looks the same.
// `drawFrame(content, sizeId, t)` draws it, waits for its pictures and fonts and for the page to
// paint, and gives the size drawn, for the main process to capture.
const renderer = createAdRenderer(document.getElementById('frame'), { fit: false });
let shown = null; // { json, ad, sizeId }

const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

window.drawFrame = async (content, sizeId, t) => {
  const json = JSON.stringify(content);
  if (shown?.json !== json) shown = { json, ad: normalizeAd(content), sizeId: null };
  if (shown.sizeId !== sizeId) {
    renderer.show(shown.ad, sizeId);
    shown.sizeId = sizeId;
  }
  renderer.seek(t);
  await renderer.ready();
  await painted();
  const { width, height } = renderer.size;
  return { width, height };
};
