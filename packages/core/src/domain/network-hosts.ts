/**
 * Host names as the `sandbox_network` card and its grants see them
 * (spec 2026-10-12-sandbox-design). Pure, and browser-safe: the web UI
 * imports permissions.ts, so this uses `URL` and nothing from Node.
 *
 * One canonical spelling per host is what makes a host grant mean what the
 * card said: without it `PyPI.org.`, `pypi.org` and the Unicode and punycode
 * forms of an IDN are different strings, and `0x7f.1` slips past a check for
 * `127.0.0.1`.
 */

/**
 * Characters that make a "host" more than a host name: a path, query,
 * credentials, port, percent-escape or whitespace. `URL` would quietly drop or
 * decode these (`evil.com@pypi.org` has hostname `pypi.org`), so the raw
 * string is refused instead. Brackets are refused too: an IPv6 literal has no
 * canonical form here (see `canonicalHost`).
 */
const NOT_A_HOST = /[\s\u0000-\u001f\u007f/\\?#@:%[\]]/;

/** Dot-separated labels of `[a-z0-9-]`, none empty: what `URL` leaves for a valid ASCII or punycode name or an IPv4 address. */
const HOST_LABELS = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/**
 * The canonical form of a host name, or `null` when `raw` isn't one.
 *
 * `URL` does the work: IDNA (Unicode to punycode), lowercasing, and IPv4
 * normalisation (`0x7f.1` and `2130706433` both become `127.0.0.1`). One
 * trailing dot is dropped (`pypi.org.` is `pypi.org`). Anything that isn't a
 * plain host name is `null`: a non-string, an empty string, a string with a
 * path, port, credentials or spaces, and any IPv6 literal (`[::1]`), which the
 * sandbox reaches by name only.
 */
export function canonicalHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || NOT_A_HOST.test(raw)) return null;
  let host: string;
  try {
    host = new URL(`http://${raw}`).hostname;
  } catch {
    return null;
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length > 253 || !HOST_LABELS.test(host)) return null;
  return host;
}

/**
 * IPv4 ranges a sandboxed command must never be let at: this machine, the LAN,
 * link-local (cloud metadata), CGNAT, multicast, the reserved class E block
 * (with the broadcast address) and the ranges set aside for benchmarking,
 * documentation and protocol assignments. None of them is a public server.
 */
const PRIVATE_IPV4: ReadonlyArray<readonly [base: number, bits: number]> = [
  [ipv4(0, 0, 0, 0), 8],
  [ipv4(10, 0, 0, 0), 8],
  [ipv4(100, 64, 0, 0), 10],
  [ipv4(127, 0, 0, 0), 8],
  [ipv4(169, 254, 0, 0), 16],
  [ipv4(172, 16, 0, 0), 12],
  [ipv4(192, 0, 0, 0), 24],
  [ipv4(192, 0, 2, 0), 24],
  [ipv4(192, 168, 0, 0), 16],
  [ipv4(198, 18, 0, 0), 15],
  [ipv4(198, 51, 100, 0), 24],
  [ipv4(203, 0, 113, 0), 24],
  [ipv4(224, 0, 0, 0), 4],
  [ipv4(240, 0, 0, 0), 4],
];

/** Name suffixes that only ever mean a private network: mDNS, internal DNS, home routers, the default search domain. */
const LOCAL_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa', '.localdomain'];

function ipv4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * Whether a CANONICAL host (from `canonicalHost`) is this machine or a private
 * network, judged by its spelling alone: an IPv4 address in a private or
 * reserved range (the integer, hex and octal forms are already dotted quads by
 * now), `localhost` and the names that only resolve on a private network
 * (`*.internal`, `*.local`, `*.home.arpa`, ...), and any name with no dot at
 * all (`router`, `nas`: a search-domain name, never a public one). IPv6
 * literals never get this far: `canonicalHost` refuses them all.
 *
 * A public-looking name can still resolve to a private address (DNS rebinding
 * included). The sandbox agent checks the addresses a name resolves to, and the
 * sandbox runtime refuses them again at connect time; this is the early refusal.
 */
export function isLocalOrPrivateHost(host: string): boolean {
  if (!host.includes('.')) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) return true;
  const parts = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!parts) return false;
  const address = ipv4(Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4]));
  return PRIVATE_IPV4.some(([base, bits]) => (address >>> (32 - bits)) === (base >>> (32 - bits)));
}
