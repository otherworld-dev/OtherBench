/**
 * Shared test vectors for the browser's website rules (spec
 * 2026-10-12-model-browser-design). The same raw addresses go through the core
 * rules (`browserUrlCheck`) and, in the tools package, through the egress
 * proxy's check, and both must give exactly these answers: a card, a grant and
 * a connection may never disagree about which host an address means.
 *
 * `site`: the canonical host (`siteOf`), or null when the address is refused
 * outright (userinfo, backslash, whitespace, control characters, other
 * schemes, empty or unparseable). `denied`: whether the browser may NOT use it
 * (a null site is always denied: missing host fails closed).
 */
export interface BrowserHostVector {
  /** Why this row exists. */
  note: string;
  /** The raw address, exactly as a model, a page or a redirect might hand it over. */
  input: string;
  site: string | null;
  denied: boolean;
  /** The profile's `browserBlockedHosts` for this row. */
  blockedHosts?: string[];
  /** `GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS` for this row. */
  allowLoopbackPorts?: number[];
}

const ok = (note: string, input: string, site: string): BrowserHostVector => ({ note, input, site, denied: false });
const no = (note: string, input: string, site: string): BrowserHostVector => ({ note, input, site, denied: true });
const refused = (note: string, input: string): BrowserHostVector => ({ note, input, site: null, denied: true });

export const BROWSER_HOST_VECTORS: readonly BrowserHostVector[] = [
  // Ordinary public sites, in their different spellings.
  ok('plain', 'http://example.com', 'example.com'),
  ok('case, port, path, query, fragment', 'https://Example.COM:8443/a?b#c', 'example.com'),
  ok('trailing dot', 'https://example.com./x', 'example.com'),
  ok('IDN as punycode', 'https://bücher.example/', 'xn--bcher-kva.example'),
  ok('IDN in upper case', 'https://BÜCHER.example/', 'xn--bcher-kva.example'),
  ok('public IPv4', 'https://8.8.8.8/', '8.8.8.8'),
  ok('just outside 172.16/12', 'http://172.32.0.1/', '172.32.0.1'),
  ok('just outside CGNAT', 'http://100.128.0.1/', '100.128.0.1'),
  ok('public IPv6', 'http://[2606:4700:4700::1111]/', '2606:4700:4700::1111'),
  ok('v4-mapped public IPv4', 'http://[::ffff:8.8.8.8]/', '::ffff:808:808'),
  ok('NAT64 public IPv4', 'http://[64:ff9b::808:808]/', '64:ff9b::808:808'),
  ok('local words inside an ordinary name', 'https://localhost.example.com/', 'localhost.example.com'),
  ok('local words inside an ordinary name (2)', 'https://lan.example/', 'lan.example'),

  // Local names.
  no('localhost', 'http://localhost:3000/', 'localhost'),
  no('localhost, upper case and trailing dot', 'https://LOCALHOST./', 'localhost'),
  no('*.localhost', 'http://app.localhost/', 'app.localhost'),
  no('*.local', 'http://printer.local/', 'printer.local'),
  no('*.internal', 'http://db.internal/', 'db.internal'),
  no('*.home.arpa', 'http://nas.home.arpa/', 'nas.home.arpa'),
  no('*.lan', 'http://router.lan/', 'router.lan'),

  // IPv4 in every spelling WHATWG reads as an address.
  no('loopback', 'http://127.0.0.1/', '127.0.0.1'),
  no('loopback as a decimal number', 'http://2130706433/', '127.0.0.1'),
  no('loopback in hex with a short tail', 'http://0x7f.1/', '127.0.0.1'),
  no('loopback in octal', 'http://0177.0.0.1/', '127.0.0.1'),
  no('loopback shorthand', 'http://127.1/', '127.0.0.1'),
  no('loopback as one hex number', 'http://0x7f000001/', '127.0.0.1'),
  no('loopback as one octal number', 'http://017700000001/', '127.0.0.1'),
  no('loopback with a trailing dot', 'http://127.0.0.1./', '127.0.0.1'),
  no('whole 127/8', 'http://127.255.0.9/', '127.255.0.9'),
  no('"this network"', 'http://0.0.0.0/', '0.0.0.0'),
  no('10/8', 'http://10.0.0.5/', '10.0.0.5'),
  no('172.16/12', 'http://172.16.0.1/', '172.16.0.1'),
  no('192.168/16', 'http://192.168.1.1/', '192.168.1.1'),
  no('link-local, cloud metadata', 'http://169.254.169.254/', '169.254.169.254'),
  no('link-local in hex', 'http://0xa9fea9fe/', '169.254.169.254'),
  no('CGNAT', 'http://100.64.0.1/', '100.64.0.1'),
  no('multicast', 'http://224.0.0.1/', '224.0.0.1'),
  no('reserved', 'http://240.0.0.1/', '240.0.0.1'),
  no('broadcast', 'http://255.255.255.255/', '255.255.255.255'),
  no('documentation range', 'http://192.0.2.5/', '192.0.2.5'),

  // IPv6.
  no('IPv6 loopback', 'http://[::1]:8080/', '::1'),
  no('IPv6 loopback written out', 'http://[0:0:0:0:0:0:0:1]/', '::1'),
  no('IPv6 unspecified', 'http://[::]/', '::'),
  no('unique-local', 'http://[fc00::1]/', 'fc00::1'),
  no('link-local IPv6', 'http://[fe80::1]/', 'fe80::1'),
  no('multicast IPv6', 'http://[ff02::1]/', 'ff02::1'),
  no('v4-mapped private, dotted form', 'http://[::FFFF:192.168.1.1]/', '::ffff:c0a8:101'),
  no('v4-mapped private, hex form', 'http://[::ffff:c0a8:101]/', '::ffff:c0a8:101'),
  no('v4-mapped loopback, dotted form', 'http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'),
  no('v4-mapped loopback, hex form', 'http://[::ffff:7f00:1]/', '::ffff:7f00:1'),
  no('NAT64 private IPv4', 'http://[64:ff9b::10.0.0.1]/', '64:ff9b::a00:1'),
  no('6to4 private IPv4', 'http://[2002:c0a8:101::1]/', '2002:c0a8:101::1'),

  // The profile's blocklist.
  { note: 'blocked host', input: 'https://ads.test/', site: 'ads.test', denied: true, blockedHosts: ['ads.test'] },
  { note: 'subdomain of a blocked host', input: 'https://x.y.ads.test/', site: 'x.y.ads.test', denied: true, blockedHosts: ['ads.test'] },
  { note: 'lookalike of a blocked host', input: 'https://badads.test/', site: 'badads.test', denied: false, blockedHosts: ['ads.test'] },
  { note: 'blocked host, entry in odd case with a trailing dot', input: 'https://tracker.example/', site: 'tracker.example', denied: true, blockedHosts: ['Tracker.Example.'] },
  { note: 'blocked IP, entry in hex', input: 'http://8.8.8.8/', site: '8.8.8.8', denied: true, blockedHosts: ['0x8.8.8.8'] },
  { note: 'another site is not blocked', input: 'https://example.com/', site: 'example.com', denied: false, blockedHosts: ['ads.test'] },

  // The tests-only loopback escape: 127.0.0.1 on a listed port, nothing else.
  { note: 'loopback on a listed port', input: 'http://127.0.0.1:4766/', site: '127.0.0.1', denied: false, allowLoopbackPorts: [4766] },
  { note: 'loopback spelled as a number on a listed port', input: 'http://2130706433:4766/', site: '127.0.0.1', denied: false, allowLoopbackPorts: [4766] },
  { note: 'loopback on another port', input: 'http://127.0.0.1:4747/', site: '127.0.0.1', denied: true, allowLoopbackPorts: [4766] },
  { note: 'loopback on the default port', input: 'http://127.0.0.1/', site: '127.0.0.1', denied: true, allowLoopbackPorts: [4766] },
  { note: 'localhost is never let through', input: 'http://localhost:4766/', site: 'localhost', denied: true, allowLoopbackPorts: [4766] },
  { note: 'other loopback addresses are never let through', input: 'http://127.0.0.2:4766/', site: '127.0.0.2', denied: true, allowLoopbackPorts: [4766] },
  { note: 'private addresses are never let through', input: 'http://192.168.1.1:4766/', site: '192.168.1.1', denied: true, allowLoopbackPorts: [4766] },
  { note: 'a blocked loopback stays blocked', input: 'http://127.0.0.1:4766/', site: '127.0.0.1', denied: true, blockedHosts: ['127.0.0.1'], allowLoopbackPorts: [4766] },

  // Refused, not repaired: parsers could read these differently.
  refused('userinfo', 'http://good@evil.example/'),
  refused('empty userinfo', 'http://@evil.example/'),
  refused('userinfo with a password', 'http://user:pw@evil.example/'),
  refused('userinfo hiding a loopback host', 'http://evil.example@127.0.0.1/'),
  refused('userinfo hiding a public host behind a private one', 'http://127.0.0.1@8.8.8.8/'),
  refused('backslash before the userinfo', 'http://127.0.0.1\\@evil.example/'),
  refused('backslash after the host', 'http://evil.example\\@good.example/'),
  refused('backslash in the path', 'http://example.com/a\\b'),
  refused('space in the host', 'http://exa mple.com/'),
  refused('leading space', ' http://example.com/'),
  refused('trailing space', 'http://example.com/ '),
  refused('tab', 'http://exam\tple.com/'),
  refused('newline', 'http://example.com/\n'),
  refused('carriage return', 'http://example.com\r/'),
  refused('NUL', 'http://exam\u0000ple.com/'),
  refused('no-break space', 'http://example.com/\u00a0'),
  refused('line separator', 'http://example.com/\u2028'),
  refused('file scheme', 'file:///etc/passwd'),
  refused('ftp scheme', 'ftp://example.com/'),
  refused('websocket scheme', 'ws://example.com/'),
  refused('javascript scheme', 'javascript:alert(1)'),
  refused('data scheme', 'data:text/html,hi'),
  refused('chrome scheme', 'chrome://settings'),
  refused('no scheme', 'example.com'),
  refused('not an address', 'not a url'),
  refused('empty', ''),
  refused('no host', 'http://'),
  refused('no host, slashes', 'http:///'),
  refused('only a dot', 'http://./'),
  refused('two trailing dots', 'http://example.com../'),
];
