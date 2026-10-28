import type { Migration } from './types.js';

// A schedule may let its runs use Claude Code's auto mode (Schedule.autoMode):
// off for every schedule made before, as runs were. Schedules are local and
// never sync (023-schedules), so no change-tracking trigger changes here.
export const MIGRATION_034_SCHEDULE_AUTO: Migration = {
  version: 34,
  name: '034-schedule-auto',
  sql: `
ALTER TABLE schedule ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 0;
`,
};
