import type { ChangeBatch, ChangeRow } from '../../domain/sync.js';

export interface SyncApplyResult {
  applied: number;
  skipped: number;
  /**
   * Of `skipped`, the rows not taken because their stamp is further ahead of this machine's clock than another
   * machine's may be (`HLC_MAX_AHEAD_MS`), yet within a day of it. They are fine once this machine reaches their
   * time, so the caller should ask for them again rather than move on. (A row stamped more than a day ahead is
   * skipped and not counted here: see `HLC_MAX_WAIT_MS`.)
   */
  ahead: number;
  /** Attachments written by this batch, whose blobs may need fetching. */
  attachments: { id: string; sha256: string }[];
  /** Every row written (connections among them have secrets to store). */
  written: { tbl: string; id: string }[];
}

/**
 * Change tracking and applying other machines' changes (v2 plan, Tasks
 * 49-50). Implemented by the SQLite store only, where triggers keep the
 * change log; the in-memory fake has none.
 */
export interface SyncRepo {
  /** The current state of each row changed after `since` (at most `limit` rows), oldest change first; rows that never leave this machine are left out. */
  changesSince(since: number, limit: number): ChangeBatch;
  /** Applies a batch from another machine in one transaction; `observe` sees the stamps of every row taken so local stamps stay later. */
  apply(rows: ChangeRow[], observe?: (hlc: string) => void): SyncApplyResult;
  /** The newest change-log position. */
  latestSeq(): number;
  /** Where an attachment's blob is on this machine, recorded without counting as a change. */
  setStoragePath(attachmentId: string, path: string): void;
  /** Attachments that came from another machine whose blob isn't here yet. */
  missingBlobs(): { id: string; sha256: string; size: number }[];
  /** Whether a blob belongs to a file that has been sent in a message (only those leave this machine). */
  isSentBlob(sha256: string): boolean;
  /**
   * Notes that paired machine `nodeId` asked for changes after `since`: it has everything up to there. What
   * `pruneLog` goes by. A lower `since` than last time (the machine lost its newest commits) is taken as it is.
   */
  notePulled(nodeId: string, since: number): void;
  /**
   * One bounded step of tidying the change log and the tombstones: looks at up to `limit` logged rows after
   * `after` (null to start a pass) and answers where to carry on from, null once the pass is done.
   *
   * Only at or below what every paired machine has stood past for `PULL_SETTLE_MS` (everything, with none
   * paired): a row keeps its first and last entries there, which are what a machine pairing later reads it by,
   * and a deleted row its delete. A delete's tombstone and entry go once it is also `TOMBSTONE_KEEP_MS` old. A machine that
   * is paired and has not pulled holds all of it back.
   */
  pruneLog(step: { now: number; limit: number; after: string | null }): { entries: number; tombstones: number; after: string | null };
  /** Observes a stamp from another machine (its clock runs a little ahead, say); one too far ahead is not followed. */
  observe(hlc: string): void;
}
