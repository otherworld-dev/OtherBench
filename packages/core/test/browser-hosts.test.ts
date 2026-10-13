import { describe, expect, it } from 'vitest';
import { BROWSER_HOST_VECTORS } from '../src/testing/browser-host-vectors.js';
import {
  BROWSER_COMMANDS,
  browserCommandRisk,
  browserHostDenial,
  browserUrlCheck,
  isLocalName,
  isOwnAddress,
  isPublicAddress,
  normaliseHost,
  ownAddresses,
  siteOf,
  V4_NOT_PUBLIC,
  V6_GLOBAL_NOT_PUBLIC,
} from '../src/domain/browser-hosts.js';

describe('siteOf', () => {
  it('gives the lower-case hostname of an http or https address, port dropped', () => {
    expect(siteOf('https://Example.COM:8443/a?b#c')).toBe('example.com');
    expect(siteOf('http://example.com')).toBe('example.com');
  });

  it('writes an international name as punycode and drops a trailing dot', () => {
    expect(siteOf('https://bücher.example/')).toBe('xn--bcher-kva.example');
    expect(siteOf('https://LOCALHOST./')).toBe('localhost');
    expect(siteOf('https://example.com./x')).toBe('example.com');
  });

  it('turns IPv4 written as a number or in hex into the dotted address, and unwraps IPv6', () => {
    expect(siteOf('http://2130706433/')).toBe('127.0.0.1');
    expect(siteOf('http://0x7f.1/')).toBe('127.0.0.1');
    expect(siteOf('http://[::FFFF:192.168.1.1]/')).toBe('::ffff:c0a8:101');
    expect(siteOf('http://[::1]:8080/')).toBe('::1');
  });

  it('is null for anything but http and https, and for nonsense', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', '']) {
      expect(siteOf(url), url).toBeNull();
    }
  });
});

describe('normaliseHost', () => {
  it('gives the canonical host: lower case, one trailing dot and brackets dropped, IDN as punycode', () => {
    expect(normaliseHost('Example.COM.')).toBe('example.com');
    expect(normaliseHost('[::1]')).toBe('::1');
    expect(normaliseHost('::1')).toBe('::1');
    expect(normaliseHost('BÜCHER.example')).toBe('xn--bcher-kva.example');
  });

  it('writes IPv4 in any spelling as a dotted quad, and IPv6 compressed', () => {
    for (const h of ['2130706433', '0x7f.1', '0177.0.0.1', '127.1', '127.0.0.1.']) expect(normaliseHost(h), h).toBe('127.0.0.1');
    expect(normaliseHost('[0:0:0:0:0:0:0:1]')).toBe('::1');
    expect(normaliseHost('::FFFF:192.168.1.1')).toBe('::ffff:c0a8:101');
  });

  it('is null for anything that is not exactly a hostname or address', () => {
    for (const h of ['', '.', '..', ' example.com', 'example.com ', 'exa mple.com', 'a\tb', 'example.com\n', 'a\\b', 'a@b.com', 'good@evil.com', 'example.com/x', 'example.com?x', 'example.com#x', 'example.com:80', 'example.com..', '[::1', 'a%zz']) {
      expect(normaliseHost(h), JSON.stringify(h)).toBeNull();
    }
  });
});

describe('the shared host vectors (also run through the egress proxy in @grunt/tools)', () => {
  it.each(BROWSER_HOST_VECTORS.map((v) => [v.note, v] as const))('%s', (_note, v) => {
    const check = browserUrlCheck(v.input, { browserBlockedHosts: v.blockedHosts }, { allowLoopbackPorts: v.allowLoopbackPorts });
    expect(check.site, JSON.stringify(v.input)).toBe(v.site);
    expect(check.denial !== null, JSON.stringify(v.input)).toBe(v.denied);
    expect(siteOf(v.input)).toBe(v.site);
    // A refused address never has a port, and a usable one always does.
    expect(check.port === null).toBe(v.site === null);
  });

  it('covers every kind of case the review asked for', () => {
    const sites = BROWSER_HOST_VECTORS.filter((v) => v.site === null).length;
    expect(sites).toBeGreaterThanOrEqual(25);
    expect(BROWSER_HOST_VECTORS.filter((v) => v.denied && v.site !== null).length).toBeGreaterThanOrEqual(40);
    expect(BROWSER_HOST_VECTORS.filter((v) => !v.denied).length).toBeGreaterThanOrEqual(10);
  });
});

describe('the range tables', () => {
  // samePrefix shifts a 32-bit mask by (32 - prefix): outside 0..32 that count is negative and JavaScript wraps it
  // (0xffffffff << (32 - 48) is a /16), so a bad row would silently match the wrong block.
  it('give every IPv4 row a prefix of 1..32', () => {
    for (const [a, b, c, d, prefix] of V4_NOT_PUBLIC) {
      expect(Number.isInteger(prefix) && prefix >= 1 && prefix <= 32, `${a}.${b}.${c}.${d}/${prefix}`).toBe(true);
    }
  });

  it('give every IPv6 row, which compares only the first 32 bits, a prefix of 3..32 inside 2000::/3', () => {
    for (const [a, b, prefix] of V6_GLOBAL_NOT_PUBLIC) {
      const row = `${a.toString(16)}:${b.toString(16)}::/${prefix}`;
      expect(Number.isInteger(prefix) && prefix >= 3 && prefix <= 32, row).toBe(true);
      expect(a & 0xe000, row).toBe(0x2000);
    }
  });
});

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, CGNAT, multicast, documentation and reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254',
      '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
      '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9', '192.0.0.8', '192.88.99.1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('allows public IPv4, including the addresses just outside the private ranges', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '9.255.255.255', '11.0.0.0', '223.255.255.255']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses loopback, unspecified, unique-local, link-local, multicast, discard and documentation IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '100::1', '2001::1', '3fff::1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('judges v4-mapped, NAT64 and 6to4 addresses by the IPv4 address inside them', () => {
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:c0a8:101')).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicAddress('64:ff9b::10.0.0.1')).toBe(false);
    expect(isPublicAddress('64:ff9b::808:808')).toBe(true);
    expect(isPublicAddress('2002:c0a8:0101::1')).toBe(false);
    expect(isPublicAddress('2002:0808:0808::1')).toBe(true);
  });

  it('allows global IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2a00:1450:4009:81f::200e']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('fails closed on anything that is not an address', () => {
    for (const s of ['example.com', '1.2.3', '1.2.3.256', '::1::2', '', 'gggg::1']) expect(isPublicAddress(s), s).toBe(false);
  });

  it('fails closed on IPv4 written with leading zeros (a parser may read them as octal)', () => {
    for (const s of ['0177.0.0.1', '010.0.0.1', '08.8.8.8', '8.08.8.8', '8.8.8.008', '00.0.0.0', '::ffff:0177.0.0.1', '64:ff9b::08.8.8.8']) {
      expect(isPublicAddress(s), s).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('1.0.0.1')).toBe(true);
  });
});

describe('ownAddresses / isOwnAddress', () => {
  // Public-looking addresses, only ever compared here: nothing connects to them.
  const own = ownAddresses(['127.0.0.1', '::1', '192.168.1.20', 'fe80::1%eth0', '81.2.69.160', '2A02:8010:1234:5678:0:0:0:10', '2a02:8010:aaaa:1::%3']);

  it("keeps only the public ones (the rest are refused as local or private anyway)", () => {
    expect([...own.exact].sort()).toEqual(['2a02:8010:1234:5678:0:0:0:10', '2a02:8010:aaaa:1:0:0:0:0', '81.2.69.160']);
    expect([...own.v6Prefixes].sort()).toEqual(['2a02:8010:1234:5678', '2a02:8010:aaaa:1']);
  });

  it('matches its own IPv4 address, written as IPv4 or as v4-mapped, NAT64 or 6to4 IPv6', () => {
    for (const ip of ['81.2.69.160', '::ffff:81.2.69.160', '::ffff:5102:45a0', '64:ff9b::5102:45a0', '2002:5102:45a0::1']) expect(isOwnAddress(ip, own), ip).toBe(true);
    expect(isOwnAddress('81.2.69.161', own)).toBe(false);
  });

  it('matches anything in the /64 of one of its public IPv6 addresses, in any spelling', () => {
    for (const ip of ['2a02:8010:1234:5678::10', '2a02:8010:1234:5678:ffff:ffff:ffff:ffff', '2A02:8010:1234:5678::abcd', '2a02:8010:aaaa:1::99']) expect(isOwnAddress(ip, own), ip).toBe(true);
    for (const ip of ['2a02:8010:1234:5679::10', '2a02:8010:1234::10', '8.8.8.8']) expect(isOwnAddress(ip, own), ip).toBe(false);
  });

  it('matches nothing for an empty list or a non-address', () => {
    expect(isOwnAddress('81.2.69.160', ownAddresses([]))).toBe(false);
    expect(isOwnAddress('example.com', own)).toBe(false);
    expect(ownAddresses(['not an address']).exact.size).toBe(0);
  });
});

describe('isLocalName', () => {
  it('knows the local network names, in any case and with a trailing dot', () => {
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'printer.local', 'db.internal', 'nas.home.arpa', 'router.lan']) {
      expect(isLocalName(h), h).toBe(true);
    }
  });

  it('leaves ordinary names alone, even ones that merely contain those words', () => {
    for (const h of ['example.com', 'localhost.example.com', 'local.example.com', 'lan.example']) expect(isLocalName(h), h).toBe(false);
    // A name with no dot is a search-domain name: a different machine on every network.
    for (const h of ['router', 'intranet', 'NAS.', 'com', 'box.localdomain']) expect(isLocalName(h), h).toBe(true);
    // An address is never a name, dots or not: its range decides.
    for (const h of ['::1', '[2606:4700:4700::1111]', '8.8.8.8', '2130706433']) expect(isLocalName(h), h).toBe(false);
  });
});

describe('browserHostDenial', () => {
  it("refuses the profile's blocked sites and their subdomains, but not lookalikes", () => {
    const policy = { browserBlockedHosts: ['ads.test', 'Tracker.Example.'] };
    expect(browserHostDenial('ads.test', policy)).toBe('ads.test is blocked for this profile.');
    expect(browserHostDenial('x.y.ads.test', policy)).toBe('x.y.ads.test is blocked for this profile.');
    expect(browserHostDenial('tracker.example', policy)).toBe('tracker.example is blocked for this profile.');
    expect(browserHostDenial('badads.test', policy)).toBeNull();
    expect(browserHostDenial('example.com', policy)).toBeNull();
  });

  it('refuses local names, non-public addresses and a missing host', () => {
    expect(browserHostDenial('localhost', {})).toBe("localhost is a local network name. The model's browser can't reach it.");
    expect(browserHostDenial('router', {})).toBe("router is a local network name. The model's browser can't reach it.");
    expect(browserHostDenial('INTRANET.', {})).toBe("intranet is a local network name. The model's browser can't reach it.");
    // A public IPv6 address has no dot either, and is still a site.
    expect(browserHostDenial('2606:4700:4700::1111', {})).toBeNull();
    expect(browserHostDenial('192.168.1.1', {})).toBe("192.168.1.1 is a local or private address. The model's browser can't reach it.");
    expect(browserHostDenial('::1', {})).toMatch(/local or private address/);
    expect(browserHostDenial(null, {})).toBe("Grunt couldn't tell which website this is for.");
    expect(browserHostDenial('', {})).toBe("Grunt couldn't tell which website this is for.");
    expect(browserHostDenial('8.8.8.8', {})).toBeNull();
    expect(browserHostDenial('example.com', {})).toBeNull();
  });

  it('lets 127.0.0.1 through only for the test ports, and only 127.0.0.1', () => {
    // The broker knows no port: any configured test port lets the name through.
    expect(browserHostDenial('127.0.0.1', {}, { allowLoopbackPorts: [4766] })).toBeNull();
    // The proxy knows the port, and holds it to the list.
    expect(browserHostDenial('127.0.0.1', {}, { allowLoopbackPorts: [4766], port: 4766 })).toBeNull();
    expect(browserHostDenial('127.0.0.1', {}, { allowLoopbackPorts: [4766], port: 4747 })).toMatch(/local or private/);
    expect(browserHostDenial('127.0.0.1', {}, {})).toMatch(/local or private/);
    expect(browserHostDenial('localhost', {}, { allowLoopbackPorts: [4766], port: 4766 })).toMatch(/local network name/);
    expect(browserHostDenial('127.0.0.1', { browserBlockedHosts: ['127.0.0.1'] }, { allowLoopbackPorts: [4766] })).toMatch(/blocked/);
  });
});

describe('browser commands', () => {
  it('reads with snapshot, scroll and close, and changes the page with everything else', () => {
    expect(BROWSER_COMMANDS.filter((c) => browserCommandRisk(c) === 'read')).toEqual(['snapshot', 'scroll', 'close']);
    expect(BROWSER_COMMANDS.filter((c) => browserCommandRisk(c) === 'mutate')).toEqual(['open', 'click', 'type', 'select', 'press', 'back']);
  });
});
