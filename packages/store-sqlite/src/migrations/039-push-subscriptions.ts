import type { Migration } from './types.js';

// Web Push for remote access's signed-in devices: one subscription per remote
// session (037), deleted with it by the foreign key, so signing a device out or
// its session expiring stops its pushes. `endpoint` is the push service URL
// the browser handed out; `p256dh` and `auth` are the keys payloads are
// encrypted to (RFC 8291). Local to this machine like `remote_session`: no
// hlc column and no sync triggers, so a subscription never reaches a paired
// machine.
export const MIGRATION_039_PUSH_SUBSCRIPTIONS: Migration = {
  version: 39,
  name: '039-push-subscriptions',
  sql: `
CREATE TABLE push_subscription (
  session_id TEXT PRIMARY KEY REFERENCES remote_session(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  approvals INTEGER NOT NULL DEFAULT 1,
  replies INTEGER NOT NULL DEFAULT 1,
  scheduled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
};
