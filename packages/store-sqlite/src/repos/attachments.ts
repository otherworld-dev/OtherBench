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

  create(a: Attachment): Attachment {
    return this.crud.create(a);
  }

  get(id: string): Attachment | null {
    return this.crud.get(id);
  }

  list(chatId: string): Attachment[] {
    return this.crud.listWhere('chat_id = ?', chatId);
  }

  update(id: string, patch: Partial<Omit<Attachment, 'id'>>): Attachment {
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
