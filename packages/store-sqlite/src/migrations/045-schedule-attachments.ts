import type { Migration } from './types.js';

// Files a schedule sends with its prompt on every run (docs/features/
// scheduled-tasks.md, "Attachments"). Local, like `schedule` itself: no sync
// triggers. The bytes are a blob in the attachment store, shared by content
// hash with chat attachments; `SqliteAttachmentRepo.isReferenced` and
// `referencedShas` count these rows, so blob GC keeps a schedule's files while
// the row exists. A row goes with its schedule (ON DELETE CASCADE, so also
// with the schedule's chat, project or profile), and blob GC then frees the
// blob once nothing else references it. Indexed by blob for that check.
export const MIGRATION_045_SCHEDULE_ATTACHMENTS: Migration = {
  version: 45,
  name: '045-schedule-attachments',
  sql: `
CREATE TABLE schedule_attachment (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  extracted_text TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_schedule_attachment_schedule ON schedule_attachment(schedule_id, created_at);
CREATE INDEX idx_schedule_attachment_sha256 ON schedule_attachment(sha256);
`,
};
