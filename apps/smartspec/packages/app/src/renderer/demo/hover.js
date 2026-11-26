// The demo's cursor is drawn, so it can't set off the app's :hover styles. Each :hover rule is
// copied for .demo-hover, which the director puts on whatever the cursor is over (and its
// ancestors, as hovering does). Each of the demo's windows (the app's, the chat's) does it for its
// own page.
export function mirrorHover() {
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

// The demo's drawn cursor, in this page's top layer, so it's above everything, open dialogs too.
export const CURSOR_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 2.5v17.2l4.6-4.4 2.9 6.6 2.7-1.2-2.9-6.5h6.4Z" fill="#1d1d1f" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
export function makeCursor() {
  const cursor = document.createElement('div');
  cursor.className = 'demo-cursor';
  cursor.popover = 'manual';
  cursor.innerHTML = CURSOR_SVG;
  document.body.append(cursor);
  cursor.showPopover();
  return cursor;
}
