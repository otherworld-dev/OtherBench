import { syncTriggers } from './013-change-tracking.js';
import type { Migration } from './types.js';

// ComfyUI workflows a user imported for image and video generation (plan
// 2026-10-22-media-generation, Task 7). `graph` and `bindings` are JSON text;
// the built-in workflows live in code and are never stored. Synced like the
// other user-made tables, and a row from another machine is checked on apply
// as strictly as an import is (`mediaWorkflowRowOk`).
const byId = (row: 'NEW' | 'OLD'): string => `${row}.id`;

export const MIGRATION_031_MEDIA_WORKFLOWS: Migration = {
  version: 31,
  name: '031-media-workflows',
  sql: `
CREATE TABLE media_workflow (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  media TEXT NOT NULL,
  graph TEXT NOT NULL,
  bindings TEXT NOT NULL,
  checkpoint TEXT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
${syncTriggers({ table: 'media_workflow', key: byId })}
`,
};
