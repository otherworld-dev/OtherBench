// Adds `message.kept_at`: when the user last kept this reply as the chosen
// variant of a compare turn. Before this, a keep lived only in
// `chat.head_message_id`, so moving the head to another branch and back
// forgot it. NULL for every message that was never kept. No index: it is only
// read alongside the rows a chat already loads.
export const MIGRATION_009_MESSAGE_KEPT_AT = `
ALTER TABLE message ADD COLUMN kept_at INTEGER NULL;
`;
