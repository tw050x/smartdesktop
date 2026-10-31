import { startApp } from '../app-shell.js';
import { createDemoApi } from './demo-api.js';
import { createDirector } from './director.js';

// The website demo: the app's own interface (app-shell.js) working through a stand-in API, played
// scene by scene. The site shows it in an iframe (so its styles stay its own) and moves through
// the scenes as its story scrolls, through window.demo. On its own it plays the scenes in turn.
const api = createDemoApi();
startApp(api);
mirrorHover();
const director = createDirector({ api });
window.demo = director;

if (window.parent === window) {
  (async () => {
    for (let i = 0; ; i = (i + 1) % director.scenes.length) {
      await director.show(director.scenes[i]);
      director.start();
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  })();
}

// The demo's cursor is drawn, so it can't set off the app's :hover styles. Each :hover rule is
// copied for .demo-hover, which the director puts on whatever the cursor is over (and its
// ancestors, as hovering does).
function mirrorHover() {
  const copies = [];
  const walk = (rules, wrap) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (rule.selectorText.includes(':hover')) copies.push(wrap(`${rule.selectorText.replaceAll(':hover', '.demo-hover')} { ${rule.style.cssText} }`));
      } else if (rule instanceof CSSMediaRule) {
        walk(rule.cssRules, (text) => wrap(`@media ${rule.conditionText} { ${text} }`));
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, (text) => text);
    } catch {} // a sheet that can't be read
  }
  document.head.append(Object.assign(document.createElement('style'), { textContent: copies.join('\n') }));
}
