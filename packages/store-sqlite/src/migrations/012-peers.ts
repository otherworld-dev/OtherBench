import type { Migration } from './types.js';

// Migration 012: paired machines and per-node audit (v2 plan, Tasks 47-48;
// spec §3, §9).
//
// - `peer` holds each paired machine: its pinned certificate fingerprint,
//   the addresses to reach it, the hash of the token we issued it (never the
//   token) and the SecretStore reference of the token it issued us. Peers
//   are local to this machine and never synced.
// - `audit.decided_on_node` is the machine an approval was given on; every
//   existing decision was made here.
export const MIGRATION_012_PEERS: Migration = {
  version: 12,
  name: '012-peers',
  sql: `
CREATE TABLE peer (
  node_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  addresses TEXT NOT NULL DEFAULT '[]',
  issued_token_hash TEXT NOT NULL,
  held_token_ref TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER NULL,
  last_sync_seq INTEGER NOT NULL DEFAULT 0,
  paired_at INTEGER NOT NULL
);
ALTER TABLE audit ADD COLUMN decided_on_node TEXT NULL;
`,
  run: (db) => {
    const self = (db.prepare('SELECT id FROM node_self LIMIT 1').get() as { id: string } | undefined)?.id ?? null;
    db.prepare('UPDATE audit SET decided_on_node = ?').run(self);
  },
};
