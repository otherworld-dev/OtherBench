// Adds `artifact_version.live`: the data calls an html version declares
// (spec 2026-10-12-live-artifacts), as JSON, NULL for none. Existing
// versions stay NULL. Nothing is backfilled, so no sync change is logged;
// the column syncs with the row like any other.
export const MIGRATION_024_ARTIFACT_VERSION_LIVE = `
ALTER TABLE artifact_version ADD COLUMN live TEXT;
`;
