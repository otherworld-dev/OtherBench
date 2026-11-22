import type { Migration } from './types.js';

// Whether a job chat was made with its app's knowledge (docs/features/jobs.md): its turns then get the app's notes and
// its linked project's instructions and memory, as an app chat does. Off for every chat already here, and for any made
// without it. Local like the rest of the table: only this machine's job service sets it.
export const MIGRATION_052_JOB_APP_CONTEXT: Migration = {
  version: 52,
  name: '052-job-app-context',
  sql: `
ALTER TABLE job_chat ADD COLUMN app_context INTEGER NOT NULL DEFAULT 0;
`,
};
