// Adds `chat.plan_mode`: the per-chat Plan toggle (spec
// 2026-10-12-thread-cards-design §4). Every existing chat is off. It syncs
// as its own chat field (CHAT_FIELDS); an older build leaves the column alone.
export const MIGRATION_022_CHAT_PLAN_MODE = `
ALTER TABLE chat ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;
`;
