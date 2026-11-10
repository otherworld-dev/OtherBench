import type { Migration } from './types.js';

// Whether this machine's own folder for a location was set on this machine
// (`set_here = 1`) or arrived by sync (0). A paired machine may fill in this
// machine's path for a location that has none here yet (adopting a location,
// docs/deviations.md), so a synced row can name any folder at all; only a path
// set here may be browsed from a paired machine (peer/location-dirs.ts). The
// column never leaves this machine and is never taken from one
// (`LOCAL_COLUMNS` in repos/sync.ts), so no peer can set it.
//
// Every existing row starts as 0, deliberately: nothing recorded before this
// says where a row came from (a row's stamp names a machine, but a peer can
// send any stamp), so none is taken on trust. Setting a location's path again
// in Settings → Locations marks it as set here.
export const MIGRATION_046_LOCATION_PATH_SET_HERE: Migration = {
  version: 46,
  name: '046-location-path-set-here',
  sql: `
ALTER TABLE location_path ADD COLUMN set_here INTEGER NOT NULL DEFAULT 0;
`,
};
