import { useRef, useState, type ComponentPropsWithoutRef, type JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { looksLikePath } from '../viewer/paths.js';
import { useViewer } from '../viewer/ViewerContext.js';

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

/** A file:// URL or a plain href as a path. */
function hrefToPath(href: string): string {
  if (!/^file:/i.test(href)) return decodeURIComponent(href);
  const path = decodeURIComponent(new URL(href).pathname);
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/** react-markdown hands every component its AST `node`; it must not reach the DOM. */
type FromMarkdown<T extends keyof JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & { node?: unknown };

/** Inside a chat, websites open in their own window (Ctrl-click: the browser) and paths in the viewer; other schemes (mailto:) are left alone. */
function Link({ node: _node, href, children, ...rest }: FromMarkdown<'a'>): JSX.Element {
  const viewer = useViewer();
  if (!viewer || !href) return <a href={href} {...rest}>{children}</a>;
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        const web = /^https?:\/\//i.test(href);
        if (!web && /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return;
        e.preventDefault();
        if (web) viewer.openLink(href, { external: e.ctrlKey || e.metaKey });
        else viewer.openPath(hrefToPath(href));
      }}
    >
      {children}
    </a>
  );
}

/** Inline code that looks like a path becomes a button that opens it in the chat's viewer. Code blocks (with a language class) are untouched. */
function InlineCode({ node: _node, ...props }: FromMarkdown<'code'>): JSX.Element {
  const viewer = useViewer();
  const text = typeof props.children === 'string' ? props.children : null;
  if (!viewer || props.className || text === null || !looksLikePath(text)) return <code {...props} />;
  return (
    <code {...props}>
      <button type="button" title="Open in the viewer" onClick={() => viewer.openPath(text)} className="cursor-pointer underline decoration-dotted underline-offset-2">
        {text}
      </button>
    </code>
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock, a: Link, code: InlineCode }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
