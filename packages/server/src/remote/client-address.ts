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

/**
 * Who is asking (spec, "Client address"): the socket's address; or, when
 * that is a trusted proxy, the right-most `X-Forwarded-For` entry that is a
 * valid IP and not a trusted proxy. Exact IPs only. With no usable entry it
 * stays the proxy's own address, so everyone behind it shares one, which
 * fails safe for the limiter and the `/view/` binding.
 */
export function clientAddress(c: Context, trusted: ReadonlySet<string>): string | null {
  const peer = socketAddress(c);
  if (peer === null || !trusted.has(peer)) return peer;
  const forwarded = c.req.header('x-forwarded-for');
  if (!forwarded) return peer;
  const entries = forwarded.split(',');
  for (let i = entries.length - 1; i >= 0; i--) {
    const ip = normalizeIp(entries[i]);
    if (ip !== null && !trusted.has(ip)) return ip;
  }
  return peer;
}
