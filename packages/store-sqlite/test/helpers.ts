import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';

/** Opens a fresh, migrated, in-memory database for a single test. */
export function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

/**
 * Seeds a minimal connection -> model chain via raw SQL (bypassing the
 * connection/model repos deliberately, so per-repo test files that exercise
 * those repos directly don't depend on the very code being tested).
 */
export function seedConnectionAndModel(db: DatabaseSync, ids: { connectionId: string; modelId: string }): void {
  db.prepare(
    `INSERT INTO connection (id, name, kind, extra_headers, status) VALUES (?, 'Test Connection', 'mock', '{}', 'unknown')`
  ).run(ids.connectionId);
  db.prepare(
    `INSERT INTO model (id, connection_id, model_id, display_name, source, currency) VALUES (?, ?, 'test-model', 'Test Model', 'manual', 'USD')`
  ).run(ids.modelId, ids.connectionId);
}

/** Seeds a minimal connection -> model -> profile chain via raw SQL. */
export function seedProfileChain(
  db: DatabaseSync,
  ids: { connectionId: string; modelId: string; profileId: string }
): void {
  seedConnectionAndModel(db, ids);
  db.prepare(
    `INSERT INTO profile (id, name, connection_id, model_id, params, tool_policy, is_default) VALUES (?, 'Test Profile', ?, ?, '{}', '{}', 0)`
  ).run(ids.profileId, ids.connectionId, ids.modelId);
}

/** Seeds a connection -> model -> profile -> chat chain via raw SQL. */
export function seedChatChain(
  db: DatabaseSync,
  ids: { connectionId: string; modelId: string; profileId: string; chatId: string }
): void {
  seedProfileChain(db, ids);
  db.prepare(
    `INSERT INTO chat (id, title, profile_id, pinned, created_at, updated_at) VALUES (?, 'Test Chat', ?, 0, 1000, 1000)`
  ).run(ids.chatId, ids.profileId);
}
