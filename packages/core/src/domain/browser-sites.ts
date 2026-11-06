import { hasLocalSuffix, isIpLiteral, normaliseHost } from './browser-hosts.js';

/**
 * A profile's browser site list: websites its chats' browser may use without
 * a card (`Profile.browserAllowedSites`). Pure (no Node imports): the broker,
 * the profiles route and the web all use it.
 *
 * An entry is a host name, `example.com`, which matches that host only, or
 * `*.example.com`, which matches every subdomain of it at any depth
 * (`a.example.com`, `a.b.example.com`) but NOT `example.com` itself: list
 * both to allow both. That is how a wildcard reads in a TLS certificate and in
 * the sandbox's host list, so one pattern means one thing across OtherBench.
 *
 * The spelling is `normaliseHost`'s, the one the broker, the grants and the
 * proxy compare (lower case, punycode, no trailing dot). An entry is refused,
 * never repaired, when it carries a scheme, path, query, port, userinfo or
 * any `*` but a leading `*.`, when it is an IP address, `localhost` or a local
 * network name, a bare top-level domain, or a public suffix (see
 * `isPublicSuffix`).
 *
 * The list only ever skips the card. It is consulted after the broker's own
 * refusals (the blocked sites, local names and private addresses), and the
 * proxy never reads it, so a listed name that resolves to this machine or the
 * LAN is still refused when the page connects.
 */

/** The most entries a profile's site list may hold, as for the blocked sites. */
export const MAX_BROWSER_ALLOWED_SITES = 200;

/** One label of a host name: letters and digits in any script (an IDN), and inner hyphens. */
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`;
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, 'u');

/**
 * Second-level labels that country-code domains hand out as public registries
 * (`co.uk`, `com.au`, `ac.jp`, `or.kr`, `gob.mx`): with a two-letter last
 * label, a base such as `co.uk` is treated as a public suffix. Deliberately
 * broad: refusing a real site here only means listing its exact hosts instead.
 */
const REGISTRY_SECOND_LEVEL: ReadonlySet<string> = new Set([
  'ac', 'co', 'com', 'edu', 'gob', 'go', 'gov', 'govt', 'gv', 'ltd', 'mil', 'mod', 'ne', 'net', 'nhs', 'nic', 'nom', 'or', 'org', 'plc', 'police', 'sch',
]);

/**
 * Multi-part public suffixes the rule above doesn't catch: hosting platforms
 * where every subdomain belongs to someone else (`*.github.io` would be every
 * GitHub Pages site), and a few registries of other shapes. Not the whole
 * Public Suffix List: OtherBench ships none (`tldts` is in node_modules only as
 * a test dependency of jsdom), so this is a short list of the common ones.
 */
const KNOWN_MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  // Hosting platforms (the list's private section).
  'amazonaws.com', 'appspot.com', 'azurewebsites.net', 'blogspot.com', 'cloudfront.net', 'duckdns.org', 'firebaseapp.com', 'fly.dev',
  'github.io', 'githubusercontent.com', 'gitlab.io', 'glitch.me', 'herokuapp.com', 'netlify.app', 'ngrok.io', 'ngrok-free.app', 'onrender.com',
  'pages.dev', 'r2.dev', 's3.amazonaws.com', 'trycloudflare.com', 'vercel.app', 'web.app', 'workers.dev',
  // Registries outside the two-letter country pattern.
  'eu.com', 'uk.com', 'us.com', 'co.com', 'uk.net', 'gb.net', 'eu.org', 'us.org',
]);

/**
 * Whether a canonical base (`example.com`, the part after `*.`) is a public
 * suffix, so a pattern on it would cover sites that belong to strangers. With
 * no list shipped, the rule is: no dot at all (a top-level domain such as
 * `com`), a registry second level under a two-letter country code (`co.uk`,
 * `com.au`), or one of `KNOWN_MULTI_PART_SUFFIXES`. A suffix this misses
 * (`*.k12.ca.us`) is allowed through; the entry still only skips the card for
 * the sites it names, and the proxy's rules still hold.
 */
export function isPublicSuffix(base: string): boolean {
  const labels = base.split('.');
  if (labels.length < 2) return true;
  if (KNOWN_MULTI_PART_SUFFIXES.has(base)) return true;
  if (labels.length === 2) {
    const [second, top] = labels as [string, string];
    if (/^[a-z]{2}$/.test(top) && REGISTRY_SECOND_LEVEL.has(second)) return true;
  }
  return false;
}

export type AllowedSiteResult = { ok: true; site: string } | { ok: false; problem: string };

/**
 * One entry of a profile's site list as typed (trimmed here), in its canonical
 * form, or why it can't be listed. The problem completes a sentence about the
 * entry: `"https://x.com" ${problem}`.
 */
export function parseAllowedSite(raw: string): AllowedSiteResult {
  const no = (problem: string): AllowedSiteResult => ({ ok: false, problem });
  if (typeof raw !== 'string') return no("isn't a website name");
  const entry = raw.trim();
  if (entry === '') return no('is empty');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) return no('has a scheme; leave out http:// or https:// and give the name alone, like example.com');
  if (/[/?#]/.test(entry)) return no('has a path; give the name alone, like example.com');
  if (entry.includes('@')) return no('has a user name in it; give the name alone, like example.com');
  const wildcard = entry.startsWith('*.');
  // One trailing dot is the same name (`example.com.`), as normaliseHost reads it.
  const rest = (wildcard ? entry.slice(2) : entry).replace(/(?<=[^.])\.$/, '');
  if (rest.includes('*')) return no('has a * somewhere other than a leading *. (use *.example.com for the subdomains of example.com)');
  // Two colons or a bracket can only be an IPv6 address; one colon, a port.
  const colons = rest.split(':').length - 1;
  if (rest.startsWith('[') || colons > 1) return no('is an IP address; the list takes website names only');
  if (colons === 1) return no('has a port; give the name alone, like example.com');
  if (!HOSTNAME.test(rest)) return no("isn't a website name; use a name like example.com or *.example.com");
  const base = normaliseHost(rest);
  if (base === null) return no("isn't a website name; use a name like example.com or *.example.com");
  if (base.length > 253) return no('is longer than 253 characters');
  if (isIpLiteral(base)) return no('is an IP address; the list takes website names only');
  if (hasLocalSuffix(base)) return no('is this machine or a local network name, which the browser never reaches');
  if (!base.includes('.')) return no(wildcard ? 'covers a whole top-level domain' : 'is a top-level domain or a local name, not a website');
  if (isPublicSuffix(base)) return no(wildcard ? 'covers a public suffix, so it would allow sites that belong to anyone' : 'is a public suffix, not a website');
  return { ok: true, site: wildcard ? `*.${base}` : base };
}

/**
 * A whole site list as the profiles route takes it: every entry canonical,
 * duplicates dropped, order kept. The first bad entry is returned with its
 * problem, as typed, so the editor can say which line is wrong.
 */
export function parseAllowedSites(value: readonly string[]): { ok: true; sites: string[] } | { ok: false; entry: string; problem: string } {
  const sites: string[] = [];
  for (const raw of value) {
    const parsed = parseAllowedSite(raw);
    if (!parsed.ok) return { ok: false, entry: raw, problem: parsed.problem };
    if (!sites.includes(parsed.site)) sites.push(parsed.site);
  }
  return { ok: true, sites };
}

/**
 * The entry of `sites` that covers `host`, or null. Every entry is parsed
 * again here, so one that never went through the route (a profile synced from
 * a paired machine, a hand-edited row) matches only if it is valid now: an
 * IP address or `localhost` on the list matches nothing. `host` is compared in
 * its canonical spelling, and a host that is an IP address or a local name is
 * never covered, whatever the list holds.
 */
export function siteListEntryFor(host: string | null | undefined, sites: unknown): string | null {
  if (typeof host !== 'string' || !Array.isArray(sites)) return null;
  const h = normaliseHost(host);
  if (h === null || isIpLiteral(h) || !h.includes('.') || hasLocalSuffix(h)) return null;
  for (const raw of sites) {
    if (typeof raw !== 'string') continue;
    const parsed = parseAllowedSite(raw);
    if (!parsed.ok) continue;
    const site = parsed.site;
    if (site.startsWith('*.') ? h.endsWith(site.slice(1)) : h === site) return site;
  }
  return null;
}
