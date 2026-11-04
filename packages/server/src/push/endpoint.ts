import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isLocalNetworkName, isPublicAddress } from '@otherbench/core/domain/browser-hosts.js';

/**
 * A push endpoint is a URL the browser hands us and the server then POSTs to,
 * so it is checked like any outbound URL a client names: https only, no
 * credentials, and never this machine or a private network. Checked twice:
 * by its spelling when it is saved (`endpointProblem`), and by the addresses
 * its name resolves to when a push is sent (`publicOnlyLookup`, used as the
 * connection's own lookup, so a name that changes its answer later, DNS
 * rebinding included, still can't reach a private address).
 */

export const MAX_ENDPOINT_LENGTH = 2048;

/** Why `raw` can't be a push endpoint, or null when it can. */
export function endpointProblem(raw: string): string | null {
  if (raw.length > MAX_ENDPOINT_LENGTH) return 'The push endpoint is too long.';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'The push endpoint is not a URL.';
  }
  if (url.protocol !== 'https:') return 'The push endpoint must be https.';
  if (url.username !== '' || url.password !== '') return 'The push endpoint may not carry a user name or password.';
  // `URL` has already lowercased the name and turned every IPv4 spelling into a dotted quad; IPv6 keeps its brackets.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (host === '') return 'The push endpoint has no host.';
  if (isIP(host) !== 0) return isPublicAddress(host) ? null : 'The push endpoint is on this machine or a private network.';
  if (isLocalNetworkName(host)) return 'The push endpoint is on this machine or a private network.';
  return null;
}

type Resolve = (hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const resolveAll: Resolve = (hostname, callback) => dnsLookup(hostname, { all: true, verbatim: true }, callback);

/**
 * A `lookup` for the push request's socket that only ever hands back public
 * addresses: if any address the name resolves to is private, loopback or
 * otherwise not on the public internet, the connection fails instead. `resolve`
 * is for tests.
 */
export function publicOnlyLookup(resolve: Resolve = resolveAll): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err);
      const bad = addresses.find((a) => !isPublicAddress(a.address));
      if (addresses.length === 0 || bad) {
        const refused = Object.assign(new Error(`the push endpoint ${hostname} resolves to an address that isn't on the public internet`), { code: 'EPUSHPRIVATE' });
        return callback(refused);
      }
      if (options?.all) return callback(null, addresses);
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  }) as LookupFunction;
}

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** How a push goes out; tests hand the service a fake. Resolves with the push service's status code. */
export type PushTransport = (req: PushRequest) => Promise<{ status: number }>;

const TIMEOUT_MS = 15_000;

/**
 * POSTs a push over https with `publicOnlyLookup`, following no redirects,
 * reading at most a little of the answer. An IP-literal endpoint was judged
 * when it was saved and is judged again here.
 */
export const httpsPushTransport: PushTransport = (req) =>
  new Promise((resolve, reject) => {
    const problem = endpointProblem(req.endpoint);
    if (problem) {
      reject(new Error(problem));
      return;
    }
    const url = new URL(req.endpoint);
    const r = request(
      url,
      {
        method: 'POST',
        headers: { ...req.headers, 'Content-Length': String(req.body.length) },
        lookup: publicOnlyLookup(),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        // Only the status matters; drain at most a little so the socket can close.
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > 16 * 1024) res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    r.on('timeout', () => r.destroy(new Error('the push service did not answer in time')));
    r.on('error', reject);
    r.end(req.body);
  });
