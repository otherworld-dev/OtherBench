import type { Migration } from './types.js';

// How much context a reply's last model call read (`Usage.contextTokens`), kept on the reply's own usage row.
// A chat on a model API reads it back on the next turn to tell how close the conversation is to the model's
// context window (docs/features/history-summary.md): the provider's own count beats an estimate. NULL on every
// existing row and wherever the engine doesn't say. `usage` is a synced table, so peers on different schema
// versions refuse to sync (server peer/syncer.ts), as for 028.
export const MIGRATION_058_USAGE_CONTEXT_TOKENS: Migration = {
  version: 58,
  name: '058-usage-context-tokens',
  sql: 'ALTER TABLE usage ADD COLUMN context_tokens INTEGER;',
};
