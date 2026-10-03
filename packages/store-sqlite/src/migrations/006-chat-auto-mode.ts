// Adds `chat.auto_mode`: the per-chat Auto toggle for Claude Code turns
// (spec 2026-10-03-claude-code-auto-mode-design §1). 0 = off, which is what
// every existing chat gets.
export const MIGRATION_006_CHAT_AUTO_MODE = `
ALTER TABLE chat ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 0;
`;
