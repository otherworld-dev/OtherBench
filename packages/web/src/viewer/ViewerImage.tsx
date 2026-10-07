import { useEffect, useState, type JSX } from 'react';
import { api } from '../state/api.js';
import { serverUrl } from '../state/transport.js';

/**
 * An image a viewed Markdown file points at, from the chat's folders (Deck
 * #901): it gets its own `/view/` link, as any image the viewer opens. One
 * that can't be shown (missing, outside the chat's folders, not an image) is
 * its alt text in brackets.
 */
export function ViewerImage({ chatId, path, alt }: { chatId: string; path: string; alt: string }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    api.view.open(chatId, path).then(
      (o) => {
        if (cancelled) return;
        if (o.kind === 'image' && o.url) setSrc(serverUrl(o.url));
        else setFailed(true);
      },
      () => !cancelled && setFailed(true)
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, path]);
  if (failed) return <span title={path} className="text-[var(--text-faint)]">[{alt || path}]</span>;
  if (!src) return <span className="text-[var(--text-faint)]">{alt}</span>;
  return <img src={src} alt={alt} className="max-w-full" />;
}
