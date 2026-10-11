// Adds `chat.project_pinned`: a chat kept at the top of its own project's
// group in the sidebar, separate from `pinned` (spec
// 2026-10-11-sidebar-layout-design §5). No existing chat is pinned in its
// project. It syncs as its own chat field (CHAT_FIELDS); an older build
// leaves the column alone.
export const MIGRATION_020_CHAT_PROJECT_PINNED = `
ALTER TABLE chat ADD COLUMN project_pinned INTEGER NOT NULL DEFAULT 0;
`;
