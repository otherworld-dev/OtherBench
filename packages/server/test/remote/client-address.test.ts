import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientAddress, normalizeIp } from '../../src/remote/client-address.js';
import { from } from './helpers.js';

function app(trusted: string[]) {
  const set = new Set(trusted);
  const a = new Hono();
  a.get('/', (c) => c.text(String(clientAddress(c, set))));
  return a;
}

const ask = async (trusted: string[], socket: string | null, xff?: string): Promise<string> =>
  (await app(trusted).request('/', xff === undefined ? {} : { headers: { 'X-Forwarded-For': xff } }, socket === null ? undefined : from(socket))).text();

describe('clientAddress', () => {
  it("is the socket's address, without the IPv4-mapped prefix", async () => {
    expect(await ask([], '10.0.0.7')).toBe('10.0.0.7');
    expect(await ask([], '::ffff:10.0.0.7')).toBe('10.0.0.7');
    expect(await ask([], null)).toBe('null');
  });

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', async () => {
    expect(await ask([], '10.0.0.7', '1.2.3.4')).toBe('10.0.0.7');
    expect(await ask(['127.0.0.1'], '10.0.0.7', '1.2.3.4')).toBe('10.0.0.7');
  });

  it('takes the right-most entry that is not a trusted proxy', async () => {
    expect(await ask(['127.0.0.1'], '127.0.0.1', '1.2.3.4')).toBe('1.2.3.4');
    expect(await ask(['127.0.0.1', '10.0.0.2'], '127.0.0.1', '6.6.6.6, 1.2.3.4, 10.0.0.2')).toBe('1.2.3.4');
  });

  it('does not fall back to an entry the client wrote when the right-most one is unusable', async () => {
    expect(await ask(['127.0.0.1'], '127.0.0.1', '1.2.3.4, not-an-ip')).toBe('127.0.0.1');
    expect(await ask(['127.0.0.1'], '127.0.0.1', '6.6.6.6, 1.2.3.4:notaport')).toBe('127.0.0.1');
    expect(await ask(['127.0.0.1'], '127.0.0.1', '6.6.6.6, 1.2.3.4, ')).toBe('127.0.0.1');
  });

  it('drops a :port from the entry a proxy appended', async () => {
    expect(await ask(['127.0.0.1'], '127.0.0.1', '6.6.6.6, 1.2.3.4:51234')).toBe('1.2.3.4');
    expect(await ask(['127.0.0.1'], '127.0.0.1', '6.6.6.6, [FD00::5]:51234')).toBe('fd00::5');
    expect(await ask(['127.0.0.1', '10.0.0.2'], '127.0.0.1', '1.2.3.4:1, 10.0.0.2:443')).toBe('1.2.3.4');
  });

  it("falls back to the proxy's own address when the header has nothing usable", async () => {
    expect(await ask(['127.0.0.1'], '127.0.0.1')).toBe('127.0.0.1');
    expect(await ask(['127.0.0.1'], '127.0.0.1', 'garbage, , 1.2.3')).toBe('127.0.0.1');
  });
});

describe('normalizeIp', () => {
  it('accepts IPv4 and IPv6 (bracketed or not), lower-cases, and refuses the rest', () => {
    expect(normalizeIp(' 10.0.0.1 ')).toBe('10.0.0.1');
    expect(normalizeIp('[FD00::5]')).toBe('fd00::5');
    expect(normalizeIp('10.0.0.0/8')).toBeNull();
    expect(normalizeIp('grunt.lan')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});
