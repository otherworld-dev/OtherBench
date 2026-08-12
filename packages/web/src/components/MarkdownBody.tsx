import { useRef, useState, type ComponentPropsWithoutRef, type JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

function CodeBlock(props: ComponentPropsWithoutRef<'pre'>): JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    // Reading `textContent` off the rendered node (rather than the
    // highlighted AST) reconstructs the original plain-text source exactly,
    // regardless of how many `<span class="hljs-*">` wrappers rehype-highlight
    // introduced around it.
    const text = ref.current?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[grunt-web] copy to clipboard failed:', err);
    }
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="absolute top-1.5 right-1.5 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--text)]"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

/**
 * Renders assistant (and user) message text as Markdown: GFM tables/strikethrough/task
 * lists (remark-gfm) and syntax-highlighted code via rehype-highlight, whose
 * token colours are themed in index.css to track light/dark rather than a
 * fixed hljs stylesheet. Every code block gets a hover-revealed copy button.
 */
export function MarkdownBody({ text }: { text: string }): JSX.Element {
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
