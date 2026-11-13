import type { Migration } from './types.js';

// Chat sends across machines (spec 2026-11-13-chat-sends-across-machines-design).
// Still local, like migration 044: each machine keeps its own side of a send.
// The sender's machine sets `to_node` on a row handed to a paired machine; that
// machine keeps a mirror row with the same id and `from_node` set. The rest say
// where the conversation between the two machines is: when it was handed over,
// when the outcome was reported back, a stop still to tell the other side, and
// why a handover is waiting (and whether the user chose to wait).
export const MIGRATION_049_CHAT_SEND_REMOTE: Migration = {
  version: 49,
  name: '049-chat-send-remote',
  sql: `
ALTER TABLE chat_send ADD COLUMN to_node TEXT NULL;
ALTER TABLE chat_send ADD COLUMN from_node TEXT NULL;
ALTER TABLE chat_send ADD COLUMN to_app_id TEXT NULL;
ALTER TABLE chat_send ADD COLUMN from_title TEXT NULL;
ALTER TABLE chat_send ADD COLUMN handed_at INTEGER NULL;
ALTER TABLE chat_send ADD COLUMN reported_at INTEGER NULL;
ALTER TABLE chat_send ADD COLUMN stop_pending TEXT NULL;
ALTER TABLE chat_send ADD COLUMN held_reason TEXT NULL;
ALTER TABLE chat_send ADD COLUMN held_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_send ADD COLUMN chain_base INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_send ADD COLUMN handover_tried INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_chat_send_to_node ON chat_send (to_node);
`,
};
