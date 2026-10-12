import { createServer as createHttpServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserHostDenial, browserUrlCheck } from '@grunt/core/domain/browser-hosts.js';
import { BROWSER_HOST_VECTORS, type BrowserHostVector } from '@grunt/core/testing/browser-host-vectors.js';
import { checkProxyTarget, startEgressProxy, type EgressProxy, type EgressProxyOptions } from '../../src/browser/proxy.js';

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const portOf = (s: Server | NetServer) => (s.address() as AddressInfo).port;
const listen = (s: Server | NetServer) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));

let echo: NetServer;
let site: Server;
let siteHits: string[];
/** The headers each request (plain or upgrade) reached the fixture site with. */
let siteHeaders: IncomingMessage['headers'][];
/** Every connection the echo fixture accepted, and a promise per connection that settles when it closes. */
let echoSockets: Socket[];
let echoClosed: Promise<void>[];
/** Settles when the fixture's `/sse` or `/upload` response is cut off by the other side. */
let sseClosed: Promise<void>;
let uploadClosed: Promise<void>;
let proxy: EgressProxy | null = null;

/** Resolves true if `p` settles within `ms`, false if not. */
const settlesWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  siteHits = [];
  siteHeaders = [];
  echoSockets = [];
  echoClosed = [];
  let sseDone!: () => void;
  let uploadDone!: () => void;
  sseClosed = new Promise<void>((r) => (sseDone = r));
  uploadClosed = new Promise<void>((r) => (uploadDone = r));
  echo = createNetServer((socket) => {
    echoSockets.push(socket);
    echoClosed.push(new Promise<void>((r) => socket.on('close', () => r())));
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  site = createHttpServer((req, res) => {
    siteHits.push(req.url ?? '');
    siteHeaders.push(req.headers);
    if (req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': hello\n\n');
      res.on('close', () => sseDone());
      return;
    }
    if (req.url === '/echo') {
      req.pipe(res);
      return;
    }
    if (req.url === '/upload') {
      res.on('close', () => uploadDone());
      return;
    }
    res.end(`${req.url} ${req.headers.host} ${req.headers['proxy-authorization'] ?? 'none'}`);
  });
  site.on('upgrade', (req, socket: Socket) => {
    siteHeaders.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
    socket.on('error', () => undefined);
  });
  await listen(echo);
  await listen(site);
});

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  for (const s of echoSockets) s.destroy();
  echo.close();
  site.closeAllConnections();
  site.close();
});

/** A proxy where `*.test` names resolve to 127.0.0.1 and only the fixtures' ports on it may be reached. */
async function start(o: Partial<EgressProxyOptions> = {}): Promise<EgressProxy> {
  const fixturePorts = [portOf(echo), portOf(site)];
  proxy = await startEgressProxy({
    check: (_user, host, port) => browserHostDenial(host, { browserBlockedHosts: ['blocked.test'] }, { port }),
    addressAllowed: (ip, port) => ip === '127.0.0.1' && fixturePorts.includes(port),
    resolve: async (host) => (host === 'intranet.test' ? ['10.0.0.1'] : ['127.0.0.1']),
    ...o,
  });
  return proxy;
}

function connectVia(p: EgressProxy, authority: string, auth?: string): Promise<{ status: number; socket: Socket }> {
  const { port } = new URL(p.server);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(port), method: 'CONNECT', path: authority, headers: auth ? { 'Proxy-Authorization': auth } : {} });
    req.on('connect', (res: IncomingMessage, socket: Socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('error', reject);
    req.end();
  });
}

function getVia(p: EgressProxy, url: string, headers: Record<string, string>): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  const { port } = new URL(p.server);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(port), method: 'GET', path: url, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A request line written by hand, so inputs Node's own client would refuse still reach the proxy. Resolves with the status line. */
function rawVia(p: EgressProxy, method: string, target: string, auth: string): Promise<number> {
  const { port } = new URL(p.server);
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port: Number(port) });
    let seen = '';
    const done = (): void => {
      socket.destroy();
      resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(seen)?.[1] ?? 0));
    };
    socket.on('data', (d) => {
      seen += d.toString();
      if (seen.includes('\r\n')) done();
    });
    socket.on('close', done);
    socket.on('error', done);
    socket.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${auth}\r\n\r\n`);
  });
}

describe('startEgressProxy', () => {
  it('listens on 127.0.0.1 only and asks for its credentials (407) when they are missing or wrong', async () => {
    const p = await start();
    expect(p.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const plain = await getVia(p, `http://site.test:${portOf(site)}/`, {});
    expect(plain.status).toBe(407);
    expect(plain.headers['proxy-authenticate']).toBe('Basic realm="grunt"');
    expect((await connectVia(p, `echo.test:${portOf(echo)}`)).status).toBe(407);
    expect((await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', 'wrong'))).status).toBe(407);
  });

  it('refuses a tunnel to 127.0.0.1, and counts it', async () => {
    const onRefused = vi.fn();
    const p = await start({ onRefused, addressAllowed: undefined });
    const { status, socket } = await connectVia(p, `127.0.0.1:${portOf(echo)}`, basic('chat-a', p.password));
    socket.destroy();
    expect(status).toBe(403);
    expect(onRefused).toHaveBeenCalledWith('chat-a', '127.0.0.1', expect.stringMatching(/local or private/));
  });

  it('refuses a name that resolves to a private address, checking what it connects to rather than the name', async () => {
    const p = await start();
    const { status, socket } = await connectVia(p, 'intranet.test:443', basic('chat-a', p.password));
    socket.destroy();
    expect(status).toBe(403);
  });

  it("refuses a blocked host without looking it up, and hands the chat's user to the check", async () => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const check = vi.fn((_u: string, host: string) => (host === 'blocked.test' ? 'blocked.test is blocked for this profile.' : null));
    const p = await start({ resolve, check });
    const { status, socket } = await connectVia(p, 'blocked.test:443', basic('chat-b', p.password));
    socket.destroy();
    expect(status).toBe(403);
    expect(check).toHaveBeenCalledWith('chat-b', 'blocked.test', 443);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('tunnels an allowed CONNECT, passing bytes both ways', async () => {
    const p = await start();
    const { status, socket } = await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', p.password));
    expect(status).toBe(200);
    const back = new Promise<string>((r) => socket.once('data', (d: Buffer) => r(d.toString())));
    socket.write('ping');
    expect(await back).toBe('ping');
    socket.destroy();
  });

  it('forwards a plain-HTTP request with its Host, and without the proxy credentials', async () => {
    const p = await start();
    const res = await getVia(p, `http://site.test:${portOf(site)}/hello?x=1`, { Host: `site.test:${portOf(site)}`, 'Proxy-Authorization': basic('chat-a', p.password) });
    expect(res).toMatchObject({ status: 200, body: `/hello?x=1 site.test:${portOf(site)} none` });
  });

  it('forwards an HTTP upgrade (ws://) both ways', async () => {
    const p = await start();
    const { port } = new URL(p.server);
    const upgraded = await new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: Number(port),
        method: 'GET',
        path: `http://site.test:${portOf(site)}/ws`,
        headers: { Host: `site.test:${portOf(site)}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Proxy-Authorization': basic('chat-a', p.password) },
      });
      req.on('upgrade', (res: IncomingMessage, socket: Socket) => resolve({ status: res.statusCode ?? 0, socket }));
      req.on('error', reject);
      req.end();
    });
    expect(upgraded.status).toBe(101);
    const back = new Promise<string>((r) => upgraded.socket.once('data', (d: Buffer) => r(d.toString())));
    upgraded.socket.write('hi');
    expect(await back).toBe('hi');
    upgraded.socket.destroy();
  });

  it('puts the target URL host in the Host header, whatever the client sent', async () => {
    const p = await start();
    const res = await getVia(p, `http://site.test:${portOf(site)}/h`, { Host: 'other.example', 'Proxy-Authorization': basic('chat-a', p.password) });
    expect(res.body).toBe(`/h site.test:${portOf(site)} none`);
  });
});

describe('the post-DNS check', () => {
  it('connects to the address it checked and looks the name up once, never again', async () => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const p = await start({ resolve });
    const { status, socket } = await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', p.password));
    expect(status).toBe(200);
    socket.destroy();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('echo.test');
  });

  it('refuses when ANY resolved address is not public, in either order', async () => {
    for (const answer of [['93.184.216.34', '10.0.0.1'], ['10.0.0.1', '93.184.216.34'], ['2606:4700:4700::1111', '::1']]) {
      const onRefused = vi.fn();
      // The default address check (isPublicAddress): nothing here may ever be connected to.
      const p = await start({ resolve: async () => answer, addressAllowed: undefined, onRefused });
      const { status, socket } = await connectVia(p, 'rebind.test:443', basic('chat-a', p.password));
      socket.destroy();
      expect(status, answer.join()).toBe(403);
      expect(onRefused).toHaveBeenCalledWith('chat-a', 'rebind.test', expect.stringMatching(/local or private/));
      await p.close();
      proxy = null;
    }
  });

  it('judges each resolved address after canonicalising it: v4-mapped, NAT64, zones and odd spellings', async () => {
    const hidden = [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:10.0.0.1', '0:0:0:0:0:ffff:c0a8:101', '64:ff9b::10.0.0.1', '2002:c0a8:101::1',
      'fe80::1%eth0', '2606:4700:4700::1111%eth0', '::', '0.0.0.0', '169.254.169.254', '100.64.0.1', 'fd00::1', 'not-an-address', '', '0177.0.0.1',
    ];
    for (const address of hidden) {
      const p = await start({ resolve: async () => [address], addressAllowed: undefined });
      const { status, socket } = await connectVia(p, 'rebind.test:80', basic('chat-a', p.password));
      socket.destroy();
      expect(status, JSON.stringify(address)).toBe(403);
      await p.close();
      proxy = null;
    }
  });

  it('refuses a name that does not resolve, or resolves to nothing', async () => {
    for (const resolve of [async (): Promise<string[]> => [], async (): Promise<string[]> => { throw new Error('ENOTFOUND'); }]) {
      const p = await start({ resolve });
      const { status, socket } = await connectVia(p, 'nowhere.test:443', basic('chat-a', p.password));
      socket.destroy();
      expect(status).toBe(403);
      await p.close();
      proxy = null;
    }
  });

  it('applies the same check to plain-HTTP requests and upgrades', async () => {
    const p = await start({ addressAllowed: undefined });
    const auth = basic('chat-a', p.password);
    const res = await getVia(p, `http://intranet.test:${portOf(site)}/`, { 'Proxy-Authorization': auth });
    expect(res.status).toBe(403);
    expect(await rawVia(p, 'GET', 'http://intranet.test/ws', auth)).toBe(403);
    expect(siteHits).toEqual([]);
  });
});

describe('what the proxy reads as the host (the same parser as core)', () => {
  it.each([
    ['decimal IPv4', '2130706433:80'],
    ['hex IPv4', '0x7f.1:80'],
    ['octal IPv4', '0177.0.0.1:80'],
    ['shorthand IPv4', '127.1:80'],
    ['trailing dot', '127.0.0.1.:80'],
    ['bracketed IPv6 loopback', '[::1]:80'],
    ['bracketed v4-mapped', '[::ffff:127.0.0.1]:80'],
    ['bracketed v4-mapped, hex', '[::ffff:7f00:1]:80'],
    ['link-local', '169.254.169.254:80'],
    ['localhost', 'localhost:80'],
    ['LOCALHOST.', 'LOCALHOST.:80'],
    ['a *.local name', 'printer.local:80'],
    ['a *.internal name', 'db.internal:443'],
  ])('refuses a CONNECT to %s without ever connecting', async (_note, authority) => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const p = await start({ resolve, addressAllowed: undefined });
    const { status, socket } = await connectVia(p, authority, basic('chat-a', p.password));
    socket.destroy();
    expect(status).toBe(403);
  });

  it.each([
    ['no port', 'example.com'],
    ['port zero', 'example.com:0'],
    ['port too big', 'example.com:99999'],
    ['empty host', ':443'],
    ['userinfo', 'user@example.com:443'],
    ['userinfo hiding a loopback host', 'example.com@127.0.0.1:443'],
    ['a backslash', 'example.com\\@127.0.0.1:443'],
    ['a space', 'exam ple.com:443'],
    ['a path', 'example.com:443/x'],
    ['unbracketed IPv6', '::1:443'],
    ['a scheme', 'http://example.com:443'],
    ['two ports', 'example.com:80:443'],
  ])('refuses a CONNECT with %s as unusable, without a lookup', async (_note, authority) => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const onRefused = vi.fn();
    const p = await start({ resolve, onRefused });
    const status = await rawVia(p, 'CONNECT', authority, basic('chat-a', p.password));
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses an absolute-form request that is not plain http, or has no host', async () => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const p = await start({ resolve });
    const auth = basic('chat-a', p.password);
    for (const target of ['/relative', 'https://site.test/x', 'ftp://site.test/', 'file:///etc/passwd', 'ws://site.test/', 'http://', 'http://user@site.test/', 'http://site.test\\@127.0.0.1/']) {
      const status = await rawVia(p, 'GET', target, auth);
      expect(status, target).toBeGreaterThanOrEqual(400);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(siteHits).toEqual([]);
  });
});

describe('the shared browser host vectors', () => {
  const policyOf = (v: BrowserHostVector) => ({ browserBlockedHosts: v.blockedHosts ?? [] });
  const checkOf = (v: BrowserHostVector) => (host: string, port: number) =>
    browserHostDenial(host, policyOf(v), { port, allowLoopbackPorts: v.allowLoopbackPorts });

  it.each(BROWSER_HOST_VECTORS.map((v) => [v.note, v] as const))('checkProxyTarget agrees with core: %s', (_note, v) => {
    const ours = checkProxyTarget(v.input, checkOf(v), { allowLoopbackPorts: v.allowLoopbackPorts });
    const core = browserUrlCheck(v.input, policyOf(v), { allowLoopbackPorts: v.allowLoopbackPorts });
    expect(ours.site).toBe(v.site);
    expect(ours.site).toBe(core.site);
    expect(ours.port).toBe(core.port);
    expect(ours.denial !== null).toBe(v.denied);
    expect(ours.denial !== null).toBe(core.denial !== null);
    expect(ours.denial).toBe(core.denial);
  });

  // Through real sockets. Only http inputs can arrive in absolute form; allowed
  // names are re-pointed at the fixture's port and resolved to 127.0.0.1 by an
  // injected resolver (never real DNS); allowed IP literals and the tests-only
  // loopback rows are covered by the pure check above (connecting to a public
  // IP would leave the machine).
  const httpVectors = BROWSER_HOST_VECTORS.filter((v) => v.input.startsWith('http://'));

  it.each(httpVectors.filter((v) => v.denied).map((v) => [v.note, v] as const))('refuses over a socket: %s', async (_note, v) => {
    const onRefused = vi.fn();
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const p = await start({ check: (_u, host, port) => checkOf(v)(host, port), onRefused, resolve, addressAllowed: undefined });
    const status = await rawVia(p, 'GET', v.input, basic('chat-a', p.password));
    expect(status, v.input).toBeGreaterThanOrEqual(400);
    expect(siteHits).toEqual([]);
    if (v.site !== null) expect(status).toBe(403);
    if (v.site !== null) expect(onRefused).toHaveBeenCalledWith('chat-a', v.site, expect.any(String));
  });

  it.each(
    BROWSER_HOST_VECTORS.filter((v) => !v.denied && v.allowLoopbackPorts === undefined && v.site !== null && !/^[\d.]+$/.test(v.site) && !v.site.includes(':')).map((v) => [v.note, v] as const)
  )('reaches the fixture over a socket: %s', async (_note, v) => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const p = await start({ check: (_u, host, port) => checkOf(v)(host, port), resolve });
    const target = new URL(v.input);
    target.protocol = 'http:';
    target.port = String(portOf(site));
    const res = await getVia(p, target.href, { Host: target.host, 'Proxy-Authorization': basic('chat-a', p.password) });
    expect(res.status, target.href).toBe(200);
    expect(resolve).toHaveBeenCalledWith(v.site);
  });

  it('keeps core\'s floor under a check that allows everything: every vector denied for a local or private host is still denied', () => {
    for (const v of BROWSER_HOST_VECTORS.filter((x) => x.blockedHosts === undefined)) {
      const denial = checkProxyTarget(v.input, () => null, { allowLoopbackPorts: v.allowLoopbackPorts }).denial;
      expect(denial !== null, v.note).toBe(v.denied);
    }
  });

  it('left the refused rows as refused: no vector with a null site is ever allowed by the pure check', () => {
    for (const v of BROWSER_HOST_VECTORS.filter((x) => x.site === null)) {
      expect(checkProxyTarget(v.input, () => null).denial, v.note).not.toBeNull();
    }
  });
});

describe('the core floor holds whatever the supplied check says', () => {
  it('refuses local names and private, loopback and mapped addresses even when check allows everything', async () => {
    const p = await start({ check: () => null, addressAllowed: () => true });
    const auth = basic('chat-a', p.password);
    for (const authority of ['localhost:80', 'LOCALHOST.:80', `127.0.0.1:${portOf(echo)}`, `2130706433:${portOf(echo)}`, '[::1]:80', '[::ffff:7f00:1]:80', '10.0.0.5:80', '169.254.169.254:80', 'db.internal:443', 'printer.local:80']) {
      const { status, socket } = await connectVia(p, authority, auth);
      socket.destroy();
      expect(status, authority).toBe(403);
    }
    expect(await rawVia(p, 'GET', `http://127.0.0.1:${portOf(site)}/`, auth)).toBe(403);
    expect(await rawVia(p, 'GET', `http://localhost:${portOf(site)}/`, auth)).toBe(403);
    expect(echoSockets).toHaveLength(0);
    expect(siteHits).toEqual([]);
  });

  it('lets 127.0.0.1 through only on the ports it was explicitly given, and never localhost', async () => {
    const p = await start({ check: () => null, allowLoopbackPorts: [portOf(echo)] });
    const auth = basic('chat-a', p.password);
    const ok = await connectVia(p, `127.0.0.1:${portOf(echo)}`, auth);
    expect(ok.status).toBe(200);
    ok.socket.destroy();
    for (const authority of [`127.0.0.1:${portOf(site)}`, `localhost:${portOf(echo)}`, `127.0.0.2:${portOf(echo)}`]) {
      const { status, socket } = await connectVia(p, authority, auth);
      socket.destroy();
      expect(status, authority).toBe(403);
    }
  });
});

describe('every request is judged on its own', () => {
  it('checks a second request on the same keep-alive connection against its own host', async () => {
    const onRefused = vi.fn();
    const p = await start({ onRefused });
    const { port } = new URL(p.server);
    const auth = basic('chat-a', p.password);
    const socket = netConnect({ host: '127.0.0.1', port: Number(port) });
    let seen = '';
    socket.on('data', (d) => (seen += d.toString()));
    const until = async (text: string): Promise<void> => {
      for (let i = 0; i < 100 && !seen.includes(text); i++) await pause(20);
      expect(seen).toContain(text);
    };
    socket.write(`GET http://site.test:${portOf(site)}/first HTTP/1.1\r\nHost: site.test\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    await until('/first');
    expect(seen).toMatch(/^HTTP\/1\.1 200/);
    expect(seen).not.toMatch(/connection: close/i);
    socket.write(`GET http://blocked.test/second HTTP/1.1\r\nHost: blocked.test\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    await until('403');
    socket.write(`GET http://intranet.test/third HTTP/1.1\r\nHost: intranet.test\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    for (let i = 0; i < 100 && (seen.match(/HTTP\/1\.1 403/g) ?? []).length < 2; i++) await pause(20);
    socket.destroy();
    expect((seen.match(/HTTP\/1\.1 403/g) ?? []).length).toBe(2);
    expect(siteHits).toEqual(['/first']);
    expect(onRefused).toHaveBeenCalledWith('chat-a', 'blocked.test', expect.any(String));
    expect(onRefused).toHaveBeenCalledWith('chat-a', 'intranet.test', expect.any(String));
  });

  it('sends an upgrade to the host in the request line, whatever its Host header says', async () => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const p = await start({ resolve });
    const { port } = new URL(p.server);
    const upgraded = await new Promise<Socket>((res, rej) => {
      const req = request({
        host: '127.0.0.1',
        port: Number(port),
        method: 'GET',
        path: `http://site.test:${portOf(site)}/ws`,
        headers: { Host: 'evil.test', Connection: 'Upgrade', Upgrade: 'websocket', 'Proxy-Authorization': basic('chat-a', p.password) },
      });
      req.on('upgrade', (_r: IncomingMessage, socket: Socket) => res(socket));
      req.on('error', rej);
      req.end();
    });
    upgraded.destroy();
    expect(resolve.mock.calls).toEqual([['site.test']]);
    expect(siteHeaders.at(-1)?.host).toBe(`site.test:${portOf(site)}`);
    expect(siteHeaders.at(-1)?.['proxy-authorization']).toBeUndefined();
  });

  it('does not forward hop-by-hop headers on the plain path, and still forwards a streamed body', async () => {
    const p = await start();
    const { port } = new URL(p.server);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(port),
          method: 'GET',
          path: `http://site.test:${portOf(site)}/hdrs`,
          headers: {
            Connection: 'keep-alive, X-Hop',
            'X-Hop': 'secret',
            'Keep-Alive': 'timeout=5',
            TE: 'trailers',
            Upgrade: 'h2c',
            'Proxy-Connection': 'keep-alive',
            'X-Keep': 'yes',
            'Proxy-Authorization': basic('chat-a', p.password),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end();
    });
    const seen = siteHeaders.at(-1)!;
    for (const name of ['x-hop', 'keep-alive', 'te', 'upgrade', 'proxy-connection', 'proxy-authorization']) expect(seen[name], name).toBeUndefined();
    expect(seen['x-keep']).toBe('yes');
    // A chunked request body (Transfer-Encoding is not forwarded; the proxy re-frames it).
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: Number(port), method: 'POST', path: `http://site.test:${portOf(site)}/echo`, headers: { 'Proxy-Authorization': basic('chat-a', p.password) } },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve(body));
        }
      );
      req.on('error', reject);
      req.write('hel');
      setTimeout(() => req.end('lo'), 30);
    });
    expect(echoed).toBe('hello');
  });
});

describe('upstream sockets are freed when the browser goes away', () => {
  /** A request line and headers written to a fresh connection to the proxy; the socket comes back unread. */
  function rawClient(p: EgressProxy, head: string): Socket {
    const { port } = new URL(p.server);
    const socket = netConnect({ host: '127.0.0.1', port: Number(port) });
    socket.on('error', () => undefined);
    socket.write(head);
    return socket;
  }

  /** A lookup the test controls: `asked` settles when it starts, `release()` lets it answer. */
  function gatedLookup(): { resolve: () => Promise<string[]>; asked: Promise<void>; release: () => void } {
    let release!: () => void;
    let asked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const askedP = new Promise<void>((r) => (asked = r));
    return {
      resolve: async () => {
        asked();
        await gate;
        return ['127.0.0.1'];
      },
      asked: askedP,
      release,
    };
  }

  it('makes no upstream connection for a CONNECT the client abandoned during the lookup', async () => {
    const lookup = gatedLookup();
    const p = await start({ resolve: lookup.resolve });
    const client = rawClient(p, `CONNECT echo.test:${portOf(echo)} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic('chat-a', p.password)}\r\n\r\n`);
    await lookup.asked;
    client.destroy();
    await pause(80);
    lookup.release();
    await pause(150);
    expect(echoSockets).toHaveLength(0);
  });

  it('makes no upstream connection for an upgrade the client abandoned during the lookup', async () => {
    const lookup = gatedLookup();
    const p = await start({ resolve: lookup.resolve });
    const client = rawClient(
      p,
      `GET http://site.test:${portOf(site)}/ws HTTP/1.1\r\nHost: site.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: ${basic('chat-a', p.password)}\r\n\r\n`
    );
    await lookup.asked;
    client.destroy();
    await pause(80);
    lookup.release();
    await pause(150);
    expect(siteHeaders).toEqual([]);
  });

  it('makes no upstream request for a plain request the client abandoned during the lookup', async () => {
    const lookup = gatedLookup();
    const p = await start({ resolve: lookup.resolve });
    const client = rawClient(p, `GET http://site.test:${portOf(site)}/late HTTP/1.1\r\nHost: site.test\r\nProxy-Authorization: ${basic('chat-a', p.password)}\r\n\r\n`);
    await lookup.asked;
    client.destroy();
    await pause(80);
    lookup.release();
    await pause(150);
    expect(siteHits).toEqual([]);
  });

  it('makes no upstream connection when close() runs during the lookup', async () => {
    const lookup = gatedLookup();
    const p = await start({ resolve: lookup.resolve });
    const client = rawClient(p, `CONNECT echo.test:${portOf(echo)} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic('chat-a', p.password)}\r\n\r\n`);
    await lookup.asked;
    await p.close();
    proxy = null;
    lookup.release();
    await pause(150);
    client.destroy();
    expect(echoSockets).toHaveLength(0);
  });

  it('closes the upstream socket when the client closes an open tunnel', async () => {
    const p = await start();
    const { status, socket } = await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', p.password));
    expect(status).toBe(200);
    expect(echoSockets).toHaveLength(1);
    socket.destroy();
    expect(await settlesWithin(echoClosed[0]!, 2000)).toBe(true);
  });

  it('closes the client when the upstream closes an open tunnel', async () => {
    const p = await start();
    const { socket } = await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', p.password));
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    echoSockets[0]!.destroy();
    expect(await settlesWithin(closed, 2000)).toBe(true);
  });

  it('closes both sides of an open tunnel when the proxy is closed', async () => {
    const p = await start();
    const { socket } = await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', p.password));
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    await p.close();
    proxy = null;
    expect(await settlesWithin(closed, 2000)).toBe(true);
    expect(await settlesWithin(echoClosed[0]!, 2000)).toBe(true);
  });

  it('closes both sides of a tunnel that has been silent for the idle timeout', async () => {
    const p = await start({ idleTimeoutMs: 100 });
    const { socket } = await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', p.password));
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    expect(await settlesWithin(closed, 3000)).toBe(true);
    expect(await settlesWithin(echoClosed[0]!, 3000)).toBe(true);
  });

  it('keeps a tunnel that is still being used past the idle timeout', async () => {
    const p = await start({ idleTimeoutMs: 300 });
    const { socket } = await connectVia(p, `echo.test:${portOf(echo)}`, basic('chat-a', p.password));
    let closed = false;
    socket.on('close', () => (closed = true));
    for (let i = 0; i < 6; i++) {
      await pause(100);
      socket.write('x');
    }
    expect(closed).toBe(false);
    socket.destroy();
  });

  it('destroys the upstream request when the client aborts a streaming (SSE-style) response', async () => {
    const p = await start();
    const { port } = new URL(p.server);
    const req = request({ host: '127.0.0.1', port: Number(port), method: 'GET', path: `http://site.test:${portOf(site)}/sse`, headers: { 'Proxy-Authorization': basic('chat-a', p.password) } });
    req.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      req.on('response', (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.end();
    });
    expect(await settlesWithin(sseClosed, 3000)).toBe(true);
  });

  it('destroys the upstream request when the client aborts partway through sending a body', async () => {
    const p = await start();
    const client = rawClient(
      p,
      `POST http://site.test:${portOf(site)}/upload HTTP/1.1\r\nHost: site.test\r\nContent-Length: 100\r\nProxy-Authorization: ${basic('chat-a', p.password)}\r\n\r\nfive!`
    );
    for (let i = 0; i < 100 && siteHits.length === 0; i++) await pause(20);
    expect(siteHits).toEqual(['/upload']);
    client.destroy();
    expect(await settlesWithin(uploadClosed, 3000)).toBe(true);
  });

  it('destroys in-flight plain requests when the proxy is closed', async () => {
    const p = await start();
    const { port } = new URL(p.server);
    const req = request({ host: '127.0.0.1', port: Number(port), method: 'GET', path: `http://site.test:${portOf(site)}/sse`, headers: { 'Proxy-Authorization': basic('chat-a', p.password) } });
    req.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      req.on('response', (res) => res.once('data', () => resolve()));
      req.end();
    });
    await p.close();
    proxy = null;
    expect(await settlesWithin(sseClosed, 3000)).toBe(true);
    req.destroy();
  });
});

describe('the proxy and approvals (security fix round 1)', () => {
  it("judges every request on its own address, so a page on an approved site can't reach a private one by sub-resource or redirect, and does not ask for a grant per site", async () => {
    const p = await start();
    const auth = { 'Proxy-Authorization': basic('chat-a', p.password) };
    const port = portOf(site);
    // The approved site loads; so does another public site a page pulls a script or an image from (grants are per model action, not per request).
    expect((await getVia(p, `http://approved.test:${port}/`, auth)).status).toBe(200);
    expect((await getVia(p, `http://cdn.other.test:${port}/lib.js`, auth)).status).toBe(200);
    const hits = siteHits.length;
    // What a sub-resource or a redirect target looks like to the proxy: just another request. Private ones are refused, by literal or by lookup.
    for (const url of ['http://10.0.0.5/pixel.png', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:10.0.0.1]/', `http://intranet.test:${port}/x`, 'http://localhost/']) {
      expect((await getVia(p, url, auth)).status, url).toBe(403);
    }
    const tunnel = await connectVia(p, '10.0.0.5:443', basic('chat-a', p.password));
    tunnel.socket.destroy();
    expect(tunnel.status).toBe(403);
    expect(siteHits.length).toBe(hits);
  });
});
