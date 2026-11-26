// The app's own tooltips, in place of the browser's: anything with a title (set anywhere, in the
// markup or by code, as before) or a button that's only an icon (named by its aria-label) shows a
// small card saying what it is, after a moment's hover, below it (above, near the window's bottom).
// Once one has shown, moving straight to another shows it at once, as macOS does. The title is
// moved to `data-tip` as the pointer arrives, so the browser's own tooltip never shows too.

const DELAY = 450;
const WARM = 400; // how long after one closes the next opens at once
const GAP = 6;

export function installTooltips(root = document) {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  let target = null;
  let timer = null;
  let closedAt = 0;

  // The element with something to say under the pointer, and what it says.
  function tipOf(node) {
    for (let el = node instanceof Element ? node : node?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.hasAttribute('title')) {
        const text = el.getAttribute('title');
        el.removeAttribute('title');
        if (text) el.dataset.tip = text;
        else delete el.dataset.tip;
      }
      if (el.dataset.tip) return { el, text: el.dataset.tip };
      // A button with no words of its own is named by its label.
      if (el.matches('button, [role="button"]')) {
        const label = el.getAttribute('aria-label');
        return label && !el.textContent.trim() ? { el, text: label } : null;
      }
    }
    return null;
  }

  function show() {
    if (!target?.el.isConnected) return hide();
    tip.textContent = target.text;
    tip.hidden = false;
    const box = target.el.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    const below = box.bottom + GAP + height <= innerHeight - 4;
    tip.style.top = `${below ? box.bottom + GAP : box.top - GAP - height}px`;
    tip.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, box.left + box.width / 2 - width / 2))}px`;
  }

  function hide() {
    clearTimeout(timer);
    if (!tip.hidden) closedAt = Date.now();
    tip.hidden = true;
    target = null;
  }

  root.addEventListener('pointerover', (event) => {
    const next = tipOf(event.target);
    if (next?.el === target?.el) {
      if (next && next.text !== target.text) {
        target = next;
        if (!tip.hidden) show();
      }
      return;
    }
    const warm = !tip.hidden || Date.now() - closedAt < WARM;
    hide();
    if (!next) return;
    target = next;
    timer = setTimeout(show, warm ? 0 : DELAY);
  });
  // Out of the window altogether.
  root.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget) hide();
  });
  // Pressing, typing, scrolling or the window losing focus puts it away.
  for (const type of ['pointerdown', 'keydown', 'wheel']) root.addEventListener(type, hide, { capture: true, passive: true });
  addEventListener('blur', hide);
  addEventListener('scroll', hide, true);
}
