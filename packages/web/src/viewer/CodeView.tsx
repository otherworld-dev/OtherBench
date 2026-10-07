import hljs from 'highlight.js/lib/common';
import { useMemo, type JSX } from 'react';

/** Highlighting stops past this many characters; the text shows plain. */
const MAX_HIGHLIGHT_CHARS = 300_000;

/**
 * Read-only code or text with highlighting (Deck #826). highlight.js escapes
 * the text it returns, so its HTML is safe to insert; anything it doesn't
 * know, or too long, is shown as plain text through React.
 */
export function CodeView({ text, language }: { text: string; language: string }): JSX.Element {
  const html = useMemo(
    () => (text.length <= MAX_HIGHLIGHT_CHARS && language !== '' && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : null),
    [text, language]
  );
  return (
    <pre className="hljs m-0 min-h-full overflow-auto p-3 text-xs leading-relaxed">
      {html === null ? <code>{text}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
    </pre>
  );
}
