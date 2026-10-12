/**
 * One table for the two host-keyed sources: the sandbox's network cards
 * (`canonicalHost` / `isLocalOrPrivateHost`, network-hosts.ts) and the model's
 * browser (`normaliseHost` / `browserHostDenial`, browser-hosts.ts). Both are
 * built on the same spelling, the same IPv4 ranges and the same local-name
 * suffixes, so most rows have one answer. Where they differ, the row says why,
 * and `SHARED_HOST_DIFFERENCES` lists every reason there is: a new difference
 * has to be added there on purpose.
 *
 * `canonical`: the one spelling a card and a grant use for the host, or null
 * when that side doesn't take the text as a host at all. `refused`: whether
 * the broker refuses a call about it before any card (a null host always is).
 */
export interface HostJudgement {
  canonical: string | null;
  refused: boolean;
}

/** Why the sandbox and the browser read a host differently. Every one is on purpose. */
export const SHARED_HOST_DIFFERENCES = {
  ipv6: 'The sandbox reaches hosts by name only, so it takes no IPv6 literal. A website may be one, and the browser judges it by its range.',
  singleLabel:
    "The sandbox refuses a name with no dot (a search-domain name like `router`) by its spelling. The browser lets it through to its card: its proxy resolves every name itself and refuses a non-public address there.",
  percentEscape: 'The sandbox refuses a percent-escape instead of decoding it. The browser reads a host the way Chromium does, which decodes it.',
  hostCharacters: 'The sandbox takes only letters, digits, hyphens and dots (what its runtime can match). The browser takes whatever Chromium takes as a host, an underscore included.',
  length: 'The sandbox refuses a name over 253 characters. The browser leaves that to Chromium and DNS.',
} as const;
export type SharedHostDifference = keyof typeof SHARED_HOST_DIFFERENCES;

export interface SharedHostVector {
  /** Why this row exists. */
  note: string;
  /** A bare host, as a call's `host` argument or a grant's constraint might carry it. */
  host: string;
  sandbox: HostJudgement;
  browser: HostJudgement;
  /** Set exactly when the two sides differ. */
  differs?: SharedHostDifference;
}

const allowed = (note: string, host: string, canonical: string): SharedHostVector => ({ note, host, sandbox: { canonical, refused: false }, browser: { canonical, refused: false } });
const refused = (note: string, host: string, canonical: string): SharedHostVector => ({ note, host, sandbox: { canonical, refused: true }, browser: { canonical, refused: true } });
const notAHost = (note: string, host: string): SharedHostVector => ({ note, host, sandbox: { canonical: null, refused: true }, browser: { canonical: null, refused: true } });
const differs = (differs: SharedHostDifference, note: string, host: string, sandbox: HostJudgement, browser: HostJudgement): SharedHostVector => ({ note, host, sandbox, browser, differs });

const LONG_NAME = `${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.example`;

export const SHARED_HOST_VECTORS: readonly SharedHostVector[] = [
  // Public names, in their different spellings: one canonical form.
  allowed('plain', 'pypi.org', 'pypi.org'),
  allowed('case and a trailing dot', 'PyPI.org.', 'pypi.org'),
  allowed('IDN as punycode', 'bücher.example', 'xn--bcher-kva.example'),
  allowed('IDN in upper case', 'BÜCHER.example', 'xn--bcher-kva.example'),
  allowed('punycode already', 'xn--bcher-kva.example', 'xn--bcher-kva.example'),
  allowed('local words inside an ordinary name', 'localhost.example.com', 'localhost.example.com'),
  allowed('local words inside an ordinary name (2)', 'internal.example.com', 'internal.example.com'),
  allowed('a local suffix as an ordinary label', 'lan.example', 'lan.example'),

  // Public IPv4, and the public neighbours of the refused ranges.
  allowed('public IPv4', '8.8.8.8', '8.8.8.8'),
  allowed('public IPv4 in hex', '0x8.8.8.8', '8.8.8.8'),
  allowed('just outside 10/8', '11.0.0.1', '11.0.0.1'),
  allowed('just outside 172.16/12', '172.32.0.1', '172.32.0.1'),
  allowed('just outside CGNAT', '100.128.0.1', '100.128.0.1'),
  allowed('just below the 6to4 relay range', '192.88.98.1', '192.88.98.1'),
  allowed('just above the 6to4 relay range', '192.88.100.1', '192.88.100.1'),

  // Local names: one suffix list.
  refused('localhost', 'localhost', 'localhost'),
  refused('localhost, upper case and a trailing dot', 'LOCALHOST.', 'localhost'),
  refused('*.localhost', 'api.localhost', 'api.localhost'),
  refused('*.local', 'printer.local', 'printer.local'),
  refused('*.internal', 'db.internal', 'db.internal'),
  refused('*.home.arpa', 'nas.home.arpa', 'nas.home.arpa'),
  refused('home.arpa itself', 'home.arpa', 'home.arpa'),
  refused('*.lan', 'router.lan', 'router.lan'),
  refused('*.localdomain', 'box.localdomain', 'box.localdomain'),
  refused('a local suffix on its own', 'local', 'local'),
  refused('a local suffix on its own (2)', 'internal', 'internal'),

  // IPv4 that isn't the public internet, in every spelling: one table of ranges.
  refused('loopback', '127.0.0.1', '127.0.0.1'),
  refused('loopback as a decimal number', '2130706433', '127.0.0.1'),
  refused('loopback in hex with a short tail', '0x7f.1', '127.0.0.1'),
  refused('loopback in octal', '0177.0.0.1', '127.0.0.1'),
  refused('loopback shorthand', '127.1', '127.0.0.1'),
  refused('whole 127/8', '127.255.0.9', '127.255.0.9'),
  refused('"this network"', '0.0.0.0', '0.0.0.0'),
  refused('10/8', '10.0.0.5', '10.0.0.5'),
  refused('172.16/12', '172.16.0.1', '172.16.0.1'),
  refused('top of 172.16/12', '172.31.255.255', '172.31.255.255'),
  refused('192.168/16', '192.168.1.1', '192.168.1.1'),
  refused('link-local, cloud metadata', '169.254.169.254', '169.254.169.254'),
  refused('link-local in hex', '0xa9fea9fe', '169.254.169.254'),
  refused('CGNAT', '100.64.0.1', '100.64.0.1'),
  refused('multicast', '224.0.0.1', '224.0.0.1'),
  refused('reserved', '240.0.0.1', '240.0.0.1'),
  refused('broadcast', '255.255.255.255', '255.255.255.255'),
  refused('protocol assignments', '192.0.0.1', '192.0.0.1'),
  refused('documentation (TEST-NET-1)', '192.0.2.5', '192.0.2.5'),
  refused('documentation (TEST-NET-2)', '198.51.100.7', '198.51.100.7'),
  refused('documentation (TEST-NET-3)', '203.0.113.200', '203.0.113.200'),
  refused('benchmarking', '198.18.0.1', '198.18.0.1'),
  refused('6to4 relay anycast', '192.88.99.1', '192.88.99.1'),

  // Not a host on either side: refused, never repaired.
  notAHost('empty', ''),
  notAHost('a path', 'pypi.org/simple'),
  notAHost('a query', 'pypi.org?x'),
  notAHost('a fragment', 'pypi.org#x'),
  notAHost('a port', 'pypi.org:443'),
  notAHost('userinfo', 'evil.example@pypi.org'),
  notAHost('a space inside', 'py pi.org'),
  notAHost('a leading space', ' pypi.org'),
  notAHost('a tab', 'pypi\t.org'),
  notAHost('a newline', 'pypi.org\n'),
  notAHost('NUL', 'pypi\u0000.org'),
  notAHost('a backslash', 'pypi.org\\'),
  notAHost('only a dot', '.'),
  notAHost('an empty label', 'pypi..org'),
  notAHost('two trailing dots', 'pypi.org..'),
  notAHost('a leading dot', '.pypi.org'),

  // IPv6: the sandbox takes none; the browser judges each by its range.
  differs('ipv6', 'IPv6 loopback', '::1', { canonical: null, refused: true }, { canonical: '::1', refused: true }),
  differs('ipv6', 'IPv6 loopback in brackets', '[::1]', { canonical: null, refused: true }, { canonical: '::1', refused: true }),
  differs('ipv6', 'unique-local IPv6', 'fd00::1', { canonical: null, refused: true }, { canonical: 'fd00::1', refused: true }),
  differs('ipv6', 'v4-mapped loopback', '::ffff:127.0.0.1', { canonical: null, refused: true }, { canonical: '::ffff:7f00:1', refused: true }),
  differs('ipv6', 'public IPv6', '2606:4700:4700::1111', { canonical: null, refused: true }, { canonical: '2606:4700:4700::1111', refused: false }),
  differs('ipv6', 'public IPv6 in brackets', '[2606:4700:4700::1111]', { canonical: null, refused: true }, { canonical: '2606:4700:4700::1111', refused: false }),

  // A name with no dot.
  differs('singleLabel', 'a search-domain name', 'router', { canonical: 'router', refused: true }, { canonical: 'router', refused: false }),
  differs('singleLabel', 'a search-domain name (2)', 'intranet', { canonical: 'intranet', refused: true }, { canonical: 'intranet', refused: false }),

  // Spellings only the browser takes.
  differs('percentEscape', 'a percent-escaped letter', 'ex%61mple.com', { canonical: null, refused: true }, { canonical: 'example.com', refused: false }),
  differs('hostCharacters', 'an underscore', 'a_b.example.com', { canonical: null, refused: true }, { canonical: 'a_b.example.com', refused: false }),
  differs('length', 'a name over 253 characters', LONG_NAME, { canonical: null, refused: true }, { canonical: LONG_NAME, refused: false }),
];

/**
 * Resolved addresses, as the browser's proxy (`isPublicAddress`) and the
 * sandbox's agent in the VM (`isPrivateAddress`, sandbox/resources/agent-core.mjs)
 * judge them. The agent is a plain script that can't import core, so it keeps
 * its own copy of the ranges: this table is what holds the two together.
 * `reachable`: whether a connection to the address may be made.
 */
export interface SharedAddressVector {
  note: string;
  address: string;
  browser: boolean;
  sandboxAgent: boolean;
  /** Set exactly when the two sides differ: why. */
  differs?: string;
}

const both = (reachable: boolean) => (note: string, address: string): SharedAddressVector => ({ note, address, browser: reachable, sandboxAgent: reachable });
const reachable = both(true);
const unreachable = both(false);
/** The browser refuses it and the sandbox's agent doesn't: the agent names the ranges it refuses, the browser names the one IPv6 range it allows. */
const browserOnly = (note: string, address: string, differs: string): SharedAddressVector => ({ note, address, browser: false, sandboxAgent: true, differs });

const AGENT_LISTS_RANGES = "The sandbox's agent lists the IPv6 ranges it refuses; the browser allows only global unicast (2000::/3) less its special ranges.";

export const SHARED_ADDRESS_VECTORS: readonly SharedAddressVector[] = [
  reachable('public IPv4', '8.8.8.8'),
  reachable('public IPv4 (2)', '93.184.216.34'),
  reachable('just outside 10/8', '11.0.0.1'),
  reachable('just outside CGNAT', '100.128.0.1'),
  reachable('just outside 172.16/12', '172.32.0.1'),
  reachable('just outside link-local', '169.255.1.1'),
  reachable('just outside benchmarking', '198.20.0.1'),
  reachable('top of the public range', '223.255.255.255'),
  reachable('public IPv6', '2606:4700:4700::1111'),
  reachable('public IPv6 (2)', '2a00:1450:4009:81f::200e'),
  reachable('v4-mapped public IPv4', '::ffff:8.8.8.8'),
  reachable('NAT64 public IPv4', '64:ff9b::808:808'),

  unreachable('"this network"', '0.0.0.0'),
  unreachable('loopback', '127.0.0.1'),
  unreachable('10/8', '10.0.0.1'),
  unreachable('CGNAT', '100.64.0.1'),
  unreachable('link-local, cloud metadata', '169.254.169.254'),
  unreachable('172.16/12', '172.16.0.1'),
  unreachable('192.168/16', '192.168.0.1'),
  unreachable('protocol assignments', '192.0.0.8'),
  unreachable('documentation (TEST-NET-1)', '192.0.2.1'),
  unreachable('documentation (TEST-NET-2)', '198.51.100.1'),
  unreachable('documentation (TEST-NET-3)', '203.0.113.9'),
  unreachable('benchmarking', '198.18.0.1'),
  unreachable('multicast', '224.0.0.1'),
  unreachable('reserved', '240.0.0.1'),
  unreachable('broadcast', '255.255.255.255'),
  unreachable('IPv6 unspecified', '::'),
  unreachable('IPv6 loopback', '::1'),
  unreachable('link-local IPv6', 'fe80::1'),
  unreachable('site-local IPv6', 'fec0::1'),
  unreachable('unique-local IPv6', 'fc00::1'),
  unreachable('unique-local IPv6 (2)', 'fd12:3456:789a::1'),
  unreachable('multicast IPv6', 'ff02::1'),
  unreachable('documentation IPv6', '2001:db8::1'),
  unreachable('v4-mapped loopback', '::ffff:127.0.0.1'),
  unreachable('v4-mapped private, hex form', '::ffff:c0a8:101'),
  unreachable('v4-compatible loopback', '::127.0.0.1'),
  unreachable('NAT64 private IPv4', '64:ff9b::10.0.0.1'),
  unreachable('not an address', 'localhost'),
  unreachable('empty', ''),
  unreachable('too few parts', '1.2.3'),
  unreachable('a part over 255', '256.1.1.1'),
  unreachable('a leading zero (octal to some parsers)', '010.0.0.1'),

  browserOnly('6to4 relay anycast', '192.88.99.1', "Not on the sandbox agent's list of IPv4 ranges."),
  browserOnly('6to4 of a private IPv4', '2002:c0a8:101::1', AGENT_LISTS_RANGES),
  browserOnly('Teredo and the other 2001::/23 assignments', '2001::1', AGENT_LISTS_RANGES),
  browserOnly('documentation IPv6 (RFC 9637)', '3fff::1', AGENT_LISTS_RANGES),
  browserOnly('discard-only IPv6', '100::1', AGENT_LISTS_RANGES),
  browserOnly('v4-compatible public IPv4 (deprecated)', '::8.8.8.8', AGENT_LISTS_RANGES),
  browserOnly('outside global unicast', 'fb00::1', AGENT_LISTS_RANGES),
];
