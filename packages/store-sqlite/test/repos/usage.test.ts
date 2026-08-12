import { describe, it, expect } from 'vitest';
import type { UsageRecord } from '@grunt/core/ports/store.js';
import type { PricingSnapshot } from '@grunt/core/types/usage.js';
import { freshDb, seedChatChain } from '../helpers.js';
import { SqliteMessageRepo } from '../../src/repos/messages.js';
import { SqliteUsageRepo } from '../../src/repos/usage.js';

const zeroPricing: PricingSnapshot = { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' };

function makeUsage(
  over: Partial<UsageRecord> & { id: string; chatId: string; messageId: string; profileId: string; connectionId: string; modelId: string }
): UsageRecord {
  return {
    tokensIn: 10,
    tokensOut: 20,
    tokensCached: 0,
    tokensReasoning: 0,
    costEstimate: null,
    pricingSnapshot: zeroPricing,
    latencyMs: 100,
    ...over,
  };
}

describe('SqliteUsageRepo', () => {
  it('create/get round-trips every field, including pricingSnapshot JSON', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    new SqliteMessageRepo(db).create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    const repo = new SqliteUsageRepo(db);

    const pricing: PricingSnapshot = { priceInPer1m: 3, priceOutPer1m: 15, priceCachedPer1m: 0.3, currency: 'USD' };
    repo.create(
      makeUsage({
        id: 'usage-a',
        chatId: 'chat-a',
        messageId: 'msg-a',
        profileId: 'p1',
        connectionId: 'c1',
        modelId: 'm1',
        tokensIn: 42,
        costEstimate: 0.001234,
        pricingSnapshot: pricing,
      })
    );

    expect(repo.get('usage-a')).toEqual({
      id: 'usage-a',
      chatId: 'chat-a',
      messageId: 'msg-a',
      profileId: 'p1',
      connectionId: 'c1',
      modelId: 'm1',
      tokensIn: 42,
      tokensOut: 20,
      tokensCached: 0,
      tokensReasoning: 0,
      costEstimate: 0.001234,
      pricingSnapshot: pricing,
      latencyMs: 100,
    });
    db.close();
  });

  it('list(chatId) filters to that chat', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    seedChatChain(db, { connectionId: 'c2', modelId: 'm2', profileId: 'p2', chatId: 'chat-b' });
    const messages = new SqliteMessageRepo(db);
    messages.create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    messages.create({ id: 'msg-b', chatId: 'chat-b', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    const repo = new SqliteUsageRepo(db);
    repo.create(makeUsage({ id: 'usage-a', chatId: 'chat-a', messageId: 'msg-a', profileId: 'p1', connectionId: 'c1', modelId: 'm1' }));
    repo.create(makeUsage({ id: 'usage-b', chatId: 'chat-b', messageId: 'msg-b', profileId: 'p2', connectionId: 'c2', modelId: 'm2' }));

    expect(repo.list('chat-a').map((u) => u.id)).toEqual(['usage-a']);
    db.close();
  });
});
