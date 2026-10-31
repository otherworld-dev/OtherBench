import { useEffect, useState, type JSX } from 'react';
import type { MediaProgress } from '@otherbench/core/ports/media.js';
import { isToolImageRef, isToolVideoRef } from '@otherbench/core/domain/tool-images.js';
import { api } from '../state/api.js';
import { authHeaders, hasToken } from '../state/transport.js';
import { AuthedImage } from './AuthedImage.js';
import { ImageLightbox } from './ImageLightbox.js';

/** The reply a generated file belongs to: it is served only for that chat and message. */
export interface MediaScope {
  chatId: string;
  messageId: string;
}

/** The names of the tools whose results are generated media. */
export function isGenerationTool(name: string): boolean {
  return name === 'generate_image' || name === 'generate_video';
}

/** True for a generation result that carries a stored image or video, which `GeneratedMedia` shows (an error result stays a plain result block). */
export function hasGeneratedMedia(result: unknown): boolean {
  return Array.isArray(result) && result.some((item) => isToolImageRef(item) || isToolVideoRef(item));
}

/** The `{ error: true, code, message }` a failed generation returns, or null for any other result. */
export function generationFailure(result: unknown): { code: string; message: string } | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  return r['error'] === true && typeof r['message'] === 'string' ? { code: typeof r['code'] === 'string' ? r['code'] : '', message: r['message'] } : null;
}

/** Why a generation gave nothing, as a short line where the media would have been. A stop is muted: nothing went wrong. */
export function GenerationFailure({ failure }: { failure: { code: string; message: string } }): JSX.Element {
  const stopped = failure.code === 'generation_cancelled' || failure.code === 'cancelled';
  return (
    <p data-testid="generation-failure" className={`my-1 text-xs ${stopped ? 'text-[var(--text-muted)]' : 'text-[var(--danger)]'}`}>
      {failure.message}
    </p>
  );
}

function extensionOf(mime: string): string {
  const sub = (mime.split('/')[1] ?? '').split(';')[0]?.replace(/[^a-z0-9]/gi, '') ?? '';
  return sub === 'jpeg' ? 'jpg' : sub || 'bin';
}

/**
 * A URL a `<video>` or a download can use against a token-protected server. With no token the server URL is used as is
 * (and supports seeking); with one the file is fetched with it and shown through an object URL, revoked on unmount.
 */
function useAuthedUrl(src: string): { url: string | null; failed: boolean } {
  const direct = !hasToken();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (direct) return;
    const controller = new AbortController();
    let created: string | null = null;
    fetch(src, { headers: authHeaders(), signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error(`[otherbench-web] failed to load media ${src}:`, err);
        setFailed(true);
      });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
      setObjectUrl(null);
    };
  }, [src, direct]);
  return direct ? { url: src, failed: false } : { url: objectUrl, failed };
}

/** Saves the file. With a token a plain link can't send it, so the file is fetched first. */
function DownloadLink({ src, filename }: { src: string; filename: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const className = 'underline decoration-dotted hover:text-[var(--text)]';
  if (!hasToken()) {
    return (
      <a href={src} download={filename} className={className}>
        Download
      </a>
    );
  }
  async function save(): Promise<void> {
    try {
      const res = await fetch(src, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setFailed(false);
    } catch (err) {
      console.error(`[otherbench-web] failed to download ${src}:`, err);
      setFailed(true);
    }
  }
  return (
    <span>
      <button type="button" onClick={() => void save()} className={className}>
        Download
      </button>
      {failed && <span className="ml-1 text-[var(--danger)]">Download failed.</span>}
    </span>
  );
}

function Note({ text }: { text: string }): JSX.Element {
  return (
    <p role="note" className="text-[var(--text-muted)] italic">
      {text}
    </p>
  );
}

function GeneratedImage({ src, mimeType }: { src: string; mimeType: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  if (missing) return <Note text="Image not available." />;
  return (
    <div className="space-y-1">
      <button type="button" aria-label="View full size" onClick={() => setOpen(true)} className="block cursor-zoom-in">
        <AuthedImage
          src={src}
          alt="Generated image"
          data-testid="generated-image"
          onError={() => setMissing(true)}
          onFailed={() => setMissing(true)}
          className="max-h-[28rem] max-w-full rounded border border-[var(--border)]"
        />
      </button>
      <div className="text-xs text-[var(--text-muted)]">
        <DownloadLink src={src} filename={`generated-image.${extensionOf(mimeType)}`} />
      </div>
      {open && <ImageLightbox src={src} label="Generated image" onClose={() => setOpen(false)} />}
    </div>
  );
}

function GeneratedVideo({ src, mimeType }: { src: string; mimeType: string }): JSX.Element {
  const { url, failed } = useAuthedUrl(src);
  const [broken, setBroken] = useState(false);
  if (failed || broken) return <Note text="Video not available." />;
  return (
    <div className="space-y-1">
      {url && <video controls src={url} data-testid="generated-video" onError={() => setBroken(true)} className="max-h-[28rem] max-w-full rounded border border-[var(--border)]" />}
      <div className="text-xs text-[var(--text-muted)]">
        <DownloadLink src={src} filename={`generated-video.${extensionOf(mimeType)}`} />
      </div>
    </div>
  );
}

/** What a finished `generate_image` or `generate_video` call returned: the file, a way to save it, and the line saying how it was made. */
export function GeneratedMedia({ result, scope }: { result: unknown; scope: MediaScope }): JSX.Element {
  const items = Array.isArray(result) ? (result as unknown[]) : [];
  return (
    <div data-testid="generated-media" className="my-1 space-y-1 text-sm">
      {items.map((item, i) => {
        if (isToolImageRef(item) || isToolVideoRef(item)) {
          if (item.pending === true) return <Note key={i} text={`${item.type === 'video' ? 'Video' : 'Image'} not available yet.`} />;
          const src = api.attachments.toolMediaUrl(scope.chatId, scope.messageId, item.attachmentId);
          return item.type === 'video' ? <GeneratedVideo key={i} src={src} mimeType={item.mimeType} /> : <GeneratedImage key={i} src={src} mimeType={item.mimeType} />;
        }
        const rec = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
        if (rec?.['type'] === 'text' && typeof rec['text'] === 'string') {
          return (
            <p key={i} className="text-xs text-[var(--text-muted)]">
              {rec['text']}
            </p>
          );
        }
        // Anything else (a media item that isn't a stored reference, say) is never dumped as data.
        return null;
      })}
    </div>
  );
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The state of a generation that is still running: queued, a step count when the backend gives one, else the time so far. */
export function GenerationProgress({ progress }: { progress?: MediaProgress | undefined }): JSX.Element {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const stage = progress?.stage ?? 'generating';
  const hasSteps = stage === 'generating' && progress?.step !== undefined && progress.steps !== undefined && progress.steps > 0;
  let text: string;
  if (stage === 'queued') text = 'Queued';
  else if (stage === 'saving') text = 'Saving…';
  else if (hasSteps) text = `Generating… step ${progress?.step} of ${progress?.steps}`;
  else text = `Generating… ${clock(Math.max(0, Math.floor((now - started) / 1000)))}`;
  return (
    <div data-testid="generation-progress" role="status" className="my-1 flex items-center gap-2 text-xs text-[var(--text-muted)]">
      <span>{text}</span>
      {hasSteps && <progress value={progress?.step} max={progress?.steps} className="h-1.5 w-32" />}
    </div>
  );
}
