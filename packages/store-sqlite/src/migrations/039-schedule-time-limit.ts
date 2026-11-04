import type { Migration } from './types.js';

// A schedule's runs may go for its own time limit (Schedule.timeLimitMinutes),
// NULL for none. Every schedule made before gets 30, the fixed limit all runs
// had until now. Schedules are local and never sync (023-schedules), so no
// change-tracking trigger changes here.
export const MIGRATION_039_SCHEDULE_TIME_LIMIT: Migration = {
  version: 39,
  name: '039-schedule-time-limit',
  sql: `
ALTER TABLE schedule ADD COLUMN time_limit_minutes INTEGER DEFAULT 30;
`,
};
