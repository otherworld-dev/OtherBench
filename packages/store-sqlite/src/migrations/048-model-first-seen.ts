import type { Migration } from './types.js';

// When "Discover models" first found a model (ModelInfo.firstSeenAt), so the
// Models page can tag the ones the latest run added. Every model from one run
// shares one stamp; a re-run never moves it. Models already here, and models
// added by hand, have none. `model` already syncs (migration 013's triggers
// fire on every stamped update, whatever the column), so the stamp travels
// with the rest of the row and needs no trigger change here.
export const MIGRATION_048_MODEL_FIRST_SEEN: Migration = {
  version: 48,
  name: '048-model-first-seen',
  sql: `
ALTER TABLE model ADD COLUMN first_seen_at INTEGER NULL;
`,
};
