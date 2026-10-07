import { useMemo, useRef, useState, type ComponentPropsWithoutRef, type JSX } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { isRelativePath, joinPath, looksLikePath } from '../viewer/paths.js';
import { ViewerImage } from '../viewer/ViewerImage.js';
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

/** A file:// URL or a plain href as a path: decoded, without its query or anchor. */
function hrefToPath(href: string): string {
  if (!/^file:/i.test(href)) return decodeURIComponent(href.replace(/[?#].*$/, ''));
  const path = decodeURIComponent(new URL(href).pathname);
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/**
 * A viewed file's own folder, for its relative links and images (Deck #901).
 * Chat messages have none: their relative links mean the chat's workspace.
 */
export interface MarkdownFiles {
  chatId: string;
  base: string;
}

/** react-markdown blanks file: URLs by default; Grunt keeps them, since a click opens them only in the viewer, inside the chat's folders. */
function urlTransform(url: string): string {
  return /^file:/i.test(url) ? url : defaultUrlTransform(url);
}

/** react-markdown hands every component its AST `node`; it must not reach the DOM. */
type FromMarkdown<T extends keyof JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & { node?: unknown };

/**
 * Inside a chat, websites open in their own window (Ctrl-click: the browser)
 * and paths in the viewer, a viewed file's relative ones from its own folder;
 * other schemes (mailto:) and in-page anchors are left alone.
 */
function Link({ files, node: _node, href, children, ...rest }: FromMarkdown<'a'> & { files: MarkdownFiles | undefined }): JSX.Element {
  const viewer = useViewer();
  if (!viewer || !href) return <a href={href} {...rest}>{children}</a>;
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (href.startsWith('#')) return;
        const web = /^https?:\/\//i.test(href);
        if (!web && /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return;
        e.preventDefault();
        if (web) viewer.openLink(href, { external: e.ctrlKey || e.metaKey });
        else viewer.openPath(files && isRelativePath(href) ? joinPath(files.base, hrefToPath(href)) : hrefToPath(href));
      }}
    >
      {children}
    </a>
  );
}

/** A viewed file's relative image comes from its own folder, through a `/view/` link; any other image is left as written. */
function Image({ files, node: _node, src, alt, ...rest }: FromMarkdown<'img'> & { files: MarkdownFiles | undefined }): JSX.Element {
  if (files && typeof src === 'string' && isRelativePath(src)) return <ViewerImage chatId={files.chatId} path={joinPath(files.base, hrefToPath(src))} alt={alt ?? ''} />;
  return <img src={src} alt={alt} {...rest} />;
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
export function MarkdownBody({ text, files }: { text: string; files?: MarkdownFiles }): JSX.Element {
  // Stable component types: new ones each render would remount every link and
  // image as a reply streams (and refetch a viewed file's images).
  const chatId = files?.chatId;
  const base = files?.base;
  const components = useMemo(() => {
    const at = chatId !== undefined && base !== undefined ? { chatId, base } : undefined;
    return {
      pre: CodeBlock,
      a: (props: FromMarkdown<'a'>) => <Link {...props} files={at} />,
      img: (props: FromMarkdown<'img'>) => <Image {...props} files={at} />,
      code: InlineCode,
    };
  }, [chatId, base]);
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
