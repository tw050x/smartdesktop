// Confirmation shown when a PDF is dropped while another is open. The file names and whether
// there are unsaved changes come in the query string; the choice goes back to the main process.
const params = new URLSearchParams(location.search);
const current = params.get('current');
const next = params.get('next');
const unsaved = params.get('unsaved') === '1';

document.getElementById('title').textContent = unsaved
  ? `Save changes to “${current}” before opening “${next}”?`
  : `Open “${next}”?`;
document.getElementById('message').textContent = unsaved
  ? 'Your changes will be lost if you don’t save them.'
  : `“${current}” will be closed.`;

// [label, choice, kind]; the last button is the default (Return), Cancel answers Escape.
const buttons = unsaved
  ? [['Don’t Save', 'replace', 'secondary'], ['Cancel', 'cancel', 'secondary'], ['Save', 'save', 'primary']]
  : [['Cancel', 'cancel', 'secondary'], ['Open', 'replace', 'primary']];

const container = document.getElementById('buttons');
for (const [label, choice, kind] of buttons) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = kind;
  button.textContent = label;
  button.addEventListener('click', () => window.confirmReplace.respond(choice));
  container.append(button);
}
if (unsaved) container.firstElementChild.classList.add('push-left');
container.lastElementChild.focus();

window.confirmReplace.fitHeight(document.body.scrollHeight);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.confirmReplace.respond('cancel');
});
