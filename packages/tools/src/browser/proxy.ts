import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP, type AddressInfo, type Socket } from 'node:net';
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
  /**
   * Tests only (`GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS`): 127.0.0.1 may be reached
   * on these ports. Core's own rules (local names, private and loopback
   * addresses) are applied by the proxy itself whatever `check` says; this is
   * the one way through them, and it is off unless set.
   */
  allowLoopbackPorts?: readonly number[];
  /** How long an upstream connection may take to open; default 15 s. */
  connectTimeoutMs?: number;
  /** How long a tunnel, or a plain request waiting on its upstream, may sit silent; default 5 minutes. */
  idleTimeoutMs?: number;
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
  check: (host: string, port: number) => string | null,
  opts: { allowLoopbackPorts?: readonly number[] } = {}
): { site: string | null; port: number | null; denial: string | null } {
  // `check` carries the profile's rules (its blocklist). Core's own floor
  // (local names, private and loopback addresses) is applied here as well, so a
  // mis-wired `check` can't drop it; the loopback allowance only exists when
  // `opts` sets it.
  const parsed = browserUrlCheck(raw, {}, { allowLoopbackPorts: opts.allowLoopbackPorts });
  if (parsed.site === null || parsed.port === null) return { site: null, port: null, denial: parsed.denial ?? "Grunt couldn't tell which website this is for." };
  return { site: parsed.site, port: parsed.port, denial: check(parsed.site, parsed.port) ?? parsed.denial };
}

/** Headers that belong to one hop, not to the request: never forwarded on the plain path. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { ...headers };
  const named = String(headers.connection ?? '').split(',').map((t) => t.trim().toLowerCase());
  for (const name of [...HOP_BY_HOP, ...named]) if (name !== '') delete out[name];
  return out;
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

/**
 * Holds whatever a CONNECT or upgrade client sends before its tunnel is open,
 * and drops the client if it hangs up first (an HTTP server socket doesn't
 * notice a hang-up nobody is reading).
 */
function watchClient(client: Socket): { release(): Buffer } {
  const early: Buffer[] = [];
  let size = 0;
  const onData = (chunk: Buffer): void => {
    size += chunk.length;
    if (size > 64 * 1024) client.destroy();
    else early.push(chunk);
  };
  const onEnd = (): void => {
    client.destroy();
  };
  client.on('data', onData);
  client.once('end', onEnd);
  return {
    release() {
      client.off('data', onData);
      client.off('end', onEnd);
      client.pause();
      return Buffer.concat(early);
    },
  };
}

type Routed = { ip: string; url: URL; site: string; port: number } | { refused: string; host: string; bad: boolean };

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const password = randomBytes(18).toString('hex');
  const resolveName = options.resolve ?? defaultResolve;
  const addressAllowed = options.addressAllowed ?? ((ip: string) => isPublicAddress(ip));
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  let closed = false;
  const sockets = new Set<Duplex>();
  const requests = new Set<ClientRequest>();
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
    const verdict = checkProxyTarget(raw, (host, port) => options.check(user, host, port), { allowLoopbackPorts: options.allowLoopbackPorts });
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

  /**
   * Pipes `client` and a new connection to `ip:port`; `onOpen` writes whatever
   * must go first. Nothing is connected for a client that has already gone
   * (it left during the lookup), and whichever side ends or goes quiet takes
   * the other with it.
   */
  function tunnel(client: Socket, ip: string, port: number, onOpen: (upstream: Duplex) => void): void {
    if (closed || client.destroyed) return;
    let open = false;
    const upstream = netConnect({ host: ip, port });
    track(upstream);
    const connectTimer = setTimeout(() => {
      upstream.destroy();
      if (!client.destroyed) client.end(BAD_GATEWAY);
    }, connectTimeoutMs);
    const teardown = (): void => {
      clearTimeout(connectTimer);
      upstream.destroy();
      client.destroy();
    };
    upstream.once('connect', () => {
      clearTimeout(connectTimer);
      open = true;
      upstream.setTimeout(idleTimeoutMs);
      client.setTimeout(idleTimeoutMs);
      onOpen(upstream);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('timeout', teardown);
    client.on('timeout', teardown);
    upstream.on('error', () => {
      if (client.destroyed) return;
      if (open) client.destroy();
      else client.end(BAD_GATEWAY);
    });
    upstream.on('close', () => {
      clearTimeout(connectTimer);
      if (open) client.destroy();
    });
    client.on('close', () => {
      clearTimeout(connectTimer);
      upstream.destroy();
    });
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = userOf(req);
    if (user === null) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="grunt"' }).end();
      return;
    }
    // The browser going away (or close()) ends the upstream request too, however far along it is.
    let upstream: ClientRequest | undefined;
    let gone = false;
    res.on('close', () => {
      if (res.writableFinished) return;
      gone = true;
      upstream?.destroy();
    });
    const where = await route(user, req.url ?? '');
    if ('refused' in where) {
      refuse(user, where.host, where.refused);
      res.writeHead(where.bad ? 400 : 403, { 'Content-Type': 'text/plain; charset=utf-8' }).end(where.refused);
      return;
    }
    if (gone || closed || res.destroyed) return;
    const request = httpRequest(
      {
        host: where.ip,
        port: where.port,
        method: req.method,
        path: `${where.url.pathname}${where.url.search}`,
        headers: { ...withoutHopByHop(req.headers), host: where.url.host },
        setHost: false,
        agent: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, withoutHopByHop(up.headers));
        up.pipe(res);
        up.on('error', () => res.destroy());
        up.on('close', () => {
          if (!up.complete) res.destroy();
        });
      }
    );
    upstream = request;
    requests.add(request);
    request.on('close', () => requests.delete(request));
    request.on('socket', (socket: Socket) => {
      track(socket);
      if (socket.connecting) {
        const timer = setTimeout(() => request.destroy(), connectTimeoutMs);
        socket.once('connect', () => clearTimeout(timer));
        socket.once('close', () => clearTimeout(timer));
      }
    });
    request.setTimeout(idleTimeoutMs, () => request.destroy());
    request.on('error', () => {
      if (!res.headersSent && !res.destroyed) res.writeHead(502);
      res.end();
    });
    req.pipe(request);
  }

  async function handleConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
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
    const watch = watchClient(client);
    const where = await route(user, `http://${authority}/`);
    const first = Buffer.concat([head, watch.release()]);
    if ('refused' in where) {
      refuse(user, where.host, where.refused);
      client.end(where.bad ? BAD_REQUEST : FORBIDDEN);
      return;
    }
    tunnel(client, where.ip, where.port, (upstream) => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (first.length > 0) upstream.write(first);
    });
  }

  async function handleUpgrade(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    track(client);
    client.on('error', () => client.destroy());
    const user = userOf(req);
    if (user === null) {
      client.end(NEED_AUTH);
      return;
    }
    const watch = watchClient(client);
    const where = await route(user, req.url ?? '');
    const first = Buffer.concat([head, watch.release()]);
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
      if (first.length > 0) upstream.write(first);
    });
  }

  const server = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  server.on('connection', track);
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    handleConnect(req, client, head).catch(() => client.destroy());
  });
  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
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
      closed = true;
      for (const r of requests) r.destroy();
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
