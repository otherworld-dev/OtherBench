import { describe, expect, it } from 'vitest';
import { canonicalHost, isLocalOrPrivateHost } from '../src/domain/network-hosts.js';

/** What the sandbox_network card does with a raw host: refused when it isn't a host name, or is local. */
const refused = (raw: string): boolean => {
  const host = canonicalHost(raw);
  return host === null || isLocalOrPrivateHost(host);
};

describe('isLocalOrPrivateHost', () => {
  it.each([
    // Already covered: literal forms URL canonicalises, and the private ranges.
    '127.0.0.1', '127.9.9.9', '0x7f.1', '2130706433', '0x7f000001', '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.255',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    'localhost', 'LOCALHOST.', 'api.localhost',
    // Octal forms.
    '0177.0.0.1', '017700000001', '0177.1', '012.0.0.1', '0300.0250.0.1',
    // Multicast, reserved (class E) and broadcast.
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.254', '255.255.255.255',
    // Benchmarking, protocol assignments and the documentation ranges.
    '198.18.0.1', '198.19.255.255', '192.0.0.1', '192.0.0.255', '192.0.2.1', '198.51.100.7', '203.0.113.200',
    // Names that only resolve on a private network, and single-label names.
    'printer.internal', 'a.b.internal', 'nas.local', 'router.home.arpa', 'home.arpa', 'box.localdomain',
    'router', 'nas', 'intranet', 'local', 'internal', 'localdomain',
    // Every IPv6 literal, in any spelling.
    '[::1]', '[::ffff:127.0.0.1]', '[fe80::1]', '[fd00::1]', '[2001:db8::1]', '::1',
  ])('refuses %s', (raw) => {
    expect(refused(raw)).toBe(true);
  });

  it.each([
    'pypi.org', 'registry.npmjs.org', 'xn--bcher-kva.example', 'internal.example.com', 'local.example.com',
    'localhost.example.com', 'notlocal.com', 'my.internal-tools.io', 'arpa.org',
    // Public neighbours of every refused range.
    '8.8.8.8', '1.1.1.1', '11.0.0.1', '9.255.255.255', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
    '169.253.0.1', '169.255.0.1', '172.15.255.255', '172.32.0.1', '192.0.1.1', '192.0.3.1', '192.167.0.1', '192.169.0.1',
    '198.17.255.255', '198.20.0.1', '198.51.99.1', '198.51.101.1', '203.0.112.1', '203.0.114.1', '223.255.255.255',
  ])('lets %s through to a card', (raw) => {
    expect(refused(raw)).toBe(false);
  });
});

describe('canonicalHost', () => {
  it('spells the octal, hex and integer IPv4 forms as dotted quads', () => {
    expect(canonicalHost('0177.0.0.1')).toBe('127.0.0.1');
    expect(canonicalHost('017700000001')).toBe('127.0.0.1');
    expect(canonicalHost('0x7f.1')).toBe('127.0.0.1');
    expect(canonicalHost('2130706433')).toBe('127.0.0.1');
  });

  it('drops one trailing dot and refuses IPv6 literals', () => {
    expect(canonicalHost('PyPI.org.')).toBe('pypi.org');
    expect(canonicalHost('[::1]')).toBeNull();
  });
});
