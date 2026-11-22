import type { Migration } from './types.js';

// The search index's update trigger (migration 001) fired on every UPDATE of a message: it took the row out of
// `message_fts` and put it back whenever a status, a stamp, engine state or a pin was written, with the text unchanged.
// A reply is updated like that several times a turn. `search_text` is the only column the index holds, so the trigger
// now fires only for a write that names it and changes it. The index itself is untouched: what was in it stays right.
export const MIGRATION_054_MESSAGE_FTS_ON_TEXT_CHANGE: Migration = {
  version: 54,
  name: '054-message-fts-on-text-change',
  sql: `
DROP TRIGGER IF EXISTS message_fts_au;
CREATE TRIGGER message_fts_au AFTER UPDATE OF search_text ON message WHEN old.search_text IS NOT new.search_text BEGIN
  INSERT INTO message_fts(message_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO message_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
`,
};
