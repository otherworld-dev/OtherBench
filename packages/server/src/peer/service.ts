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
import type { Peer, PeerInfo, PublicPeer } from '@otherbench/core/types/peer.js';
import type { Hono } from 'hono';
import type { AppEventBus } from '../stream/events.js';
import { PeerClient, PeerUnreachableError, parsePeerAddress, type PeerRequest, type PeerResponse, type ResponseLimits } from './client.js';
import type { IdentityStore } from './identity.js';
import { PeerListener } from './listener.js';
import { PeerMonitor, type PeerMonitorOptions, type PeerStatus } from './monitor.js';
import { PairingSessions } from './pairing.js';
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

/** At most this many of a peer's running chats are kept: far more than anyone has running at once. */
const MAX_ACTIVE_CHATS = 200;

/** A peer's list of chat ids, as far as it is one: strings only, capped. */
function chatIdsOf(ids: unknown): string[] {
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, MAX_ACTIVE_CHATS) : [];
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
  /** This machine's `gh` login, as told to its peers; the overview service supplies it. */
  private githubLoginHere: () => string | null = () => null;
  /** Each peer's chats with a reply running there, as it last said. */
  private readonly activityByPeer = new Map<string, string[]>();
  /** The chats each paired machine last said have background tasks running there. */
  private readonly backgroundByPeer = new Map<string, string[]>();
  /** The chats each paired machine last said wait on an approval card or a question there. */
  private readonly waitingByPeer = new Map<string, string[]>();
  /** Each paired machine's `gh` login, as it last said. */
  private readonly loginByPeer = new Map<string, string | null>();

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
          const said = data as { chatIds?: unknown; backgroundChatIds?: unknown; waitingChatIds?: unknown; githubLogin?: unknown } | null;
          this.activityByPeer.set(nodeId, chatIdsOf(said?.chatIds));
          // An older machine doesn't say: none in the background, as far as we know.
          this.backgroundByPeer.set(nodeId, chatIdsOf(said?.backgroundChatIds));
          this.waitingByPeer.set(nodeId, chatIdsOf(said?.waitingChatIds));
          this.loginByPeer.set(nodeId, typeof said?.githubLogin === 'string' ? said.githubLogin : null);
          options.events?.emit({ type: 'peer-activity', nodeId });
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
  attachActivity(runningHere: () => string[], backgroundHere: () => string[] = () => [], waitingHere: () => string[] = () => []): void {
    this.runningHere = runningHere;
    this.backgroundHere = backgroundHere;
    this.waitingHere = waitingHere;
  }

  /** Where this machine's `gh` login comes from (the overview service); until set, none is told. */
  setGithubLogin(source: () => string | null): void {
    this.githubLoginHere = source;
  }

  /** Tells every peer this machine's activity now; call it when something it reports changes. */
  announceActivity(): void {
    this.announce('activity', this.activity());
  }

  /** What this machine tells its peers about its running replies (#790's "also active" hint) and background tasks. */
  activity(): { chatIds: string[]; backgroundChatIds: string[]; waitingChatIds: string[]; githubLogin: string | null } {
    return { chatIds: this.runningHere(), backgroundChatIds: this.backgroundHere(), waitingChatIds: this.waitingHere(), githubLogin: this.githubLoginHere() };
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

  private get store(): Store {
    return this.options.store;
  }

  fingerprint(): string {
    return this.options.identity.get().fingerprint;
  }

  info(): PeerInfo {
    const self = this.store.nodes.self();
    return { nodeId: self.id, name: self.name, protocolVersion: PEER_PROTOCOL_VERSION, schemaVersion: this.options.schemaVersion, platform: this.platform };
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

