/**
 * Where the API lives and how to authenticate to it -- the one place every
 * request, stream and image fetch in the web client gets its URL and
 * headers from.
 *
 * Browser mode (`grunt serve` + a browser) keeps the defaults: same-origin
 * `/api`, no token, so every request is byte-identical to what the client
 * sent before this module existed. The desktop shell serves this bundle
 * from its own webview origin instead and hands over the sidecar server's
 * address and per-launch token at boot (main.tsx, desktop/bridge.ts).
 */

export interface TransportConfig {
  /** Origin of the Grunt server, e.g. `http://127.0.0.1:51234`; `''` for same-origin. */
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

export function hasToken(): boolean {
  return config.token !== null;
}

export function authHeaders(): Record<string, string> {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

/**
 * `fetch` against `/api${path}` with the auth header added. `init.headers`
 * must be a plain object -- every caller in this client builds one -- so
 * the merge stays a simple spread.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const auth = authHeaders();
  if (Object.keys(auth).length === 0) return init === undefined ? fetch(apiUrl(path)) : fetch(apiUrl(path), init);
  return fetch(apiUrl(path), { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...auth } });
}
