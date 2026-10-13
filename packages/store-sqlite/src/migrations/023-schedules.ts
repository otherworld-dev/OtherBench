import type { Migration } from './types.js';

// Scheduled tasks (spec 2026-10-12-scheduled-tasks-design §3): schedules and
// their run history. Local to this machine in phase 1, like grants and MCP
// servers: no change-tracking triggers, so nothing here ever syncs. Sync
// writes chats, projects and profiles with INSERT ... ON CONFLICT DO UPDATE
// (repos/sync.ts), never REPLACE, so a synced update doesn't cascade into
// these tables; a synced delete does, as intended.
export const MIGRATION_023_SCHEDULES: Migration = {
  version: 23,
  name: '023-schedules',
  sql: `
CREATE TABLE schedule (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  chat_id TEXT NULL REFERENCES chat(id) ON DELETE CASCADE,
  project_id TEXT NULL REFERENCES project(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((chat_id IS NULL) <> (project_id IS NULL))
);
CREATE INDEX idx_schedule_due ON schedule(enabled, next_run_at);
CREATE TABLE schedule_run (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','late','manual')),
  due_at INTEGER NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NULL,
  status TEXT NOT NULL CHECK (status IN ('running','complete','error','cancelled','timed_out','not_started')),
  detail TEXT NULL,
  chat_id TEXT NULL REFERENCES chat(id) ON DELETE SET NULL,
  created_chat INTEGER NOT NULL DEFAULT 0,
  user_message_id TEXT NULL,
  message_id TEXT NULL,
  refused_calls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_schedule_run_schedule ON schedule_run(schedule_id, started_at DESC);
CREATE INDEX idx_schedule_run_chat ON schedule_run(chat_id);
`,
};
