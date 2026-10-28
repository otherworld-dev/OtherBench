import type { Migration } from './types.js';

// Claude accounts (plan 2026-10-28-claude-accounts): which Claude login a chat's
// Claude Code turns run on. `claude_account` is the account slug (NULL = the
// default); `account_auto_switch` lets the chat move to another account when
// the current one hits its usage limit. Both are synced chat fields
// (CHAT_FIELDS), so no sync trigger changes here.
export const MIGRATION_034_CLAUDE_ACCOUNTS: Migration = {
  version: 34,
  name: '034-claude-accounts',
  sql: `
ALTER TABLE chat ADD COLUMN claude_account TEXT NULL;
ALTER TABLE chat ADD COLUMN account_auto_switch INTEGER NOT NULL DEFAULT 0;
`,
};
