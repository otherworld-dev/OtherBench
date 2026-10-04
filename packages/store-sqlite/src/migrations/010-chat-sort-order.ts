// Adds `chat.sort_order`: the chat's place in its sidebar section, higher
// first (#823). The sidebar used to sort by activity (`updated_at`), so
// existing chats start from that and keep the order they had. REAL, so a
// dragged chat can be placed between two others without renumbering.
export const MIGRATION_010_CHAT_SORT_ORDER = `
ALTER TABLE chat ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
UPDATE chat SET sort_order = updated_at;
`;
