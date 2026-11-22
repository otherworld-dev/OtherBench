import type { DatabaseSync } from 'node:sqlite';
import type { JobChatStore } from '@otherbench/core/ports/store.js';

/** Job chats (migrations 051 and 052): local to this machine, never synced. */
export class SqliteJobChatStore implements JobChatStore {
  constructor(private readonly db: DatabaseSync) {}

  add(chatId: string, folder: string, options: { appContext?: boolean } = {}): void {
    this.db.prepare('INSERT OR REPLACE INTO job_chat (chat_id, folder, created_at, app_context) VALUES (?, ?, ?, ?)').run(chatId, folder, Date.now(), options.appContext === true ? 1 : 0);
  }

  appContextFor(chatId: string): boolean {
    const row = this.db.prepare('SELECT app_context FROM job_chat WHERE chat_id = ?').get(chatId) as { app_context: number } | undefined;
    return row?.app_context === 1;
  }

  folderFor(chatId: string): string | null {
    const row = this.db.prepare('SELECT folder FROM job_chat WHERE chat_id = ?').get(chatId) as { folder: string } | undefined;
    return row?.folder ?? null;
  }

  remove(chatId: string): void {
    this.db.prepare('DELETE FROM job_chat WHERE chat_id = ?').run(chatId);
  }
}
