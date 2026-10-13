import { useEffect, useRef, useState, type ImgHTMLAttributes, type JSX } from 'react';
import { authHeaders, hasToken } from '../state/transport.js';

/**
 * An `<img>` that works against a token-protected server. A plain
 * `<img src>` can't send `Authorization`, so when a token is configured
 * (desktop mode) the image is fetched with it and shown through an object
 * URL, revoked when the component unmounts or `src` changes. In browser
 * mode there is no token and `src` is used as-is, exactly as before.
 */
export function AuthedImage({
  src,
  onFailed,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  /** Called once when the image can't be fetched with the token (a 404, a network error). The `<img>`'s own `onError` covers the direct case. */
  onFailed?: () => void;
}): JSX.Element | null {
  const direct = !hasToken();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  // Read through a ref so a new callback each render doesn't refetch the image.
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });

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
        console.error(`[grunt-web] failed to load image ${src}:`, err);
        failed.current?.();
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
