import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { endpointProblem, httpsPushTransport, publicOnlyLookup } from '../../src/push/endpoint.js';

describe('endpointProblem', () => {
  it("takes the push services' https URLs", () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc:APA91b',
      'https://web.push.apple.com/QGnb7d0f',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
      'https://8.8.8.8/push',
      'https://[2606:4700::1111]/push',
    ]) {
      expect(endpointProblem(ok), ok).toBeNull();
    }
  });

  it('refuses anything but https, and credentials', () => {
    expect(endpointProblem('http://fcm.googleapis.com/fcm/send/x')).toMatch(/https/);
    expect(endpointProblem('ftp://fcm.googleapis.com/x')).toMatch(/https/);
    expect(endpointProblem('javascript:alert(1)')).toMatch(/https/);
    expect(endpointProblem('not a url')).toMatch(/not a URL/);
    expect(endpointProblem('https://user:pw@fcm.googleapis.com/x')).toMatch(/user name/);
    expect(endpointProblem(`https://fcm.googleapis.com/${'a'.repeat(3000)}`)).toMatch(/too long/);
  });

  it('refuses loopback, private, link-local and local names, in any spelling', () => {
    for (const bad of [
      'https://localhost/push',
      'https://LOCALHOST./push',
      'https://foo.localhost/push',
      'https://127.0.0.1/push',
      'https://127.1/push',
      'https://2130706433/push',
      'https://0x7f000001/push',
      'https://0.0.0.0/push',
      'https://10.1.2.3/push',
      'https://172.16.0.1/push',
      'https://192.168.1.10:8443/push',
      'https://100.64.0.1/push',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/push',
      'https://[::]/push',
      'https://[fe80::1]/push',
      'https://[fd00::1]/push',
      'https://[::ffff:127.0.0.1]/push',
      'https://[::ffff:10.0.0.1]/push',
      'https://router/push',
      'https://nas.local/push',
      'https://printer.lan/push',
      'https://svc.internal/push',
      'https://box.home.arpa/push',
    ]) {
      expect(endpointProblem(bad), bad).toMatch(/this machine or a private network/);
    }
  });
});

describe('publicOnlyLookup', () => {
  const lookupWith = (addresses: LookupAddress[]) =>
    publicOnlyLookup((_host, cb) => cb(null, addresses));

  const run = (lookup: ReturnType<typeof publicOnlyLookup>, all: boolean): Promise<{ err: NodeJS.ErrnoException | null; result: unknown }> =>
    new Promise((resolve) => {
      (lookup as unknown as (h: string, o: { all: boolean }, cb: (err: NodeJS.ErrnoException | null, a?: unknown, f?: number) => void) => void)('push.example', { all }, (err, address) =>
        resolve({ err, result: address })
      );
    });

  it('passes a name that resolves only to public addresses', async () => {
    const lookup = lookupWith([{ address: '142.250.180.10', family: 4 }, { address: '2a00:1450:4009:81f::200a', family: 6 }]);
    expect(await run(lookup, false)).toEqual({ err: null, result: '142.250.180.10' });
    expect((await run(lookup, true)).result).toHaveLength(2);
  });

  it('refuses a name that resolves to a private or loopback address, even beside a public one (DNS rebinding)', async () => {
    for (const addresses of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '142.250.180.10', family: 4 }, { address: '192.168.0.5', family: 4 }],
      [{ address: '::1', family: 6 }],
      [{ address: 'fd12::1', family: 6 }],
      [],
    ]) {
      const { err } = await run(lookupWith(addresses), true);
      expect(err?.code, JSON.stringify(addresses)).toBe('EPUSHPRIVATE');
    }
  });

  it('the https transport refuses a private endpoint before connecting', async () => {
    await expect(httpsPushTransport({ endpoint: 'https://127.0.0.1:9/push', headers: {}, body: Buffer.alloc(0) })).rejects.toThrow(/private network/);
  });
});
