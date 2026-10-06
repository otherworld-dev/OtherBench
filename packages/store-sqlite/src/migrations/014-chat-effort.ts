// Adds `chat.effort`: Claude Code's effort for the chat's turns, chosen in
// the chat window (#837). NULL follows the user's Claude Code settings, which
// is what every existing chat gets.
export const MIGRATION_014_CHAT_EFFORT = `
ALTER TABLE chat ADD COLUMN effort TEXT;
`;
