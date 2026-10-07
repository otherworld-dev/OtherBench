/** How the viewer shows a file (Deck #826). `text` and `other` are told apart by the bytes, not the name. */
export type ViewKind = 'image' | 'video' | 'pdf' | 'html' | 'markdown' | 'text' | 'other';

interface Served {
  /** The kind it opens as, or `asset`: a file only an HTML page's folder link serves (its CSS, scripts, fonts). */
  kind: 'image' | 'video' | 'pdf' | 'html' | 'asset';
  mime: string;
}

/** What a `/view/` link may serve, by lower-case extension, with the Content-Type sent: always this, never the file's own. */
const SERVED: Readonly<Record<string, Served>> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  avif: { kind: 'image', mime: 'image/avif' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  ogg: { kind: 'video', mime: 'video/ogg' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  html: { kind: 'html', mime: 'text/html; charset=utf-8' },
  htm: { kind: 'html', mime: 'text/html; charset=utf-8' },
  css: { kind: 'asset', mime: 'text/css; charset=utf-8' },
  js: { kind: 'asset', mime: 'text/javascript; charset=utf-8' },
  mjs: { kind: 'asset', mime: 'text/javascript; charset=utf-8' },
  json: { kind: 'asset', mime: 'application/json' },
  txt: { kind: 'asset', mime: 'text/plain; charset=utf-8' },
  wasm: { kind: 'asset', mime: 'application/wasm' },
  woff: { kind: 'asset', mime: 'font/woff' },
  woff2: { kind: 'asset', mime: 'font/woff2' },
  ttf: { kind: 'asset', mime: 'font/ttf' },
  otf: { kind: 'asset', mime: 'font/otf' },
  ico: { kind: 'asset', mime: 'image/x-icon' },
};

const MARKDOWN = new Set(['md', 'markdown']);

/** The extension of `path`'s last segment, lower-cased, without the dot; '' when there is none (or only a leading dot). */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** What a `/view/` link serves `path` as, or null when it may not be served. Own keys only: `x.constructor` is not a type. */
export function servedType(path: string): Served | null {
  const ext = extensionOf(path);
  return Object.hasOwn(SERVED, ext) ? SERVED[ext]! : null;
}

/** The kind `path` opens as when its name decides it; null means text or other, which the bytes decide. */
export function kindByName(path: string): 'image' | 'video' | 'pdf' | 'html' | 'markdown' | null {
  if (MARKDOWN.has(extensionOf(path))) return 'markdown';
  const served = servedType(path);
  return served && served.kind !== 'asset' ? served.kind : null;
}
