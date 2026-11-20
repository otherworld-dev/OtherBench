import type { DatabaseSync } from 'node:sqlite';
import type { JobChatStore } from '@otherbench/core/ports/store.js';

/** Job chats (migration 051): local to this machine, never synced. */
export class SqliteJobChatStore implements JobChatStore {
  constructor(private readonly db: DatabaseSync) {}

  add(chatId: string, folder: string): void {
    this.db.prepare('INSERT OR REPLACE INTO job_chat (chat_id, folder, created_at) VALUES (?, ?, ?)').run(chatId, folder, Date.now());
  }

  folderFor(chatId: string): string | null {
    const row = this.db.prepare('SELECT folder FROM job_chat WHERE chat_id = ?').get(chatId) as { folder: string } | undefined;
    return row?.folder ?? null;
  }

  remove(chatId: string): void {
    this.db.prepare('DELETE FROM job_chat WHERE chat_id = ?').run(chatId);
  }
}
