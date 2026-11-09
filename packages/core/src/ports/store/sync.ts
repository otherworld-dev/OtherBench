import type { ChangeBatch, ChangeRow } from '../../domain/sync.js';

export interface SyncApplyResult {
  applied: number;
  skipped: number;
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
  /** Applies a batch from another machine in one transaction; `observe` sees every stamp so local stamps stay later. */
  apply(rows: ChangeRow[], observe?: (hlc: string) => void): SyncApplyResult;
  /** The newest change-log position. */
  latestSeq(): number;
  /** Where an attachment's blob is on this machine, recorded without counting as a change. */
  setStoragePath(attachmentId: string, path: string): void;
  /** Attachments that came from another machine whose blob isn't here yet. */
  missingBlobs(): { id: string; sha256: string; size: number }[];
  /** Whether a blob belongs to a file that has been sent in a message (only those leave this machine). */
  isSentBlob(sha256: string): boolean;
  /** Observes a stamp from another machine (its clock runs ahead, say). */
  observe(hlc: string): void;
}
