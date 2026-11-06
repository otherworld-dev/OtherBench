import type { Migration } from './types.js';

// Fresh chat handover (spec 2026-11-06-fresh-chat-handover-design): how much
// context the chat's latest reply's last call read, where its card asks again
// after "Not now", and whether it asks at all. All three are synced chat
// fields (CHAT_FIELDS), so no sync trigger changes here.
export const MIGRATION_043_FRESH_CHAT_HANDOVER: Migration = {
  version: 43,
  name: '043-fresh-chat-handover',
  sql: `
ALTER TABLE chat ADD COLUMN context_tokens INTEGER NULL;
ALTER TABLE chat ADD COLUMN handover_ask_at INTEGER NULL;
ALTER TABLE chat ADD COLUMN handover_suggest INTEGER NOT NULL DEFAULT 1;
`,
};
