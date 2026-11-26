import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { slug } from '../main/items.js';

// Renders Markdown written by an AI or the user, so it's sanitised before it reaches the page. Its
// headings can be linked to (data-part), by the same ids the store works out from the source.
export function renderMarkdown(element, markdown) {
  element.classList.add('markdown');
  element.innerHTML = DOMPurify.sanitize(marked.parse(markdown ?? ''));
  for (const heading of element.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.dataset.part = slug(heading.textContent);
}

// One line of Markdown, for a table's cell.
export function inlineMarkdown(element, text) {
  element.innerHTML = DOMPurify.sanitize(marked.parseInline(text ?? ''));
}

// Markdown as plain text, a line per block, for a collapsed card: no formatting, links or code.
// Parsed apart from the page, so nothing in it loads or runs.
export function plainText(markdown) {
  const { body } = new DOMParser().parseFromString(marked.parse(markdown ?? ''), 'text/html');
  for (const code of body.querySelectorAll('pre')) code.remove();
  return [...body.children].map((block) => block.textContent.trim()).filter(Boolean).join('\n');
}
