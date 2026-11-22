import type { Migration } from './types.js';

// The replies being written right now are a handful of rows among every message there is, and they are asked for
// often: on each /clear, by a paired machine showing a chat live, and at every start. Without an index each of those
// read the whole table. A partial index holds only the streaming rows, so it costs nothing for the rest; it leads with
// the chat, for the per-chat question (`listStreaming`), and serves the whole-table one (`listByStatus('streaming')`).
// A query uses it only when it says `status = 'streaming'` in its text, not as a bound value.
export const MIGRATION_055_MESSAGE_STREAMING_INDEX: Migration = {
  version: 55,
  name: '055-message-streaming-index',
  sql: `
CREATE INDEX idx_message_streaming ON message(chat_id) WHERE status = 'streaming';
`,
};
