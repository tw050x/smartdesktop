import { createTabStrip } from './tab-strip.js';
import { installTooltips } from './tooltips.js';

// The window's own page: its top bar, above the tabs' pages (see tab-strip.js and main.js).
const api = window.smartdoc;
document.body.classList.add(`platform-${api.platform}`);
api.onFullScreenChange((on) => document.body.classList.toggle('full-screen', on));
// Its tooltips are drawn by the tab showing, under the top bar (see tooltips.js).
installTooltips(document, { present: (tip) => api.stripTip(tip) });
const strip = createTabStrip({ el: document.getElementById('tab-strip'), api });
api.onTabs((state) => strip.render(state));
api.tabsState();
