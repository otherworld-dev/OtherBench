import type { ScheduleRunStatus } from '../domain/schedule.js';

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

/**
 * One schedule as a machine tells its paired machines, on the `schedules` announcement of `/peer/events`: what a row
 * in the Schedules view shows, and nothing else. Never the prompt, the warnings or the run in progress. A paired
 * machine can change a schedule only while the machine holding it lets it (`peerScheduleControl`), and then through
 * that machine's own schedule routes, never through this announcement.
 */
export interface PeerScheduleSummary {
  id: string;
  name: string;
  /** The rule in words (`describeRule`), as the machine that holds it says it. */
  describe: string;
  /** Its IANA zone, the one its next run is shown in. */
  timezone: string;
  enabled: boolean;
  /** Null while paused. */
  nextRunAt: number | null;
  /** Its stored rule couldn't be read there, so it never runs until it is edited there. */
  invalid: boolean;
  /** Ids only: the receiving machine names them from its own synced rows. */
  target: { kind: 'chat'; chatId: string } | { kind: 'project'; projectId: string };
  profileId: string;
  /** Its runs use Claude Code's auto mode: the schedule opts in and its profile is a Claude Code one. */
  autoMode: boolean;
  timeLimitMinutes: number | null;
  /** A run of it is being set up or written there now. */
  running: boolean;
  lastRun: { status: ScheduleRunStatus; startedAt: number; chatId: string | null } | null;
}

/** A paired machine's schedule as this machine's own UI reads it: names from this machine's synced rows, null where the row isn't here. */
export interface PeerScheduleRow extends PeerScheduleSummary {
  targetName: string | null;
  profileName: string | null;
}

/**
 * A paired machine's schedules (`GET /api/peers/schedules`). `schedules` is empty unless the machine is reachable
 * and has said what they are (`shared`): an older build never says, and an unreachable one's last list may be stale.
 */
export interface PeerSchedules {
  nodeId: string;
  name: string;
  status: 'unknown' | 'reachable' | 'unreachable';
  shared: boolean;
  /**
   * It lets paired machines run, pause, edit, delete and create its schedules (its `peerScheduleControl`), as it last
   * said. Only decides whether this machine's UI offers the buttons: the machine holding them checks its own setting
   * on every call. False while it isn't reachable or never said.
   */
  manage: boolean;
  /** The zone a schedule made there is stored in, as it says; null when it didn't say. */
  timezone: string | null;
  schedules: PeerScheduleRow[];
}

/**
 * The `schedules` announcement on `/peer/events`, whole each time: the rows, whether the sender lets paired machines
 * manage them (`peerScheduleControl`) and the zone it makes schedules in. An older build sends only `schedules`.
 */
export interface PeerSchedulesAnnouncement {
  schedules: PeerScheduleSummary[];
  manage: boolean;
  timezone: string;
}
