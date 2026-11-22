import type { Migration } from './types.js';

// How far each paired machine has pulled this machine's change log, as heard on its requests (`since` on
// /peer/changes), so the log and the tombstones can be tidied without losing anything for a machine that hasn't
// had it yet (SqliteSyncRepo.pruneLog). Local, never synced, and kept apart from `peer` (which the peer repo
// rewrites whole): a row is made on a machine's first pull and goes when it is unpaired.
//
// `pulled_seq` is the newest cursor heard. It only counts once it has stood for a while, since a machine that
// loses its newest commits to a power cut comes back asking from further back: `candidate_seq` is what it was
// at `candidate_at`, and `settled_seq`, what the tidy goes by, is what it was the settling time before that.
export const MIGRATION_057_SYNC_PEER_CURSOR: Migration = {
  version: 57,
  name: '057-sync-peer-cursor',
  sql: `
CREATE TABLE sync_peer_cursor (
  node_id TEXT PRIMARY KEY,
  pulled_seq INTEGER NOT NULL DEFAULT 0,
  candidate_seq INTEGER NOT NULL DEFAULT 0,
  candidate_at INTEGER NOT NULL DEFAULT 0,
  settled_seq INTEGER NOT NULL DEFAULT 0
);
`,
};
