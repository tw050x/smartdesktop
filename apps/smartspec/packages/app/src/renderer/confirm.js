// A question in a window of its own (see main/confirm.js): what it says comes in the query string,
// and the chosen button's choice goes back to the main process.
const question = JSON.parse(new URLSearchParams(location.search).get('question') ?? '{}');

document.title = question.title ?? 'SmartSpec';
document.getElementById('title').textContent = question.title ?? '';
document.getElementById('message').textContent = question.message ?? '';
const points = document.getElementById('points');
for (const point of question.points ?? []) {
  const item = document.createElement('li');
  item.textContent = point;
  points.append(item);
}
if (!points.children.length) points.remove();
// What follows the list, if anything.
const after = document.getElementById('after');
if (question.after) after.textContent = question.after;
else after.remove();

const container = document.getElementById('buttons');
for (const { label, choice, kind = 'secondary', apart = false } of question.buttons ?? []) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${kind}${apart ? ' push-left' : ''}`;
  button.textContent = label;
  button.addEventListener('click', () => window.confirmWindow.respond(choice));
  container.append(button);
}
container.lastElementChild?.focus();

window.confirmWindow.fitHeight(document.body.scrollHeight);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.confirmWindow.respond('cancel');
});
