import type { Connection, ConnectionKind } from '../types/config.js';

/**
 * Where a connection can be used (v2 spec §5). A cloud API works from any
 * machine; one at a loopback address (Ollama on the PC, say) only works on
 * the machine it runs on.
 */

/** Where a kind with no base URL connects by default. */
const DEFAULT_LOCAL_KINDS: ReadonlySet<ConnectionKind> = new Set(['ollama']);

/** True for a URL whose host is this machine: `localhost`, `127.x.x.x` or `[::1]`. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The availability a new or re-pointed connection gets when none is given: this machine for a loopback one, else anywhere. */
export function defaultAvailability(kind: ConnectionKind, baseUrl: string | null, selfNodeId: string): string {
  if (baseUrl ? isLoopbackUrl(baseUrl) : DEFAULT_LOCAL_KINDS.has(kind)) return selfNodeId;
  return 'anywhere';
}

/** Whether a connection can be used on `nodeId`. */
export function availableOn(connection: Pick<Connection, 'availability'>, nodeId: string): boolean {
  const availability = connection.availability ?? 'anywhere';
  return availability === 'anywhere' || availability === nodeId;
}
