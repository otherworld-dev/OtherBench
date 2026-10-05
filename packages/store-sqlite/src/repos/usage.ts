import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord, UsageRepo } from '@grunt/core/ports/store.js';
import type { PricingSnapshot } from '@grunt/core/types/usage.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { clockOf, type SyncClock } from './clock.js';
import { fromJson, toJson } from './util.js';

const mapping: CrudMapping<UsageRecord> = {
  table: 'usage',
  columns: [
    'id',
    'chat_id',
    'message_id',
    'profile_id',
    'connection_id',
    'model_id',
    'tokens_in',
    'tokens_out',
    'tokens_cached',
    'tokens_reasoning',
    'cost_estimate',
    'pricing_snapshot',
    'latency_ms',
  ],
  toRow: (u) => [
    u.id,
    u.chatId,
    u.messageId,
    u.profileId,
    u.connectionId,
    u.modelId,
    u.tokensIn,
    u.tokensOut,
    u.tokensCached,
    u.tokensReasoning,
    u.costEstimate,
    toJson(u.pricingSnapshot),
    u.latencyMs,
  ],
  fromRow: (row) => ({
    id: row.id as string,
    chatId: row.chat_id as string,
    messageId: row.message_id as string,
    profileId: row.profile_id as string,
    connectionId: row.connection_id as string,
    modelId: row.model_id as string,
    tokensIn: row.tokens_in as number,
    tokensOut: row.tokens_out as number,
    tokensCached: row.tokens_cached as number,
    tokensReasoning: row.tokens_reasoning as number,
    costEstimate: row.cost_estimate as number | null,
    pricingSnapshot: fromJson<PricingSnapshot>(row.pricing_snapshot as string),
    latencyMs: row.latency_ms as number,
  }),
};

export class SqliteUsageRepo implements UsageRepo {
  private readonly crud: SqliteCrudRepo<UsageRecord>;

  /** A synced table: `clock` stamps its changes (migration 013). */
  constructor(db: DatabaseSync, clock: SyncClock = clockOf(db)) {
    this.crud = new SqliteCrudRepo(db, mapping, clock);
  }

  create(u: UsageRecord): UsageRecord {
    return this.crud.create(u);
  }

  get(id: string): UsageRecord | null {
    return this.crud.get(id);
  }

  list(chatId: string): UsageRecord[] {
    return this.crud.listWhere('chat_id = ?', chatId);
  }

  update(id: string, patch: Partial<Omit<UsageRecord, 'id'>>): UsageRecord {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
