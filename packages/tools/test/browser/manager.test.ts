import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_IDLE_MS, BrowserManager, CHAT_IDLE_MS, CLOSED_STATE, type BrowserFrame, type BrowserState } from '../../src/browser/manager.js';
import { startEgressProxy } from '../../src/browser/proxy.js';
import { BrowserBusyError } from '../../src/browser/session.js';
import { FakeFactory, fakeProxy } from './fakes.js';

function make(o: { allowLoopbackPorts?: number[]; maxOpen?: number } = {}) {
  const factory = new FakeFactory();
  const proxy = fakeProxy();
  const manager = new BrowserManager({ factory, startProxy: proxy.start, ...o });
  return { factory, proxy, manager };
}
const turn = () => new AbortController();

afterEach(() => vi.useRealTimers());

describe('BrowserManager', () => {
  it('opens one session per chat on first use, through the proxy under its own user', async () => {
    const { factory, manager } = make();
    const t = turn();
    const first = await manager.acquire('c1', 'm1', t.signal);
    expect(await manager.acquire('c1', 'm1', t.signal)).toBe(first);
    await Promise.all([manager.acquire('c2', 'm9', t.signal), manager.acquire('c2', 'm9', t.signal)]);
    expect(factory.sessions).toHaveLength(2);
    const [a, b] = factory.sessions;
    expect(a!.proxy).toMatchObject({ server: 'http://127.0.0.1:9', password: 'pw' });
    expect(a!.proxy.username).toMatch(/^[0-9a-f]{24}$/);
    expect(b!.proxy.username).not.toBe(a!.proxy.username);
    expect(manager.peek('c1')).toBe(first);
    expect(manager.peek('nope')).toBeNull();
  });

  it("keeps a chat's browser for the reply that last acted until that reply's turn ends", async () => {
    const { manager } = make();
    const one = turn();
    const two = turn();
    await manager.acquire('c1', 'm1', one.signal);
    await expect(manager.acquire('c1', 'm2', two.signal)).rejects.toThrow(new BrowserBusyError("This chat's browser is in use by another reply."));
    expect(manager.state('c1').holder).toBe('m1');
    one.abort();
    expect(manager.state('c1').holder).toBeNull();
    await manager.acquire('c1', 'm2', two.signal);
    expect(manager.state('c1').holder).toBe('m2');
  });

  it('closes on request, telling watchers, and reports closed state for a chat with no browser', async () => {
    const { factory, manager } = make();
    const states: BrowserState[] = [];
    manager.watch('c1', () => {}, (s) => states.push(s));
    await manager.acquire('c1', 'm1', turn().signal);
    await manager.close('c1');
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(manager.state('c1')).toEqual(CLOSED_STATE);
    expect(states.at(-1)).toEqual(CLOSED_STATE);
    await manager.close('c1'); // a second close is harmless
  });

  it("closes a chat's browser after 15 idle minutes, and the browser process 5 minutes after the last one", async () => {
    vi.useFakeTimers();
    const { factory, proxy, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal);
    await vi.advanceTimersByTimeAsync(CHAT_IDLE_MS - 1_000);
    expect(factory.sessions[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(factory.sessions[0]!.closed).toBe(true));
    expect(factory.shutdowns).toBe(0);
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS);
    await vi.waitFor(() => expect(proxy.closes()).toBe(1));
    expect(factory.shutdowns).toBe(1);
  });

  it('keeps at most four open: a fifth closes the least recently used one nobody holds, or is refused', async () => {
    const { manager } = make();
    const turns = [turn(), turn(), turn(), turn()];
    for (const [i, t] of turns.entries()) await manager.acquire(`c${i}`, `m${i}`, t.signal);
    await expect(manager.acquire('c4', 'm4', turn().signal)).rejects.toThrow(/in use/);
    turns[2]!.abort();
    turns[1]!.abort();
    await manager.acquire('c4', 'm4', turn().signal);
    expect(manager.state('c1').open).toBe(false); // used before c2
    expect(manager.state('c2').open).toBe(true);
    expect(manager.state('c4').open).toBe(true);
  });

  it('counts browsers still starting against the cap', async () => {
    const { factory, manager } = make({ maxOpen: 2 });
    const t = turn();
    const results = await Promise.allSettled([manager.acquire('c1', 'm1', t.signal), manager.acquire('c2', 'm2', t.signal), manager.acquire('c3', 'm3', t.signal)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(factory.sessions).toHaveLength(2);
  });

  it('streams frames only while someone watches, starting when the page opens if they were already waiting', async () => {
    const { factory, manager } = make();
    const frames: BrowserFrame[] = [];
    const states: BrowserState[] = [];
    const stop = manager.watch('c1', (f) => frames.push(f), (s) => states.push(s));
    await manager.acquire('c1', 'm1', turn().signal);
    const session = factory.sessions[0]!;
    await vi.waitFor(() => expect(session.onFrame).not.toBeNull());
    session.onFrame!(Buffer.from('jpeg-1'));
    expect(frames).toEqual([{ seq: 1, jpeg: Buffer.from('jpeg-1').toString('base64') }]);
    session.navigate('https://example.com/', 'Example');
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ open: true, url: 'https://example.com/', title: 'Example', host: 'example.com', holder: 'm1' }));
    stop();
    await vi.waitFor(() => expect(session.onFrame).toBeNull());
  });

  it("checks each proxied request against the chat it came from, and counts refusals for that chat's next result", async () => {
    const { factory, proxy, manager } = make({ allowLoopbackPorts: [4766] });
    await manager.acquire('c1', 'm1', turn().signal, ['ads.test']);
    const user = factory.sessions[0]!.proxy.username;
    const o = proxy.options();
    expect(o.check(user, 'example.com', 443)).toBeNull();
    expect(o.check(user, 'cdn.ads.test', 443)).toBe('cdn.ads.test is blocked for this profile.');
    expect(o.check(user, '10.0.0.1', 80)).toMatch(/local or private/);
    expect(o.check(user, '127.0.0.1', 4766)).toBeNull();
    expect(o.check(user, '127.0.0.1', 4747)).toMatch(/local or private/);
    expect(o.check('someone-else', 'example.com', 443)).toBe('This browser session has ended.');
    expect(o.addressAllowed!('127.0.0.1', 4766)).toBe(true);
    expect(o.addressAllowed!('127.0.0.1', 4747)).toBe(false);
    expect(o.addressAllowed!('93.184.216.34', 443)).toBe(true);
    // Only 127.0.0.1 gets the allowance: no other loopback or private address, on any port.
    expect(o.addressAllowed!('127.0.0.2', 4766)).toBe(false);
    expect(o.addressAllowed!('::1', 4766)).toBe(false);
    expect(o.addressAllowed!('10.0.0.5', 4766)).toBe(false);
    o.onRefused!(user, '10.0.0.1', 'x');
    o.onRefused!(user, '10.0.0.2', 'x');
    expect(manager.peek('c1')!.takeNotes()).toEqual(['2 requests to blocked or local addresses were refused.']);
    o.onRefused!(user, '10.0.0.3', 'x');
    expect(manager.peek('c1')!.takeNotes()).toEqual(['1 request to a blocked or local address was refused.']);
    expect(manager.peek('c1')!.takeNotes()).toEqual([]);
  });

  it('gives the proxy no loopback allowance and no permissive address override unless ports are configured', async () => {
    const { factory, proxy, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal);
    const user = factory.sessions[0]!.proxy.username;
    const o = proxy.options();
    expect(o.allowLoopbackPorts ?? []).toEqual([]);
    expect(o.check(user, '127.0.0.1', 4766)).toMatch(/local or private/);
    if (o.addressAllowed) {
      expect(o.addressAllowed('127.0.0.1', 4766)).toBe(false);
      expect(o.addressAllowed('10.0.0.5', 80)).toBe(false);
      expect(o.addressAllowed('93.184.216.34', 443)).toBe(true);
    }

    const looped = make({ allowLoopbackPorts: [4766] });
    await looped.manager.acquire('c1', 'm1', turn().signal);
    expect(looped.proxy.options().allowLoopbackPorts).toEqual([4766]);
  });

  it('closeAll closes every chat, the browser process and the proxy', async () => {
    const { factory, proxy, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal);
    await manager.acquire('c2', 'm2', turn().signal);
    await manager.closeAll();
    expect(factory.sessions.every((s) => s.closed)).toBe(true);
    expect(factory.shutdowns).toBe(1);
    expect(proxy.closes()).toBe(1);
  });
});

describe('BrowserManager with the real egress proxy', () => {
  let fixture: Server | null = null;
  let manager: BrowserManager | null = null;

  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
    await new Promise<void>((resolve) => (fixture ? fixture.close(() => resolve()) : resolve()));
    fixture = null;
  });

  /**
   * A loopback site, and a manager wired to the real proxy with every name
   * resolving to `resolvesTo`. `allowFixturePort` plays GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS.
   */
  async function setup(resolvesTo: string, allowFixturePort: boolean) {
    const hits: string[] = [];
    fixture = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('fixture');
    });
    await new Promise<void>((resolve) => fixture!.listen(0, '127.0.0.1', () => resolve()));
    const sitePort = (fixture.address() as AddressInfo).port;
    const factory = new FakeFactory();
    manager = new BrowserManager({
      factory,
      allowLoopbackPorts: allowFixturePort ? [sitePort] : [],
      startProxy: (o) => startEgressProxy({ ...o, resolve: async () => [resolvesTo] }),
    });
    await manager.acquire('c1', 'm1', new AbortController().signal);
    return { hits, sitePort, creds: factory.sessions[0]!.proxy };
  }

  /** One plain-HTTP request through the proxy, as the browser would send it. */
  function viaProxy(creds: { server: string; username: string; password: string }, target: string): Promise<number> {
    const proxy = new URL(creds.server);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: proxy.hostname,
          port: Number(proxy.port),
          method: 'GET',
          path: target,
          headers: {
            host: new URL(target).host,
            'proxy-authorization': `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
          },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('refuses a name that resolves to 127.0.0.1 when no loopback ports are configured', async () => {
    const { hits, sitePort, creds } = await setup('127.0.0.1', false);
    expect(await viaProxy(creds, `http://rebind.example:${sitePort}/secret`)).toBe(403);
    expect(hits).toEqual([]);
    expect(manager!.peek('c1')!.takeNotes()).toEqual(['1 request to a blocked or local address was refused.']);
  });

  it('refuses a name that resolves to a private address even when its port is a configured loopback port', async () => {
    const { hits, sitePort, creds } = await setup('10.0.0.5', true);
    expect(await viaProxy(creds, `http://lan.example:${sitePort}/`)).toBe(403);
    expect(hits).toEqual([]);
  });

  it('reaches 127.0.0.1 only on a configured port, for tests', async () => {
    const { hits, sitePort, creds } = await setup('127.0.0.1', true);
    expect(await viaProxy(creds, `http://127.0.0.1:${sitePort}/ok`)).toBe(200);
    expect(await viaProxy(creds, `http://127.0.0.1:${sitePort + 1}/no`)).toBe(403);
    expect(hits).toEqual(['/ok']);
  });
});
