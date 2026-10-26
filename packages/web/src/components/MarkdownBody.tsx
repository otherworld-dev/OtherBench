import { useMemo, useRef, useState, type ComponentPropsWithoutRef, type JSX } from 'react';
import type { Link as LinkNode, Parent, PhrasingContent, Root, RootContent, Text } from 'mdast';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { openDeckCard } from '../code/openDeckCard.js';
import { openInBrowser } from '../desktop/bridge.js';
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
      console.error('[otherbench-web] copy to clipboard failed:', err);
    }
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => void handleCopy()}
        data-copy-chrome=""
        className="btn absolute top-1.5 right-1.5 bg-[var(--bg-raised)] px-1.5 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--bg-sunken)] focus-visible:opacity-100"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

/**
 * A remark plugin: each top-level `---` and what follows it, up to the next
 * one, becomes a section whose rule carries a Copy button (`CopySection`).
 * Replies put a draft (an email, a message) under a rule after their own
 * preamble, and the button copies the draft alone. The section's markdown
 * source rides along as its plain text. A rule with nothing after it stays a
 * rule.
 */
export function remarkCopySections(): (tree: Root, file: { value?: unknown }) => void {
  return (tree, file) => {
    if (!tree.children.some((c) => c.type === 'thematicBreak')) return;
    const source = typeof file.value === 'string' ? file.value : undefined;
    const out: RootContent[] = [];
    let rule: RootContent | null = null;
    let section: RootContent[] = [];
    const close = (): void => {
      if (rule === null) return;
      if (section.length === 0) {
        out.push(rule);
      } else {
        const from = section[0]!.position?.start.offset;
        const to = section[section.length - 1]!.position?.end.offset;
        const text = source !== undefined && from !== undefined && to !== undefined ? source.slice(from, to) : undefined;
        const wrapped = {
          type: 'copySection',
          data: { hName: 'section', hProperties: { dataCopySection: '', ...(text !== undefined ? { dataCopyText: text } : {}) } },
          children: section,
        };
        out.push(wrapped as unknown as RootContent);
      }
      rule = null;
      section = [];
    };
    for (const child of tree.children) {
      if (child.type === 'thematicBreak') {
        close();
        rule = child;
      } else if (rule !== null) section.push(child);
      else out.push(child);
    }
    close();
    tree.children = out;
  };
}

/**
 * The text under a rule, with a Copy button on the rule. Copies it as HTML
 * (for a mail or document editor) and as its markdown source (for anything
 * that only takes plain text). Any other section (GFM's footnotes) renders
 * as usual.
 */
function CopySection({
  node: _node,
  children,
  'data-copy-section': marker,
  'data-copy-text': source,
  ...rest
}: FromMarkdown<'section'> & { 'data-copy-section'?: string; 'data-copy-text'?: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  if (marker === undefined) return <section {...rest}>{children}</section>;

  async function handleCopy(): Promise<void> {
    const el = ref.current;
    if (!el) return;
    const clone = el.cloneNode(true) as HTMLElement;
    for (const chrome of clone.querySelectorAll('[data-copy-chrome]')) chrome.remove();
    const plain = source ?? el.innerText;
    try {
      if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([plain], { type: 'text/plain' }),
            'text/html': new Blob([clone.innerHTML], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[otherbench-web] copy to clipboard failed:', err);
    }
  }

  return (
    <section {...rest}>
      <div className="my-[1em] flex items-center gap-2">
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border)]" />
        <button
          type="button"
          onClick={() => void handleCopy()}
          title="Copy the text below this line"
          className="label-caps text-xs text-[var(--text-faint)] hover:text-[var(--text)] focus-visible:text-[var(--text)]"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div ref={ref}>{children}</div>
    </section>
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

/** A card reference in a message: "Deck #967" or "Deck card #967" (spec 2026-10-22-nextcloud-tabs). A bare "#967" is left alone. */
export const DECK_REF = /\bDeck(?: card)? #(\d{1,9})\b/gi;

/** The href a Deck reference links to, and the card number in one. */
const DECK_HREF = /^deck:(\d{1,9})$/;

/** A text node's value split into text and `deck:N` links, or null when it has no Deck reference. */
function splitDeckRefs(node: Text): PhrasingContent[] | null {
  const out: PhrasingContent[] = [];
  let last = 0;
  for (const m of node.value.matchAll(DECK_REF)) {
    const at = m.index;
    if (at > last) out.push({ type: 'text', value: node.value.slice(last, at) });
    const link: LinkNode = { type: 'link', url: `deck:${m[1]}`, title: null, children: [{ type: 'text', value: m[0] }] };
    out.push(link);
    last = at + m[0].length;
  }
  if (out.length === 0) return null;
  if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
  return out;
}

/**
 * A remark plugin: each "Deck #N" in the text becomes a link to `deck:N`,
 * which `Link` opens with `openDeckCard`. Text in code and in links (an
 * existing one, or a reference to one) is left as written.
 */
export function remarkDeckLinks(): (tree: Root) => void {
  const walk = (parent: Parent): void => {
    if (parent.type === 'link' || parent.type === 'linkReference') return;
    const children: Parent['children'] = [];
    for (const child of parent.children) {
      const split = child.type === 'text' ? splitDeckRefs(child) : null;
      if (split) children.push(...split);
      else {
        if ('children' in child) walk(child);
        children.push(child);
      }
    }
    parent.children = children;
  };
  return (tree) => walk(tree);
}

/**
 * react-markdown blanks file: URLs by default; OtherBench keeps them, since a click opens them only in the viewer, inside the chat's folders.
 * A `deck:N` link (from `remarkDeckLinks`) is kept too.
 */
function urlTransform(url: string): string {
  return /^file:/i.test(url) || DECK_HREF.test(url) ? url : defaultUrlTransform(url);
}

/** react-markdown hands every component its AST `node`; it must not reach the DOM. */
type FromMarkdown<T extends keyof JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & { node?: unknown };

/**
 * Websites open in the default browser, never inside OtherBench, chat or not
 * (the desktop shell's links.rs does the same for anything that asks it for a
 * new window). Inside a chat paths open in the viewer, a viewed file's
 * relative ones from its own folder; other schemes (mailto:) and in-page
 * anchors are left alone.
 */
function Link({ files, node: _node, href, children, ...rest }: FromMarkdown<'a'> & { files: MarkdownFiles | undefined }): JSX.Element {
  const viewer = useViewer();
  const deck = href === undefined ? null : DECK_HREF.exec(href);
  if (deck) {
    const cardId = Number(deck[1]);
    return (
      <a
        href={href}
        {...rest}
        onClick={(e) => {
          e.preventDefault();
          void openDeckCard(cardId);
        }}
      >
        {children}
      </a>
    );
  }
  const web = href !== undefined && /^https?:\/\//i.test(href);
  if (!href || (!viewer && !web)) return <a href={href} {...rest}>{children}</a>;
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (href.startsWith('#')) return;
        if (!web && /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return;
        e.preventDefault();
        if (web) void openInBrowser(href);
        else viewer?.openPath(files && isRelativePath(href) ? joinPath(files.base, hrefToPath(href)) : hrefToPath(href));
      }}
    >
      {children}
    </a>
  );
}

/**
 * A viewed file's relative image comes from its own folder, through a `/view/` link; any other image is left as written.
 * Without `remote`, no image is loaded at all, only its alt text shown: text from elsewhere (a Deck card) must not reach the network.
 */
function Image({ files, remote, node: _node, src, alt, ...rest }: FromMarkdown<'img'> & { files: MarkdownFiles | undefined; remote: boolean }): JSX.Element {
  if (!remote) return <span className="text-[var(--text-muted)]">[image: {alt}]</span>;
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
 * `remoteImages={false}` shows each image as its alt text instead, for
 * untrusted text such as a Nextcloud card or page. `deckLinks` makes each
 * "Deck #N" a link that opens the card (`openDeckCard`), for message text.
 * `copySections` puts a Copy button on each `---` for the text under it
 * (`remarkCopySections`), for a reply's drafts.
 */
export function MarkdownBody({
  text,
  files,
  remoteImages = true,
  deckLinks = false,
  copySections = false,
}: {
  text: string;
  files?: MarkdownFiles;
  remoteImages?: boolean;
  deckLinks?: boolean;
  copySections?: boolean;
}): JSX.Element {
  // The same list each render while the flags hold.
  const remarkPlugins = useMemo(
    () => [remarkGfm, ...(deckLinks ? [remarkDeckLinks] : []), ...(copySections ? [remarkCopySections] : [])],
    [deckLinks, copySections]
  );
  // Stable component types: new ones each render would remount every link and
  // image as a reply streams (and refetch a viewed file's images).
  const chatId = files?.chatId;
  const base = files?.base;
  const components = useMemo(() => {
    const at = chatId !== undefined && base !== undefined ? { chatId, base } : undefined;
    return {
      pre: CodeBlock,
      a: (props: FromMarkdown<'a'>) => <Link {...props} files={at} />,
      img: (props: FromMarkdown<'img'>) => <Image {...props} files={at} remote={remoteImages} />,
      code: InlineCode,
      section: CopySection,
    };
  }, [chatId, base, remoteImages]);
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
