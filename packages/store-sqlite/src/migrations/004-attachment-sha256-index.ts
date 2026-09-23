// Adds an index on `attachment(sha256)`.
//
// The blob GC sweep (`blob-gc.ts`) used to call `AttachmentRepo.isReferenced`
// once PER FILE found on disk -- a `SELECT 1 FROM attachment WHERE sha256 = ?`
// with no index on that column, so SQLite did a full table scan for every
// single blob, on every sweep. A sweep runs on server startup AND after every
// chat/profile/connection delete (those cascade attachment rows away), so
// this was O(files on disk x rows in the table), synchronous, on the request
// path of an ordinary delete. `sweepOrphanedBlobs` was changed to call
// `referencedShas()` ONCE per sweep instead (one full-table read, not one
// per file) -- this index is what makes THAT query, and the still-per-
// attachment-delete `isReferenced` lookup (decision #2a's cheap path), fast
// regardless of table size.
export const MIGRATION_004_ATTACHMENT_SHA256_INDEX = `
CREATE INDEX idx_attachment_sha256 ON attachment(sha256);
`;
