/**
 * A paired machine (v2 spec §3). Stored on each side after pairing; never
 * synced. The token this machine issued to it is kept only as a hash, and
 * the token it issued to us lives in the `SecretStore` under `heldTokenRef`.
 */
export interface Peer {
  nodeId: string;
  name: string;
  /** SHA-256 of its certificate (lowercase hex): its identity. Every connection pins it. */
  fingerprint: string;
  /** `host:port` addresses to reach its peer listener, tried in order; the last one that worked is moved first. */
  addresses: string[];
  /** SHA-256 (hex) of the bearer token we issued it. */
  issuedTokenHash: string;
  /** `SecretStore` reference of the bearer token it issued us. */
  heldTokenRef: string;
  /** Its `process.platform`, from pairing; informs path handling and the UI. */
  platform: string;
  lastSeenAt: number | null;
  /** Our sync cursor into its change log (Task 50). */
  lastSyncSeq: number;
  pairedAt: number;
}

/** A peer as the local API shows it: never its tokens. */
export type PublicPeer = Omit<Peer, 'issuedTokenHash' | 'heldTokenRef'>;

/** What a machine says about itself on the peer listener (`GET /peer/info`). */
export interface PeerInfo {
  nodeId: string;
  name: string;
  protocolVersion: number;
  schemaVersion: number;
  platform: string;
  /** The OtherBench build it runs (`0.2.0-beta.7`); absent from builds before the updater. */
  appVersion?: string;
}
