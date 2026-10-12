import type { RiskClass } from '../ports/tool-provider.js';

/**
 * The model's browser (spec 2026-10-12-model-browser-design): its commands,
 * and which websites it may never use. Pure (no Node imports): the broker,
 * the proxy, the server's profile validation and the web all use it.
 */

export const BROWSER_TOOL = 'browser';

export const BROWSER_COMMANDS = ['open', 'snapshot', 'click', 'type', 'select', 'press', 'scroll', 'back', 'close'] as const;
export type BrowserCommand = (typeof BROWSER_COMMANDS)[number];

/** Commands that change nothing on the page: under "ask on mutate" they need no card (by name, never by declared risk). */
export const BROWSER_READ_COMMANDS: ReadonlySet<string> = new Set<string>(['snapshot', 'scroll', 'close']);

export function isBrowserCommand(value: unknown): value is BrowserCommand {
  return typeof value === 'string' && (BROWSER_COMMANDS as readonly string[]).includes(value);
}

export function browserCommandRisk(command: BrowserCommand): RiskClass {
  return BROWSER_READ_COMMANDS.has(command) ? 'read' : 'mutate';
}

/*
 * One parser, the one Chromium uses. Every host Grunt compares (a card's site,
 * a grant, the blocklist, the private-address refusal, the proxy) comes out of
 * WHATWG `new URL()` and the single normalisation in `hostOf`: IDNA/punycode,
 * lower case, IPv4 in any spelling as a dotted quad (`2130706433`, `0x7f.1`,
 * `0177.0.0.1`), IPv6 compressed (v4-mapped as hex words), then one trailing
 * dot dropped and brackets removed. Nothing here hand-parses a host out of a
 * string, and nothing compares raw text. Input that parsers could read
 * differently (userinfo, backslashes, whitespace, control characters, other
 * schemes, empty hosts) is refused, never repaired.
 */

/** Whitespace (any Unicode kind), control characters and backslashes: refused anywhere in raw input. */
const UNSAFE_RAW = /[\s\u0000-\u001f\u007f-\u009f\\]/;

/** The canonical host of a parsed http(s) URL: brackets off, one trailing dot off. Null when nothing sensible is left. */
function hostOf(url: URL): string | null {
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  return host;
}

/**
 * A bare host (no scheme, port or path) as the broker and the proxy compare
 * it: the host Chromium would connect to for `http://<host>/`, canonical (see
 * above). Null for anything that isn't exactly a hostname or IP address:
 * whitespace, control characters, `\`, `/ ? # @`, a port, userinfo, nothing.
 * An IPv6 address may be given with or without brackets.
 */
export function normaliseHost(hostname: string): string | null {
  if (typeof hostname !== 'string' || hostname === '' || UNSAFE_RAW.test(hostname) || /[/?#@]/.test(hostname)) return null;
  const bracketed = hostname.startsWith('[') && hostname.endsWith(']');
  const authority = !bracketed && hostname.includes(':') ? `[${hostname}]` : hostname;
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return hostOf(url);
}

/**
 * The website an address is on: the canonical host of an http or https URL
 * (see above), port dropped. Null for anything else, and for an address with
 * userinfo (an `@` anywhere in the raw authority), a backslash, whitespace or
 * a control character: those are refused, not repaired.
 */
export function siteOf(raw: string): string | null {
  return parseBrowserUrl(raw)?.site ?? null;
}

function parseBrowserUrl(raw: string): { site: string; port: number } | null {
  if (typeof raw !== 'string' || raw === '' || UNSAFE_RAW.test(raw)) return null;
  // An `@` before the path: userinfo, however empty. (The scheme and slashes
  // are skipped only to find where the authority starts; the host itself
  // always comes from the parser.)
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '').split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const site = hostOf(url);
  if (site === null) return null;
  return { site, port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 };
}

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    // No leading zeros: some parsers read `0177` as octal. Fail closed.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit words, or null. Accepts `::`, an embedded IPv4 tail and a `%zone`. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let v4Tail: number[] = [];
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    if (cut < 0) return null;
    const v4 = parseIPv4(s.slice(cut + 1));
    if (!v4) return null;
    v4Tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = s.slice(0, cut + 1);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const w of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(w)) return null;
      out.push(parseInt(w, 16));
    }
    return out;
  };
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  if (!head || !rest) return null;
  const total = 8 - v4Tail.length;
  if (halves.length === 2) {
    const fill = total - head.length - rest.length;
    if (fill < 1) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...rest, ...v4Tail];
  }
  return head.length === total ? [...head, ...v4Tail] : null;
}

/**
 * True for an IPv4 dotted quad or an IPv6 address (no brackets). Strict: it
 * judges the CANONICAL host only (`normaliseHost` / `siteOf` output), where
 * every IPv4 spelling is already a dotted quad; `0x7f.1` is not a literal here.
 */
export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

/** IPv4 ranges that are not the public internet: [a, b, c, d, prefix length]. */
const V4_NOT_PUBLIC: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10], // CGNAT
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16], // link-local, cloud metadata
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // TEST-NET-1
  [192, 88, 99, 0, 24], // 6to4 relay anycast
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // TEST-NET-2
  [203, 0, 113, 0, 24], // TEST-NET-3
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, broadcast
];

function v4Int(o: readonly number[]): number {
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

function isPublicV4(o: readonly number[]): boolean {
  const ip = v4Int(o);
  for (const [a, b, c, d, prefix] of V4_NOT_PUBLIC) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((ip & mask) >>> 0) === ((v4Int([a, b, c, d]) & mask) >>> 0)) return false;
  }
  return true;
}

function v4Of(w: readonly number[], at: number): number[] {
  return [w[at]! >> 8, w[at]! & 0xff, w[at + 1]! >> 8, w[at + 1]! & 0xff];
}

function isPublicV6(w: readonly number[]): boolean {
  // ::ffff:a.b.c.d (v4-mapped): as its IPv4 address.
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isPublicV4(v4Of(w, 6));
  // 64:ff9b::a.b.c.d (NAT64): as its IPv4 address.
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return isPublicV4(v4Of(w, 6));
  // Only 2000::/3 is global unicast: this also refuses ::, ::1, ::a.b.c.d,
  // 100::/64, 64:ff9b:1::/48, fc00::/7, fe80::/10, fec0::/10 and ff00::/8.
  if ((w[0]! & 0xe000) !== 0x2000) return false;
  if (w[0] === 0x2001 && w[1]! < 0x0200) return false; // 2001::/23 IETF assignments (Teredo, ORCHID, ...)
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false; // documentation
  if (w[0] === 0x3fff && w[1]! < 0x1000) return false; // documentation (RFC 9637)
  if (w[0] === 0x2002) return isPublicV4(v4Of(w, 1)); // 6to4: as its IPv4 address
  return true;
}

/** True only for an address on the public internet. Anything that isn't an address at all is false (fail closed). */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicV4(v4);
  const v6 = parseIPv6(ip);
  return v6 ? isPublicV6(v6) : false;
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/** `localhost` and the local-network suffixes (and those suffixes on their own). */
export function isLocalName(host: string): boolean {
  const h = normaliseHost(host);
  if (h === null) return false;
  return h === 'localhost' || LOCAL_SUFFIXES.some((suffix) => h === suffix.slice(1) || h.endsWith(suffix));
}

export interface HostCheckOptions {
  /** Tests only (`GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS`): 127.0.0.1 is allowed on these ports. */
  allowLoopbackPorts?: readonly number[];
  /** The port being reached, when known: the proxy knows it, the broker doesn't. */
  port?: number;
}

/**
 * Why the browser may not use `host`, or null when it may. Used by the broker
 * (before any card) and by the proxy (for every connection the page makes).
 */
export function browserHostDenial(
  host: string | null | undefined,
  policy: { browserBlockedHosts?: readonly string[] },
  opts: HostCheckOptions = {}
): string | null {
  const h = typeof host === 'string' ? normaliseHost(host) : null;
  if (h === null) return "Grunt couldn't tell which website this is for.";
  for (const entry of policy.browserBlockedHosts ?? []) {
    const blocked = normaliseHost(entry);
    if (blocked !== null && (h === blocked || h.endsWith(`.${blocked}`))) return `${h} is blocked for this profile.`;
  }
  if (isIpLiteral(h)) {
    if (h === '127.0.0.1' && loopbackEscape(opts)) return null;
    return isPublicAddress(h) ? null : `${h} is a local or private address. The model's browser can't reach it.`;
  }
  if (isLocalName(h)) return `${h} is a local network name. The model's browser can't reach it.`;
  return null;
}

/**
 * The whole judgement of one address: its site (`siteOf`), the port it is on
 * (80 or 443 when the address names none), and why it is refused (null when
 * it may be used). An address with no usable site is refused. The proxy and
 * the shared test vectors (`testing/browser-host-vectors.ts`) go through
 * this, so a card, a grant and a connection can never disagree about a host.
 */
export function browserUrlCheck(
  raw: string,
  policy: { browserBlockedHosts?: readonly string[] },
  opts: Omit<HostCheckOptions, 'port'> = {}
): { site: string | null; port: number | null; denial: string | null } {
  const parsed = parseBrowserUrl(raw);
  if (!parsed) return { site: null, port: null, denial: browserHostDenial(null, policy, opts) };
  return { site: parsed.site, port: parsed.port, denial: browserHostDenial(parsed.site, policy, { ...opts, port: parsed.port }) };
}

function loopbackEscape(opts: HostCheckOptions): boolean {
  const ports = opts.allowLoopbackPorts ?? [];
  if (ports.length === 0) return false;
  return opts.port === undefined || ports.includes(opts.port);
}
