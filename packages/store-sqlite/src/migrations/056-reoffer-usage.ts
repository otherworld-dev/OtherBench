import type { Migration } from './types.js';

// Usage written while its reply was still streaming (a sub-agent's) used to be logged ahead of the reply, so a paired
// machine that pulled in between turned it down and was never offered it again (fixed in repos/messages.ts,
// `relogDependents`). Which rows a machine missed can't be told from here, so every usage row is logged once more.
// Nothing is re-stamped: a machine that has a row sees the stamp it already holds and writes nothing, one that
// changed or deleted it since keeps its own, and one that lacks it takes it.
export const MIGRATION_056_REOFFER_USAGE: Migration = {
  version: 56,
  name: '056-reoffer-usage',
  sql: `
INSERT INTO change_log (tbl, row_id, op) SELECT 'usage', id, 'upsert' FROM usage ORDER BY rowid;
`,
};
