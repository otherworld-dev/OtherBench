import type { Migration } from './types.js';

// Chats that message each other (spec 2026-11-06-chat-to-chat-design): one
// row per message a chat's model sent to another chat, and where it is. Local
// to this machine, so no sync triggers: sends only reach chats that run here.
// No foreign keys either, as in migration 029: a chat can be deleted while a
// send to or from it waits, and ChatSendService settles the row then.
export const MIGRATION_044_CHAT_SENDS: Migration = {
  version: 44,
  name: '044-chat-sends',
  sql: `
CREATE TABLE chat_send (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  from_chat_id TEXT NOT NULL,
  from_message_id TEXT NOT NULL,
  to_chat_id TEXT NOT NULL,
  created_chat INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  to_reply_id TEXT,
  reply_text TEXT,
  reason TEXT,
  resumed_as TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_chat_send_from_message_id ON chat_send (from_message_id);
CREATE INDEX idx_chat_send_to_reply_id ON chat_send (to_reply_id);
CREATE INDEX idx_chat_send_chain_id ON chat_send (chain_id);
CREATE INDEX idx_chat_send_resumed_as ON chat_send (resumed_as);
CREATE INDEX idx_chat_send_from_chat_id ON chat_send (from_chat_id);
CREATE INDEX idx_chat_send_to_chat_id ON chat_send (to_chat_id);
CREATE INDEX idx_chat_send_status ON chat_send (status);
`,
};
