import type { Migration } from './types.js';

// Changes a paired machine made to this machine's schedules over the peer
// listener, while this machine lets it (the `peerScheduleControl` setting):
// what, to which schedule, from which machine and when. Local like the
// schedules themselves (023-schedules), so no change-tracking triggers. No
// foreign key to `schedule`: a delete is one of the changes recorded, and its
// row outlives the schedule with the name it had.
export const MIGRATION_045_SCHEDULE_PEER_CHANGES: Migration = {
  version: 45,
  name: '045-schedule-peer-changes',
  sql: `
CREATE TABLE schedule_peer_change (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','edited','paused','resumed','deleted','ran')),
  from_node TEXT NOT NULL,
  run_id TEXT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_schedule_peer_change_schedule ON schedule_peer_change(schedule_id, at DESC);
`,
};
