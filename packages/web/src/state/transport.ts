/**
 * Where the API lives and how to authenticate to it -- the one place every
 * request, stream and image fetch in the web client gets its URL and
 * headers from.
 *
 * Browser mode (`otherbench serve` + a browser) keeps the defaults: same-origin
 * `/api`, no token, so every request is byte-identical to what the client
 * sent before this module existed. The desktop shell serves this bundle
 * from its own webview origin instead and hands over the sidecar server's
 * address and per-launch token at boot (main.tsx, desktop/bridge.ts).
 */

export interface TransportConfig {
  /** Origin of the OtherBench server, e.g. `http://127.0.0.1:51234`; `''` for same-origin. */
  baseUrl: string;
  /** Bearer token for every `/api` call, or `null` when the server enforces none. */
  token: string | null;
}

let config: TransportConfig = { baseUrl: '', token: null };

export function configureTransport(cfg: TransportConfig): void {
  config = { baseUrl: cfg.baseUrl.replace(/\/+$/, ''), token: cfg.token };
}

export function apiUrl(path: string): string {
  return `${config.baseUrl}/api${path}`;
}

/** A URL on the OtherBench server outside `/api` (the viewer's `/view/` links, Deck #826). */
export function serverUrl(path: string): string {
  return `${config.baseUrl}${path}`;
}

export function hasToken(): boolean {
  return config.token !== null;
}

export function authHeaders(): Record<string, string> {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

const unauthorizedListeners = new Set<() => void>();

/**
 * Sign-in mode (spec 2026-10-12-remote-access §5): told whenever the server
 * answers 401, so the sign-in gate can show the login page. Returns the
 * unsubscribe. Nothing listens in the desktop app or in open mode.
 */
export function onUnauthorized(cb: () => void): () => void {
  unauthorizedListeners.add(cb);
  return () => {
    unauthorizedListeners.delete(cb);
  };
}

/** Tells every `onUnauthorized` listener. Called by `apiFetch` and the SSE connect on a 401. */
export function reportUnauthorized(): void {
  for (const cb of [...unauthorizedListeners]) cb();
}

/**
 * `fetch` against `/api${path}` with the auth header added. `init.headers`
 * must be a plain object -- every caller in this client builds one -- so
 * the merge stays a simple spread. A 401 is reported to `onUnauthorized`.
 * Same-origin fetches already carry the sign-in cookie.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const auth = authHeaders();
  const sent =
    Object.keys(auth).length === 0
      ? init === undefined
        ? fetch(apiUrl(path))
        : fetch(apiUrl(path), init)
      : fetch(apiUrl(path), { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...auth } });
  return sent.then((res) => {
    if (res.status === 401) reportUnauthorized();
    return res;
  });
}
