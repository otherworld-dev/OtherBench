import type { Migration } from './types.js';

// Remote access's signed-in browsers, so a restart keeps them signed in (spec
// 2026-10-12-remote-access). The cookie's token is never stored, only its
// SHA-256 (`token_hash`); `id` is a separate random id that the devices list
// and Sign out name a session by. Local to this machine: no hlc column and no
// sync triggers (013's `syncTriggers`), so a session never reaches a paired
// machine.
export const MIGRATION_037_REMOTE_SESSIONS: Migration = {
  version: 37,
  name: '037-remote-sessions',
  sql: `
CREATE TABLE remote_session (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  epoch TEXT NOT NULL,
  address TEXT,
  device_label TEXT NOT NULL
);
CREATE INDEX idx_remote_session_created ON remote_session(created_at);
`,
};
