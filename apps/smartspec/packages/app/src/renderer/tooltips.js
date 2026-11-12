// The app's own tooltips, in place of the browser's: anything with a title (set anywhere, in the
// markup or by code, as before) or a button that's only an icon (named by its aria-label) shows a
// small card saying what it is, after a moment's hover, below it (above, near the window's bottom).
// Once one has shown, moving straight to another shows it at once, as macOS does. The title is
// moved to `data-tip` as the pointer arrives, so the browser's own tooltip never shows too.
//
// The window's top bar (tab-strip.js) is a page of its own, and the tab's page below it would cover
// a tooltip drawn there, so the top bar passes its tooltips (`present`) to the tab showing, which
// draws them just under it, over its content (`showAt`). The top bar's tooltips are blue (the
// user's choice), wherever they're drawn, but for a tab's chat button's: it sits over the blue
// pill pointing at its tab shows, so it's the ordinary dark card (`plain`, the user's choice).

const DELAY = 450;
const WARM = 400; // how long after one closes the next opens at once
const GAP = 6;

export function installTooltips(root = document, { present = null } = {}) {
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
      // Somewhere that shows something else on hover instead (the top bar's tabs: tab-strip.js).
      if (el.hasAttribute('data-no-tip')) return null;
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

  // Shows `text` beside `box` (a rect in this page), below it unless there's no room.
  function showAt(text, box, { strip = false } = {}) {
    tip.textContent = text;
    tip.classList.toggle('strip-tip', strip);
    tip.hidden = false;
    const { width, height } = tip.getBoundingClientRect();
    const below = box.bottom + GAP + height <= innerHeight - 4;
    tip.style.top = `${below ? box.bottom + GAP : box.top - GAP - height}px`;
    tip.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, box.left + box.width / 2 - width / 2))}px`;
  }

  let shown = false;
  function show() {
    if (!target?.el.isConnected) return hide();
    const box = target.el.getBoundingClientRect();
    shown = true;
    const plain = Boolean(target.el.closest('.tab-chat-button'));
    if (present) return present({ text: target.text, plain, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width } });
    showAt(target.text, box, { strip: !plain && Boolean(target.el.closest('.tab-strip')) });
  }

  function hide() {
    clearTimeout(timer);
    if (shown) closedAt = Date.now();
    if (shown && present) present(null);
    shown = false;
    tip.hidden = true;
    target = null;
  }

  root.addEventListener('pointerover', (event) => {
    const next = tipOf(event.target);
    if (next?.el === target?.el) {
      if (next && next.text !== target.text) {
        target = next;
        if (shown) show();
      }
      return;
    }
    const warm = shown || Date.now() - closedAt < WARM;
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
  // The top bar's, drawn here (see above); `hide` puts away whichever shows.
  return {
    showAt: (text, box, { plain = false } = {}) => showAt(text, box, { strip: !plain }),
    hide: () => {
      tip.hidden = true;
    },
  };
}
