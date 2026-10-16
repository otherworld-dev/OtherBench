import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_IDLE_MS, BrowserManager, CHAT_IDLE_MS, CLOSED_STATE, type BrowserFrame, type BrowserState } from '../../src/browser/manager.js';
import { startEgressProxy } from '../../src/browser/proxy.js';
import { BrowserBusyError } from '../../src/browser/session.js';
import { FakeFactory, fakeProxy, gate } from './fakes.js';

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
    const first = await manager.acquire('c1', 'm1', t.signal, []);
    expect(await manager.acquire('c1', 'm1', t.signal, [])).toBe(first);
    await Promise.all([manager.acquire('c2', 'm9', t.signal, []), manager.acquire('c2', 'm9', t.signal, [])]);
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
    await manager.acquire('c1', 'm1', one.signal, []);
    await expect(manager.acquire('c1', 'm2', two.signal, [])).rejects.toThrow(new BrowserBusyError("This chat's browser is in use by another reply."));
    expect(manager.state('c1').holder).toBe('m1');
    one.abort();
    expect(manager.state('c1').holder).toBeNull();
    await manager.acquire('c1', 'm2', two.signal, []);
    expect(manager.state('c1').holder).toBe('m2');
  });

  it('closes on request, telling watchers, and reports closed state for a chat with no browser', async () => {
    const { factory, manager } = make();
    const states: BrowserState[] = [];
    manager.watch('c1', () => {}, (s) => states.push(s));
    await manager.acquire('c1', 'm1', turn().signal, []);
    await manager.close('c1');
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(manager.state('c1')).toEqual(CLOSED_STATE);
    expect(states.at(-1)).toEqual(CLOSED_STATE);
    await manager.close('c1'); // a second close is harmless
  });

  it("closes a chat's browser after 15 idle minutes, and the browser process 5 minutes after the last one", async () => {
    vi.useFakeTimers();
    const { factory, proxy, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal, []);
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
    for (const [i, t] of turns.entries()) await manager.acquire(`c${i}`, `m${i}`, t.signal, []);
    await expect(manager.acquire('c4', 'm4', turn().signal, [])).rejects.toThrow(/in use/);
    turns[2]!.abort();
    turns[1]!.abort();
    await manager.acquire('c4', 'm4', turn().signal, []);
    expect(manager.state('c1').open).toBe(false); // used before c2
    expect(manager.state('c2').open).toBe(true);
    expect(manager.state('c4').open).toBe(true);
  });

  it('counts browsers still starting against the cap', async () => {
    const { factory, manager } = make({ maxOpen: 2 });
    const t = turn();
    const results = await Promise.allSettled([manager.acquire('c1', 'm1', t.signal, []), manager.acquire('c2', 'm2', t.signal, []), manager.acquire('c3', 'm3', t.signal, [])]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(factory.sessions).toHaveLength(2);
  });

  it('streams frames only while someone watches, starting when the page opens if they were already waiting', async () => {
    const { factory, manager } = make();
    const frames: BrowserFrame[] = [];
    const states: BrowserState[] = [];
    const stop = manager.watch('c1', (f) => frames.push(f), (s) => states.push(s));
    await manager.acquire('c1', 'm1', turn().signal, []);
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

  it("holds the proxy to every blocked list one reply's calls bring, in any order, and starts again for the next reply", async () => {
    const { factory, proxy, manager } = make();
    const reply = turn();
    // The reply itself (its profile blocks ads.test), then its sub-agent under the same message id (casino.test added by the profile it runs as).
    await manager.acquire('c1', 'm1', reply.signal, ['ads.test']);
    const user = factory.sessions[0]!.proxy.username;
    const check = (host: string): string | null => proxy.options().check(user, host, 443);
    const blocked = (host: string): string => `${host} is blocked for this profile.`;
    expect(check('casino.test')).toBeNull();
    await manager.acquire('c1', 'm1', reply.signal, ['ads.test', 'casino.test']);
    expect(check('ads.test')).toBe(blocked('ads.test'));
    expect(check('casino.test')).toBe(blocked('casino.test'));
    // The parent calls again with its own shorter list while the sub-agent's page is still loading: nothing is lifted.
    await manager.acquire('c1', 'm1', reply.signal, ['ads.test']);
    expect(check('play.casino.test')).toBe(blocked('play.casino.test'));
    // Calls arriving together, in either order, end the same.
    await Promise.all([manager.acquire('c1', 'm1', reply.signal, ['tracker.example']), manager.acquire('c1', 'm1', reply.signal, []), manager.acquire('c1', 'm1', reply.signal, ['ads.test'])]);
    for (const host of ['ads.test', 'casino.test', 'tracker.example']) expect(check(host), host).toBe(blocked(host));
    expect(check('example.com')).toBeNull();

    // The same reply after its signal changed (a new call's own signal) keeps the list.
    const later = turn();
    await manager.acquire('c1', 'm1', later.signal, []);
    expect(check('casino.test')).toBe(blocked('casino.test'));

    // Another reply takes the browser: the list is that reply's own, so a site taken off the profile's list is no longer blocked.
    later.abort();
    const next = turn();
    await manager.acquire('c1', 'm2', next.signal, ['social.test']);
    expect(check('social.test')).toBe(blocked('social.test'));
    for (const host of ['ads.test', 'casino.test', 'tracker.example']) expect(check(host), host).toBeNull();
    // A reply that is refused the browser (another holds it) changes nothing.
    await expect(manager.acquire('c1', 'm3', turn().signal, [])).rejects.toThrow(BrowserBusyError);
    expect(check('social.test')).toBe(blocked('social.test'));
  });

  it('gives the proxy no loopback allowance and no permissive address override unless ports are configured', async () => {
    const { factory, proxy, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal, []);
    const user = factory.sessions[0]!.proxy.username;
    const o = proxy.options();
    expect(o.allowLoopbackPorts ?? []).toEqual([]);
    expect(o.check(user, '127.0.0.1', 4766)).toMatch(/local or private/);
    // No override at all: the proxy's own default (public addresses only) applies. The real-proxy tests below show what that refuses.
    expect(o.addressAllowed).toBeUndefined();

    const looped = make({ allowLoopbackPorts: [4766] });
    await looped.manager.acquire('c1', 'm1', turn().signal, []);
    expect(looped.proxy.options().allowLoopbackPorts).toEqual([4766]);
  });

  it('gives a browser started while the old one is shutting down a new proxy and a working session', async () => {
    vi.useFakeTimers();
    const { factory, proxy, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal, []);
    await manager.close('c1');
    const slowExit = gate();
    factory.shutdownGate = slowExit.promise;
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS);
    await vi.waitFor(() => expect(factory.shutdowns).toBe(1));

    const starting = manager.acquire('c2', 'm2', turn().signal, []);
    await vi.advanceTimersByTimeAsync(0);
    // Nothing starts against the proxy and Chromium that are going away.
    expect(proxy.starts()).toBe(1);
    expect(factory.sessions).toHaveLength(1);

    slowExit.open();
    const browser = await starting;
    expect(proxy.closes()).toBe(1); // the old proxy
    expect(proxy.starts()).toBe(2);
    expect(factory.sessions).toHaveLength(2);
    expect(factory.sessions[1]!.proxy.server).toBe('http://127.0.0.1:10');
    expect(browser.session).toBe(factory.sessions[1]);
    // The new browser is not closed by the old shutdown's tail: only one proxy has been closed.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proxy.closes()).toBe(1);
    expect(factory.sessions[1]!.closed).toBe(false);
  });

  it('schedules the browser and proxy to close after a failed start with nothing else open', async () => {
    vi.useFakeTimers();
    const { factory, proxy, manager } = make();
    factory.failNextOpen = new Error('Chromium would not start');
    await expect(manager.acquire('c1', 'm1', turn().signal, [])).rejects.toThrow('Chromium would not start');
    expect(proxy.starts()).toBe(1);
    expect(proxy.closes()).toBe(0);
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS);
    await vi.waitFor(() => expect(proxy.closes()).toBe(1));
    expect(factory.shutdowns).toBe(1);
    // And the chat can try again.
    await manager.acquire('c1', 'm1', turn().signal, []);
    expect(manager.state('c1').open).toBe(true);
  });

  it('detaches an evicted browser at once, so nothing can claim it while it closes', async () => {
    const { factory, manager } = make({ maxOpen: 2 });
    const t1 = turn();
    const t2 = turn();
    await manager.acquire('c1', 'm1', t1.signal, []);
    await manager.acquire('c2', 'm2', t2.signal, []);
    t1.abort();
    t2.abort();
    const closing = gate();
    factory.sessions[0]!.closeGate = closing.promise;
    // c3's start evicts c1 (the least recently used) in this very tick; c1 is asked for in the same tick.
    const third = manager.acquire('c3', 'm3', turn().signal, []);
    const again = manager.acquire('c1', 'm9', turn().signal, []);
    closing.open();
    const [, c1] = await Promise.all([third, again]);
    expect(c1.session).not.toBe(factory.sessions[0]);
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(manager.state('c1').open).toBe(true);
  });

  it('lets only one of two replies racing on a first use have the browser', async () => {
    const { factory, manager } = make();
    const results = await Promise.allSettled([manager.acquire('c1', 'm1', turn().signal, []), manager.acquire('c1', 'm2', turn().signal, [])]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(BrowserBusyError);
    expect(factory.sessions).toHaveLength(1);
    expect(manager.state('c1').holder).toBe('m1');
  });

  it('closing a chat while its browser is still starting leaves it closed', async () => {
    const { factory, manager } = make();
    const opening = gate();
    factory.openGate = opening.promise;
    const starting = manager.acquire('c1', 'm1', turn().signal, []).catch(() => null);
    const closing = manager.close('c1');
    opening.open();
    await Promise.all([starting, closing]);
    expect(factory.sessions).toHaveLength(1);
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(manager.state('c1')).toEqual(CLOSED_STATE);
    expect(manager.peek('c1')).toBeNull();
  });

  it('tolerates unsubscribing twice, and keeps the screencast for the watcher that is left', async () => {
    const { factory, manager } = make();
    const stopA = manager.watch('c1', () => {}, () => {});
    const framesB: BrowserFrame[] = [];
    const stopB = manager.watch('c1', (f) => framesB.push(f), () => {});
    await manager.acquire('c1', 'm1', turn().signal, []);
    const session = factory.sessions[0]!;
    await vi.waitFor(() => expect(session.onFrame).not.toBeNull());
    stopA();
    stopA();
    expect(session.onFrame).not.toBeNull();
    session.onFrame!(Buffer.from('x'));
    expect(framesB).toHaveLength(1);
    stopB();
    stopB();
    await vi.waitFor(() => expect(session.onFrame).toBeNull());
  });

  it('starts one screencast however many watch', async () => {
    const { factory, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal, []);
    manager.watch('c1', () => {}, () => {});
    manager.watch('c1', () => {}, () => {});
    manager.watch('c1', () => {}, () => {});
    await vi.waitFor(() => expect(factory.sessions[0]!.screencastStarts).toBe(1));
    await Promise.resolve();
    expect(factory.sessions[0]!.screencastStarts).toBe(1);
  });

  it('keeps serving the other watchers when one throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { factory, manager } = make();
      const frames: BrowserFrame[] = [];
      const states: BrowserState[] = [];
      manager.watch('c1', () => { throw new Error('bad frame sink'); }, () => { throw new Error('bad state sink'); });
      manager.watch('c1', (f) => frames.push(f), (s) => states.push(s));
      await manager.acquire('c1', 'm1', turn().signal, []);
      await vi.waitFor(() => expect(factory.sessions[0]!.onFrame).not.toBeNull());
      factory.sessions[0]!.onFrame!(Buffer.from('f'));
      expect(frames).toHaveLength(1);
      expect(states.at(-1)).toMatchObject({ open: true, holder: 'm1' });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('closeAll leaves no timers behind', async () => {
    vi.useFakeTimers();
    const { manager } = make();
    await manager.acquire('c1', 'm1', turn().signal, []);
    await manager.acquire('c2', 'm2', turn().signal, []);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await manager.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closeAll closes every chat, the browser process and the proxy', async () => {
    const { factory, proxy, manager } = make();
    await manager.acquire('c1', 'm1', turn().signal, []);
    await manager.acquire('c2', 'm2', turn().signal, []);
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
   * resolving to `resolvesTo`. `allowFixturePort` plays OTHERBENCH_BROWSER_ALLOW_LOOPBACK_PORTS.
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
    await manager.acquire('c1', 'm1', new AbortController().signal, []);
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
