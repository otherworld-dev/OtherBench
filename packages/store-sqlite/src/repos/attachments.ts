import type { DatabaseSync } from 'node:sqlite';
import type { Attachment, AttachmentRepo } from '@grunt/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { clockOf, type SyncClock } from './clock.js';

const mapping: CrudMapping<Attachment> = {
  table: 'attachment',
  columns: ['id', 'chat_id', 'message_id', 'filename', 'mime', 'size', 'sha256', 'storage_path', 'extracted_text'],
  toRow: (a) => [a.id, a.chatId, a.messageId, a.filename, a.mime, a.size, a.sha256, a.storagePath, a.extractedText],
  fromRow: (row) => ({
    id: row.id as string,
    chatId: row.chat_id as string,
    messageId: row.message_id as string | null,
    filename: row.filename as string,
    mime: row.mime as string,
    size: row.size as number,
    sha256: row.sha256 as string,
    storagePath: row.storage_path as string,
    extractedText: row.extracted_text as string | null,
  }),
};

export class SqliteAttachmentRepo implements AttachmentRepo {
  private readonly crud: SqliteCrudRepo<Attachment>;

  /** A synced table: `clock` stamps its changes (migration 013). */
  constructor(
    private readonly db: DatabaseSync,
    clock: SyncClock = clockOf(db)
  ) {
    this.crud = new SqliteCrudRepo(db, mapping, clock);
  }

  /**
   * A file is tied to one chat for good, and once it is sent to a message of
   * that chat: the same rule sync applies to a row from another machine
   * (`BOUND_ATTACHMENT_SQL` in sync.ts). A message of another chat, or one that
   * does not exist, is refused whoever asks (a route, an import, a turn).
   */
  private requireBoundTo(chatId: string, messageId: string | null): void {
    if (messageId === null) return;
    const message = this.db.prepare('SELECT chat_id FROM message WHERE id = ?').get(messageId) as { chat_id: string } | undefined;
    if (!message || message.chat_id !== chatId) {
      throw new Error(`Attachment cannot be bound to message "${messageId}": it is not a message of chat "${chatId}".`);
    }
  }

  create(a: Attachment): Attachment {
    this.requireBoundTo(a.chatId, a.messageId);
    return this.crud.create(a);
  }

  get(id: string): Attachment | null {
    return this.crud.get(id);
  }

  list(chatId: string): Attachment[] {
    return this.crud.listWhere('chat_id = ?', chatId);
  }

  update(id: string, patch: Partial<Omit<Attachment, 'id'>>): Attachment {
    const current = this.crud.get(id);
    if (current) {
      // Chat, content and type never change; the message it was sent with is set once.
      if (patch.chatId !== undefined && patch.chatId !== current.chatId) throw new Error(`Attachment "${id}" cannot move to another chat.`);
      if (patch.sha256 !== undefined && patch.sha256 !== current.sha256) throw new Error(`Attachment "${id}" cannot change its content.`);
      if (patch.mime !== undefined && patch.mime !== current.mime) throw new Error(`Attachment "${id}" cannot change its type.`);
      if (patch.size !== undefined && patch.size !== current.size) throw new Error(`Attachment "${id}" cannot change its size.`);
      if (patch.messageId !== undefined && patch.messageId !== current.messageId) {
        if (current.messageId !== null) throw new Error(`Attachment "${id}" was already sent with message "${current.messageId}".`);
        this.requireBoundTo(current.chatId, patch.messageId);
      }
    }
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }

  isReferenced(sha256: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM attachment WHERE sha256 = ? LIMIT 1').get(sha256);
    return row !== undefined;
  }

  referencedShas(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT sha256 FROM attachment').all() as { sha256: string }[];
    return new Set(rows.map((r) => r.sha256));
  }
}
