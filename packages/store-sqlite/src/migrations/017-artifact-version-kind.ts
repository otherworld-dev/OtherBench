import type { Migration } from './types.js';

// Each artifact version gets its own kind and language (Deck #896): a
// rewrite may make a markdown note into an html page as its next version.
// Existing versions take their artifact's. The backfill leaves `hlc` alone,
// so it logs no sync change: every machine runs this migration itself, and
// machines on different schemas don't sync.
export const MIGRATION_017_ARTIFACT_VERSION_KIND: Migration = {
  version: 17,
  name: '017-artifact-version-kind',
  sql: `
ALTER TABLE artifact_version ADD COLUMN kind TEXT NOT NULL DEFAULT '';
ALTER TABLE artifact_version ADD COLUMN language TEXT;
UPDATE artifact_version SET
  kind = COALESCE((SELECT kind FROM artifact WHERE artifact.id = artifact_version.artifact_id), kind),
  language = (SELECT language FROM artifact WHERE artifact.id = artifact_version.artifact_id);
`,
};
