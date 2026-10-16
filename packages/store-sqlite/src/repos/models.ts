import type { DatabaseSync } from 'node:sqlite';
import type { ModelRepo } from '@otherbench/core/ports/store.js';
import type { ModelInfo } from '@otherbench/core/types/config.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { clockOf, type SyncClock } from './clock.js';
import { fromBool, toBool } from './util.js';

const mapping: CrudMapping<ModelInfo> = {
  table: 'model',
  columns: [
    'id',
    'connection_id',
    'model_id',
    'display_name',
    'source',
    'supports_vision',
    'supports_tools',
    'supports_reasoning',
    'context_window',
    'max_output',
    'price_in_per_1m',
    'price_out_per_1m',
    'price_cached_per_1m',
    'currency',
  ],
  toRow: (m) => [
    m.id,
    m.connectionId,
    m.modelId,
    m.displayName,
    m.source,
    toBool(m.supportsVision),
    toBool(m.supportsTools),
    toBool(m.supportsReasoning),
    m.contextWindow,
    m.maxOutput,
    m.priceInPer1m,
    m.priceOutPer1m,
    m.priceCachedPer1m,
    m.currency,
  ],
  fromRow: (row) => ({
    id: row.id as string,
    connectionId: row.connection_id as string,
    modelId: row.model_id as string,
    displayName: row.display_name as string,
    source: row.source as ModelInfo['source'],
    supportsVision: fromBool(row.supports_vision as number),
    supportsTools: fromBool(row.supports_tools as number),
    supportsReasoning: fromBool(row.supports_reasoning as number),
    contextWindow: row.context_window as number | null,
    maxOutput: row.max_output as number | null,
    priceInPer1m: row.price_in_per_1m as number | null,
    priceOutPer1m: row.price_out_per_1m as number | null,
    priceCachedPer1m: row.price_cached_per_1m as number | null,
    currency: row.currency as string,
  }),
};

export class SqliteModelRepo implements ModelRepo {
  private readonly crud: SqliteCrudRepo<ModelInfo>;

  /** A synced table: `clock` stamps its changes (migration 013). */
  constructor(db: DatabaseSync, clock: SyncClock = clockOf(db)) {
    this.crud = new SqliteCrudRepo(db, mapping, clock);
  }

  create(m: ModelInfo): ModelInfo {
    return this.crud.create(m);
  }

  get(id: string): ModelInfo | null {
    return this.crud.get(id);
  }

  list(connectionId?: string): ModelInfo[] {
    return connectionId ? this.crud.listWhere('connection_id = ?', connectionId) : this.crud.list();
  }

  update(id: string, patch: Partial<Omit<ModelInfo, 'id'>>): ModelInfo {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
