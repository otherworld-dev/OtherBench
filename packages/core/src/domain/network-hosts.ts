/**
 * Host names as the `sandbox_network` card and its grants see them
 * (spec 2026-10-12-sandbox-design). Pure, and browser-safe: the web UI
 * imports permissions.ts, so this uses `URL` and nothing from Node.
 *
 * One canonical spelling per host is what makes a host grant mean what the
 * card said: without it `PyPI.org.`, `pypi.org` and the Unicode and punycode
 * forms of an IDN are different strings, and `0x7f.1` slips past a check for
 * `127.0.0.1`.
 *
 * The spelling, the IPv4 ranges and the local-name suffixes are the browser's
 * (browser-hosts.ts): one implementation, so a sandbox card and a browser
 * card can't read the same host two ways. What the sandbox adds on top is
 * narrower, never wider; `testing/shared-host-vectors.ts` pins each difference.
 */
import { hasLocalSuffix, isPublicAddress, normaliseHost } from './browser-hosts.js';

/**
 * Characters that make a "host" more than a host name: a path, query,
 * credentials, port, percent-escape or whitespace. `URL` would quietly drop or
 * decode these (`evil.com@pypi.org` has hostname `pypi.org`), so the raw
 * string is refused instead. Brackets are refused too: an IPv6 literal has no
 * canonical form here (see `canonicalHost`).
 */
const NOT_A_HOST = /[\s\u0000-\u001f\u007f/\\?#@:%[\]]/;

/** One label of a host name pattern: letters, digits and hyphens, not starting or ending with a hyphen. */
const HOST_PATTERN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Why `entry` (already trimmed and lower-cased) isn't an allowlist entry the
 * sandbox takes: `pypi.org`, `*.example.com`, optionally `:port`; no IP
 * literals (v4 or v6, bracketed or not, with or without a port), no
 * `localhost` or `*.localhost`. Null when it is fine. The profile routes
 * refuse a bad entry with this; the sandbox drops one again before every run,
 * since a profile synced from a peer never went through the routes, and the
 * runtime lets an allowlisted IP literal through without its own checks on
 * where a name resolves.
 */
export function sandboxHostProblem(entry: string): string | null {
  if (entry.length > 253) return 'is longer than 253 characters';
  let host = entry;
  const withPort = /^(.*):(\d{1,5})$/.exec(entry);
  if (withPort) {
    const port = Number(withPort[2]);
    if (port < 1 || port > 65535 || withPort[2]!.startsWith('0')) return 'has a port outside 1-65535';
    host = withPort[1]!;
  }
  if (host.includes('[') || host.includes(':')) return 'is an IP address; name the host instead';
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  const labels = bare.split('.');
  if (labels.every((l) => /^\d+$/.test(l))) return 'is an IP address; name the host instead';
  if (labels[labels.length - 1] === 'localhost') return 'is this machine, which the sandbox never reaches';
  if (labels.length < 2) return 'must be a full host name like pypi.org';
  if (!labels.every((l) => HOST_PATTERN_LABEL.test(l))) return "isn't a host name pattern (letters, digits, hyphens and dots, optionally starting with *.)";
  return null;
}

/** Dot-separated labels of `[a-z0-9-]`, none empty: what `URL` leaves for a valid ASCII or punycode name or an IPv4 address. */
const HOST_LABELS = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/**
 * The canonical form of a host name, or `null` when `raw` isn't one.
 *
 * The spelling is `normaliseHost`'s (browser-hosts.ts), the one the browser's
 * cards and grants use, so a host has one canonical form in Grunt. `URL` does
 * the work there: IDNA (Unicode to punycode), lowercasing, and IPv4
 * normalisation (`0x7f.1` and `2130706433` both become `127.0.0.1`). One
 * trailing dot is dropped (`pypi.org.` is `pypi.org`).
 *
 * The sandbox takes fewer hosts than the browser, and this is where. Anything
 * that isn't a plain host name is `null`: a non-string, an empty string, a
 * string with a path, port, credentials, percent-escape or spaces, a name over
 * 253 characters, a name with a character outside `[a-z0-9.-]` once canonical
 * (an underscore), and any IPv6 literal (`[::1]`), which the sandbox reaches
 * by name only.
 */
export function canonicalHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || NOT_A_HOST.test(raw)) return null;
  const host = normaliseHost(raw);
  if (host === null || host.length > 253 || !HOST_LABELS.test(host)) return null;
  return host;
}

/** Four dot-separated numbers: an IPv4 address, or something that only looks like one. */
const LOOKS_LIKE_IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Whether a CANONICAL host (from `canonicalHost`) is this machine or a private
 * network, judged by its spelling alone:
 *
 *   - an IPv4 address that isn't on the public internet (`isPublicAddress`,
 *     the browser's table: this machine, the LAN, link-local and cloud
 *     metadata, CGNAT, multicast, the reserved class E block with the
 *     broadcast address, and the ranges set aside for benchmarking,
 *     documentation and protocol assignments; the integer, hex and octal forms
 *     are already dotted quads by now). Four numbers `isPublicAddress` can't
 *     read as an address count as private (fail closed);
 *   - `localhost` and the names that only resolve on a private network
 *     (`hasLocalSuffix`: `*.internal`, `*.local`, `*.home.arpa`, `*.lan`, ...);
 *   - any name with no dot at all (`router`, `nas`: a search-domain name,
 *     never a public one). This one is the sandbox's own rule. The browser
 *     lets such a name through to its card, because its proxy resolves every
 *     name itself and refuses a non-public address there.
 *
 * IPv6 literals never get this far: `canonicalHost` refuses them all.
 *
 * A public-looking name can still resolve to a private address (DNS rebinding
 * included). The sandbox agent checks the addresses a name resolves to, and the
 * sandbox runtime refuses them again at connect time; this is the early refusal.
 */
export function isLocalOrPrivateHost(host: string): boolean {
  if (!host.includes('.')) return true;
  if (hasLocalSuffix(host)) return true;
  return LOOKS_LIKE_IPV4.test(host) && !isPublicAddress(host);
}
