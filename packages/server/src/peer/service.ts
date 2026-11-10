import {
  PEER_PROTOCOL_VERSION,
  digestsEqual,
  formatPairingCode,
  generatePeerToken,
  hashPeerToken,
  isPlausiblePairingCode,
  normalisePairingCode,
  pairingKey,
  pairingMac,
  shortFingerprint,
} from '@otherbench/core/domain/pairing.js';
import type { SecretStore } from '@otherbench/core/ports/secret-store.js';
import type { Store } from '@otherbench/core/ports/store.js';
import { COMPUTER_START_OUTCOMES, type ComputerSessionSummary, type ComputerStartOutcome, type ToolStateSection } from '@otherbench/core/types/events.js';
import type { Peer, PeerInfo, PeerScheduleSummary, PublicPeer } from '@otherbench/core/types/peer.js';
import { isIP } from 'node:net';
import type { Hono } from 'hono';
import type { AppEventBus } from '../stream/events.js';
import { DEFAULT_PEER_PORT, PeerClient, PeerUnreachableError, parsePeerAddress, type PeerRequest, type PeerResponse, type ResponseLimits } from './client.js';
import type { IdentityStore } from './identity.js';
import { PeerListener } from './listener.js';
import { PeerMonitor, type PeerMonitorOptions, type PeerStatus } from './monitor.js';
import { PairingSessions } from './pairing.js';
import { peerSchedulesOf } from './schedules.js';
import type { Syncer } from './syncer.js';

/** How long the machine entering a code waits for the other's answer: long enough to derive a key, too short to crack one. */
const PAIRING_RESPONSE_TIMEOUT_MS = 15_000;

/** A pairing attempt or a call to a peer that failed in a way the user should read. */
export class PeerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 502 | 503 = 400
  ) {
    super(message);
    this.name = 'PeerError';
  }
}

/** What `POST /peer/pair` carries: the initiator's side of the exchange (v2 spec §3, step 3). */
export interface PairRequest {
  nodeId: string;
  name: string;
  platform: string;
  addresses: string[];
  /** `pairingMac(code, initiatorFp, responderFpAsSeen)`. */
  mac: string;
  /** The token the initiator issues the responder. */
  token: string;
}

/** The responder's answer (step 4). */
export interface PairResponse {
  nodeId: string;
  name: string;
  platform: string;
  addresses: string[];
  /** `pairingMac(code, responderFp, initiatorFp)`. */
  mac: string;
  token: string;
}

export interface PairingView {
  /** `ABCD-EFGH`. */
  code: string;
  expiresAt: number;
  addresses: string[];
  /** This machine's short fingerprint, to compare by eye. */
  fingerprint: string;
}

export interface PeerServiceOptions {
  store: Store;
  secrets: SecretStore;
  events?: AppEventBus;
  identity: IdentityStore;
  /** Builds the peer listener's app, given this service. */
  createApp: (service: PeerService) => Hono<never>;
  port: number;
  hosts: string[];
  schemaVersion: number;
  /** This build's version, told to peers so a version mismatch can name both builds. */
  appVersion?: string;
  platform?: string;
  now?: () => number;
  /** Backoff and hooks for the peer monitor (tests shorten the backoff). */
  monitor?: Omit<PeerMonitorOptions, 'events' | 'now'>;
}

function heldTokenRef(nodeId: string): string {
  return `peer-token:${nodeId}`;
}

function toPublic({ issuedTokenHash: _issued, heldTokenRef: _held, ...peer }: Peer): PublicPeer {
  return peer;
}

/** An IPv4-mapped IPv6 address as plain IPv4. */
function plainIp(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/** At most this many addresses are kept for a paired machine: enough for the networks a laptop moves between. */
const MAX_PEER_ADDRESSES = 5;

/** At most this many of a peer's running chats are kept: far more than anyone has running at once. */
const MAX_ACTIVE_CHATS = 200;

/** A peer's list of chat ids, as far as it is one: strings only, capped. */
function chatIdsOf(ids: unknown): string[] {
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, MAX_ACTIVE_CHATS) : [];
}

/** At most this many computer-use sessions are kept for a paired machine: it holds one at a time, so more is noise. */
const MAX_COMPUTER_SESSIONS = 4;
/** The longest chat id and last-action line kept from a paired machine. */
const MAX_COMPUTER_ID = 200;
const MAX_COMPUTER_ACTION = 200;

/**
 * A peer's `computerSessions`, as far as it is one: each a chat id and, when it says, a one-line last action, both
 * strings and bounded; anything else in an entry is dropped, and so is an entry without a chat id. An older machine
 * doesn't say, which reads as none.
 */
export function computerSessionsOf(said: unknown): ComputerSessionSummary[] {
  if (!Array.isArray(said)) return [];
  const out: ComputerSessionSummary[] = [];
  for (const entry of said) {
    if (out.length >= MAX_COMPUTER_SESSIONS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { chatId, lastAction } = entry as Record<string, unknown>;
    if (typeof chatId !== 'string' || chatId === '' || chatId.length > MAX_COMPUTER_ID) continue;
    out.push(typeof lastAction === 'string' ? { chatId, lastAction: lastAction.slice(0, MAX_COMPUTER_ACTION) } : { chatId });
  }
  return out;
}

const TOOL_STATE_SECTIONS: readonly ToolStateSection[] = ['mcp', 'grants', 'audit'];

/** A peer's `tool-state` announcement, as far as it is one: a known section and a bounded chat id or null; else null. */
export function toolStateOf(said: unknown): { section: ToolStateSection; chatId: string | null } | null {
  if (typeof said !== 'object' || said === null) return null;
  const { section, chatId } = said as Record<string, unknown>;
  if (!TOOL_STATE_SECTIONS.includes(section as ToolStateSection)) return null;
  if (chatId !== null && (typeof chatId !== 'string' || chatId === '' || chatId.length > MAX_COMPUTER_ID)) return null;
  return { section: section as ToolStateSection, chatId };
}

/**
 * A peer's `computer-start` announcement, as far as it is one: a bounded chat id and one of the known outcomes; else
 * null. Anything else it carries is dropped, so a reason in that machine's words never reaches this one.
 */
export function computerStartOf(said: unknown): { chatId: string; outcome: ComputerStartOutcome } | null {
  if (typeof said !== 'object' || said === null) return null;
  const { chatId, outcome } = said as Record<string, unknown>;
  if (typeof chatId !== 'string' || chatId === '' || chatId.length > MAX_COMPUTER_ID) return null;
  if (!COMPUTER_START_OUTCOMES.includes(outcome as ComputerStartOutcome)) return null;
  return { chatId, outcome: outcome as ComputerStartOutcome };
}

/** A peer's `waitingSince`: a finite time for each of `waiting`, the chats it says wait on a card; anything else dropped. */
function waitingSinceOf(said: unknown, waiting: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof said !== 'object' || said === null || Array.isArray(said)) return out;
  for (const id of waiting) {
    const at = (said as Record<string, unknown>)[id];
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

/**
 * Machines this one is paired with, and the peer listener they reach it on
 * (v2 plan, Tasks 46-47). Owns pairing in both directions, revocation, and
 * calls to peers through the pinned client, keeping each peer's last working
 * address first.
 */
export class PeerService {
  readonly client: PeerClient;
  readonly pairing: PairingSessions;
  readonly listener: PeerListener;
  readonly monitor: PeerMonitor;
  private readonly now: () => number;
  /** Open `/peer/events` streams, by the peer reading them, so removing a peer can end its stream. */
  private readonly streams = new Map<string, Set<(event: string, data: unknown) => void>>();
  private readonly closers = new Map<string, Set<() => void>>();
  private readonly platform: string;
  /** Set while this machine is entering a code: the listener runs so the other side can be told where to reach it. */
  private pairingOut = 0;
  /** Pulls changes from peers (Task 50); attached by the container once it exists. */
  private syncer: Syncer | null = null;
  /** This machine's chats with a reply running, as told to its peers (attached by the container). */
  private runningHere: () => string[] = () => [];
  private backgroundHere: () => string[] = () => [];
  private waitingHere: () => string[] = () => [];
  private waitingSinceHere: () => Record<string, number> = () => ({});
  /** The chats controlling this computer (computer use), as told to its peers so they can show the banner and Stop it. */
  private computerHere: () => ComputerSessionSummary[] = () => [];
  /** This machine's `gh` login, as told to its peers; the overview service supplies it. */
  private githubLoginHere: () => string | null = () => null;
  /** Each peer's chats with a reply running there, as it last said. */
  private readonly activityByPeer = new Map<string, string[]>();
  /** The chats each paired machine last said have background tasks running there. */
  private readonly backgroundByPeer = new Map<string, string[]>();
  /** The chats each paired machine last said wait on an approval card or a question there. */
  private readonly waitingByPeer = new Map<string, string[]>();
  /** Since when each of those chats has waited, as each paired machine last said. */
  private readonly waitingSinceByPeer = new Map<string, Record<string, number>>();
  /** Each paired machine's `gh` login, as it last said. */
  private readonly loginByPeer = new Map<string, string | null>();
  /** The chats controlling each paired machine (computer use), as it last said. */
  private readonly computerByPeer = new Map<string, ComputerSessionSummary[]>();
  /** This machine's schedules as told to its peers (attached by the container), and the last list sent, to send only a change. */
  private schedulesHere: () => PeerScheduleSummary[] = () => [];
  private schedulesSent: string | null = null;
  /** Each paired machine's schedules, as it last said; absent until it says (an older build never does). Read-only. */
  private readonly schedulesByPeer = new Map<string, PeerScheduleSummary[]>();

  constructor(private readonly options: PeerServiceOptions) {
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.client = new PeerClient(() => options.identity.get());
    this.pairing = new PairingSessions(this.now);
    this.listener = new PeerListener(options.createApp(this), options.identity, options.port, options.hosts);
    this.monitor = new PeerMonitor(this, {
      ...options.monitor,
      ...(options.events ? { events: options.events } : {}),
      now: this.now,
      // A peer that (re)connects, or says it has changes, is pulled from.
      onConnected: (nodeId) => {
        options.monitor?.onConnected?.(nodeId);
        this.syncer?.pullSoon(nodeId);
      },
      onMessage: (nodeId, event, data) => {
        options.monitor?.onMessage?.(nodeId, event, data);
        if (event === 'changes-available') this.syncer?.pullSoon(nodeId);
        if (event === 'activity') {
          const said = data as { chatIds?: unknown; backgroundChatIds?: unknown; waitingChatIds?: unknown; waitingSince?: unknown; githubLogin?: unknown; computerSessions?: unknown } | null;
          this.activityByPeer.set(nodeId, chatIdsOf(said?.chatIds));
          // An older machine doesn't say: none in the background, as far as we know.
          this.backgroundByPeer.set(nodeId, chatIdsOf(said?.backgroundChatIds));
          const waiting = chatIdsOf(said?.waitingChatIds);
          this.waitingByPeer.set(nodeId, waiting);
          this.waitingSinceByPeer.set(nodeId, waitingSinceOf(said?.waitingSince, waiting));
          this.loginByPeer.set(nodeId, typeof said?.githubLogin === 'string' ? said.githubLogin : null);
          this.computerByPeer.set(nodeId, computerSessionsOf(said?.computerSessions));
          options.events?.emit({ type: 'peer-activity', nodeId });
        }
        if (event === 'schedules') {
          // Not a list at all: what it said before stands.
          const said = peerSchedulesOf(data);
          if (said !== null) {
            this.schedulesByPeer.set(nodeId, said);
            options.events?.emit({ type: 'peer-schedules', nodeId });
          }
        }
        if (event === 'tool-state') {
          const change = toolStateOf(data);
          if (change) options.events?.emit({ type: 'peer-tool-state', nodeId, ...change });
        }
        if (event === 'computer-start') {
          // A computer-use start this machine asked for there didn't start: shown on the chat here.
          const ended = computerStartOf(data);
          if (ended) options.events?.emit({ type: 'peer-computer-start', nodeId, ...ended });
        }
      },
    });
  }

  attachSyncer(syncer: Syncer): void {
    this.syncer = syncer;
  }

  syncerOrNull(): Syncer | null {
    return this.syncer;
  }

  /**
   * Where this machine's activity comes from: the ids of its own chats with a reply running,
   * and of those with background tasks running.
   */
  attachActivity(
    runningHere: () => string[],
    backgroundHere: () => string[] = () => [],
    waitingHere: () => string[] = () => [],
    waitingSinceHere: () => Record<string, number> = () => ({}),
    computerHere: () => ComputerSessionSummary[] = () => []
  ): void {
    this.runningHere = runningHere;
    this.backgroundHere = backgroundHere;
    this.waitingHere = waitingHere;
    this.waitingSinceHere = waitingSinceHere;
    this.computerHere = computerHere;
  }

  /** Where this machine's `gh` login comes from (the overview service); until set, none is told. */
  setGithubLogin(source: () => string | null): void {
    this.githubLoginHere = source;
  }

  /** Tells every peer this machine's activity now; call it when something it reports changes. */
  announceActivity(): void {
    this.announce('activity', this.activity());
  }

  /**
   * What this machine tells its peers, whole each time (so a missed one is made good by the next, and a stream that
   * opens gets it straight after its hello): the chats with a reply running (#790's "also active" hint), with
   * background tasks running, and waiting on a card, since when, its `gh` login, and the chats controlling this
   * computer with their last action. Only ids, times, counts and the one-line action summary: never a card's content,
   * a grant, an audit row or an MCP server. A paired machine reads those for a chat that runs here, over the peer
   * listener (`chatToolStateRoutes`), when a `tool-state` announcement says they changed.
   */
  activity(): {
    chatIds: string[];
    backgroundChatIds: string[];
    waitingChatIds: string[];
    waitingSince: Record<string, number>;
    githubLogin: string | null;
    computerSessions: ComputerSessionSummary[];
  } {
    return {
      chatIds: this.runningHere(), backgroundChatIds: this.backgroundHere(), waitingChatIds: this.waitingHere(),
      waitingSince: this.waitingSinceHere(), githubLogin: this.githubLoginHere(),
      computerSessions: this.computerHere().map((s) => (s.lastAction === undefined ? { chatId: s.chatId } : { chatId: s.chatId, lastAction: s.lastAction })),
    };
  }

  /** Where this machine's schedules come from, as its peers are told them (`ownSchedules`). */
  attachSchedules(source: () => PeerScheduleSummary[]): void {
    this.schedulesHere = source;
    this.schedulesSent = null;
  }

  /**
   * What this machine tells its peers about its schedules, whole: what each row shows, never the prompt. Sent straight
   * after a `/peer/events` stream's hello and again whenever it changes (`announceSchedulesIfChanged`), as its own
   * event rather than in `activity`, which goes out on every reply and card.
   */
  schedulesAnnouncement(): { schedules: PeerScheduleSummary[] } {
    return { schedules: this.schedulesHere() };
  }

  /** Tells every peer this machine's schedules if they differ from what it last told them. Cheap to call often. */
  announceSchedulesIfChanged(): void {
    const now = this.schedulesAnnouncement();
    const text = JSON.stringify(now);
    if (text === this.schedulesSent) return;
    this.schedulesSent = text;
    this.announce('schedules', now);
  }

  /**
   * `nodeId`'s schedules, as it last said: null while it isn't reachable (its last list may be stale) and until it
   * says (an older build never does). For showing only: nothing here can run or change one there.
   */
  schedules(nodeId: string): PeerScheduleSummary[] | null {
    return this.status(nodeId).status === 'reachable' ? (this.schedulesByPeer.get(nodeId) ?? null) : null;
  }

  /** The chats with a reply running on `nodeId`, as it last said; none while it isn't reachable. */
  activeChats(nodeId: string): string[] {
    return this.status(nodeId).status === 'reachable' ? (this.activityByPeer.get(nodeId) ?? []) : [];
  }

  /** The chats with background tasks running on `nodeId`, as it last said; none while it isn't reachable. */
  backgroundChats(nodeId: string): string[] {
    return this.status(nodeId).status === 'reachable' ? (this.backgroundByPeer.get(nodeId) ?? []) : [];
  }

  /** The chats on `nodeId` waiting on an approval card or a question, as it last said; none while it isn't reachable. */
  waitingChats(nodeId: string): string[] {
    return this.status(nodeId).status === 'reachable' ? (this.waitingByPeer.get(nodeId) ?? []) : [];
  }

  /**
   * Since when (ms, its clock) each chat in `waitingChats` has waited on a card there, as it last said: the sidebar's
   * Needs you order. Empty from an older machine, which doesn't say, and while it isn't reachable.
   */
  waitingSince(nodeId: string): Record<string, number> {
    return this.status(nodeId).status === 'reachable' ? (this.waitingSinceByPeer.get(nodeId) ?? {}) : {};
  }

  /**
   * The chats controlling `nodeId` (computer use), with their last action, as it last said; none while it isn't
   * reachable. Its banner here, and the one thing this machine may do about it: Stop (`POST /chats/:id/computer/stop`).
   */
  computerSessions(nodeId: string): ComputerSessionSummary[] {
    return this.status(nodeId).status === 'reachable' ? (this.computerByPeer.get(nodeId) ?? []) : [];
  }

  /** The `gh` login `nodeId` last said it has; null if none, unknown, or while it isn't reachable. */
  githubLogin(nodeId: string): string | null {
    return this.status(nodeId).status === 'reachable' ? (this.loginByPeer.get(nodeId) ?? null) : null;
  }

  /** The syncer, for the peer listener's sync routes. */
  requireSyncer(): Syncer {
    if (!this.syncer) throw new PeerError('Sync is not available on this machine.', 503);
    return this.syncer;
  }

  /** Starts watching every paired machine's event stream; the container calls it once it's up. */
  startMonitoring(): void {
    this.monitor.start();
  }

  peer(nodeId: string): Peer | null {
    return this.store.peers.get(nodeId);
  }

  status(nodeId: string): PeerStatus {
    return this.monitor.status(nodeId);
  }

  /**
   * Registers a peer's open `/peer/events` stream: `send` delivers an event
   * to it, `close` ends it. Returns the unregister function.
   */
  openEventStream(nodeId: string, send: (event: string, data: unknown) => void, close: () => void): () => void {
    const sends = this.streams.get(nodeId) ?? new Set();
    const closes = this.closers.get(nodeId) ?? new Set();
    sends.add(send);
    closes.add(close);
    this.streams.set(nodeId, sends);
    this.closers.set(nodeId, closes);
    return () => {
      sends.delete(send);
      closes.delete(close);
    };
  }

  /** Tells every peer listening that this machine has changes for it to pull (Task 51). */
  announce(event: string, data: unknown = {}): void {
    for (const sends of this.streams.values()) for (const send of sends) send(event, data);
  }

  /**
   * Tells only `nodeId`, on each `/peer/events` stream it holds open here, and no other paired machine: for what is
   * that machine's own business (how a computer-use start it asked for came out). Nothing is kept for a stream that
   * isn't open: a machine that has gone meanwhile isn't told.
   */
  announceTo(nodeId: string, event: string, data: unknown = {}): void {
    for (const send of this.streams.get(nodeId) ?? []) send(event, data);
  }

  private get store(): Store {
    return this.options.store;
  }

  fingerprint(): string {
    return this.options.identity.get().fingerprint;
  }

  info(): PeerInfo {
    const self = this.store.nodes.self();
    const info: PeerInfo = { nodeId: self.id, name: self.name, protocolVersion: PEER_PROTOCOL_VERSION, schemaVersion: this.options.schemaVersion, platform: this.platform };
    if (this.options.appVersion) info.appVersion = this.options.appVersion;
    return info;
  }

  list(): PublicPeer[] {
    return this.store.peers.list().map(toPublic);
  }

  /** Runs the listener while there's a peer or an open pairing code, and only then. */
  async refreshListener(): Promise<void> {
    const needed = this.store.peers.list().length > 0 || this.pairing.current() !== null || this.pairingOut > 0;
    if (needed && !this.listener.running) await this.listener.start();
    if (!needed && this.listener.running) await this.listener.stop();
  }

  // --- pairing, this machine showing the code ------------------------------

  async startPairing(): Promise<PairingView> {
    const session = this.pairing.open();
    await this.refreshListener();
    return { code: formatPairingCode(session.code), expiresAt: session.expiresAt, addresses: this.listener.addresses(), fingerprint: shortFingerprint(this.fingerprint()) };
  }

  currentPairing(): PairingView | null {
    const session = this.pairing.current();
    if (!session) return null;
    return { code: formatPairingCode(session.code), expiresAt: session.expiresAt, addresses: this.listener.addresses(), fingerprint: shortFingerprint(this.fingerprint()) };
  }

  async cancelPairing(): Promise<void> {
    this.pairing.cancel();
    await this.refreshListener();
  }

  /**
   * The responder's half (step 4): `initiatorFp` is the certificate the
   * caller presented on this very connection. The MAC proves the caller knows
   * the code AND saw this machine's real certificate.
   */
  async acceptPairing(req: PairRequest, initiatorFp: string | null, remoteAddress: string | null): Promise<PairResponse> {
    if (!initiatorFp) throw new PeerError('Pairing needs the other machine to present its certificate.', 400);
    if (typeof req.nodeId !== 'string' || typeof req.mac !== 'string' || typeof req.token !== 'string' || req.token.length < 32) {
      throw new PeerError('Malformed pairing request.', 400);
    }
    const ownFp = this.fingerprint();
    let key: Buffer | null = null;
    const result = await this.pairing.attempt(async (candidate) => {
      const derived = await pairingKey(candidate, initiatorFp, ownFp);
      const ok = digestsEqual(req.mac, pairingMac(derived, initiatorFp, ownFp));
      if (ok) key = derived;
      return ok;
    });
    if (result === 'no-session') throw new PeerError('This machine has no pairing code open.', 410);
    if (result === 'cancelled') {
      this.refreshListenerSoon();
      throw new PeerError('Wrong code too many times: pairing was cancelled on the other machine.', 403);
    }
    if (result === 'wrong-code' || key === null) throw new PeerError('Wrong code, or something between the two machines changed the connection.', 403);

    const self = this.store.nodes.self();
    if (req.nodeId === self.id) throw new PeerError('A machine cannot pair with itself.', 409);
    this.assertNoIdentityClash(req.nodeId, initiatorFp);
    const issued = generatePeerToken();
    const advertised = Array.isArray(req.addresses) ? req.addresses.filter((a): a is string => typeof a === 'string') : [];
    // Where the call came from, at the port it says it listens on.
    const port = advertised[0] ? parsePeerAddress(advertised[0]).port : null;
    const seenAt = remoteAddress && port ? [`${plainIp(remoteAddress)}:${port}`] : [];
    await this.savePeer({
      nodeId: req.nodeId,
      name: typeof req.name === 'string' && req.name.trim() ? req.name.trim() : 'Paired machine',
      fingerprint: initiatorFp,
      addresses: [...new Set([...seenAt, ...advertised])],
      issuedTokenHash: hashPeerToken(issued),
      heldTokenRef: heldTokenRef(req.nodeId),
      platform: typeof req.platform === 'string' ? req.platform : '',
      lastSeenAt: this.now(),
      lastSyncSeq: 0,
      pairedAt: this.now(),
    }, req.token);
    await this.refreshListener();
    return { nodeId: self.id, name: self.name, platform: this.platform, addresses: this.listener.addresses(), mac: pairingMac(key, ownFp, initiatorFp), token: issued };
  }

  /**
   * A machine id already paired under a different certificate, or a
   * certificate already paired as a different machine, is refused: pairing
   * again must not let a machine that knows the code take over another
   * machine's identity. The same machine and certificate pairing again just
   * replaces the old pairing.
   */
  private assertNoIdentityClash(nodeId: string, fingerprint: string): void {
    const byId = this.store.peers.get(nodeId);
    const byFp = this.store.peers.getByFingerprint(fingerprint);
    if ((byId && byId.fingerprint !== fingerprint) || (byFp && byFp.nodeId !== nodeId)) {
      const name = (byId ?? byFp)!.name;
      throw new PeerError(`This doesn't match the machine already paired as ${name}. Remove ${name} first if it really is the same machine.`, 409);
    }
  }

  // --- pairing, this machine entering the code -----------------------------

  /** The initiator's half (steps 3 and 5): connect, accepting whatever certificate is shown for this request only, and prove both sides saw the same two. */
  async pairWith(address: string, codeInput: string): Promise<PublicPeer> {
    if (!isPlausiblePairingCode(codeInput)) throw new PeerError('Enter the 8-character code shown on the other machine.', 400);
    const code = normalisePairingCode(codeInput);
    // Listening first, so the other machine is told where to reach this one.
    this.pairingOut++;
    try {
      await this.refreshListener();
      return await this.completePairing(address.trim(), code);
    } finally {
      this.pairingOut--;
      await this.refreshListener();
    }
  }

  private async completePairing(address: string, code: string): Promise<PublicPeer> {
    let conn;
    try {
      conn = await this.client.connectTo(address, null);
    } catch (err) {
      throw new PeerError(`Couldn't reach ${address}: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    const ownFp = this.fingerprint();
    const responderFp = conn.fingerprint;
    const self = this.store.nodes.self();
    const issued = generatePeerToken();
    const key = await pairingKey(code, ownFp, responderFp);
    const body: PairRequest = { nodeId: self.id, name: self.name, platform: this.platform, addresses: this.listener.addresses(), mac: pairingMac(key, ownFp, responderFp), token: issued };
    let res;
    try {
      // A short wait and a small answer: the other side only has to check a MAC.
      res = await this.client.requestOn(conn, { method: 'POST', path: '/peer/pair', body }, { timeoutMs: PAIRING_RESPONSE_TIMEOUT_MS, maxBytes: 64 * 1024 });
    } catch (err) {
      conn.socket.destroy();
      throw new PeerError(`Pairing failed: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    if (res.status !== 200) {
      const message = typeof res.body === 'object' && res.body !== null && typeof (res.body as { error?: unknown }).error === 'string' ? (res.body as { error: string }).error : `HTTP ${res.status}`;
      throw new PeerError(`Pairing failed: ${message}`, res.status === 409 ? 409 : res.status === 403 || res.status === 410 ? 403 : 502);
    }
    const answer = res.body as PairResponse;
    if (typeof answer?.mac !== 'string' || !digestsEqual(answer.mac, pairingMac(key, responderFp, ownFp))) {
      throw new PeerError("Pairing failed: the other machine's answer doesn't match. Something between the two machines may be intercepting the connection.", 403);
    }
    if (typeof answer.token !== 'string' || answer.token.length < 32 || typeof answer.nodeId !== 'string') throw new PeerError('Pairing failed: malformed answer.', 502);
    if (answer.nodeId === self.id) throw new PeerError('A machine cannot pair with itself.', 409);
    this.assertNoIdentityClash(answer.nodeId, responderFp);
    const advertised = Array.isArray(answer.addresses) ? answer.addresses.filter((a): a is string => typeof a === 'string') : [];
    const peer = await this.savePeer({
      nodeId: answer.nodeId,
      name: typeof answer.name === 'string' && answer.name.trim() ? answer.name.trim() : 'Paired machine',
      fingerprint: responderFp,
      addresses: [...new Set([address, ...advertised])],
      issuedTokenHash: hashPeerToken(issued),
      heldTokenRef: heldTokenRef(answer.nodeId),
      platform: typeof answer.platform === 'string' ? answer.platform : '',
      lastSeenAt: this.now(),
      lastSyncSeq: 0,
      pairedAt: this.now(),
    }, answer.token);
    return toPublic(peer);
  }

  /** Stores a new pairing, replacing an earlier one with the same machine and certificate (see `assertNoIdentityClash`). */
  private async savePeer(peer: Peer, heldToken: string): Promise<Peer> {
    const existing = this.store.peers.get(peer.nodeId) ?? this.store.peers.getByFingerprint(peer.fingerprint);
    if (existing) await this.forget(existing);
    await this.options.secrets.set(peer.heldTokenRef, heldToken);
    const saved = this.store.peers.create(peer);
    this.options.events?.emit({ type: 'peers-changed' });
    this.monitor.reconcile();
    return saved;
  }

  private async forget(peer: Peer): Promise<void> {
    this.store.peers.delete(peer.nodeId);
    await this.options.secrets.delete(peer.heldTokenRef);
    this.monitor.reconcile();
    for (const close of [...(this.closers.get(peer.nodeId) ?? [])]) close();
    this.streams.delete(peer.nodeId);
    this.closers.delete(peer.nodeId);
    this.activityByPeer.delete(peer.nodeId);
    this.backgroundByPeer.delete(peer.nodeId);
    this.waitingByPeer.delete(peer.nodeId);
    this.waitingSinceByPeer.delete(peer.nodeId);
    this.loginByPeer.delete(peer.nodeId);
    this.computerByPeer.delete(peer.nodeId);
    this.schedulesByPeer.delete(peer.nodeId);
  }

  // --- after pairing ---------------------------------------------------------

  rename(nodeId: string, patch: { name?: string; addresses?: string[] }): PublicPeer {
    if (!this.store.peers.get(nodeId)) throw new PeerError(`No paired machine "${nodeId}".`, 404);
    return toPublic(this.store.peers.update(nodeId, patch));
  }

  /**
   * Removes a machine here at once, then tells it to do the same if it can be
   * reached. Its token is refused from now on whether or not it heard.
   */
  async remove(nodeId: string): Promise<{ notified: boolean }> {
    const peer = this.store.peers.get(nodeId);
    if (!peer) throw new PeerError(`No paired machine "${nodeId}".`, 404);
    const token = await this.options.secrets.get(peer.heldTokenRef);
    await this.forget(peer);
    this.options.events?.emit({ type: 'peers-changed' });
    await this.refreshListener();
    if (!token) return { notified: false };
    try {
      const res = await this.client.request({ addresses: peer.addresses, fingerprint: peer.fingerprint }, { method: 'POST', path: '/peer/revoke', token });
      return { notified: res.status === 204 };
    } catch {
      return { notified: false };
    }
  }

  /** The other side removed us: forget it here too. */
  async revokedBy(peer: Peer): Promise<void> {
    await this.forget(peer);
    this.options.events?.emit({ type: 'peers-changed' });
    this.refreshListenerSoon();
  }

  /** `refreshListener` once the request being answered on the listener has gone out. */
  private refreshListenerSoon(): void {
    setTimeout(() => {
      this.refreshListener().catch((err: unknown) => console.error('[otherbench-server] peer listener refresh failed:', err));
    }, 50);
  }

  /** The peer whose certificate and token a caller presented, or null. */
  authenticate(fingerprint: string | null, token: string | null): Peer | null {
    if (!fingerprint || !token) return null;
    const peer = this.store.peers.getByFingerprint(fingerprint);
    if (!peer) return null;
    return digestsEqual(hashPeerToken(token), peer.issuedTokenHash) ? peer : null;
  }

  /**
   * A call to a paired machine: its pinned certificate, our token, its last
   * working address first. A success moves that address to the front and
   * records when the machine was last seen.
   */
  async call(nodeId: string, req: Omit<PeerRequest, 'token'>, limits: ResponseLimits = {}): Promise<PeerResponse> {
    const peer = this.store.peers.get(nodeId);
    if (!peer) throw new PeerError(`No paired machine "${nodeId}".`, 404);
    const token = await this.options.secrets.get(peer.heldTokenRef);
    if (!token) throw new PeerError(`The token for ${peer.name} is missing; pair again.`, 409);
    try {
      const res = await this.client.request({ addresses: peer.addresses, fingerprint: peer.fingerprint }, { ...req, token }, limits);
      this.noteReached(peer, res.address);
      return res;
    } catch (err) {
      if (err instanceof PeerUnreachableError) throw new PeerError(`${peer.name} isn't reachable. ${err.message}`, 503);
      throw err;
    }
  }

  /** Records a working address (moved to the front) and the time. */
  noteReached(peer: Peer, address: string): void {
    const current = this.store.peers.get(peer.nodeId);
    if (!current) return;
    this.store.peers.update(peer.nodeId, { lastSeenAt: this.now(), addresses: [address, ...current.addresses.filter((a) => a !== address)] });
  }

  /**
   * A paired machine called from `remoteAddress`, so it can probably be
   * reached there too, at the port it listens on: a laptop that moved
   * networks is found again without anyone typing its new address. It goes
   * after the addresses already known (a call can come through a router a
   * reply can't), and once a call to it works `noteReached` moves it first.
   * Safe to learn from anyone authenticated: every connection is pinned to
   * the machine's certificate, so a wrong address only fails.
   */
  noteCalledFrom(peer: Peer, remoteAddress: string | null): void {
    if (!remoteAddress) return;
    const current = this.store.peers.get(peer.nodeId);
    if (!current) return;
    const port = current.addresses[0] ? parsePeerAddress(current.addresses[0]).port : DEFAULT_PEER_PORT;
    const ip = plainIp(remoteAddress);
    const seen = isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`;
    if (current.addresses.includes(seen)) return;
    this.store.peers.update(peer.nodeId, { addresses: [...current.addresses.slice(0, MAX_PEER_ADDRESSES - 1), seen] });
  }

  async heldToken(nodeId: string): Promise<string | null> {
    const peer = this.store.peers.get(nodeId);
    return peer ? this.options.secrets.get(peer.heldTokenRef) : null;
  }

  async close(): Promise<void> {
    this.monitor.stop();
    this.pairing.cancel();
    for (const closes of this.closers.values()) for (const close of [...closes]) close();
    await this.listener.stop();
  }
}

