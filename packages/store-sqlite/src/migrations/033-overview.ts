import { syncTriggers } from './013-change-tracking.js';
import type { Migration } from './types.js';

// The Overview (plan 2026-10-26-overview): what needs the user across chats,
// GitHub issues and Deck cards. `chat.dealt_with_at` is when the user ticked a
// chat off; it is a synced chat field of its own (CHAT_FIELDS.dealtWithAt), so
// no sync trigger changes there.
// `issue_tick` is how far the user has ticked an app's GitHub issue off
// (`through` is the ISO time of the activity ticked through). Its key is a
// string, `${app_id}#${number}`, because sync's rowKey needs strings, and
// `app_id` is not a foreign key: sync applies rows in no fixed order.
const byId = (row: 'NEW' | 'OLD'): string => `${row}.id`;

export const MIGRATION_033_OVERVIEW: Migration = {
  version: 33,
  name: '033-overview',
  sql: `
ALTER TABLE chat ADD COLUMN dealt_with_at INTEGER NULL;
CREATE TABLE issue_tick (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  through TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
${syncTriggers({ table: 'issue_tick', key: byId })}
`,
};
