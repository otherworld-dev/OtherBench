import { PEER_PROTOCOL_VERSION } from '@grunt/core/domain/pairing.js';
import { connectionSecretRef, isSha256, type ChangeBatch, type ChangeRow } from '@grunt/core/domain/sync.js';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { Store, SyncRepo } from '@grunt/core/ports/store.js';
import type { PeerInfo } from '@grunt/core/types/peer.js';
import { sha256Of, type BlobStore } from '@grunt/store-sqlite/blob-store.js';

import type { AppEventBus } from '../stream/events.js';
import { PeerError, type PeerService } from './service.js';

/** Rows per `/peer/changes` batch: well under the client's 64 MiB answer cap for ordinary chats. */
export const SYNC_BATCH_SIZE = 500;
/** How often a reachable peer is pulled from even with nothing announced. */
export const SYNC_FALLBACK_MS = 60_000;
/** How often this machine checks for its own new changes to announce. */
export const CHANGE_CHECK_MS = 500;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * Whether a row states a size its blob can be held to: a whole number of
 * bytes from 0 to the cap. Anything else (text in an old row, NaN, a
 * fraction, a negative) would make every comparison below false and so switch
 * the limits off, so such a row's blob is not fetched at all.
 */
function usableBlobSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isInteger(size) && size >= 0 && size <= MAX_BLOB_BYTES;
}

export interface SyncStatus {
  lastSyncedAt: number | null;
  /** Why the last sync failed, until one succeeds. */
  error: string | null;
}

export interface SyncerOptions {
  store: Store;
  secrets: SecretStore;
  blobStore?: BlobStore;
  peers: PeerService;
  events?: AppEventBus;
  now?: () => number;
  batchSize?: number;
  fallbackMs?: number;
  changeCheckMs?: number;
}

/**
 * Pulls other machines' changes into this one (v2 plan, Tasks 50-51), and
 * serves this machine's to them. A pull reads `/peer/changes` from the
 * peer's cursor until there's nothing more, stores connection keys in this
 * machine's SecretStore, fetches and checks the blobs of new files, and
 * moves the cursor after every batch. It refuses a machine running a
 * different protocol or schema, saying which.
 *
 * Pulls run when a peer connects, when it announces changes, every minute
 * as a fallback while it's reachable, and on demand (`/peer/sync-request`,
 * and around remote execution). Pulls from one machine never overlap; one
 * asked for while another runs follows it.
 */
export class Syncer {
  private readonly running = new Map<string, Promise<number>>();
  private readonly again = new Set<string>();
  private readonly statuses = new Map<string, SyncStatus>();
  private readonly now: () => number;
  private timers: ReturnType<typeof setInterval>[] = [];
  private announcedSeq = 0;

  constructor(private readonly options: SyncerOptions) {
    this.now = options.now ?? Date.now;
  }

  private get sync(): SyncRepo {
    const sync = this.options.store.sync;
    if (!sync) throw new PeerError('This store does not track changes, so it cannot sync.', 503);
    return sync;
  }

  status(nodeId: string): SyncStatus {
    return this.statuses.get(nodeId) ?? { lastSyncedAt: null, error: null };
  }

  /** Starts the fallback pull and the check for local changes to announce. */
  start(): void {
    if (!this.options.store.sync) return;
    this.announcedSeq = this.sync.latestSeq();
    this.timers.push(
      setInterval(() => {
        for (const peer of this.options.peers.list()) {
          if (this.options.peers.status(peer.nodeId).status === 'reachable') this.pullSoon(peer.nodeId);
        }
      }, this.options.fallbackMs ?? SYNC_FALLBACK_MS),
      setInterval(() => this.announceIfChanged(), this.options.changeCheckMs ?? CHANGE_CHECK_MS)
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Tells listening peers when this machine has logged changes since it last said so. */
  announceIfChanged(): void {
    const seq = this.sync.latestSeq();
    if (seq <= this.announcedSeq) return;
    this.announcedSeq = seq;
    this.options.peers.announce('changes-available', { seq });
  }

  /** `pullFrom` without waiting, logging a failure (it's shown in Settings → Machines). */
  pullSoon(nodeId: string): void {
    this.pullFrom(nodeId).catch(() => {});
  }

  /** Pulls everything `nodeId` has that this machine doesn't. Resolves with the number of rows written. */
  pullFrom(nodeId: string): Promise<number> {
    const current = this.running.get(nodeId);
    if (current) {
      // Asked again mid-pull: the changes that prompted it may be after this pull's last batch.
      this.again.add(nodeId);
      return current;
    }
    const run = (async (): Promise<number> => {
      let total = 0;
      do {
        this.again.delete(nodeId);
        total += await this.pullOnce(nodeId);
      } while (this.again.has(nodeId));
      return total;
    })();
    this.running.set(nodeId, run);
    const settle = (): void => {
      this.running.delete(nodeId);
    };
    run.then(settle, settle);
    return run;
  }

  private async pullOnce(nodeId: string): Promise<number> {
    const peers = this.options.peers;
    try {
      const info = (await peers.call(nodeId, { method: 'GET', path: '/peer/info' })).body as PeerInfo;
      const self = peers.info();
      if (info.protocolVersion !== PEER_PROTOCOL_VERSION || info.schemaVersion !== self.schemaVersion) {
        const older = info.schemaVersion < self.schemaVersion || info.protocolVersion < PEER_PROTOCOL_VERSION ? info.name : self.name;
        throw new PeerError(
          `${info.name} runs a different version of Grunt (protocol ${info.protocolVersion}, schema ${info.schemaVersion}; this machine ${PEER_PROTOCOL_VERSION}, ${self.schemaVersion}). Update ${older} to sync.`,
          409
        );
      }
      let written = 0;
      for (;;) {
        const peer = peers.peer(nodeId);
        if (!peer) return written;
        const res = await peers.call(nodeId, { method: 'GET', path: `/peer/changes?since=${peer.lastSyncSeq}&limit=${this.options.batchSize ?? SYNC_BATCH_SIZE}` });
        if (res.status !== 200) throw new PeerError(`${peer.name} refused to send its changes (HTTP ${res.status}).`, 502);
        const batch = res.body as ChangeBatch;
        written += await this.applyBatch(batch.rows);
        this.options.store.peers.update(nodeId, { lastSyncSeq: batch.nextSeq });
        if (!batch.more) break;
      }
      await this.fetchMissingBlobs(nodeId);
      this.statuses.set(nodeId, { lastSyncedAt: this.now(), error: null });
      if (written > 0) this.options.events?.emit({ type: 'sync-applied', nodeId, changed: written });
      return written;
    } catch (err) {
      this.statuses.set(nodeId, { lastSyncedAt: this.status(nodeId).lastSyncedAt, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async applyBatch(rows: ChangeRow[]): Promise<number> {
    const result = this.sync.apply(rows);
    // API keys travel with their connection inside the TLS session, and are
    // stored here under this machine's own SecretStore key.
    const secrets = new Map(rows.filter((r) => r.op === 'upsert' && r.tbl === 'connection' && typeof r.secret === 'string').map((r) => [r.id, r]));
    for (const w of result.written) {
      const row = w.tbl === 'connection' ? secrets.get(w.id) : undefined;
      if (row?.op !== 'upsert' || typeof row.secret !== 'string' || row.row['secret_ref'] == null) continue;
      // Under the connection's own reference only (the store rewrote the row's to match).
      await this.options.secrets.set(connectionSecretRef(w.id), row.secret);
    }
    return result.applied;
  }

  /** Every file from another machine whose blob isn't here: fetched and checked against its hash; a mismatch is dropped and tried again next time. */
  private async fetchMissingBlobs(nodeId: string): Promise<void> {
    const blobStore = this.options.blobStore;
    if (!blobStore) return;
    for (const missing of this.sync.missingBlobs()) {
      if (!isSha256(missing.sha256) || !usableBlobSize(missing.size)) continue;
      try {
        const existing = await blobStore.get(missing.sha256).catch(() => null);
        const data =
          existing ??
          (await (async (): Promise<Buffer | null> => {
            // No more than the row declares (and never more than the cap): a longer body is turned away by the client itself.
            const res = await this.options.peers.call(nodeId, { method: 'GET', path: `/peer/blobs/${missing.sha256}` }, { binary: true, maxBytes: Math.min(MAX_BLOB_BYTES, missing.size) });
            if (res.status !== 200 || !Buffer.isBuffer(res.body)) return null;
            return sha256Of(res.body) === missing.sha256 ? res.body : null;
          })());
        // A file longer than its row says (or than the cap) is dropped, whether it came from the peer or was already here.
        if (!data || data.length > missing.size || data.length > MAX_BLOB_BYTES) continue;
        const stored = await blobStore.put(data);
        this.sync.setStoragePath(missing.id, stored.path);
      } catch {
        // Unreachable mid-way, or the other machine no longer has it: next sync tries again.
      }
    }
  }

  // --- serving this machine's changes -------------------------------------------

  /** A batch for a peer, with each connection's key unless it stays on this machine. */
  async changesFor(since: number, limit: number): Promise<ChangeBatch> {
    const batch = this.sync.changesSince(since, Math.min(Math.max(limit, 1), 2000));
    for (const row of batch.rows) {
      if (row.op !== 'upsert' || row.tbl !== 'connection') continue;
      // Only a key this machine shares, and only from the connection's own
      // reference: never whatever secret a row (perhaps synced in) names.
      const local = this.options.store.connections.get(row.id);
      if (!local || local.syncSecret === false || local.secretRef !== connectionSecretRef(row.id)) continue;
      const secret = await this.options.secrets.get(connectionSecretRef(row.id));
      if (secret !== null) row.secret = secret;
    }
    return batch;
  }

  /** A blob a peer may have: only one belonging to a file sent in a message. */
  async blob(sha256: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{64}$/.test(sha256) || !this.sync.isSentBlob(sha256) || !this.options.blobStore) return null;
    return this.options.blobStore.get(sha256).catch(() => null);
  }
}
