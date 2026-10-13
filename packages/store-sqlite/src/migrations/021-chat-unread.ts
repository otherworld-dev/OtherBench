// Adds `chat.unread`: a reply finished in the chat that the user hasn't had
// on screen since, which the sidebar marks. No existing chat starts unread.
// It syncs as its own chat field (CHAT_FIELDS), so reading a chat on one
// machine clears it on the other; an older build leaves the column alone.
export const MIGRATION_021_CHAT_UNREAD = `
ALTER TABLE chat ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
`;
