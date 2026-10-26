import type { Migration } from './types.js';

// The Overview (plan 2026-10-26-overview): what needs the user across chats,
// GitHub issues and Deck cards. `chat.dealt_with_at` is when the user ticked a
// chat off; it is a synced chat field of its own (CHAT_FIELDS.dealtWithAt), so
// no sync trigger changes here.
export const MIGRATION_033_OVERVIEW: Migration = {
  version: 33,
  name: '033-overview',
  sql: `
ALTER TABLE chat ADD COLUMN dealt_with_at INTEGER NULL;
`,
};
