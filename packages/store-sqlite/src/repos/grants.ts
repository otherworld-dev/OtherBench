import type { DatabaseSync } from 'node:sqlite';
import type { Grant, GrantRepo } from '@otherbench/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromJsonNullable, toJsonNullable } from './util.js';

// The table is named `"grant"` and the column `"constraint"` -- both quoted
// in the schema since GRANT/CONSTRAINT are SQL keywords in the standard
// grammar (see migrations/001-initial.ts). Quoting carries through here.
const mapping: CrudMapping<Grant> = {
  table: '"grant"',
  columns: ['id', 'chat_id', 'profile_id', 'tool_name', 'source', 'scope', '"constraint"', 'expires_at'],
  toRow: (g) => [g.id, g.chatId, g.profileId, g.toolName, g.source, g.scope, toJsonNullable(g.constraint), g.expiresAt],
  fromRow: (row) => ({
    id: row.id as string,
    chatId: row.chat_id as string | null,
    profileId: row.profile_id as string | null,
    toolName: row.tool_name as string,
    source: row.source as Grant['source'],
    scope: row.scope as Grant['scope'],
    constraint: fromJsonNullable(row.constraint as string | null),
    expiresAt: row.expires_at as number | null,
  }),
};

export class SqliteGrantRepo implements GrantRepo {
  private readonly crud: SqliteCrudRepo<Grant>;

  constructor(db: DatabaseSync) {
    this.crud = new SqliteCrudRepo(db, mapping);
  }

  create(g: Grant): Grant {
    return this.crud.create(g);
  }

  get(id: string): Grant | null {
    return this.crud.get(id);
  }

  list(chatId?: string): Grant[] {
    return chatId ? this.crud.listWhere('chat_id = ?', chatId) : this.crud.list();
  }

  update(id: string, patch: Partial<Omit<Grant, 'id'>>): Grant {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
