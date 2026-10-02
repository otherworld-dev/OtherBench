// Adds `message.engine_meta`: engine-owned JSON state on an assistant message.
// Only the Claude Code engine writes it (its session id, backend and cwd), so
// the next turn can continue that Claude Code session. NULL everywhere
// else. No index: lookups are by chat (`latestBySession`), which is already
// a small, chat-scoped scan.
export const MIGRATION_005_MESSAGE_ENGINE_META = `
ALTER TABLE message ADD COLUMN engine_meta TEXT NULL;
`;
