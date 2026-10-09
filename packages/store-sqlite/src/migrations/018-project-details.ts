// Adds a project's description (for the user; global memory's project index, added later, also shows it to models) and its
// instructions (added to the system prompt of every chat in the project) --
// spec 2026-10-08-project-page-design §1. Every existing project has neither.
export const MIGRATION_018_PROJECT_DETAILS = `
ALTER TABLE project ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE project ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
`;
