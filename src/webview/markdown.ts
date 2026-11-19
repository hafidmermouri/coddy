import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Markdown to sanitized HTML. Links are rendered inert text targets; no remote images (CSP blocks them anyway). */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'img', 'iframe', 'form'], FORBID_ATTR: ['style'] });
}
