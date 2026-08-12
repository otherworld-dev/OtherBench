// Migration 001: initial schema.
//
// Deviation from the task brief (authorised by the dispatch instructions):
// the brief names this file `001-initial.sql`, but a plain .sql file is not
// copied into `dist/` by `tsc` (it only emits .js/.d.ts from .ts sources), so
// a built package would ship without its migrations. Inlining the SQL as a
// TypeScript string constant removes that packaging failure mode entirely,
// at the cost of losing standalone .sql syntax highlighting for this file.
//
// Column set and types follow the design doc's "Data model" section
// (docs/superpowers/specs/2026-08-12-grunt-multi-model-chat-workbench-design.md)
// mapped onto the TypeScript entity types in @grunt/core
// (packages/core/src/ports/store.ts, packages/core/src/types/*.ts):
//   - Table names are singular, matching the design doc exactly (`connection`,
//     `model`, `profile`, `chat`, `message`, `attachment`, `usage`,
//     `mcp_server`, `grant`, `audit`).
//   - `created_at` / `updated_at` columns exist ONLY where the corresponding
//     TypeScript type has them: `chat` has both; `message` and `audit` have
//     `created_at` only; `connection`, `model`, `profile`, `attachment`,
//     `usage`, `mcp_server` and `grant` have neither.
//   - JSON-typed TS fields (extraHeaders, params, toolPolicy, parts, error,
//     producedBy, pricingSnapshot, args, env, headerRefs, toolsCache,
//     constraint, argsRedacted) are stored as TEXT columns holding serialized
//     JSON; the repository layer (Task 9) is responsible for
//     JSON.stringify/parse at the boundary.
//   - Booleans are stored as INTEGER 0/1 (SQLite has no native boolean type).
//   - `grant` and the `constraint` column are quoted throughout: both are SQL
//     keywords in the standard grammar (GRANT, CONSTRAINT) even though
//     SQLite itself doesn't reserve either word — quoting keeps the schema
//     portable and unambiguous to read.
//   - `profile.connection_id` has a foreign key to `connection`, but
//     `profile.model_id` deliberately does NOT reference `model.id`: the
//     design doc states model_id is "free text; need not be a discovered
//     row" (a profile can target a model that was never catalogued).
//     `usage.model_id` and `mcp_server`/`model` fields follow the same
//     free-text-where-the-type-says-so principle.
//   - `chat.head_message_id` and `message.parent_id` are nullable
//     self/forward references; SQLite explicitly permits forward references
//     in foreign keys (the referenced table need not exist yet at CREATE
//     TABLE time, only by the time FK enforcement runs), so `chat` can
//     reference `message` even though `message` is created afterward.
//   - `search_text` on `message` is NOT part of the CanonMessage TypeScript
//     type. It exists purely as an FTS5 sync target: SQLite triggers cannot
//     conveniently parse a JSON `parts` array to extract just the `text`-type
//     parts, so the repository layer (Task 9) is responsible for populating
//     `search_text` on every insert/update with the concatenated text of
//     parts whose `type` is `'text'`. The FTS5 triggers below index that
//     column, not `parts` directly.
export const MIGRATION_001_INITIAL = `
CREATE TABLE connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT,
  secret_ref TEXT,
  extra_headers TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unknown',
  status_message TEXT,
  checked_at INTEGER
);

CREATE TABLE model (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER,
  max_output INTEGER,
  price_in_per_1m REAL,
  price_out_per_1m REAL,
  price_cached_per_1m REAL,
  currency TEXT NOT NULL DEFAULT 'USD'
);

CREATE INDEX idx_model_connection_id ON model(connection_id);

CREATE TABLE profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  colour TEXT,
  connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  system_prompt TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  tool_policy TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER
);

CREATE INDEX idx_profile_connection_id ON profile(connection_id);

CREATE TABLE chat (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  head_message_id TEXT REFERENCES message(id) ON DELETE SET NULL,
  workspace_root TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_profile_id ON chat(profile_id);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES message(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  produced_by TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_message_chat_id ON message(chat_id);
CREATE INDEX idx_message_parent_id ON message(parent_id);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES message(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  extracted_text TEXT
);

CREATE INDEX idx_attachment_chat_id ON attachment(chat_id);
CREATE INDEX idx_attachment_message_id ON attachment(message_id);

CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL,
  pricing_snapshot TEXT NOT NULL DEFAULT '{}',
  latency_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_usage_chat_id ON usage(chat_id);
CREATE INDEX idx_usage_message_id ON usage(message_id);

CREATE TABLE mcp_server (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  url TEXT,
  header_refs TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  tools_cache TEXT
);

CREATE TABLE "grant" (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chat(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profile(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  "constraint" TEXT,
  expires_at INTEGER
);

CREATE INDEX idx_grant_chat_id ON "grant"(chat_id);
CREATE INDEX idx_grant_profile_id ON "grant"(profile_id);

CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_redacted TEXT NOT NULL DEFAULT '{}',
  result_summary TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_chat_id ON audit(chat_id);

-- Full-text search over message.search_text (see the module comment above
-- for why this is a plain column populated on write, not a JSON extraction
-- done in-trigger). External-content FTS5 table, kept in sync by triggers.
CREATE VIRTUAL TABLE message_fts USING fts5(
  search_text,
  content='message',
  content_rowid='rowid'
);

CREATE TRIGGER message_fts_ai AFTER INSERT ON message BEGIN
  INSERT INTO message_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER message_fts_ad AFTER DELETE ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER message_fts_au AFTER UPDATE ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO message_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
`;
