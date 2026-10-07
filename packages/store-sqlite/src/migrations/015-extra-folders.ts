// Adds `folders` to chats and projects: the extra folders a chat may use
// besides its workspace (spec 2026-10-07-extra-folders, Deck #839), as a JSON
// list of { workspace, access }. Every existing chat and project has none.
export const MIGRATION_015_EXTRA_FOLDERS = `
ALTER TABLE chat ADD COLUMN folders TEXT NOT NULL DEFAULT '[]';
ALTER TABLE project ADD COLUMN folders TEXT NOT NULL DEFAULT '[]';
`;
