import { useEffect, useRef, useState, type JSX } from 'react';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { isDesktop, revealPath } from '../desktop/bridge.js';
import { ApiError, api, type ViewOpened, type ViewText } from '../state/api.js';
import { serverUrl } from '../state/transport.js';
import { ArtifactView } from './ArtifactView.js';
import { CodeView } from './CodeView.js';
import type { ViewItem } from './items.js';
import { dirOf } from './paths.js';

/** A link this old may have expired (they last 10 minutes); an error on it asks for a fresh one. */
const STALE_LINK_MS = 9 * 60_000;

/** The extension, lower-cased, as highlight.js knows most languages by it. */
export function languageOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't open this. Please try again.";
}

const TOGGLE = 'rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-sunken)]';

/** The file's text, as Markdown, code or HTML source, with a note when it was cut off. */
function TextBody({ chatId, opened, as }: { chatId: string; opened: ViewOpened; as: 'markdown' | 'code' }): JSX.Element {
  const [text, setText] = useState<ViewText | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.view.text(chatId, opened.path).then(
      (t) => !cancelled && setText(t),
      (err: unknown) => !cancelled && setError(failure(err))
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, opened.path]);
  if (error) return <p role="alert" className="p-3 text-sm text-[var(--danger)]">{error}</p>;
  if (!text) return <p className="p-3 text-sm text-[var(--text-faint)]">Loading…</p>;
  return (
    <div>
      {text.truncated && <p className="border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--warn)]">This file is large: only the first 2 MB is shown.</p>}
      {as === 'markdown' ? (
        <div className="p-4">
          <MarkdownBody text={text.content} files={{ chatId, base: dirOf(opened.path) }} />
        </div>
      ) : (
        <CodeView text={text.content} language={opened.kind === 'html' ? 'html' : languageOf(opened.name)} />
      )}
    </div>
  );
}

/** What the viewer shows for an item: a file, or an artifact (Deck #896). */
export function ItemView({ chatId, item }: { chatId: string; item: ViewItem }): JSX.Element {
  return item.kind === 'artifact' ? <ArtifactView chatId={chatId} item={item} /> : <FileView chatId={chatId} path={item.path} />;
}

/**
 * One file from a chat's folders (spec 2026-10-07-viewer): images, video and
 * PDF from their `/view/` links, HTML run only in the sandbox (an iframe with
 * scripts but no same-origin), Markdown formatted, code and text highlighted,
 * and anything else named with Show in folder. Every failure says why.
 */
function FileView({ chatId, path }: { chatId: string; path: string }): JSX.Element {
  const [opened, setOpened] = useState<ViewOpened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const openedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.view.open(chatId, path).then(
      (o) => {
        if (cancelled) return;
        openedAt.current = Date.now();
        setOpened(o);
      },
      (err: unknown) => !cancelled && setError(failure(err))
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, path, attempt]);

  if (error) return <p role="alert" className="p-3 text-sm text-[var(--danger)]">{error}</p>;
  if (!opened) return <p className="p-3 text-sm text-[var(--text-faint)]">Opening…</p>;

  const src = opened.url ? serverUrl(opened.url) : '';
  const canToggle = opened.kind === 'markdown' || opened.kind === 'html';
  // Markdown formatted, or its source; text always as code; anything else
  // asked for as source (only HTML can be) falls to its own branch below.
  const asMarkdown = opened.kind === 'markdown' && !source;
  const asCode = (opened.kind === 'markdown' && source) || opened.kind === 'text';
  let body: JSX.Element;
  if (asMarkdown || asCode) {
    body = <TextBody chatId={chatId} opened={opened} as={asMarkdown ? 'markdown' : 'code'} />;
  } else if (opened.kind === 'html') {
    body = source ? (
      <TextBody chatId={chatId} opened={opened} as="code" />
    ) : (
      <iframe title={opened.name} src={src} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="h-full w-full border-0 bg-white" />
    );
  } else if (opened.kind === 'image') {
    body = (
      <div className="flex h-full items-center justify-center p-3">
        <img src={src} alt={opened.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  } else if (opened.kind === 'video') {
    body = (
      <video
        data-testid="viewer-video"
        controls
        src={src}
        onError={() => (Date.now() - openedAt.current > STALE_LINK_MS ? setAttempt((a) => a + 1) : setError("This video can't be played here."))}
        className="max-h-full max-w-full"
      />
    );
  } else if (opened.kind === 'pdf') {
    body = <iframe title={opened.name} src={src} className="h-full w-full border-0" />;
  } else {
    body = <p className="p-3 text-sm text-[var(--text-muted)]">Can't preview this.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={opened.path}>
          {opened.name}
        </span>
        {canToggle && (
          <button type="button" aria-pressed={source} onClick={() => setSource((s) => !s)} className={TOGGLE}>
            Source
          </button>
        )}
        {isDesktop() && (
          <button type="button" onClick={() => void revealPath(opened.path)} className={TOGGLE}>
            Show in folder
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
