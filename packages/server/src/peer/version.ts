import type { PeerInfo } from '@otherbench/core/types/peer.js';
import { PeerError } from './peer-error.js';

/**
 * Paired machines must run the same version of OtherBench to do anything together (the owner's rule: every machine
 * on the latest). "The same version" is the peer protocol and the database schema, as sync has always compared:
 * the two numbers that say whether the machines mean the same thing by a call and by a row. The app version is told
 * for the message only. Requiring it to match would lock out a pair that agrees on both numbers, which is every day
 * for a dev machine on a local build (`0.2.0-alpha.local.<stamp>`) beside one on a beta (`0.2.0-beta.<n>`). So a
 * change to what machines say to each other must bump `PEER_PROTOCOL_VERSION` (core/domain/pairing.ts).
 *
 * Checked on both sides. The caller refuses before it sends (`PeerService.call`, `checkVersion`), from what the
 * other machine last said of itself (the hello of its `/peer/events` stream, heard again on every reconnect, and
 * each sync's `/peer/info`): no round trip per call. The listener refuses a caller whose versions, sent as headers
 * on every call, differ from its own (`peer/app.ts`); a caller that sends none is an older build, and differs.
 *
 * What still passes between mismatched machines, and why (`versionExempt`):
 * - `GET /peer/info`, `GET /peer/events`: how each finds out the other's version, that it is reachable, and which
 *   chats it is replying in or controls the computer for (ids only), which is where a Stop is sent.
 * - `POST /peer/pair`, `POST /peer/revoke`: pairing (a stranger's call, checked by its code) and unpairing.
 * - Every Stop: a reply, a chat's replies, its chat sends, a background task, computer use. Stop is always allowed
 *   (docs/HANDOVER.md), and starts nothing.
 */

/** Sync was refused because the two machines run different versions; kept until a pull succeeds. */
export interface VersionMismatch {
  peerAppVersion: string | null;
  peerSchemaVersion: number;
  peerProtocolVersion: number;
  /** The peer is ahead, so updating this machine is what fixes it (the desktop app then checks for an update). */
  thisMachineOlder: boolean;
  at: number;
}

/** The headers every call to a peer carries: this machine's versions, for the listener's check. */
export const PROTOCOL_HEADER = 'x-otherbench-protocol';
export const SCHEMA_HEADER = 'x-otherbench-schema';
export const APP_HEADER = 'x-otherbench-app';

export function versionHeaders(self: PeerInfo): Record<string, string> {
  return { [PROTOCOL_HEADER]: String(self.protocolVersion), [SCHEMA_HEADER]: String(self.schemaVersion), ...(self.appVersion ? { [APP_HEADER]: self.appVersion } : {}) };
}

/** What a machine said its versions are, as far as it said: both numbers whole, else null (an older build, or noise). */
export interface PeerVersions {
  protocolVersion: number;
  schemaVersion: number;
  appVersion: string | null;
}

const MAX_APP_VERSION = 64;

export function peerVersionsOf(said: unknown): PeerVersions | null {
  if (typeof said !== 'object' || said === null) return null;
  const { protocolVersion, schemaVersion, appVersion } = said as Record<string, unknown>;
  if (!Number.isInteger(protocolVersion) || !Number.isInteger(schemaVersion)) return null;
  return { protocolVersion: protocolVersion as number, schemaVersion: schemaVersion as number, appVersion: typeof appVersion === 'string' && appVersion ? appVersion.slice(0, MAX_APP_VERSION) : null };
}

/** The versions a caller sent as headers; null when it sent none it can be held to. */
export function versionsFromHeaders(header: (name: string) => string | undefined): PeerVersions | null {
  const whole = (text: string | undefined): number | null => (text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : null);
  const protocolVersion = whole(header(PROTOCOL_HEADER));
  const schemaVersion = whole(header(SCHEMA_HEADER));
  if (protocolVersion === null || schemaVersion === null) return null;
  return peerVersionsOf({ protocolVersion, schemaVersion, appVersion: header(APP_HEADER) });
}

export interface VersionVerdict {
  /** For the person: which machine runs what, and which to update. */
  message: string;
  mismatch: VersionMismatch;
}

/**
 * Null when `peer` runs the same version as this machine; otherwise the mismatch and its message, the one sync has
 * always given. `peer` null is a machine that never said (a build from before it was asked): older, by definition.
 */
export function compareVersions(self: PeerInfo, peerName: string, peer: PeerVersions | null, now: number): VersionVerdict | null {
  if (peer === null) {
    return {
      message: `${peerName} runs a different version of OtherBench (an older one that doesn't say which; this machine ${self.appVersion ?? `protocol ${self.protocolVersion}, schema ${self.schemaVersion}`}). Update ${peerName} to sync.`,
      mismatch: { peerAppVersion: null, peerSchemaVersion: 0, peerProtocolVersion: 0, thisMachineOlder: false, at: now },
    };
  }
  if (peer.protocolVersion === self.protocolVersion && peer.schemaVersion === self.schemaVersion) return null;
  const peerOlder = peer.schemaVersion < self.schemaVersion || peer.protocolVersion < self.protocolVersion;
  const older = peerOlder ? peerName : self.name;
  const versions =
    peer.appVersion && self.appVersion
      ? `${peer.appVersion}; this machine ${self.appVersion}`
      : `protocol ${peer.protocolVersion}, schema ${peer.schemaVersion}; this machine ${self.protocolVersion}, ${self.schemaVersion}`;
  return {
    message: `${peerName} runs a different version of OtherBench (${versions}). Update ${older} to sync.`,
    mismatch: { peerAppVersion: peer.appVersion, peerSchemaVersion: peer.schemaVersion, peerProtocolVersion: peer.protocolVersion, thisMachineOlder: !peerOlder, at: now },
  };
}

/** What a refusal for the version is called, on the wire between machines and in this machine's answers to its UI. */
export const VERSION_MISMATCH_KIND = 'peer_version_mismatch';

/** A call to or from a paired machine refused because the two run different versions. */
export class PeerVersionError extends PeerError {
  readonly kind = VERSION_MISMATCH_KIND;

  constructor(
    readonly nodeId: string,
    readonly verdict: VersionVerdict
  ) {
    super(verdict.message, 409);
    this.name = 'PeerVersionError';
  }

  /** The answer this machine's own UI gets: the message, and which machine to update. */
  body(): { error: string; kind: string; nodeId: string; thisMachineOlder: boolean } {
    return { error: this.message, kind: this.kind, nodeId: this.nodeId, thisMachineOlder: this.verdict.mismatch.thisMachineOlder };
  }
}

/** The Stops among the forwarded API's routes (forward.ts `forwardedApi`): each ends something and starts nothing. */
const STOPS: readonly RegExp[] = [
  /^\/api\/chats\/[^/]+\/stop$/,
  /^\/api\/chats\/[^/]+\/sends\/stop$/,
  /^\/api\/chats\/[^/]+\/sends\/[^/]+\/remote-stop$/,
  /^\/api\/chats\/[^/]+\/computer\/stop$/,
  /^\/api\/chats\/[^/]+\/helpers\/[^/]+\/stop$/,
  /^\/api\/messages\/[^/]+\/cancel$/,
];

/** Whether a call on the peer listener passes whatever the two machines' versions (see the module comment). */
export function versionExempt(method: string, path: string): boolean {
  const route = path.split('?')[0]!;
  const verb = method.toUpperCase();
  if (verb === 'GET') return route === '/peer/info' || route === '/peer/events';
  if (verb !== 'POST') return false;
  return route === '/peer/pair' || route === '/peer/revoke' || STOPS.some((stop) => stop.test(route));
}
