import type { DatabaseSync } from 'node:sqlite';
import type { Chat, ChatRepo } from '@grunt/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromBool, toBool } from './util.js';

const mapping: CrudMapping<Chat> = {
  table: 'chat',
  columns: [
    'id',
    'title',
    'profile_id',
    'head_message_id',
    'workspace_root',
    'pinned',
    'archived_at',
    'created_at',
    'updated_at',
  ],
  toRow: (c) => [
    c.id,
    c.title,
    c.profileId,
    c.headMessageId,
    c.workspaceRoot,
    toBool(c.pinned),
    c.archivedAt,
    c.createdAt,
    c.updatedAt,
  ],
  fromRow: (row) => ({
    id: row.id as string,
    title: row.title as string,
    profileId: row.profile_id as string,
    headMessageId: row.head_message_id as string | null,
    workspaceRoot: row.workspace_root as string | null,
    pinned: fromBool(row.pinned as number),
    archivedAt: row.archived_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }),
};

export class SqliteChatRepo implements ChatRepo {
  private readonly crud: SqliteCrudRepo<Chat>;

  constructor(db: DatabaseSync) {
    this.crud = new SqliteCrudRepo(db, mapping);
  }

  create(c: Omit<Chat, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): Chat {
    const now = Date.now();
    const full: Chat = { ...c, createdAt: c.createdAt ?? now, updatedAt: c.updatedAt ?? now };
    return this.crud.create(full);
  }

  get(id: string): Chat | null {
    return this.crud.get(id);
  }

  list(): Chat[] {
    return this.crud.list();
  }

  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
