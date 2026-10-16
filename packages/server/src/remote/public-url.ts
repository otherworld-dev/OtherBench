import { InsecurePublicUrlError } from './errors.js';

export interface PublicUrl {
  /** `https://host[:port]`, lower case, no default port: what a browser sends as `Origin`. */
  origin: string;
  /** `new URL(u).host`: what a browser sends as `Host` (`:443` dropped, IPv6 in brackets). */
  host: string;
  /** The name or IP alone, without brackets: what the certificate must cover. */
  hostname: string;
}

/**
 * One `--public-url`: what a browser types to reach OtherBench. https only, with
 * no path, query, fragment or user name (spec, "Turning sign-in on").
 */
export function parsePublicUrl(raw: string): PublicUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InsecurePublicUrlError(raw);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) {
    throw new InsecurePublicUrlError(raw);
  }
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return { origin: url.origin, host: url.host, hostname };
}
