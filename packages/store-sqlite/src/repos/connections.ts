import type { DatabaseSync } from 'node:sqlite';
import type { ConnectionRepo } from '@grunt/core/ports/store.js';
import type { Connection } from '@grunt/core/types/config.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromJson, toJson } from './util.js';

const mapping: CrudMapping<Connection> = {
  table: 'connection',
  columns: ['id', 'name', 'kind', 'base_url', 'secret_ref', 'extra_headers', 'status', 'status_message', 'checked_at'],
  toRow: (c) => [c.id, c.name, c.kind, c.baseUrl, c.secretRef, toJson(c.extraHeaders), c.status, c.statusMessage, c.checkedAt],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as Connection['kind'],
    baseUrl: row.base_url as string | null,
    secretRef: row.secret_ref as string | null,
    extraHeaders: fromJson(row.extra_headers as string),
    status: row.status as Connection['status'],
    statusMessage: row.status_message as string | null,
    checkedAt: row.checked_at as number | null,
  }),
};

export class SqliteConnectionRepo implements ConnectionRepo {
  private readonly crud: SqliteCrudRepo<Connection>;

  constructor(db: DatabaseSync) {
    this.crud = new SqliteCrudRepo(db, mapping);
  }

  create(c: Connection): Connection {
    return this.crud.create(c);
  }

  get(id: string): Connection | null {
    return this.crud.get(id);
  }

  list(): Connection[] {
    return this.crud.list();
  }

  update(id: string, patch: Partial<Omit<Connection, 'id'>>): Connection {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
