import type { DatabaseSync } from 'node:sqlite';
import type { ConnectionRepo } from '@otherbench/core/ports/store.js';
import type { Connection } from '@otherbench/core/types/config.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { clockOf, type SyncClock } from './clock.js';
import { fromJson, toJson } from './util.js';

const mapping: CrudMapping<Connection> = {
  table: 'connection',
  columns: ['id', 'name', 'kind', 'base_url', 'secret_ref', 'extra_headers', 'status', 'status_message', 'checked_at', 'availability', 'sync_secret'],
  toRow: (c) => [
    c.id,
    c.name,
    c.kind,
    c.baseUrl,
    c.secretRef,
    toJson(c.extraHeaders),
    c.status,
    c.statusMessage,
    c.checkedAt,
    c.availability ?? 'anywhere',
    c.syncSecret === false ? 0 : 1,
  ],
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
    availability: (row.availability as string | undefined) ?? 'anywhere',
    syncSecret: (row.sync_secret as number | undefined) !== 0,
  }),
};

/** A connection's health, which is this machine's view of it and never syncs. */
const HEALTH_KEYS: ReadonlySet<string> = new Set(['status', 'statusMessage', 'checkedAt']);

export class SqliteConnectionRepo implements ConnectionRepo {
  private readonly crud: SqliteCrudRepo<Connection>;

  /** A synced table: `clock` stamps its changes (migration 013). */
  constructor(db: DatabaseSync, clock: SyncClock = clockOf(db)) {
    this.crud = new SqliteCrudRepo(db, mapping, clock);
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

  /** A patch of only health fields leaves the sync stamp alone, so a health check is never a change to sync. */
  update(id: string, patch: Partial<Omit<Connection, 'id'>>): Connection {
    const healthOnly = Object.keys(patch).length > 0 && Object.keys(patch).every((k) => HEALTH_KEYS.has(k));
    return this.crud.update(id, patch, healthOnly ? false : undefined);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
