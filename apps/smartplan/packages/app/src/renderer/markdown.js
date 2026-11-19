import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Renders Markdown written by an AI, so it's sanitised before it reaches the page.
export function renderMarkdown(element, markdown) {
  element.classList.add('markdown');
  element.innerHTML = DOMPurify.sanitize(marked.parse(markdown ?? ''));
}

// Markdown as plain text, a line per block, for a card's face on its list: no formatting, links or
// code.
// Parsed apart from the page, so nothing in it loads or runs.
export function plainText(markdown) {
  const { body } = new DOMParser().parseFromString(marked.parse(markdown ?? ''), 'text/html');
  for (const code of body.querySelectorAll('pre')) code.remove();
  return [...body.children].map((block) => block.textContent.trim()).filter(Boolean).join('\n');
}
