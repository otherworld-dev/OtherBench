import { isIP } from 'node:net';
import type { Context } from 'hono';

/** An IP in one canonical text form (no brackets, no `::ffff:` for IPv4, lower case), or null for anything else. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

/** The socket's remote address. Null under `app.request` in tests, which passes no `env` unless asked. */
export function socketAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return normalizeIp(env?.incoming?.socket?.remoteAddress);
}

/** `a.b.c.d:port` or `[v6]:port` without the port; anything else as it came. */
function withoutPort(entry: string): string {
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(entry);
  if (v4) return v4[1] as string;
  const v6 = /^(\[[^\]]+\]):\d{1,5}$/.exec(entry);
  return v6 ? (v6[1] as string) : entry;
}

/**
 * Who is asking (spec, "Client address"): the socket's address; or, when
 * that is a trusted proxy, the first `X-Forwarded-For` entry from the right
 * that is not a trusted proxy. A `:port` on it is dropped. Exact IPs only.
 * Only the entries the trusted proxies wrote are believed, so the walk stops
 * at the first one that isn't a proxy: if that doesn't parse as an IP (a
 * proxy that appends something odd), the answer is the proxy's own address,
 * never an entry further left, which the client wrote. Everyone behind it
 * then shares one address, which fails safe for the limiter and the `/view/`
 * binding.
 */
export function clientAddress(c: Context, trusted: ReadonlySet<string>): string | null {
  const peer = socketAddress(c);
  if (peer === null || !trusted.has(peer)) return peer;
  const forwarded = c.req.header('x-forwarded-for');
  if (!forwarded) return peer;
  const entries = forwarded.split(',');
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = (entries[i] ?? '').trim();
    const ip = normalizeIp(withoutPort(entry));
    if (ip !== null && trusted.has(ip)) continue;
    return ip ?? peer;
  }
  return peer;
}
