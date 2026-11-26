// The window an app shows when SmartDesktop has gone (see desktop-missing.js beside it): what it is,
// Reinstall (its progress as it downloads, checks and installs), or Use Without It.
const name = new URLSearchParams(location.search).get('app') ?? 'This app';
const ui = window.desktopMissing;
document.getElementById('title').textContent = 'SmartDesktop isn’t installed';
document.getElementById('message').textContent = `${name} opens in SmartDesktop, which holds the windows and the AI chat for all your apps. Reinstall it to carry on, or use ${name} on its own for now.`;
const install = document.getElementById('install');
const without = document.getElementById('without');
const progress = document.getElementById('progress');
const problem = document.getElementById('problem');
install.addEventListener('click', () => {
  install.disabled = true;
  without.disabled = true;
  problem.hidden = true;
  progress.hidden = false;
  ui.install();
});
without.addEventListener('click', () => ui.respond('without'));
ui.onProgress(({ step, received, total, error }) => {
  if (error) {
    progress.hidden = true;
    problem.hidden = false;
    problem.textContent = `Couldn’t install it: ${error}`;
    install.disabled = false;
    without.disabled = false;
    install.textContent = 'Try Again';
    ui.fitHeight(document.body.scrollHeight);
    return;
  }
  document.getElementById('step').textContent = total ? `${step}… ${Math.min(100, Math.round((100 * received) / total))}%` : `${step}…`;
  document.getElementById('bar').style.width = total ? `${Math.min(100, (100 * received) / total)}%` : '100%';
});
install.focus();
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !without.disabled) ui.respond('without');
});
ui.fitHeight(document.body.scrollHeight);
