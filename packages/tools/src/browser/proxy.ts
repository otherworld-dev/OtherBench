import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { browserUrlCheck, isPublicAddress } from '@grunt/core/domain/browser-hosts.js';

/**
 * Grunt's egress proxy for the model's browser (spec
 * 2026-10-12-model-browser-design §2). Every byte the browser sends goes
 * through it. It listens on 127.0.0.1 only, needs per-launch credentials,
 * checks each hostname, resolves it ITSELF and connects to the checked
 * address, so DNS rebinding can't swap the address after the check. It
 * handles CONNECT (https, wss), absolute-form plain-HTTP requests and HTTP
 * upgrades.
 *
 * The host of every request is derived exactly as core derives it
 * (`browserUrlCheck`: WHATWG `new URL()` plus one normalisation; userinfo,
 * backslashes, whitespace, control characters, other schemes and empty hosts
 * are refused, never repaired), so a card, a grant and a connection can never
 * disagree about which host an address means. Nothing here parses a host by
 * hand. The only text this file takes apart is the `:port` end of a CONNECT
 * authority, and the whole authority then goes through the core parser.
 */

export interface EgressProxyOptions {
  /** Why `host:port` may not be reached for proxy user `user` (one per chat), or null. `host` is normalised. */
  check(user: string, host: string, port: number): string | null;
  /** Whether a resolved address (canonical form) may be connected to; defaults to isPublicAddress. */
  addressAllowed?(ip: string, port: number): boolean;
  /** Name lookup; defaults to dns.lookup(host, { all: true }). Tests inject one. */
  resolve?(host: string): Promise<string[]>;
  /** Told about every refused request. */
  onRefused?(user: string, host: string, reason: string): void;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`. */
  server: string;
  /** This launch's password; every user (one per chat) shares it. */
  password: string;
  close(): Promise<void>;
}

const NEED_AUTH = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="grunt"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const FORBIDDEN = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const BAD_GATEWAY = 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

async function defaultResolve(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

/**
 * The proxy's own host check, a pure function: the site and port of the raw
 * address as core reads them (`browserUrlCheck`), and why it is refused. The
 * address is refused when it has no usable site (missing host fails closed);
 * otherwise `check` decides, with the canonical host and the port.
 */
export function checkProxyTarget(
  raw: string,
  check: (host: string, port: number) => string | null
): { site: string | null; port: number | null; denial: string | null } {
  // Core's policy part is bypassed ({}), only its parsing is used: the profile's
  // own rules, and the tests-only loopback allowance, come in through `check`.
  const parsed = browserUrlCheck(raw, {});
  if (parsed.site === null || parsed.port === null) return { site: null, port: null, denial: parsed.denial ?? "Grunt couldn't tell which website this is for." };
  return { site: parsed.site, port: parsed.port, denial: check(parsed.site, parsed.port) };
}

/** A resolved address in canonical form (IPv6 compressed, a v4-mapped one as hex words), or null when it isn't an address. */
function canonicalAddress(ip: string): string | null {
  const family = isIP(ip);
  if (family === 0) return null;
  try {
    const host = new URL(family === 6 ? `http://[${ip}]/` : `http://${ip}/`).hostname;
    return family === 6 ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

type Routed = { ip: string; url: URL; site: string; port: number } | { refused: string; host: string; bad: boolean };

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const password = randomBytes(18).toString('hex');
  const resolveName = options.resolve ?? defaultResolve;
  const addressAllowed = options.addressAllowed ?? ((ip: string) => isPublicAddress(ip));
  const sockets = new Set<Duplex>();
  const track = (s: Duplex): void => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };

  /** The proxy user a request authenticated as, or null. */
  function userOf(req: IncomingMessage): string | null {
    const header = req.headers['proxy-authorization'];
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('basic ')) return null;
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    const given = Buffer.from(decoded.slice(colon + 1));
    const want = Buffer.from(password);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    return decoded.slice(0, colon);
  }

  /**
   * The checked address to connect to for the raw absolute URL `raw`, or why
   * not. Order: the core parse and the profile's rules (before any lookup),
   * then the lookup, then EVERY resolved address must be allowed.
   */
  async function route(user: string, raw: string): Promise<Routed> {
    const verdict = checkProxyTarget(raw, (host, port) => options.check(user, host, port));
    if (verdict.site === null || verdict.port === null) return { refused: verdict.denial ?? 'Not a usable address.', host: raw.slice(0, 200), bad: true };
    const { site, port } = verdict;
    if (verdict.denial) return { refused: verdict.denial, host: site, bad: false };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { refused: 'Not a usable port.', host: site, bad: true };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { refused: 'Not a usable address.', host: raw.slice(0, 200), bad: true };
    }
    // Only http: is proxied here (https and wss arrive as CONNECT, which builds an http address).
    if (url.protocol !== 'http:') return { refused: 'Only http addresses are proxied this way.', host: site, bad: true };
    let found: string[];
    try {
      found = isIP(site) ? [site] : await resolveName(site);
    } catch {
      return { refused: `${site} could not be found.`, host: site, bad: false };
    }
    if (found.length === 0) return { refused: `${site} could not be found.`, host: site, bad: false };
    const addresses: string[] = [];
    for (const address of found) {
      const canonical = canonicalAddress(address);
      if (canonical === null || !addressAllowed(canonical, port)) {
        return { refused: `${site} points at a local or private address (${address}).`, host: site, bad: false };
      }
      addresses.push(canonical);
    }
    return { ip: addresses[0]!, url, site, port };
  }

  function refuse(user: string, host: string, reason: string): void {
    try {
      options.onRefused?.(user, host, reason);
    } catch (err) {
      console.error('[browser-proxy] onRefused threw:', err);
    }
  }

  /** Pipes `client` and a new connection to `ip:port`; `onOpen` writes whatever must go first. */
  function tunnel(client: Duplex, ip: string, port: number, onOpen: (upstream: Duplex) => void): void {
    let open = false;
    const upstream = netConnect({ host: ip, port }, () => {
      open = true;
      onOpen(upstream);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => {
      if (client.destroyed) return;
      if (open) client.destroy();
      else client.end(BAD_GATEWAY);
    });
    client.on('close', () => upstream.destroy());
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = userOf(req);
    if (user === null) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="grunt"' }).end();
      return;
    }
    const where = await route(user, req.url ?? '');
    if ('refused' in where) {
      refuse(user, where.host, where.refused);
      res.writeHead(where.bad ? 400 : 403, { 'Content-Type': 'text/plain; charset=utf-8' }).end(where.refused);
      return;
    }
    const headers: OutgoingHttpHeaders = { ...req.headers, host: where.url.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest(
      { host: where.ip, port: where.port, method: req.method, path: `${where.url.pathname}${where.url.search}`, headers, setHost: false, agent: false },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('socket', track);
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }

  async function handleConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    track(client);
    client.on('error', () => client.destroy());
    const user = userOf(req);
    if (user === null) {
      client.end(NEED_AUTH);
      return;
    }
    // A CONNECT target is `host:port`. It must end in an explicit port and
    // can't carry anything that would change the address's shape (a path,
    // query, fragment or userinfo); the whole authority then goes through the
    // core parser as an http address.
    const authority = req.url ?? '';
    if (!/:\d{1,5}$/.test(authority) || /[/?#@]/.test(authority)) {
      refuse(user, authority.slice(0, 200), 'Not a usable address.');
      client.end(BAD_REQUEST);
      return;
    }
    const where = await route(user, `http://${authority}/`);
    if ('refused' in where) {
      refuse(user, where.host, where.refused);
      client.end(where.bad ? BAD_REQUEST : FORBIDDEN);
      return;
    }
    tunnel(client, where.ip, where.port, (upstream) => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
    });
  }

  async function handleUpgrade(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    track(client);
    client.on('error', () => client.destroy());
    const user = userOf(req);
    if (user === null) {
      client.end(NEED_AUTH);
      return;
    }
    const where = await route(user, req.url ?? '');
    if ('refused' in where) {
      refuse(user, where.host, where.refused);
      client.end(where.bad ? BAD_REQUEST : FORBIDDEN);
      return;
    }
    tunnel(client, where.ip, where.port, (upstream) => {
      const lines = [`${req.method ?? 'GET'} ${where.url.pathname}${where.url.search} HTTP/1.1`, `Host: ${where.url.host}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        if (/^(proxy-authorization|proxy-connection|host)$/i.test(name)) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ''}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
    });
  }

  const server = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  server.on('connection', track);
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    handleConnect(req, client, head).catch(() => client.destroy());
  });
  server.on('upgrade', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    handleUpgrade(req, client, head).catch(() => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    password,
    close: async () => {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
