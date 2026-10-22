import type { MediaConnection } from '@otherbench/core/ports/media.js';
import { MAX_TOOL_VIDEO_BYTES } from '@otherbench/core/domain/tool-images.js';

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function authHeader(conn: MediaConnection): string | null {
  const key = conn.apiKey;
  if (!key) return null;
  // A1111 behind --api-auth takes `user:pass` as HTTP Basic.
  if (conn.kind === 'a1111' && key.includes(':')) {
    return `Basic ${Buffer.from(key, 'utf8').toString('base64')}`;
  }
  return `Bearer ${key}`;
}

/**
 * Fetch `path` relative to the connection's base URL with its credentials and
 * extra headers. A network failure becomes a plain-English error naming the
 * base URL (never the key); an abort stays an `AbortError`.
 */
export async function mediaFetch(
  conn: MediaConnection,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const base = conn.baseUrl.replace(/\/+$/, '');
  let url: string;
  let headers: Headers;
  try {
    if (/^https?:\/\//i.test(path)) {
      // Credentials only ever go to the connection's own origin.
      if (new URL(path).origin !== new URL(conn.baseUrl).origin) {
        throw new Error('The server answered with a link to another site.');
      }
      url = path;
    } else {
      url = base + (path.startsWith('/') ? path : `/${path}`);
    }
    headers = new Headers(conn.extraHeaders);
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    const auth = authHeader(conn);
    if (auth) headers.set('authorization', auth);
  } catch (e) {
    if (e instanceof Error && e.message === 'The server answered with a link to another site.') throw e;
    // Node quotes the offending value in its own message, which could be the key.
    throw new Error("The API key or a header value has characters that can't be sent.");
  }
  try {
    // Never follow a redirect: extra headers would travel with it to another site.
    return await fetch(url, { ...init, headers, signal, redirect: 'error' });
  } catch (e) {
    if (signal.aborted || isAbort(e)) throw abortError();
    const cause = (e as { cause?: { message?: string } } | null)?.cause;
    const reason = cause?.message ?? (e instanceof Error ? e.message : String(e));
    if (/redirect/i.test(reason)) throw new Error(`${conn.baseUrl} tried to redirect the request, which isn't allowed.`);
    throw new Error(`Couldn't reach ${conn.baseUrl}: ${reason}`);
  }
}

/** Read a body, stopping as soon as it passes `cap` bytes. */
export async function readCapped(res: Response, cap: number = MAX_TOOL_VIDEO_BYTES): Promise<Buffer> {
  const tooBig = () =>
    new Error(`The server's answer was larger than ${Math.floor(cap / (1024 * 1024))} MB, so it was refused.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Read a capped body as JSON. */
export async function readJson(res: Response, conn: MediaConnection): Promise<unknown> {
  const text = (await readCapped(res)).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${conn.baseUrl} answered with something that isn't JSON.`);
  }
}

export function httpError(conn: MediaConnection, res: Response, what: string): Error {
  if (res.status === 401 || res.status === 403) {
    return new Error(`${conn.baseUrl} refused the credentials (HTTP ${res.status}). Check the API key.`);
  }
  return new Error(`${what} failed at ${conn.baseUrl} (HTTP ${res.status}).`);
}
