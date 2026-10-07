import { syncTriggers } from './013-change-tracking.js';
import type { Migration } from './types.js';

// Artifacts (spec 2026-10-07-artifacts, Deck #896): what the model made in a
// chat, and every version of it. Versions never change once written. A
// version's message_id is the reply that made it, a plain column rather than
// a foreign key, so a version synced before its reply is still kept. Both
// tables sync like the rest (migration 013's triggers).
const byId = (row: 'NEW' | 'OLD'): string => `${row}.id`;

export const MIGRATION_016_ARTIFACTS: Migration = {
  version: 16,
  name: '016-artifacts',
  sql: `
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  language TEXT,
  created_at INTEGER NOT NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
CREATE INDEX artifact_chat ON artifact(chat_id, slug);
CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  made_by TEXT NOT NULL,
  message_id TEXT,
  parent_version_id TEXT,
  created_at INTEGER NOT NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
CREATE INDEX artifact_version_artifact ON artifact_version(artifact_id, number);
${syncTriggers({ table: 'artifact', key: byId })}
${syncTriggers({ table: 'artifact_version', key: byId })}
`,
};
