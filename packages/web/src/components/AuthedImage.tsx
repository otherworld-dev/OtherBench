import { useEffect, useState, type ImgHTMLAttributes, type JSX } from 'react';
import { authHeaders, hasToken } from '../state/transport.js';

/**
 * An `<img>` that works against a token-protected server. A plain
 * `<img src>` can't send `Authorization`, so when a token is configured
 * (desktop mode) the image is fetched with it and shown through an object
 * URL, revoked when the component unmounts or `src` changes. In browser
 * mode there is no token and `src` is used as-is, exactly as before.
 */
export function AuthedImage({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }): JSX.Element | null {
  const direct = !hasToken();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

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
        if (!controller.signal.aborted) console.error(`[grunt-web] failed to load image ${src}:`, err);
      });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
      setObjectUrl(null);
    };
  }, [src, direct]);

  if (direct) return <img src={src} {...rest} />;
  return objectUrl ? <img src={objectUrl} {...rest} /> : null;
}
