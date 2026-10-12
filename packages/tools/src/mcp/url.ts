/**
 * Every URL comparison on the MCP sign-in path, in one place. Each URL is
 * parsed once with WHATWG `new URL()` (what `fetch` and the SDK use) and
 * compared by its parsed parts, never by string operations on the raw text.
 *
 * Refused outright, because parsers disagree about them: userinfo
 * (`https://good@evil.example/` — some readers see `good`, fetch connects to
 * `evil`), a backslash (WHATWG reads `\` as `/` in http(s) URLs, RFC 3986
 * parsers don't), and whitespace or control characters (WHATWG silently
 * strips or encodes them). Only http and https are accepted.
 *
 * Normalised: the host is lower-cased and IDN hosts are punycoded (both by
 * WHATWG), a trailing dot on the host is dropped, a default port (`:443`,
 * `:80`) is dropped (WHATWG), and percent-encoding in the path follows
 * RFC 3986 §6.2.2: hex upper-cased, unreserved characters (`A-Z a-z 0-9 - . _ ~`)
 * decoded, everything else (`%2F` included) left encoded. The path is kept
 * otherwise exactly: `/mcp` and `/mcp/` and `/mcp-evil` are three resources.
 * A resource has no query or fragment.
 */

/** The authority part of the raw text (between `//` and the first `/`, `?` or `#`). */
function rawAuthority(raw: string): string {
  const start = raw.indexOf('//');
  if (start === -1) return '';
  const rest = raw.slice(start + 2);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Parses an http(s) URL as fetch will, or null when it is refused (see the module comment). */
export function parseHttpUrl(raw: string | URL): URL | null {
  const text = typeof raw === 'string' ? raw : raw.href;
  if (/[\\\s\u0000-\u001f\u007f]/.test(text)) return null;
  if (rawAuthority(text).includes('@')) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url;
}

/** The host as compared: WHATWG's (lower-cased, punycoded, IPv6 in brackets) without a trailing dot. */
export function hostOf(url: URL): string {
  return url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
}

function originOf(url: URL): string {
  return `${url.protocol}//${hostOf(url)}${url.port ? `:${url.port}` : ''}`;
}

function normalisePath(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_match: string, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /^[A-Za-z0-9\-._~]$/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

function partsOf(raw: string | URL): { origin: string; path: string } | null {
  const url = parseHttpUrl(raw);
  return url ? { origin: originOf(url), path: normalisePath(url.pathname) } : null;
}

/** The resource identifier tokens are bound to: scheme, host and port, and the path, normalised; no query or fragment. Null when refused. */
export function normaliseResource(raw: string | URL): string | null {
  const parts = partsOf(raw);
  return parts ? `${parts.origin}${parts.path}` : null;
}

/** Whether two addresses name the same resource. False when either is missing or refused. */
export function sameResource(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normaliseResource(a);
  return na !== null && na === normaliseResource(b);
}

/** Whether two addresses share scheme, host and port. False when either is refused. */
export function sameOrigin(a: string | URL, b: string | URL): boolean {
  const pa = partsOf(a);
  const pb = partsOf(b);
  return pa !== null && pb !== null && pa.origin === pb.origin;
}

/**
 * Whether protected-resource metadata naming `resource` may speak for the
 * MCP server at `serverUrl` (RFC 9728 §3.3 as MCP applies it): the same
 * origin, and the server's path is the resource's path or lies under it,
 * segment by segment (`/` covers everything, `/mcp` covers `/mcp/x` but not
 * `/mcp-evil`). Not exact identity, because the SDK falls back to the
 * origin's root metadata, whose resource is the origin itself.
 */
export function resourceCovers(serverUrl: string | URL, resource: string | URL): boolean {
  const server = partsOf(serverUrl);
  const res = partsOf(resource);
  if (!server || !res || server.origin !== res.origin) return false;
  if (server.path === res.path) return true;
  const prefix = res.path.endsWith('/') ? res.path : `${res.path}/`;
  return server.path.startsWith(prefix);
}

/**
 * Whether authorization-server metadata's `issuer` names the authorization
 * server it was discovered from (RFC 8414 §3.3): the same normalised
 * address, path included, and no query or fragment.
 */
export function sameIssuer(issuer: string, authorizationServerUrl: string | URL): boolean {
  if (/[?#]/.test(issuer)) return false;
  const a = normaliseResource(issuer);
  return a !== null && a === normaliseResource(authorizationServerUrl);
}

/** Why an http MCP server address can't be saved, or null. Refuses userinfo and backslashes; other malformed addresses are left to the connection's own error. */
export function mcpServerUrlProblem(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (rawAuthority(raw).includes('@')) return "A server address can't hold a user name or password. Send credentials in a header instead.";
  if (raw.includes('\\')) return "A server address can't contain a backslash.";
  return null;
}
