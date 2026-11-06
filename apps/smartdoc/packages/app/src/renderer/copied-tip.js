// "Copied", in a small tip just above a copy button for a moment, so the button itself keeps its
// text and width. In a modal dialog the tip goes in the dialog, the only layer that shows above it.

const SHOWN_FOR = 1500;
const tips = new WeakMap(); // button → { tip, timer }

export function showCopied(button) {
  const shown = tips.get(button);
  if (shown) {
    clearTimeout(shown.timer);
    shown.tip.remove();
  }
  const tip = document.createElement('div');
  tip.className = 'copied-tip';
  tip.setAttribute('role', 'status');
  tip.textContent = 'Copied';
  (button.closest('dialog') ?? document.body).append(tip);
  const b = button.getBoundingClientRect();
  tip.style.left = `${b.left + b.width / 2}px`;
  tip.style.top = `${b.top}px`;
  const timer = setTimeout(() => {
    tip.remove();
    tips.delete(button);
  }, SHOWN_FOR);
  tips.set(button, { tip, timer });
}
